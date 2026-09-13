import { Type } from 'typebox'
import { mkdir, readdir, realpath, stat, open } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { body, queryNumber } from './http.ts'
import type { Router } from './http.ts'
import { HttpError } from './types.ts'
import type { Json } from './types.ts'
import { conversationAuditEvents, type Store } from './store.ts'
import { legacyProject } from './legacy.ts'
import { projectFgs } from './fgs.ts'

export async function workspacePath(workspaces: string, projectId: string, relative: string) {
  if (!/^proj_[0-9]+$/.test(projectId) || path.isAbsolute(relative) || /^[a-z]:/i.test(relative) || relative.includes('\0')) throw new HttpError(400, 'Invalid Workspace path')
  const base = path.resolve(workspaces), root = path.join(base, projectId)
  await mkdir(root, { recursive: true })
  const resolvedBase = await realpath(base), resolvedRoot = await realpath(root)
  const contained = (parent: string, target: string) => { const p = path.relative(parent, target); if (p === '..' || p.startsWith(`..${path.sep}`) || path.isAbsolute(p)) throw new HttpError(400, 'Path escapes Workspace') }
  contained(resolvedBase, resolvedRoot)
  const target = path.resolve(resolvedRoot, relative.replaceAll('\\', '/')); contained(resolvedRoot, target)
  try { const resolved = await realpath(target); contained(resolvedRoot, resolved); return { root: resolvedRoot, target: resolved } }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(404, 'Workspace path not found') }
}
export function auditRoutes(router: Router, store: Store, workspaceRoot: string) {
  const runs = (id?: string): Record<string, any>[] => (id ? store.db.prepare('SELECT data FROM audit_runs WHERE project_id=?').all(id) : store.db.prepare('SELECT data FROM audit_runs').all()).map(r => JSON.parse(String(r.data)))
  const usage = (id?: string) => {
    const value: Record<string, number> = { bootstrap: 0, reason: 0, explore: 0 }
    for (const run of runs(id)) value[run.task_type] = (value[run.task_type] ?? 0) + ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens'].reduce((sum, key) => sum + Number(run[key] ?? 0), 0)
    return { ...value, total: Object.values(value).reduce((a, b) => a + b, 0) }
  }
  router.add('POST', '/audit/events', async c => {
    const b = await body(c.req, Type.Object({ run: Type.Record(Type.String(), Type.Unknown()), events: Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 128 }) }))
    for (const key of ['id', 'project_id', 'task_type', 'phase', 'worker', 'provider', 'workspace_kind', 'workspace_ref', 'workspace_root', 'status', 'started_at']) if (!(key in b.run)) throw new HttpError(422, 'Incomplete audit run metadata')
    const rawUsage = b.run.usage && typeof b.run.usage === 'object' ? b.run.usage as Record<string, unknown> : b.run
    for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) { const n = Number(rawUsage[key]) || 0; b.run[key] = Number.isSafeInteger(n) && n > 0 ? n : 0 }
    return store.audit(b.run as Record<string, Json>, b.events as Record<string, Json>[])
  })
  router.add('GET', '/audit/usage', () => usage())
  router.add('GET', '/audit/tasks', () => store.projects().map(p => {
    const r = runs(p.id); return { id: p.id, title: p.title, status: p.status, created_at: p.createdAt, run_count: r.length, last_run_at: r.map(r => r.started_at).sort().at(-1) ?? null, running_count: r.filter(r => r.status === 'running').length, token_total: usage(p.id).total }
  }).sort((a, b) => String(b.last_run_at ?? b.created_at).localeCompare(String(a.last_run_at ?? a.created_at))))
  router.add('GET', '/audit/tasks/:project/usage', c => { store.project(c.params.project); return usage(c.params.project) })
  router.add('GET', '/audit/tasks/:project/runs', c => { store.project(c.params.project); return runs(c.params.project).sort((a, b) => String(b.started_at).localeCompare(a.started_at)) })
  router.add('GET', '/audit/tasks/:project/events', c => {
    store.project(c.params.project)
    return store.db.prepare('SELECT id,data FROM audit_events WHERE project_id=? AND id<? ORDER BY id DESC LIMIT ?').all(c.params.project, queryNumber(c.url, 'before_id', Number.MAX_SAFE_INTEGER), queryNumber(c.url, 'limit', 200, 1, 500))
      .flatMap(r => conversationAuditEvents({ ...JSON.parse(String(r.data)), id: Number(r.id) })).sort((a, b) => String(a.timestamp ?? '').localeCompare(String(b.timestamp ?? '')) || Number(a.run_sequence ?? 0) - Number(b.run_sequence ?? 0) || Number(a.id) - Number(b.id))
  })
  router.add('GET', '/audit/tasks/:project/stream', async c => {
    store.project(c.params.project)
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'X-Accel-Buffering': 'no' }); c.res.write(': connected\n\n')
    await new Promise<void>(resolve => {
      const emit = (id: string, event: Json) => { if (id === c.params.project && !c.res.write(`event: audit\ndata: ${JSON.stringify(event)}\n\n`)) c.res.destroy() }
      const timer = setInterval(() => c.res.write(': ping\n\n'), 15000)
      const close = () => { clearInterval(timer); store.changes.off('audit', emit); c.signal.removeEventListener('abort', close); resolve() }
      store.changes.on('audit', emit); c.signal.addEventListener('abort', close, { once: true }); if (c.signal.aborted) close()
    })
  })
  router.add('GET', '/audit/tasks/:project/workspace', async c => {
    store.project(c.params.project); const relative = c.url.searchParams.get('path') ?? '', { root, target } = await workspacePath(workspaceRoot, c.params.project, relative)
    if (!(await stat(target)).isDirectory()) throw new HttpError(404, 'Directory not found')
    const entries = await Promise.all((await readdir(target, { withFileTypes: true })).filter(d => !d.isSymbolicLink()).map(async d => { const name = path.join(target, d.name), info = await stat(name); return { name: d.name, path: path.relative(root, name).replaceAll('\\', '/'), type: d.isDirectory() ? 'directory' : 'file', size: info.size, modified_at: info.mtimeMs / 1000 } }))
    entries.sort((a, b) => Number(a.type !== 'directory') - Number(b.type !== 'directory') || a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
    return { path: relative, source: 'local', entries: entries.slice(0, 500) }
  })
  router.add('GET', '/audit/tasks/:project/workspace/file', async c => {
    store.project(c.params.project); const relative = c.url.searchParams.get('path'); if (!relative) throw new HttpError(422, 'path required')
    const { target } = await workspacePath(workspaceRoot, c.params.project, relative), file = await open(target, 'r')
    try {
      const info = await file.stat(); if (!info.isFile()) throw new HttpError(404, 'File not found'); if (info.size > 256 * 1024) throw new HttpError(413, 'File is too large to preview')
      const content = Buffer.alloc(256 * 1024 + 1), { bytesRead } = await file.read(content)
      if (bytesRead > 256 * 1024) throw new HttpError(413, 'File is too large to preview')
      const bytes = content.subarray(0, bytesRead), binary = bytes.includes(0)
      return { path: relative, size: bytesRead, modified_at: info.mtimeMs / 1000, binary, content: binary ? '' : bytes.toString('utf8') }
    } finally { await file.close() }
  })
  router.add('GET', '/projects/:project/export', c => {
    const format = c.url.searchParams.get('format') ?? 'yaml', detail = legacyProject(store, c.params.project), graph = store.graph(c.params.project)
    if (!['yaml', 'timeline'].includes(format)) throw new HttpError(400, 'Supported formats: yaml, timeline')
    const resources = (store.db.prepare('SELECT * FROM shared_resources WHERE project_id=? ORDER BY created_at').all(c.params.project) as any[]).map(row => {
      const metadata = JSON.parse(row.metadata_json), secret = JSON.parse(row.secret_json)
      return { id: row.id, kind: row.kind, name: row.name, status: row.status, target: row.target, summary: row.summary, metadata, ...(row.kind === 'credential_ref' ? { secret } : {}), worker: row.worker, intent: row.intent_id, fact: row.fact_id, parent: row.parent_resource_id, source_task: row.source_task_id, locked_by: row.locked_by ? `${row.locked_by_type}:${row.locked_by}` : null, worker_paused: !!row.worker_paused, created_at: row.created_at, updated_at: row.updated_at, last_seen_at: row.last_seen_at }
    })
    const tasks = (store.db.prepare('SELECT * FROM operation_tasks WHERE project_id=? ORDER BY created_at').all(c.params.project) as any[]).map(row => ({ id: row.id, resource: row.resource_id, intent: row.intent_id, fact: row.fact_id, action: row.action, actor: `${row.actor_type}:${row.actor}`, risk: row.risk, status: row.status, summary: row.output_summary, result_ref: row.result_ref, requires_approval: !!row.requires_approval, approved_by: row.approved_by, created_at: row.created_at, started_at: row.started_at, completed_at: row.completed_at }))
    const data: any = { project: { title: detail.project.title, origin: detail.facts.find(f => f.id === 'origin')!.description, goal: detail.facts.find(f => f.id === 'goal')!.description, bootstrap_enabled: detail.project.bootstrap_enabled }, ...(detail.hints.length ? { hints: detail.hints } : {}), facts: detail.facts, ...(detail.intents.length ? { intents: detail.intents } : {}), goals: graph.goals, findings: graph.findings, ...(resources.length ? { shared_resources: resources } : {}), ...(tasks.length ? { operation_tasks: tasks } : {}) }
    data.fgs = { ...graph, ...projectFgs(graph) }
    const output = format === 'yaml' ? stringify(data) : [
      `[${detail.project.created_at}] PROJECT CREATED\n  origin: ${data.project.origin}\n  goal: ${data.project.goal}`,
      ...detail.hints.map(h => `[${h.created_at}] HINT by ${h.creator}\n  ${h.content}`),
      ...detail.intents.flatMap(i => [`[${i.created_at}] INTENT DECLARED ${i.id} by ${i.creator}\n  from: ${i.from.join(', ')}\n  ${i.description}`, ...(i.concluded_at ? [`[${i.concluded_at}] ${i.to === 'goal' ? 'PROJECT COMPLETED' : `INTENT CONCLUDED ${i.id}`} by ${i.worker ?? i.creator}`] : [])]),
      ...(store.db.prepare('SELECT * FROM resource_audit_events WHERE project_id=? ORDER BY id').all(c.params.project) as any[]).map(e => `[${e.created_at}] RESOURCE ${e.action} ${e.status} by ${e.actor_type}:${e.actor}\n  resource: ${e.resource_id ?? '-'}${e.task_id ? `\n  task: ${e.task_id}` : ''}`),
    ].join('\n\n') + '\n'
    c.res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); c.res.end(output)
  })
}
