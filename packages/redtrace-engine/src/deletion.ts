import { existsSync, lstatSync, realpathSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import { Type } from 'typebox'
import type { Store } from './store.ts'
import type { Operations } from './operations.ts'
import type { Router } from './http.ts'
import { body, send } from './http.ts'
import { HttpError, now } from './types.ts'

const hash = (value: string) => createHash('sha256').update(value).digest()
const projectId = (value: string) => { if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(value)) throw new HttpError(400, 'Invalid project id'); return value }

export class ProjectDeletion {
  private store: Store
  private operations: Operations
  private root: string
  private workspaceRoot: string
  constructor(store: Store, operations: Operations, root: string, workspaceRoot: string) { this.store = store; this.operations = operations; this.root = root; this.workspaceRoot = workspaceRoot }
  confirmation(id: string) {
    this.store.project(projectId(id)); const token = randomBytes(32).toString('base64url'), at = now()
    this.store.transaction(() => {
      this.store.db.prepare('DELETE FROM project_delete_authorizations WHERE expires_at<? OR used_at IS NOT NULL').run(Date.now() / 1000)
      this.store.db.prepare('INSERT INTO project_delete_authorizations VALUES (?,?,?,?,NULL,?)').run(hash(token).toString('hex'), id, 'human-ui', Date.now() / 1000 + 60, at)
    })
    return { confirmationToken: token, expiresIn: 60 }
  }
  async request(id: string, token: string, actor: string) {
    projectId(id)
    try { this.store.project(id) } catch (error) { if (error instanceof HttpError && error.status === 404) { this.store.db.prepare('DELETE FROM project_deletions WHERE project_id=?').run(id); if (token) throw new HttpError(403, 'A fresh human UI deletion confirmation is required'); return 'missing' }; throw error }
    const row: any = this.store.db.prepare('SELECT token_hash,actor FROM project_delete_authorizations WHERE project_id=? AND used_at IS NULL AND expires_at>=?').get(id, Date.now() / 1000)
    const actual = hash(token), expected = row ? Buffer.from(row.token_hash, 'hex') : Buffer.alloc(actual.length)
    if (!row || row.actor !== actor || expected.length !== actual.length || !timingSafeEqual(actual, expected)) throw new HttpError(403, 'A fresh human UI deletion confirmation is required')
    this.store.transaction(() => {
      const at = now(); this.store.db.prepare('UPDATE project_delete_authorizations SET used_at=? WHERE token_hash=?').run(at, row.token_hash)
      this.store.db.prepare("INSERT INTO project_deletions(project_id,state,attempts,requested_at,updated_at,last_error,actor,source) VALUES (?,'pending',1,?,?,NULL,?,'web-ui') ON CONFLICT(project_id) DO UPDATE SET state='pending',attempts=attempts+1,updated_at=excluded.updated_at,last_error=NULL,actor=excluded.actor").run(id, at, at, actor)
      this.store.db.prepare("INSERT INTO project_lifecycle_events(project_id,action,actor,source,detail_json,created_at) VALUES (?,'delete.requested',?,'web-ui','{}',?)").run(id, actor, at)
      this.store.markDeleting(id)
    })
    await this.operations.cancelProject(id)
    queueMicrotask(() => { void this.complete(id, true) })
    return 'pending'
  }
  status(id: string) { projectId(id); return this.store.db.prepare('SELECT * FROM project_deletions WHERE project_id=?').get(id) ?? null }
  async complete(id: string, success: boolean, error = '') {
    projectId(id); const pending = this.status(id); if (!pending) { try { this.store.project(id) } catch { return true }; throw new HttpError(409, 'Project is not pending deletion') }
    if (!success) { this.fail(id, error || 'runtime cleanup failed'); return false }
    try {
      await this.operations.cancelProject(id)
      const sessions = new Set((this.store.db.prepare('SELECT data FROM audit_runs WHERE project_id=?').all(id) as { data: string }[]).map(row => String(JSON.parse(row.data).session_id ?? '')).filter(Boolean))
      const sessionRoot = path.join(this.root, '.redtrace/sessions')
      if (existsSync(sessionRoot)) for (const project of readdirSync(sessionRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
        const directory = path.join(sessionRoot, project.name)
        let removed = 0
        for (const entry of readdirSync(directory, { withFileTypes: true })) if (entry.isDirectory() && sessions.has(entry.name)) { this.removeContained(path.join(directory, entry.name)); removed++ }
        // Only shrink directories this deletion actually emptied; untouched ones may belong to live projects.
        if (removed && !readdirSync(directory).length) this.removeContained(directory)
      }
      for (const target of [path.join(this.root, '.redtrace/projects', id), path.join(this.root, '.redtrace/log/projects', id), path.join(this.root, '.redtrace/audit', id), path.join(this.workspaceRoot, id)]) this.removeContained(target)
      this.store.transaction(() => {
        const durable = ['webshell', 'c2_listener', 'c2_session', 'c2_payload', 'c2_profile', 'credential_ref'], marks = durable.map(() => '?').join(',')
        this.store.db.prepare('DELETE FROM trace_fts WHERE project=?').run(id)
        this.store.db.prepare('DELETE FROM trace_audit_fts WHERE project=?').run(id)
        this.store.db.prepare(`DELETE FROM resource_audit_events WHERE project_id=? AND (resource_id IS NULL OR resource_id NOT IN (SELECT id FROM shared_resources WHERE project_id=? AND kind IN (${marks})))`).run(id, id, ...durable)
        this.store.db.prepare(`DELETE FROM shared_resources WHERE project_id=? AND kind NOT IN (${marks})`).run(id, ...durable)
        this.store.db.prepare('DELETE FROM project_lifecycle_events WHERE project_id=?').run(id)
        this.store.db.prepare('DELETE FROM projects WHERE id=?').run(id)
        this.store.db.prepare('DELETE FROM counters WHERE scope=?').run(id)
        this.store.db.prepare('DELETE FROM project_deletions WHERE project_id=?').run(id)
      })
      return true
    } catch (reason) { this.fail(id, reason instanceof Error ? reason.message : String(reason)); return false }
  }
  private fail(id: string, error: string) { this.store.db.prepare("UPDATE project_deletions SET state='failed',updated_at=?,last_error=? WHERE project_id=?").run(now(), error.slice(0, 1000) || 'project cleanup failed', id) }
  private removeContained(target: string) {
    if (!existsSync(target)) return
    const base = path.dirname(target), resolvedBase = realpathSync(base), resolvedTarget = realpathSync(target)
    if (lstatSync(target).isSymbolicLink() || path.relative(resolvedBase, resolvedTarget).startsWith('..') || path.isAbsolute(path.relative(resolvedBase, resolvedTarget))) throw new Error(`Path escapes managed root: ${target}`)
    rmSync(resolvedTarget, { recursive: true, force: true })
  }
}

export function deletionRoutes(router: Router, deletion: ProjectDeletion) {
  router.add('POST', '/projects/:project/deletion/confirmation', c => deletion.confirmation(c.params.project))
  router.add('DELETE', '/projects/:project', async c => {
    let value: any = {}; if (String(c.req.headers['content-type'] ?? '').startsWith('application/json')) value = await body(c.req, Type.Object({ confirmation_token: Type.String(), actor: Type.Optional(Type.String()) }))
    const state = await deletion.request(c.params.project, value.confirmation_token ?? '', value.actor ?? 'human-ui')
    if (state === 'missing') send(c.res, null, 204); else send(c.res, { projectId: c.params.project, state }, 202)
  })
  router.add('GET', '/projects/:project/deletion', c => { const value = deletion.status(c.params.project); if (!value) send(c.res, null, 204); else return value })
  router.add('POST', '/projects/:project/deletion/runtime-cleaned', async c => { const value = await body(c.req, Type.Object({ success: Type.Boolean(), error: Type.Optional(Type.String()) })); return { projectId: c.params.project, completed: await deletion.complete(c.params.project, value.success, value.error) } })
}
