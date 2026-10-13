import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { activeEvidence, HttpError, integer, now, requiredText } from './types.ts'
import { verbIds } from './capability-verbs.ts'
import { validateTaskPlugins } from './task-plugins.ts'
import type { Activity, Evidence, Fact, Finding, Goal, Graph, GraphEvent, GraphNode, Input, Json, Project, Run, Step, Worker } from './types.ts'

export const ACTIVE_NODE_SQL = "COALESCE(json_extract(data,'$.deleted'),0)=0"
export interface StepUpdate { description?: string; sourceIds?: string[]; goalId?: string; priority?: number; status?: 'cancelled' | 'pending'; executionProfile?: Step['executionProfile']; requires?: string[]; plugins?: string[]; expectedVersion?: number; mode?: 'amend' | 'replace' }
export interface EvidenceChange { operation: 'merge' | 'delete'; id: string; expectedVersion: number; sourceIds?: string[]; sourceVersions?: Record<string, number>; reason: string; description?: string; title?: string; details?: Json }

// Graph events carry delivery metadata, never a second copy of graph state.
function graphEventPayload(payload: unknown): Record<string, Json> {
  if (!payload || typeof payload !== 'object') return {}
  const values = payload as Record<string, unknown>, result: Record<string, Json> = {}
  for (const key of ['runId', 'targetId', 'reason', 'mode', 'goalId', 'factSeq', 'endedSeq', 'evidenceSeq', 'hintSeq', 'criticalSeq', 'baseRevision', 'retryAfter', 'version', 'planVersion']) {
    const value = values[key]
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value as Json
  }
  return result
}

const AUDIT_CONVERSATION_KINDS = new Set([
  'system.prompt', 'user.message', 'assistant.message', 'assistant.delta',
  'thinking.message', 'thinking.delta', 'tool.started', 'tool.completed',
  'command.started', 'command.completed', 'skill.started', 'skill.completed',
  'file.changed', 'run.completed', 'error', 'stderr',
])

export function conversationAuditEvents(event: Record<string, Json>): Record<string, Json>[] {
  const data = event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data as Record<string, Json> : {}
  const message = data.message && typeof data.message === 'object' && !Array.isArray(data.message)
    ? data.message as Record<string, Json> : undefined
  if (data.type === 'message_end' && message) {
    const blocks = Array.isArray(message.content)
      ? message.content.filter((item): item is Record<string, Json> => !!item && typeof item === 'object' && !Array.isArray(item)) : []
    const text = blocks.filter(item => item.type === 'text').map(item => String(item.text ?? '')).join('')
    const thinking = blocks.filter(item => item.type === 'thinking' || item.type === 'reasoning')
      .map(item => String(item.thinking ?? item.text ?? '')).join('')
    const uid = String(event.event_uid ?? event.id ?? randomUUID())
    if (message.role === 'user') return text ? [{ ...event, event_uid: `${uid}-user`, kind: 'user.message', role: 'user', content: text }] : []
    if (message.role === 'assistant') return [
      ...(thinking ? [{ ...event, event_uid: `${uid}-thinking`, kind: 'thinking.message', content: thinking }] : []),
      ...(text ? [{ ...event, event_uid: `${uid}-text`, kind: 'assistant.message', role: 'assistant', content: text }] : []),
    ]
    return []
  }
  const kind = String(event.kind ?? '')
  if (!AUDIT_CONVERSATION_KINDS.has(kind)) return []
  const content = event.content ?? data.content
  if (['system.prompt', 'user.message', 'assistant.message', 'assistant.delta', 'thinking.message', 'thinking.delta'].includes(kind) && !content) return []
  return content === event.content ? [event] : [{ ...event, content }]
}

export function redactSensitive(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitive)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (/^(?:authorization|cookie|set-cookie|password|passwd|secret|token|api[_-]?key|flag|requestBody|responseBody|(?:request|response)?BodyBase64)$/i.test(key)) return [key, '[REDACTED]']
    if (['content', 'text', 'arguments'].includes(key) && typeof item === 'string') {
      try {
        const parsed = JSON.parse(item), redacted = redactSensitive(parsed)
        return [key, JSON.stringify(parsed) === JSON.stringify(redacted) ? item : JSON.stringify(redacted)]
      } catch {
        return [key, item.replace(/("?(?:authorization|cookie|set-cookie|password|secret|token|api[_-]?key|flag)"?\s*[:=]\s*")[^"]*(")/ig, '$1[REDACTED]$2')]
      }
    }
    if (['url', 'location'].includes(key.toLowerCase()) && typeof item === 'string') {
      try {
        const url = new URL(item, 'http://redtrace.invalid')
        for (const param of [...url.searchParams.keys()]) if (/^(?:auth(?:orization)?|cookie|csrf|key|password|secret|session|token|api[_-]?key|code)$/i.test(param)) url.searchParams.set(param, '[REDACTED]')
        return [key, url.origin === 'http://redtrace.invalid' ? `${url.pathname}${url.search}${url.hash}` : url.toString()]
      } catch {}
    }
    return [key, redactSensitive(item)]
  }))
}

export class Store {
  readonly db: DatabaseSync
  readonly changes = new EventEmitter()
  private depth = 0
  private pending = new Set<string>()
  private pendingSteps = new Set<string>()
  private notifications = new Set<string>()
  private stepNotifications = new Set<string>()
  private notificationScheduled = false
  private pendingAudit: { projectId: string; data: Json }[] = []
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.db = new DatabaseSync(filename, { timeout: 5000 })
    const tables = Number((this.db.prepare("SELECT COUNT(*) AS value FROM sqlite_master WHERE type='table'").get() as { value: number }).value)
    if (tables) {
      const metadata = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='metadata'").get()
      const version = metadata ? this.db.prepare('SELECT value FROM metadata WHERE key=?').get('schema') as { value: string } | undefined : undefined
      if (version?.value !== '2') { this.db.close(); throw new Error(`Unsupported engine schema ${version?.value ?? 'unknown'}; remove the old engine database before starting RedTrace`) }
    }
    const importCriticalKeys=!this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='critical_keys'").get()
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE INDEX IF NOT EXISTS nodes_project_kind ON nodes(project_id,kind);
      CREATE INDEX IF NOT EXISTS nodes_active ON nodes(project_id,kind) WHERE COALESCE(json_extract(data,'$.deleted'),0)=0;
      CREATE TABLE IF NOT EXISTS counters(scope TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(scope,kind));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        type TEXT NOT NULL, node_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,id);
      CREATE INDEX IF NOT EXISTS events_step ON events(project_id,node_id,id);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        step_id TEXT, activity TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_step ON runs(project_id,step_id) WHERE status IN ('running','paused');
      CREATE UNIQUE INDEX IF NOT EXISTS one_decider ON runs(project_id) WHERE activity='decide' AND status='running';
      CREATE INDEX IF NOT EXISTS runs_status_project ON runs(status,project_id,step_id);
      CREATE INDEX IF NOT EXISTS runs_project_step ON runs(project_id,step_id);
      CREATE TABLE IF NOT EXISTS run_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_runs_project ON audit_runs(project_id);
      CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, event_uid TEXT UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_events_project ON audit_events(project_id,id);
      CREATE TABLE IF NOT EXISTS critical_keys(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,key TEXT NOT NULL,PRIMARY KEY(project_id,key));
      CREATE TABLE IF NOT EXISTS channel_versions(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,channel TEXT NOT NULL,hash TEXT NOT NULL,PRIMARY KEY(project_id,channel));
      CREATE TABLE IF NOT EXISTS attempt_ledger(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,signature TEXT NOT NULL,count INTEGER NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(project_id,signature));
      CREATE TABLE IF NOT EXISTS run_metrics(run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,call_id TEXT NOT NULL,kind TEXT NOT NULL,started INTEGER NOT NULL,ended INTEGER,PRIMARY KEY(run_id,call_id));
    `)
    if(importCriticalKeys) for(const row of this.db.prepare('SELECT id,data FROM projects').all()){const project=JSON.parse(String(row.data));for(const key of project.criticalSignals ?? [])this.db.prepare('INSERT OR IGNORE INTO critical_keys VALUES (?,?)').run(String(row.id),String(key))}
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('schema', '2')
    // Only disposable duplicate indexes are retired; raw audit and Run events stay intact.
    this.db.exec('DROP TABLE IF EXISTS trace_fts; DROP TABLE IF EXISTS trace_audit_fts; DROP TABLE IF EXISTS trace_cursors')
    // Counters of deleted projects would otherwise linger forever and are never read again.
    this.db.prepare('DELETE FROM counters WHERE scope NOT IN (SELECT id FROM projects)').run()
    try { this.migrateCurrentFgs(); this.migrateNativeTerminal() } catch (error) { this.db.close(); throw error }
    this.changes.setMaxListeners(0)
  }
  private migrateCurrentFgs() {
    if (this.db.prepare('SELECT value FROM metadata WHERE key=?').get('fgs-current-only')) return
    this.transaction(() => {
      for (const project of this.projects()) {
        type LegacyNode = GraphNode & { lifecycle?: string; mergedInto?: string; mergedFromIds?: string[]; sourceDetails?: unknown; deleted?: boolean }
        const nodes = new Map<string, LegacyNode>(this.db.prepare('SELECT data FROM nodes WHERE project_id=?').all(project.id).map(row => { const node = JSON.parse(String(row.data)) as LegacyNode; return [node.id, node] }))
        const removed = new Set([...nodes.values()].filter(n => ['fact', 'finding'].includes(n.kind) && (n.deleted || n.lifecycle && n.lifecycle !== 'active')).map(n => n.id))
        if (removed.has('origin')) throw new Error(`FGS migration ${project.id}/origin: Scope cannot be removed`)
        const redirects = new Map<string, string>()
        for (const id of removed) {
          const source = nodes.get(id)!
          if (source.lifecycle !== 'merged') continue
          const seen = new Set<string>([id]); let target = source
          while (target.lifecycle === 'merged') {
            const next = target.mergedInto
            if (!next || seen.has(next) || !nodes.has(next)) throw new Error(`FGS migration ${project.id}/${id}: invalid merge chain`)
            seen.add(next); target = nodes.get(next)!
          }
          if (target.kind !== source.kind || target.id === 'origin') throw new Error(`FGS migration ${project.id}/${id}: merge target must be evidence of the same kind`)
          redirects.set(id, target.id)
        }
        for (const node of nodes.values()) {
          if (removed.has(node.id)) continue
          const fields = node.kind === 'step' ? ['sourceIds', 'factIds'] : node.kind === 'goal' ? ['evidenceIds'] : node.kind === 'finding' ? ['factIds'] : []
          let contractChanged = false, changed = false
          for (const field of fields) {
            const refs = (node as unknown as Record<string, string[]>)[field]
            const required = node.kind === 'step' ? field === 'sourceIds' && !node.deleted && !['done', 'cancelled'].includes(node.status) : node.kind === 'goal' ? node.status === 'achieved' : !node.deleted
            const next: string[] = []
            for (const ref of refs) {
              const target = redirects.get(ref) ?? ref
              if (removed.has(target) || !nodes.has(target)) {
                if (required) throw new Error(`FGS migration ${project.id}/${node.id}: active ${field} reference ${ref} would be lost`)
                continue
              }
              if (!next.includes(target)) next.push(target)
            }
            if (JSON.stringify(next) !== JSON.stringify(refs)) {
              (node as unknown as Record<string, string[]>)[field] = next; changed = true
              contractChanged ||= required && node.kind === 'step'
            }
          }
          if (changed) node.version = (node.version ?? 1) + 1
          if (contractChanged && node.kind === 'step') node.planVersion = (node.planVersion ?? 1) + 1
          delete node.lifecycle; delete node.mergedInto; delete node.mergedFromIds; delete node.sourceDetails
          this.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify(node), project.id, node.id)
        }
        for (const id of removed) this.db.prepare('DELETE FROM nodes WHERE project_id=? AND id=?').run(project.id, id)
      }
      for (const row of this.db.prepare('SELECT id,data FROM events').iterate()) {
        this.db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify(graphEventPayload(JSON.parse(String(row.data)))), row.id)
      }
      this.db.exec(`DROP INDEX IF EXISTS nodes_active; CREATE INDEX nodes_active ON nodes(project_id,kind) WHERE ${ACTIVE_NODE_SQL}`)
      this.db.prepare('INSERT INTO metadata VALUES (?,?)').run('fgs-current-only', '1')
    })
  }
  private migrateNativeTerminal() {
    this.transaction(() => {
      for (const row of this.db.prepare(`SELECT data FROM nodes WHERE kind='step' AND ${ACTIVE_NODE_SQL} AND json_extract(data,'$.status') NOT IN ('done','cancelled')`).all()) {
        const step = JSON.parse(String(row.data)) as Step
        const requires = step.requires.filter(verb => !verb.startsWith('remote.terminal.'))
        if (requires.length === step.requires.length) continue
        step.requires = requires; step.planVersion = (step.planVersion ?? 1) + 1
        this.saveNode(step)
        this.event(step.projectId, 'step.revised', step, { reason: 'Interactive terminals now use DSH Terminal; removed remote.terminal.* requirements' })
      }
    })
  }
  close() { this.notifications.clear(); this.stepNotifications.clear(); this.changes.removeAllListeners(); this.db.close() }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    let result: T
    try {
      result = fn()
      if (result instanceof Promise) throw new Error('SQLite transactions must be synchronous')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); this.pending.clear(); this.pendingSteps.clear(); this.pendingAudit = []; throw error }
    finally { this.depth-- }
    for (const id of this.pending) this.notifications.add(id)
    for (const key of this.pendingSteps) this.stepNotifications.add(key)
    this.pending.clear(); this.pendingSteps.clear()
    // Coalesce committed changes in the same turn; rollbacks never publish Step notices.
    if (!this.notificationScheduled && (this.notifications.size || this.stepNotifications.size)) {
      this.notificationScheduled = true
      queueMicrotask(() => {
        const projects = [...this.notifications], steps = [...this.stepNotifications]
        this.notifications.clear(); this.stepNotifications.clear(); this.notificationScheduled = false
        for (const id of projects) this.changes.emit('change', id)
        for (const key of steps) this.changes.emit(key)
      })
    }
    const audit = this.pendingAudit; this.pendingAudit = []
    for (const entry of audit) queueMicrotask(() => this.changes.emit('audit', entry.projectId, entry.data))
    return result!
  }
  private next(scope: string, kind: string, prefix: string) {
    const row = this.db.prepare(`INSERT INTO counters VALUES (?,?,1) ON CONFLICT(scope,kind)
      DO UPDATE SET value=value+1 RETURNING value`).get(scope, kind) as { value: number }
    return prefix + String(row.value).padStart(3, '0')
  }
  // Project ids stay dense: the smallest unused number is picked, so deleting a project
  // releases its number for reuse instead of advancing a global counter.
  private nextProjectId(): string {
    const used = new Set((this.db.prepare('SELECT id FROM projects').all() as { id: string }[])
      .map(row => row.id.startsWith('proj_') ? Number.parseInt(row.id.slice(5), 10) : Number.NaN)
      .filter(Number.isSafeInteger))
    let n = 1
    while (used.has(n)) n++
    return `proj_${String(n).padStart(3, '0')}`
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id) as { data: string } | undefined
    if (!row) throw new HttpError(404, 'Project not found')
    const project = JSON.parse(row.data) as Project
    project.evidenceSeq ??= project.factSeq
    project.acknowledgedEvidenceSeq ??= project.acknowledgedFactSeq
    project.hintSeq ??= Number(this.db.prepare("SELECT COUNT(*) AS value FROM events WHERE project_id=? AND type IN ('hint.added','hint.deleted')").get(id)?.value ?? 0)
    project.acknowledgedHintSeq ??= 0
    return project
  }
  projects(): Project[] { return (this.db.prepare('SELECT data FROM projects ORDER BY id').all() as { data: string }[]).map(r => JSON.parse(r.data)) }
  setBenchmarkHosts(id: string, challenge: string, hosts?: string[]) {
    return this.transaction(() => {
      const project = this.writable(id)
      project.benchmarkHosts = { ...project.benchmarkHosts }
      if (hosts) project.benchmarkHosts[challenge] = hosts
      else delete project.benchmarkHosts[challenge]
      this.saveProject(project)
    })
  }
  private saveProject(p: Project) { this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(p), p.id) }
  node<T extends GraphNode = GraphNode>(projectId: string, id: string, kind?: T['kind']): T {
    this.project(projectId)
    const row = this.db.prepare('SELECT data FROM nodes WHERE project_id=? AND id=?').get(projectId, id) as { data: string } | undefined
    if (!row) throw new HttpError(404, 'Node not found')
    const value = { version: 1, ...JSON.parse(row.data) } as T
    if (kind && value.kind !== kind) throw new HttpError(404, `${kind} not found`)
    return value
  }
  nodes<T extends GraphNode = GraphNode>(projectId: string, kinds: T['kind'][], page?: { offset?: number; limit?: number }): T[] {
    this.project(projectId)
    if (!kinds.length) return []
    const placeholders = kinds.map(() => '?').join(',')
    const offset = integer(page?.offset ?? 0, 'node offset'), limit = page?.limit === undefined ? undefined : integer(page.limit, 'node limit', 1)
    const sql = `SELECT data FROM nodes WHERE project_id=? AND kind IN (${placeholders}) AND ${ACTIVE_NODE_SQL} ORDER BY rowid${limit === undefined ? '' : ' LIMIT ? OFFSET ?'}`
    return (this.db.prepare(sql).all(...(limit === undefined ? [projectId, ...kinds] : [projectId, ...kinds, limit, offset])) as { data: string }[])
      .map(row => ({ version: 1, ...JSON.parse(row.data) }))
  }
  nodeCount(projectId: string, kind: GraphNode['kind']): number {
    this.project(projectId)
    return Number((this.db.prepare(`SELECT COUNT(*) AS value FROM nodes WHERE project_id=? AND kind=? AND ${ACTIVE_NODE_SQL}`).get(projectId, kind) as { value: number }).value)
  }
  private saveNode(node: GraphNode) {
    const prior = this.db.prepare('SELECT data FROM nodes WHERE project_id=? AND id=?').get(node.projectId, node.id)
    node.version = prior ? (JSON.parse(String(prior.data)).version ?? 1) + 1 : 1
    this.db.prepare('INSERT INTO nodes VALUES (?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data')
      .run(node.projectId, node.id, node.kind, JSON.stringify(node))
  }
  graph(id: string): Graph {
    const project = this.project(id)
    const all: GraphNode[] = (this.db.prepare(`SELECT data FROM nodes WHERE project_id=? AND ${ACTIVE_NODE_SQL} ORDER BY rowid`).all(id) as { data: string }[]).map(r => JSON.parse(r.data))
    return { project, facts: all.filter((n): n is Fact => n.kind === 'fact'), goals: all.filter((n): n is Goal => n.kind === 'goal'),
      steps: all.filter((n): n is Step => n.kind === 'step'), findings: all.filter((n): n is Finding => n.kind === 'finding'),
      hints: all.filter((n): n is Input => n.kind === 'hint' && !n.deleted), observations: all.filter((n): n is Input => n.kind === 'observation' && !n.deleted) }
  }
  private event(id: string, type: string, node: GraphNode | null, payload: unknown) {
    const planning = ['project.created', 'fact.added', 'execute.succeeded', 'execute.failed', 'project.active', 'project.reopened'].includes(type)
    const p = this.project(id); p.revision++; if (planning) p.planningRevision++
    if (type === 'fact.added') p.factSeq++
    if (type === 'fact.added' || type === 'finding.added') p.evidenceSeq = (p.evidenceSeq ?? 0) + 1
    if (type === 'hint.added' || type === 'hint.deleted') p.hintSeq = (p.hintSeq ?? 0) + 1
    if ((type === 'execute.succeeded' || type === 'execute.failed') && node?.kind === 'step' && node.status !== 'cancelled') p.endedSeq++
    this.saveProject(p)
    this.db.prepare('INSERT INTO events(project_id,revision,type,node_id,data,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, p.revision, type, node?.id ?? null, JSON.stringify(graphEventPayload(node ? { ...graphEventPayload(payload), evidenceSeq: p.evidenceSeq, hintSeq: p.hintSeq ?? 0, version: node.version, ...('planVersion' in node ? { planVersion: node.planVersion } : {}) } : payload)), now())
    this.pending.add(id)
    if (node?.kind === 'step') this.pendingSteps.add(`step:${id}:${node.id}`)
  }
  events(projectId: string, after = 0, limit = 500, stepId?: string): GraphEvent[] {
    this.project(projectId)
    const rows = stepId === undefined
      ? this.db.prepare('SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(projectId, after, limit)
      : this.db.prepare('SELECT * FROM events WHERE project_id=? AND node_id=? AND id>? ORDER BY id LIMIT ?').all(projectId, stepId, after, limit)
    return rows.map((row) => ({
      id: Number(row.id), projectId, revision: Number(row.revision), type: String(row.type), nodeId: row.node_id as string | null,
      payload: JSON.parse(String(row.data)), createdAt: String(row.created_at),
    }))
  }
  private writable(id: string) {
    const p = this.project(id)
    if (!['active', 'stopped'].includes(p.status)) throw new HttpError(409, 'Project is not writable')
    return p
  }
  private hintWritable(id: string) { const p = this.project(id); if (p.status === 'deleting') throw new HttpError(403, 'Project is deleting'); return p }
  private active(id: string) { const p = this.writable(id); if (p.status !== 'active') throw new HttpError(409, 'Project is stopped'); return p }
  private factIds(id: string, values: unknown, allowEmpty = true): string[] {
    if (!Array.isArray(values) || (!allowEmpty && !values.length)) throw new HttpError(422, 'Fact references must be an array')
    const ids = values.map(v => requiredText(v, 'fact id'))
    if (new Set(ids).size !== ids.length) throw new HttpError(422, 'Duplicate fact references')
    if (ids.includes('origin')) throw new HttpError(422, 'Scope is not a supporting Fact')
    for (const fid of ids) if (!activeEvidence(this.node<Fact>(id, fid, 'fact'))) throw new HttpError(404, 'Fact not found')
    return ids
  }
  private evidenceIds(id: string, values: unknown, allowScope = false): string[] {
    if (!Array.isArray(values) || !values.length) throw new HttpError(422, 'Evidence references must be a non-empty array')
    const ids = values.map(v => requiredText(v, 'evidence id'))
    if (new Set(ids).size !== ids.length) throw new HttpError(422, 'Duplicate evidence references')
    for (const ref of ids) {
      const node = this.node(id, ref)
      if ((node.kind !== 'fact' && node.kind !== 'finding') || !activeEvidence(node) || (!allowScope && ref === 'origin')) throw new HttpError(422, 'Expected a confirmed Fact or Finding in this project')
    }
    return ids
  }
  createProject(input: { title: string; origin: string; goal: string; bootstrap?: boolean; hints?: {content: string; creator: string}[] }): Graph {
    return this.transaction(() => {
      const title = requiredText(input.title, 'title'), origin = requiredText(input.origin, 'origin'), goal = requiredText(input.goal, 'goal')
      const id = this.nextProjectId(), createdAt = now()
      const p: Project = { id, title, status: 'active', bootstrap: input.bootstrap ?? false, createdAt, revision: 0, planningRevision: 0, decidedRevision: 0, retryAfter: 0,
        factSeq: 0, endedSeq: 0, acknowledgedFactSeq: 0, acknowledgedEndedSeq: 0, evidenceSeq: 0, acknowledgedEvidenceSeq: 0, hintSeq: 0, acknowledgedHintSeq: 0, initialPlanningPending: true, planningRetryPending: false }
      this.db.prepare('INSERT INTO projects VALUES (?,?)').run(id, JSON.stringify(p))
      this.saveNode({ id: 'origin', projectId: id, kind: 'fact', description: origin, creator: 'human', createdAt, stepId: null, evidence: [] })
      this.saveNode({ id: 'goal', projectId: id, kind: 'goal', description: goal, creator: 'human', createdAt, parentId: null, status: 'open', evidenceIds: [] })
      this.event(id, 'project.created', null, {})
      for (const hint of input.hints ?? []) this.addInput(id, 'hint', hint.content, hint.creator)
      if (p.bootstrap) this.addStep(id, { description: goal, sourceIds: ['origin'], goalId: 'goal', creator: 'bootstrap', bootstrap: true })
      return this.graph(id)
    })
  }
  rename(id: string, title: string) { return this.transaction(() => { const p = this.writable(id); p.title = requiredText(title, 'title'); this.saveProject(p); this.event(id, 'project.renamed', null, p); return this.project(id) }) }
  setStatus(id: string, status: 'active' | 'stopped') {
    return this.transaction(() => {
      if (!['active', 'stopped'].includes(status)) throw new HttpError(422, 'Invalid project status')
      const p = this.writable(id); if (p.status === status) return p
      p.status = status; this.saveProject(p); this.event(id, `project.${status}`, null, p); return this.project(id)
    })
  }
  markDeleting(id: string) { return this.transaction(() => { const p = this.project(id); p.status = 'deleting'; this.saveProject(p); this.event(id, 'project.deleting', null, p); return p }) }
  addInput(id: string, kind: 'hint' | 'observation', content: string, creator = 'human', stepId: string | null = null): Input {
    return this.transaction(() => {
      this.hintWritable(id); if (stepId) this.node<Step>(id, stepId, 'step')
      const node: Input = { id: this.next(id, kind, kind === 'hint' ? 'h' : 'o'), projectId: id, kind, content: requiredText(content, 'content'), creator: requiredText(creator, 'creator'), stepId, deleted: false, createdAt: now() }
      this.saveNode(node); this.event(id, `${kind}.added`, node, node); return node
    })
  }
  deleteInput(id: string, nodeId: string) { this.transaction(() => { this.hintWritable(id); const node = this.node<Input>(id, nodeId, 'hint'); if (node.deleted) throw new HttpError(404, 'Hint not found'); node.deleted = true; this.saveNode(node); this.event(id, 'hint.deleted', node, node) }) }
  addGoal(id: string, description: string, parentId = 'goal', creator = 'decide'): Goal {
    return this.transaction(() => {
      this.writable(id); const parent = this.node<Goal>(id, parentId, 'goal'); if (parent.status !== 'open') throw new HttpError(409, 'Parent goal is closed')
      const node: Goal = { id: this.next(id, 'goal', 'g'), projectId: id, kind: 'goal', description: requiredText(description, 'description'), parentId, creator, status: 'open', evidenceIds: [], createdAt: now() }
      this.saveNode(node); this.event(id, 'goal.added', node, node); return node
    })
  }
  updateGoal(id: string, goalId: string, input: { description?: string; status?: Goal['status']; evidenceIds?: string[]; expectedVersion?: number; mode?: 'amend' | 'replace' }): Goal {
    return this.transaction(() => {
      this.writable(id); const goal = this.node<Goal>(id, goalId, 'goal')
      if (input.mode !== undefined && !['amend', 'replace'].includes(input.mode)) throw new HttpError(422, 'Invalid revision mode')
      this.checkVersion(goal, input.expectedVersion)
      const descriptionChanged = input.description !== undefined && input.description.trim() !== goal.description
      if (descriptionChanged && goal.id === 'goal') throw new HttpError(409, 'Root goal description is immutable')
      if (descriptionChanged) {
        const goals = this.nodes<Goal>(id, ['goal']), descendants = new Set([goal.id])
        for (const parent of descendants) for (const child of goals) if (child.parentId === parent) descendants.add(child.id)
        for (const step of this.nodes<Step>(id, ['step']).filter(s => descendants.has(s.goalId) && !['done', 'cancelled'].includes(s.status))) {
          if (step.attempts && (!input.mode || input.expectedVersion === undefined)) throw new HttpError(409, 'Claimed Subgoal edits require mode and expectedVersion')
          if (input.mode === 'replace' && step.attempts) this.updateStep(id, step.id, { description: step.description, expectedVersion: step.version, mode: 'replace' })
          else { step.planVersion = (step.planVersion ?? 1) + 1; this.saveNode(step); this.event(id, 'step.revised', step, { goalId, mode: input.mode ?? 'amend' }) }
        }
      }
      if (input.description !== undefined) goal.description = requiredText(input.description, 'description')
      if (input.status !== undefined) {
        if (!['open', 'achieved', 'cancelled'].includes(input.status)) throw new HttpError(422, 'Invalid goal status')
        if (goal.id === 'goal' && input.status === 'cancelled') throw new HttpError(409, 'Root goal cannot be deleted')
        if (input.status === 'open') {
          // addGoal only checks the direct parent; reopening must keep the whole ancestor chain open,
          // otherwise an open subgoal under a closed parent becomes an unfinishable orphan branch.
          let ancestorId = goal.parentId
          while (ancestorId) {
            const ancestor = this.node<Goal>(id, ancestorId, 'goal')
            if (ancestor.status !== 'open') throw new HttpError(409, 'Parent goal is closed')
            ancestorId = ancestor.parentId
          }
        }
        goal.status = input.status
      }
      if (input.evidenceIds !== undefined) {
        if (!Array.isArray(input.evidenceIds)) throw new HttpError(422, 'Evidence references must be an array')
        goal.evidenceIds = input.evidenceIds.length ? this.evidenceIds(id, input.evidenceIds) : []
      }
      if (goal.status === 'achieved') {
        if (!goal.evidenceIds.length) throw new HttpError(422, 'Goal completion requires evidence')
        goal.evidenceIds = this.evidenceIds(id, goal.evidenceIds)
      }
      this.saveNode(goal); this.event(id, 'goal.updated', goal, goal)
      if (goal.status !== 'open') {
        // Closing a goal closes its open descendants: a cancelled parent is abandoned, and an
        // achieved parent makes its remaining subgoals moot. This keeps the invariant that an
        // open goal always has an open ancestor chain, so claim and dispatch only need to
        // check the directly attached goal.
        const descendants = new Set([goal.id]), graph = this.graph(id)
        for (const parentId of descendants) for (const child of graph.goals.filter(g => g.parentId === parentId)) {
          descendants.add(child.id)
          if (child.status === 'open') { child.status = 'cancelled'; this.saveNode(child); this.event(id, 'goal.updated', child, child) }
        }
        for (const step of graph.steps.filter(s => descendants.has(s.goalId) && !['done', 'cancelled'].includes(s.status))) this.updateStep(id, step.id, { status: 'cancelled' })
      }
      if (goal.id === 'goal' && goal.status === 'achieved') {
        const p = this.project(id); p.status = 'completed'; this.saveProject(p); this.event(id, 'project.completed', goal, goal)
      }
      return goal
    })
  }
  addStep(id: string, input: { description: string; sourceIds: string[]; goalId?: string; creator?: string; priority?: number; executionProfile?: Step['executionProfile']; requires?: string[]; plugins?: string[]; bootstrap?: boolean }, maxSteps: number | null = null): Step {
    return this.transaction(() => {
      this.writable(id)
      if (maxSteps !== null && this.graph(id).steps.filter(s => ['pending', 'running', 'paused'].includes(s.status)).length >= maxSteps) throw new HttpError(409, 'Active Step limit reached')
      const goalId = input.goalId ?? 'goal'; if (this.node<Goal>(id, goalId, 'goal').status !== 'open') throw new HttpError(409, 'Goal is closed')
      const profile = input.executionProfile ?? 'direct'; if (!['direct', 'isolated'].includes(profile)) throw new HttpError(422, 'Invalid execution profile')
      const requires = input.requires ?? []
      const plugins = validateTaskPlugins(input.plugins === undefined ? [] : input.plugins)
      if (!Array.isArray(requires) || requires.some(x => typeof x !== 'string' || x.length > 64) || requires.length > 16 || new Set(requires).size !== requires.length) throw new HttpError(422, 'Invalid requires')
      if (requires.some(verb => !verbIds.includes(verb))) throw new HttpError(422, `Unknown capability verb; valid: ${verbIds.join(', ')}`)
      const step: Step = { id: this.next(id, 'step', 'i'), projectId: id, kind: 'step', description: requiredText(input.description, 'description'),
        sourceIds: this.evidenceIds(id, input.sourceIds, true), goalId, creator: input.creator ?? 'decide', priority: integer(input.priority ?? 0, 'priority', -2147483648),
        status: 'pending', factIds: [], worker: null, executionProfile: profile, requires, attempts: 0,
        endedAt: null, failure: null, createdAt: now(), bootstrap: input.bootstrap ?? false, planVersion: 1, ...(plugins.length ? { plugins } : {}) }
      this.saveNode(step); this.event(id, 'step.added', step, step); return step
    })
  }
  private checkVersion(node: GraphNode, expected?: number) {
    if (expected !== undefined && integer(expected, 'expectedVersion', 1) !== (node.version ?? 1)) throw new HttpError(409, 'Node version conflict', { current: node })
  }
  updateStep(id: string, stepId: string, input: StepUpdate): Step {
    return this.transaction(() => {
      this.writable(id); const step = this.node<Step>(id, stepId, 'step')
      this.checkVersion(step, input.expectedVersion)
      if (step.status === 'done' || step.deleted) throw new HttpError(409, 'Step is already completed or deleted')
      const definition = input.description !== undefined || input.sourceIds !== undefined || input.goalId !== undefined || input.executionProfile !== undefined || input.requires !== undefined || input.plugins !== undefined
      if (input.mode !== undefined && !['amend', 'replace'].includes(input.mode)) throw new HttpError(422, 'Invalid revision mode')
      if (definition && step.attempts && (!input.mode || input.expectedVersion === undefined)) throw new HttpError(409, 'Claimed Step edits require mode and expectedVersion')
      if (definition && step.status === 'cancelled') throw new HttpError(409, 'Cancelled Step definition is immutable')
      const next = { ...step }
      if (input.description !== undefined) next.description = requiredText(input.description, 'description')
      if (input.sourceIds !== undefined) next.sourceIds = this.evidenceIds(id, input.sourceIds, true)
      if (input.goalId !== undefined) {
        if (this.node<Goal>(id, input.goalId, 'goal').status !== 'open') throw new HttpError(409, 'Goal is closed')
        next.goalId = input.goalId
      }
      if (input.executionProfile !== undefined) {
        if (!['direct', 'isolated'].includes(input.executionProfile)) throw new HttpError(422, 'Invalid execution profile')
        next.executionProfile = input.executionProfile
      }
      if (input.requires !== undefined) {
        if (!Array.isArray(input.requires) || input.requires.length > 16 || new Set(input.requires).size !== input.requires.length || input.requires.some(v => !verbIds.includes(v))) throw new HttpError(422, 'Invalid requires capability verbs')
        next.requires = input.requires
      }
      if (input.plugins !== undefined) {
        const plugins = validateTaskPlugins(input.plugins)
        if (plugins.length) next.plugins = plugins
        else delete next.plugins
      }
      if (step.attempts && input.mode === 'amend' && (next.goalId !== step.goalId || next.executionProfile !== step.executionProfile || JSON.stringify(next.requires) !== JSON.stringify(step.requires) || JSON.stringify(next.plugins ?? []) !== JSON.stringify(step.plugins ?? []))) throw new HttpError(409, 'Goal and execution permission changes require replace')
      if (input.priority !== undefined) next.priority = integer(input.priority, 'priority', -2147483648)
      if (definition && step.attempts && input.mode === 'replace') {
        if (step.bootstrap) throw new HttpError(409, 'Bootstrap cannot be replaced by a planning edit')
        if (input.status !== undefined) throw new HttpError(422, 'Replacement cannot include status')
        const replacement = this.addStep(id, { description: next.description, sourceIds: next.sourceIds, goalId: next.goalId, priority: next.priority, requires: next.requires, plugins: next.plugins, executionProfile: next.executionProfile, creator: step.creator })
        replacement.replaces = step.id; replacement.replacementPending = true; replacement.status = 'blocked'
        step.status = 'cancelled'; step.replacedBy = replacement.id; step.endedAt = now()
        this.saveNode(step); this.event(id, 'step.updated', step, step)
        this.saveNode(replacement); this.event(id, 'step.replacement', replacement, replacement)
        const prior = this.latestRun(id, step.id)
        if (prior?.status === 'paused') {
          prior.status = prior.pendingTools.length ? 'unknown' : 'cancelled'
          prior.endedAt = now(); this.saveRun(prior)
          this.event(id, `execute.${prior.status}`, step, { runId: prior.id, reason: 'Paused Step replaced' })
        }
        if (!prior || !['running', 'paused', 'unknown'].includes(prior.status)) this.releaseReplacement(step)
        return this.node<Step>(id, replacement.id, 'step')
      }
      if (input.status !== undefined) {
        if (!['cancelled', 'pending'].includes(input.status)) throw new HttpError(422, 'Invalid Step transition')
        if (input.status === 'pending' && (!['blocked', 'cancelled'].includes(step.status) || step.replacementPending)) throw new HttpError(409, 'Step cannot be retried before stop confirmation')
        if (input.status === 'pending' && this.latestRun(id, step.id)?.status === 'unknown') throw new HttpError(409, 'Unconfirmed results must be resolved before retry')
        next.status = input.status; next.endedAt = input.status === 'cancelled' ? now() : null
      }
      if (definition) next.planVersion = (step.planVersion ?? 1) + 1
      this.saveNode(next); this.event(id, definition ? 'step.revised' : 'step.updated', next, next); return next
    })
  }
  private releaseReplacement(step: Step) {
    if (!step.replacedBy) return
    const replacement = this.node<Step>(step.projectId, step.replacedBy, 'step')
    if (!replacement.replacementPending || replacement.status === 'cancelled') return
    replacement.replacementPending = false; replacement.status = 'pending'
    this.saveNode(replacement); this.event(step.projectId, 'step.updated', replacement, replacement)
  }
  resolveUnknown(runId: string, resolution: string) {
    return this.transaction(() => {
      const run = this.run(runId); this.writable(run.projectId)
      if (run.status !== 'unknown') throw new HttpError(409, 'Run is not unknown')
      requiredText(resolution, 'resolution')
      run.status = 'cancelled'; run.pendingTools = []; run.error = resolution; this.saveRun(run)
      this.event(run.projectId, 'execute.resolved', null, { runId, resolution })
      if (run.stepId) this.releaseReplacement(this.node<Step>(run.projectId, run.stepId, 'step'))
      return run
    })
  }
  syncStep(runId: string, planVersion: number) {
    return this.transaction(() => {
      const run = this.run(runId)
      if (run.status !== 'running' || !run.stepId || run.activity !== 'execute') throw new HttpError(409, 'Execute is not running')
      const step = this.node<Step>(run.projectId, run.stepId, 'step')
      if (step.status !== 'running') throw new HttpError(409, 'Step has stopped')
      if (integer(planVersion, 'planVersion', 1) !== (step.planVersion ?? 1)) throw new HttpError(409, 'Plan version conflict', { current: step })
      const goals: Goal[] = []; let goalId: string | null = step.goalId
      while (goalId) { const goal: Goal = this.node(run.projectId, goalId, 'goal'); if (goal.status !== 'open') throw new HttpError(409, 'Step goal is closed'); goals.push(goal); goalId = goal.parentId }
      this.evidenceIds(run.projectId, step.sourceIds, true)
      run.boundStepVersion = step.planVersion ?? 1; this.saveRun(run)
      return { step, goals, dependencies: step.sourceIds.map(id => this.node(run.projectId, id)) }
    })
  }
  acknowledgeEvidence(runId: string, through: number) {
    this.transaction(() => {
      const run = this.run(runId)
      if (run.status !== 'running' || run.activity !== 'decide') throw new HttpError(409, 'Decide is not running')
      const value = integer(through, 'throughEvidenceSeq')
      if (value < (run.planningEvidenceSeq ?? 0) || value > (run.deliveredEvidenceSeq ?? run.planningEvidenceSeq ?? 0)) throw new HttpError(422, 'Acknowledgement must be within the delivered evidence boundary')
      run.processedEvidenceSeq = value; this.saveRun(run)
    })
  }
  acknowledgeHint(runId: string, through: number) {
    this.transaction(() => {
      const run = this.run(runId)
      if (run.status !== 'running' || run.activity !== 'decide') throw new HttpError(409, 'Decide is not running')
      const value = integer(through, 'throughHintSeq')
      if (value < Math.max(run.planningHintSeq ?? 0, run.processedHintSeq ?? 0) || value > (run.deliveredHintSeq ?? run.planningHintSeq ?? 0)) throw new HttpError(422, 'Acknowledgement must be within the delivered Hint boundary')
      run.processedHintSeq = value; this.saveRun(run)
    })
  }
  graphDelta(projectId: string, after = 0, limit = 100, runId?: string) {
    const events = this.events(projectId, integer(after, 'after'), Math.min(100, integer(limit, 'limit', 1)))
    const cursor = events.at(-1)?.id ?? after
    const changed = [...new Set(events.map(e => e.nodeId).filter((id): id is string => id !== null))]
    const evidenceSeq = events.reduce((seq, e) => Math.max(seq, Number((e.payload as Record<string, Json>)?.evidenceSeq) || 0), 0)
    const hintSeq = events.reduce((seq, e) => Math.max(seq, Number((e.payload as Record<string, Json>)?.hintSeq) || 0), 0)
    if (runId) this.transaction(() => {
      const run = this.run(runId)
      if (run.projectId !== projectId || run.status !== 'running') throw new HttpError(409, 'Delta reader has stopped')
      if (after <= (run.deliveredGraphCursor ?? 0)) { run.deliveredEvidenceSeq = Math.max(run.deliveredEvidenceSeq ?? 0, evidenceSeq); run.deliveredHintSeq = Math.max(run.deliveredHintSeq ?? 0, hintSeq); run.deliveredGraphCursor = Math.max(run.deliveredGraphCursor ?? 0, cursor); this.saveRun(run) }
    })
    const nodes = changed.flatMap(id => {
      const row = this.db.prepare(`SELECT data FROM nodes WHERE project_id=? AND id=? AND ${ACTIVE_NODE_SQL}`).get(projectId, id)
      return row ? [{ version: 1, ...JSON.parse(String(row.data)) } as GraphNode] : []
    })
    return { events, nodes, cursor, hasMore: this.events(projectId, cursor, 1).length > 0, evidenceSeq, hintSeq }
  }
  manageEvidence(id: string, input: EvidenceChange) {
    return this.transaction(() => {
      this.writable(id); requiredText(input.reason, 'reason')
      const target = this.node<Fact | Finding>(id, input.id)
      if (!['fact', 'finding'].includes(target.kind) || target.id === 'origin') throw new HttpError(422, 'Only non-Scope Fact or Finding can be maintained')
      this.checkVersion(target, integer(input.expectedVersion, 'expectedVersion', 1))
      if (input.operation === 'merge') {
        if (!activeEvidence(target)) throw new HttpError(409, 'Merge target must be active')
        const sources = input.sourceIds
        if (!Array.isArray(sources) || !sources.length || new Set(sources).size !== sources.length || sources.includes(target.id) || sources.includes('origin')) throw new HttpError(422, 'Invalid merge sources')
        const nodes = sources.map(source => {
          const node = this.node<Fact | Finding>(id, source)
          if (node.kind !== target.kind || !activeEvidence(node)) throw new HttpError(422, 'Merge requires active evidence of the same kind and project')
          if (input.sourceVersions?.[source] === undefined) throw new HttpError(422, 'Every source requires an expected version')
          this.checkVersion(node, input.sourceVersions[source]); return node
        })
        const union = <T>(items: T[]) => [...new Map(items.map(item => [JSON.stringify(item), item])).values()]
        target.producerStepIds = union([target, ...nodes].flatMap(n => [...(n.producerStepIds ?? []), ...(n.stepId ? [n.stepId] : [])]))
        if (target.kind === 'fact') target.evidence = union([target, ...nodes as Fact[]].flatMap(n => n.evidence))
        else {
          const findings = [target, ...nodes as Finding[]]
          target.factIds = union(findings.flatMap(n => n.factIds))
        }
        const set = new Set(sources), replace = (refs: string[]) => union(refs.map(ref => set.has(ref) ? target.id : ref))
        const affected = this.db.prepare("SELECT data FROM nodes WHERE project_id=? AND kind IN ('step','goal','finding')").all(id).map(row => ({ version: 1, ...JSON.parse(String(row.data)) }) as Step | Goal | Finding)
        for (const node of affected) {
          if (node.id === target.id || set.has(node.id)) continue
          let changed = false, contractChanged = false
          const fields = node.kind === 'step' ? ['sourceIds', 'factIds'] as const : node.kind === 'goal' ? ['evidenceIds'] as const : ['factIds'] as const
          for (const field of fields) {
            const refs = (node as unknown as Record<string, string[]>)[field]
            if (refs.some(ref => set.has(ref))) {
              (node as unknown as Record<string, string[]>)[field] = replace(refs); changed = true
              contractChanged ||= node.kind === 'step' && field === 'sourceIds'
            }
          }
          if (changed) { if (contractChanged && node.kind === 'step' && !['done', 'cancelled'].includes(node.status)) node.planVersion = (node.planVersion ?? 1) + 1; this.saveNode(node); this.event(id, `${node.kind}.updated`, node, node) }
        }
        if (input.description !== undefined) target.description = requiredText(input.description, 'description')
        if (target.kind === 'finding') {
          if (input.title !== undefined) target.title = requiredText(input.title, 'title')
          if (input.details !== undefined) target.details = input.details
        } else if (input.title !== undefined || input.details !== undefined) throw new HttpError(422, 'title/details require a Finding')
        this.saveNode(target); this.event(id, `${target.kind}.updated`, target, { reason: input.reason })
        for (const node of nodes) { this.db.prepare('DELETE FROM nodes WHERE project_id=? AND id=?').run(id, node.id); this.event(id, `${node.kind}.merged`, node, { reason: input.reason, targetId: target.id }) }
      } else if (input.operation === 'delete') {
        const affected = this.db.prepare("SELECT data FROM nodes WHERE project_id=? AND kind IN ('step','goal','finding')").all(id).map(row => ({ version: 1, ...JSON.parse(String(row.data)) }) as Step | Goal | Finding)
        const blockers = affected.filter(node => node.kind === 'step' ? !node.deleted && !['done', 'cancelled'].includes(node.status) && node.sourceIds.includes(target.id) : node.kind === 'goal' ? node.status === 'achieved' && node.evidenceIds.includes(target.id) : node.id !== target.id && node.factIds.includes(target.id))
        if (blockers.length) throw new HttpError(409, 'Evidence has active references', { blockers: blockers.map(n => ({ id: n.id, kind: n.kind, version: n.version })) })
        for (const node of affected) {
          if (node.id === target.id) continue
          const fields = node.kind === 'step' ? ['sourceIds', 'factIds'] : node.kind === 'goal' ? ['evidenceIds'] : ['factIds']
          let changed = false
          for (const field of fields) {
            const refs = (node as unknown as Record<string, string[]>)[field]
            if (refs.includes(target.id)) { (node as unknown as Record<string, string[]>)[field] = refs.filter(ref => ref !== target.id); changed = true }
          }
          if (changed) { this.saveNode(node); this.event(id, `${node.kind}.updated`, node, {}) }
        }
        this.db.prepare('DELETE FROM nodes WHERE project_id=? AND id=?').run(id, target.id)
        this.event(id, `${target.kind}.deleted`, target, { reason: input.reason })
        return { id: target.id, deleted: true }
      } else throw new HttpError(422, 'Invalid evidence operation')
      return this.node(id, target.id)
    })
  }
  deleteStep(id: string, stepId: string) {
    return this.transaction(() => {
      const s = this.node<Step>(id, stepId, 'step')
      if (s.deleted) throw new HttpError(404, 'Step not found')
      if (s.attempts || s.factIds.length || s.status !== 'pending') throw new HttpError(409, 'Claimed or concluded Step cannot be deleted')
      const deleted = this.updateStep(id, stepId, { status: 'cancelled' }); deleted.deleted = true; this.saveNode(deleted)
      this.event(id, 'step.deleted', deleted, deleted); return deleted
    })
  }
  addFact(id: string, description: string, options: { runId?: string; stepId?: string; creator?: string; evidence?: Evidence[] } = {}): Fact {
    return this.transaction(() => {
      this.active(id)
      let step: Step | undefined
      if (options.runId) {
        const run = this.run(options.runId)
        if (run.projectId !== id || run.activity !== 'execute' || run.status !== 'running') throw new HttpError(409, 'Run cannot submit facts')
        if (options.stepId && options.stepId !== run.stepId) throw new HttpError(409, 'Step does not belong to run')
        step = this.node<Step>(id, run.stepId!, 'step')
        if (step.status !== 'running') throw new HttpError(409, 'Step is no longer running')
      } else if (options.stepId) step = this.node<Step>(id, options.stepId, 'step')
      const evidence = options.evidence ?? []
      if (!Array.isArray(evidence) || evidence.some(e => !e || typeof e.description !== 'string' || !e.description.trim())) throw new HttpError(422, 'Invalid evidence')
      const fact: Fact = { id: this.next(id, 'fact', 'f'), projectId: id, kind: 'fact', description: requiredText(description, 'description'),
        stepId: step?.id ?? null, creator: options.creator ?? 'execute', evidence, createdAt: now() }
      this.saveNode(fact)
      if (step) { step.factIds.push(fact.id); this.saveNode(step) }
      this.event(id, 'fact.added', fact, fact); return fact
    })
  }
  addFinding(id: string, input: { title: string; description: string; type?: string; factIds: string[]; details?: Json; creator?: string; runId?: string }): Finding {
    return this.transaction(() => {
      this.active(id)
      let stepId: string | null = null
      if (input.runId) {
        const run = this.run(input.runId)
        if (run.projectId !== id || run.activity !== 'execute' || run.status !== 'running' || !run.stepId || this.node<Step>(id, run.stepId, 'step').status !== 'running') throw new HttpError(409, 'Run cannot submit findings')
        stepId = run.stepId
      }
      const node: Finding = { id: this.next(id, 'finding', 'finding_'), projectId: id, kind: 'finding', title: requiredText(input.title, 'title'),
        description: requiredText(input.description, 'description'), type: input.type ?? 'finding', factIds: this.factIds(id, input.factIds, false), details: input.details ?? null, creator: input.creator ?? 'execute', stepId, createdAt: now() }
      this.saveNode(node); this.event(id, 'finding.added', node, node); return node
    })
  }
  run(id: string): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE id=?').get(id) as { data: string } | undefined
    if (!row) throw new HttpError(404, 'Run not found')
    return JSON.parse(row.data)
  }
  releaseFact(id: string, factId: string) {
    const fact = this.node<Fact>(id, factId, 'fact')
    this.manageEvidence(id, { operation: 'delete', id: factId, expectedVersion: fact.version!, reason: 'Released evidence' })
  }
  ownedRun(id: string, activity: Activity, worker: string, stepId: string | null = null): Run {
    const row = this.db.prepare('SELECT data FROM runs WHERE project_id=? AND activity=? AND step_id IS ? AND status=? LIMIT 1').get(id, activity, stepId, 'running') as { data: string } | undefined
    const run = row ? JSON.parse(row.data) as Run : undefined
    if (!run || run.worker !== worker) throw new HttpError(409, 'Activity is not owned by this worker')
    return run
  }
  complete(id: string, description: string, evidenceIds: string[], worker: string): Step {
    return this.transaction(() => {
      this.active(id)
      const step = this.addStep(id, { description, sourceIds: evidenceIds, creator: worker })
      const run = this.claim(id, 'execute', { name: worker, backend: 'dsh' }, step.id)
      this.finishRun(run.id, 'succeeded'); const saved = this.node<Step>(id, step.id, 'step'); saved.resultGoalId = 'goal'; this.saveNode(saved)
      this.event(id, 'step.updated', saved, saved)
      this.updateGoal(id, 'goal', { status: 'achieved', evidenceIds }); return saved
    })
  }
  reopen(id: string, description: string, creator: string) {
    return this.transaction(() => {
      const p = this.project(id); if (p.status !== 'completed') throw new HttpError(403, `Project is ${p.status}`)
      p.status = 'active'; this.saveProject(p); this.updateGoal(id, 'goal', { status: 'open', evidenceIds: [] })
      const step = this.addStep(id, { description, sourceIds: ['origin'], creator }), run = this.claim(id, 'execute', { name: creator, backend: 'dsh' }, step.id)
      const fact = this.addFact(id, description, { runId: run.id, creator, evidence: [{ description: 'Human reopened the project' }] })
      this.finishRun(run.id, 'succeeded'); const saved = this.node<Step>(id, step.id, 'step'); saved.sourceGoalId = 'goal'; this.saveNode(saved)
      this.event(id, 'project.reopened', saved, { description, creator }); return { fact, step: saved }
    })
  }
  runs(projectId?: string): Run[] {
    const rows = projectId === undefined ? this.db.prepare('SELECT data FROM runs ORDER BY rowid').all() : this.db.prepare('SELECT data FROM runs WHERE project_id=? ORDER BY rowid').all(projectId)
    return rows.map(r => JSON.parse(String(r.data)))
  }
  runsByStatus(status: Run['status'], projectId?: string): Run[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT data FROM runs WHERE status=? ORDER BY rowid').all(status)
      : this.db.prepare('SELECT data FROM runs WHERE project_id=? AND status=? ORDER BY rowid').all(projectId, status)
    return rows.map(r => JSON.parse(String(r.data)))
  }
  latestRun(projectId: string, stepId: string): Run | undefined {
    const row = this.db.prepare('SELECT data FROM runs WHERE project_id=? AND step_id=? ORDER BY rowid DESC LIMIT 1').get(projectId, stepId) as { data: string } | undefined
    return row ? JSON.parse(row.data) : undefined
  }
  recordCriticalSignal(projectId: string, key: string, data: Json) {
    return this.transaction(() => {
      const p = this.writable(projectId), signals = new Set(Array.isArray((p as Project & { criticalSignals?: string[] }).criticalSignals) ? (p as Project & { criticalSignals: string[] }).criticalSignals : [])
      if(signals.has(key))return false
      if(!this.db.prepare('INSERT OR IGNORE INTO critical_keys VALUES (?,?)').run(projectId,key).changes)return false
      signals.add(key)
      ;(p as Project & { criticalSignals: string[] }).criticalSignals = [...signals].slice(-256)
      p.criticalSeq = (p.criticalSeq ?? 0) + 1; p.revision++; p.planningRevision++
      this.saveProject(p)
      this.db.prepare('INSERT INTO events(project_id,revision,type,node_id,data,created_at) VALUES (?,?,?,?,?,?)')
        .run(projectId, p.revision, 'planning.critical', null, JSON.stringify(data), now())
      this.pending.add(projectId)
      return true
    })
  }
  saveRun(run: Run) {
    this.db.prepare('INSERT INTO runs VALUES (?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,data=excluded.data').run(run.id, run.projectId, run.stepId, run.activity, run.status, JSON.stringify(run))
    const step = run.stepId ? this.node<Step>(run.projectId, run.stepId, 'step') : undefined
    this.audit({ id: run.id, project_id: run.projectId, intent_id: run.stepId, task_type: run.activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore', phase: run.activity,
      worker: run.worker, provider: run.provider ?? run.backend, engine: run.backend, model: run.model ?? null, execution_profile: step?.executionProfile ?? 'direct', session_id: run.id,
      workspace_kind: 'local', workspace_ref: '', workspace_root: run.workspaceRoot ?? '', status: run.status === 'succeeded' ? 'completed' : run.status,
      started_at: run.startedAt, ended_at: run.endedAt, exit_code: run.status === 'succeeded' ? 0 : null, timed_out: false, cancelled: run.status === 'cancelled',
      input_tokens: run.inputTokens, output_tokens: run.outputTokens, cache_read_tokens: run.cacheReadTokens, cache_write_tokens: run.cacheWriteTokens }, [])
  }
  audit(metadata: { [key: string]: Json }, events: { [key: string]: Json }[]) {
    return this.transaction(() => {
      const id = requiredText(metadata.id, 'run id'), projectId = requiredText(metadata.project_id, 'project id'); this.project(projectId)
      const row = this.db.prepare('SELECT project_id,data FROM audit_runs WHERE id=?').get(id)
      if (row && row.project_id !== projectId) throw new HttpError(409, 'Audit run belongs to another project')
      const saved = row ? JSON.parse(String(row.data)) : null
      const result = { ...metadata }
      if (saved) {
        if (saved.status !== 'running' && metadata.status === 'running' && !(saved.status === 'paused' && this.db.prepare("SELECT 1 FROM runs WHERE id=? AND status='running'").get(id))) for (const key of ['status', 'ended_at', 'exit_code', 'timed_out', 'cancelled']) result[key] = saved[key] ?? null
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) result[key] = Math.max(Number(saved[key]) || 0, Number(metadata[key]) || 0)
        result.session_id ??= saved.session_id
      }
      this.db.prepare('INSERT INTO audit_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, projectId, JSON.stringify(result))
      for (const data of events) {
        const event: { [key: string]: Json } = { ...redactSensitive(data) as { [key: string]: Json }, project_id: projectId, run_id: id, task_type: data.task_type ?? metadata.task_type, worker: data.worker ?? metadata.worker, provider: data.provider ?? metadata.provider }
        if (!['assistant.delta', 'thinking.delta', 'thinking.completed'].includes(String(data.kind))) {
          const inserted = this.db.prepare('INSERT OR IGNORE INTO audit_events(event_uid,project_id,run_id,data) VALUES (?,?,?,?)').run(typeof event.event_uid === 'string' ? event.event_uid : null, projectId, id, JSON.stringify(event))
          if (inserted.changes) event.id = Number(inserted.lastInsertRowid)
        }
        if (!data.persist_only) this.pendingAudit.push({ projectId, data: event })
      }
      return { accepted: events.length }
    })
  }
  claim(id: string, activity: Activity, worker: Pick<Worker, 'name' | 'backend'>, stepId: string | null = null): Run {
    return this.transaction(() => {
      const p = this.active(id)
      if (activity === 'decide' && this.db.prepare("SELECT 1 FROM runs WHERE project_id=? AND activity='decide' AND status='running' LIMIT 1").get(id)) throw new HttpError(409, 'Decide already running')
      let step: Step | undefined
      if (activity === 'execute') {
        if (!stepId) throw new HttpError(422, 'Step required')
        step = this.node<Step>(id, stepId, 'step')
        if (!['pending', 'paused'].includes(step.status) || step.replacementPending) throw new HttpError(409, 'Step is not claimable')
        if (this.node<Goal>(id, step.goalId, 'goal').status !== 'open') throw new HttpError(409, 'Step goal is closed')
        this.evidenceIds(id, step.sourceIds, true)
      }
      const paused = step?.status === 'paused' ? this.runsByStatus('paused', id).find(r => r.stepId === stepId) : undefined
      if (paused && (paused.worker !== worker.name || paused.backend !== worker.backend)) throw new HttpError(409, 'Resume must keep the original worker and backend')
      if (paused?.pendingTools.length) throw new HttpError(409, 'Unconfirmed tool results prevent automatic resume')
      const run: Run = paused ?? { id: `run-${randomUUID()}`, projectId: id, stepId, activity, worker: worker.name, backend: worker.backend, status: 'running', startedAt: now(), endedAt: null,
        baseRevision: p.planningRevision, deliveredGraphCursor: Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM events WHERE project_id=?').get(id)?.value ?? 0), checkpoint: null, pendingTools: [], error: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
        ...(activity === 'decide' ? { planningFactSeq: p.factSeq, planningEndedSeq: p.endedSeq, planningCriticalSeq: p.criticalSeq ?? 0, planningEvidenceSeq: p.evidenceSeq ?? p.factSeq, deliveredEvidenceSeq: p.evidenceSeq ?? p.factSeq, planningHintSeq: p.hintSeq ?? 0, deliveredHintSeq: p.hintSeq ?? 0 } : { boundStepVersion: step?.planVersion ?? 1 }) }
      run.status = 'running'; run.endedAt = null
      run.deliveredGraphCursor ??= Number(this.db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM events WHERE project_id=?').get(id)?.value ?? 0)
      this.saveRun(run)
      if (step) { step.status = 'running'; step.worker = worker.name; if (!paused) step.attempts++; this.saveNode(step) }
      this.event(id, `${activity}.started`, step ?? null, { runId: run.id, factSeq: run.planningFactSeq, endedSeq: run.planningEndedSeq, criticalSeq: run.planningCriticalSeq }); return run
    })
  }
  finishRun(runId: string, status: Run['status'], error: string | null = null) {
    return this.transaction(() => {
      const run = this.run(runId)
      if (run.status !== 'running') return run
      if (run.stepId && status === 'succeeded') {
        const step = this.node<Step>(run.projectId, run.stepId, 'step')
        if (step.bootstrap && !step.factIds.length) {
          status = 'failed'
          error = 'Bootstrap must return at least one Fact before Reason can start'
        }
      }
      run.status = status; run.error = error; run.endedAt = status === 'paused' ? null : now(); this.saveRun(run)
      if (run.stepId) {
        const step = this.node<Step>(run.projectId, run.stepId, 'step')
        if (step.status !== 'cancelled') step.status = status === 'succeeded' ? 'done' : status === 'paused' ? 'paused' : status === 'cancelled' ? 'cancelled' : 'blocked'
        step.failure = error; step.endedAt = run.endedAt; this.saveNode(step)
        this.event(run.projectId, `execute.${status}`, step, { runId, error })
        if (!['running', 'paused', 'unknown'].includes(status)) this.releaseReplacement(step)
      } else {
        const p = this.project(run.projectId)
        if (status === 'succeeded') {
          p.decidedRevision = Math.max(p.decidedRevision, run.baseRevision); p.retryAfter = 0
          p.acknowledgedFactSeq = run.planningFactSeq ?? p.factSeq; p.acknowledgedEndedSeq = run.planningEndedSeq ?? p.endedSeq
          p.acknowledgedCriticalSeq = run.planningCriticalSeq ?? p.criticalSeq ?? 0
          p.acknowledgedEvidenceSeq = Math.max(p.acknowledgedEvidenceSeq ?? 0, run.processedEvidenceSeq ?? run.planningEvidenceSeq ?? run.planningFactSeq ?? 0)
          p.acknowledgedHintSeq = Math.max(p.acknowledgedHintSeq ?? 0, run.processedHintSeq ?? run.planningHintSeq ?? 0)
          p.initialPlanningPending = false; p.planningRetryPending = false
        } else { p.retryAfter = Date.now() + 5000; p.planningRetryPending = true }
        this.saveProject(p); this.event(p.id, `decide.${status}`, null, { runId, error, baseRevision: run.baseRevision,
          factSeq: run.planningFactSeq, endedSeq: run.planningEndedSeq, evidenceSeq: p.acknowledgedEvidenceSeq, hintSeq: p.acknowledgedHintSeq ?? 0, retryAfter: p.retryAfter })
      }
      return run
    })
  }
  checkpoint(runId: string, checkpoint: Json) { this.transaction(() => { const run = this.run(runId); run.checkpoint = checkpoint; this.saveRun(run) }) }
  runEvent(runId: string, type: string, data: Json, recordAudit = true) {
    this.transaction(() => {
      this.run(runId)
      const timestamp = now()
      const safeData = redactSensitive(data) as Json
      const inserted = this.db.prepare('INSERT INTO run_events(run_id,type,data,created_at) VALUES (?,?,?,?)').run(runId, type, JSON.stringify(safeData), timestamp)
      const value = safeData && typeof safeData === 'object' && !Array.isArray(safeData) ? safeData as Record<string, Json> : {}
      const event: { [key: string]: Json } = { event_uid: `native-${inserted.lastInsertRowid}`, run_sequence: Number(inserted.lastInsertRowid), timestamp, kind: type, data: safeData }
      if (type === 'tool.started') { event.kind = 'tool.started'; event.title = value.name ?? null; event.call_id = value.id ?? null; event.arguments = value.arguments ?? null }
      if (type === 'tool_execution_end') { event.kind = 'tool.completed'; event.title = value.toolName ?? null; event.call_id = value.toolCallId ?? null; event.error = value.isError ?? false; event.content = JSON.stringify(value.result ?? null) }
      const metadata = JSON.parse(String(this.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(runId)!.data))
      if (recordAudit) this.audit(metadata, conversationAuditEvents(event))
    })
  }
  metricStart(runId: string, callId: string, kind: string) {
    this.db.prepare('INSERT OR IGNORE INTO run_metrics VALUES (?,?,?,?,NULL)').run(runId, callId, kind, Date.now())
  }
  metricEnd(runId: string, callId: string) {
    this.db.prepare('UPDATE run_metrics SET ended=? WHERE run_id=? AND call_id=? AND ended IS NULL').run(Date.now(), runId, callId)
  }
  runCosts(runId: string) {
    const run = this.run(runId), end = run.endedAt ? Date.parse(run.endedAt) : Date.now(), start = Date.parse(run.startedAt)
    const metrics = this.db.prepare('SELECT kind,started,ended FROM run_metrics WHERE run_id=? ORDER BY started').all(runId) as {kind:string;started:number;ended:number|null}[]
    const sum = (kind: string) => metrics.filter(row=>row.kind===kind).reduce((total,row)=>total+Math.max(0,(row.ended ?? end)-row.started),0)
    let covered=0,cursor=start
    for (const row of metrics) { const left=Math.max(start,row.started),right=Math.min(end,row.ended ?? end); covered+=Math.max(0,right-Math.max(cursor,left)); cursor=Math.max(cursor,right) }
    const tokens={input:run.inputTokens,output:run.outputTokens,cacheRead:run.cacheReadTokens,cacheWrite:run.cacheWriteTokens}
    return {runId,projectId:run.projectId,status:run.status,tokens,totalTokens:Object.values(tokens).reduce((a,b)=>a+b,0),wallMs:Math.max(0,end-start),modelMs:sum('model'),toolMs:sum('tool'),platformMs:sum('platform'),waitOrUninstrumentedMs:Math.max(0,end-start-covered),instrumented:metrics.length>0,incompleteCalls:metrics.filter(row=>row.ended===null).length,imageTokenBreakdown:null}
  }
  attempt(runId: string, callId: string, data: Json, contextVersion = '') {
    const run = this.run(runId), project = this.project(run.projectId)
    const hasResources = this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='shared_resources'").get()
    const resources = hasResources ? this.db.prepare('SELECT id,status,metadata_json,secret_json,worker_paused,locked_by FROM shared_resources WHERE project_id=? OR project_id IS NULL ORDER BY id').all(run.projectId) : []
    const value = data as Record<string, Json>, args = value.arguments as Record<string, Json> | undefined
    const signature = createHash('sha256').update(JSON.stringify({ project: run.projectId, contextVersion, challenge: args?.challenge ?? args?.unique_code ?? run.stepId, name: value.name, input: value.arguments ?? data, factSeq: project.factSeq, resources, channels:this.db.prepare('SELECT channel,hash FROM channel_versions WHERE project_id=? ORDER BY channel').all(run.projectId) })).digest('hex')
    const old = this.db.prepare('SELECT count,evidence FROM attempt_ledger WHERE project_id=? AND signature=?').get(run.projectId, signature) as { count: number; evidence: string } | undefined
    const evidence = [...(old ? JSON.parse(old.evidence) : []), { runId, callId }].slice(-3), count = (old?.count ?? 0) + 1
    this.db.prepare('INSERT INTO attempt_ledger VALUES (?,?,?,?) ON CONFLICT(project_id,signature) DO UPDATE SET count=excluded.count,evidence=excluded.evidence').run(run.projectId, signature, count, JSON.stringify(evidence))
    return count === 3 ? `同一题目、身份及通道状态下已有 3 次相同尝试：${JSON.stringify(evidence)}。先检查这些调用的结果与失败边界；只有前置条件改变后再重试。未知结果或有副作用操作不会自动重放。` : undefined
  }
  toolStarted(runId: string, callId: string, data: Json, recordAudit = true, remind = true, contextVersion = '') {
    return this.transaction(() => {
      const run = this.run(runId)
      if (run.status !== 'running') throw new HttpError(409, 'Run is not running')
      if (run.pendingTools.includes(callId)) throw new HttpError(409, 'Tool already started')
      run.pendingTools.push(callId); this.saveRun(run); this.runEvent(runId, 'tool.started', data, recordAudit)
      const name = String((data as Record<string, Json>).name ?? '')
      this.metricStart(runId, callId, name.startsWith('tsecbench_') ? 'platform' : 'tool')
      return remind ? this.attempt(runId, callId, data, contextVersion) : undefined
    })
  }
  toolEnded(runId: string, callId: string, data: Json) {
    this.transaction(() => { const run = this.run(runId); run.pendingTools = run.pendingTools.filter(id => id !== callId); this.saveRun(run); this.metricEnd(runId, callId); this.runEvent(runId, 'tool.ended', data) })
  }
  recover() {
    for (const run of this.runsByStatus('running')) this.finishRun(run.id, 'unknown', run.pendingTools.length ? 'Process stopped with an unconfirmed tool result; do not replay automatically' : 'Process stopped before run completion')
  }
}
