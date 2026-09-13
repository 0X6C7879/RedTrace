import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { HttpError, integer, now, requiredText } from './types.ts'
import type { Activity, Evidence, Fact, Finding, Goal, Graph, GraphEvent, GraphNode, Input, Json, Project, Run, Step, Worker } from './types.ts'

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

export class Store {
  readonly db: DatabaseSync
  readonly changes = new EventEmitter()
  private depth = 0
  private pending = new Set<string>()
  private pendingAudit: { projectId: string; data: Json }[] = []
  constructor(filename: string) {
    if (filename !== ':memory:') mkdirSync(path.dirname(path.resolve(filename)), { recursive: true })
    this.db = new DatabaseSync(filename, { timeout: 5000 })
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS nodes(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        id TEXT NOT NULL, kind TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(project_id,id));
      CREATE TABLE IF NOT EXISTS counters(scope TEXT NOT NULL, kind TEXT NOT NULL, value INTEGER NOT NULL, PRIMARY KEY(scope,kind));
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, revision INTEGER NOT NULL,
        type TEXT NOT NULL, node_id TEXT, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id,id);
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        step_id TEXT, activity TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_step ON runs(project_id,step_id) WHERE status IN ('running','paused');
      CREATE UNIQUE INDEX IF NOT EXISTS one_decider ON runs(project_id) WHERE activity='decide' AND status='running';
      CREATE TABLE IF NOT EXISTS run_events(id INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE, type TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_runs(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, event_uid TEXT UNIQUE,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE, data TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS audit_events_project ON audit_events(project_id,id);
    `)
    const version = this.db.prepare('SELECT value FROM metadata WHERE key=?').get('schema') as { value: string } | undefined
    if (version && version.value !== '1') { this.db.close(); throw new Error(`Unsupported engine schema ${version.value}`) }
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES (?,?)').run('schema', '1')
    this.changes.setMaxListeners(0)
  }
  close() { this.changes.removeAllListeners(); this.db.close() }
  transaction<T>(fn: () => T): T {
    if (this.depth) return fn()
    this.db.exec('BEGIN IMMEDIATE')
    this.depth++
    let result: T
    try {
      result = fn()
      if (result instanceof Promise) throw new Error('SQLite transactions must be synchronous')
      this.db.exec('COMMIT')
    } catch (error) { this.db.exec('ROLLBACK'); this.pending.clear(); this.pendingAudit = []; throw error }
    finally { this.depth-- }
    const projects = [...this.pending]; this.pending.clear()
    // Notify after commit. Queueing also prevents observers from re-entering a write.
    for (const id of projects) queueMicrotask(() => this.changes.emit('change', id))
    const audit = this.pendingAudit; this.pendingAudit = []
    for (const entry of audit) queueMicrotask(() => this.changes.emit('audit', entry.projectId, entry.data))
    return result!
  }
  private next(scope: string, kind: string, prefix: string) {
    const row = this.db.prepare(`INSERT INTO counters VALUES (?,?,1) ON CONFLICT(scope,kind)
      DO UPDATE SET value=value+1 RETURNING value`).get(scope, kind) as { value: number }
    return prefix + String(row.value).padStart(3, '0')
  }
  project(id: string): Project {
    const row = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id) as { data: string } | undefined
    if (!row) throw new HttpError(404, 'Project not found')
    return JSON.parse(row.data)
  }
  projects(): Project[] { return (this.db.prepare('SELECT data FROM projects ORDER BY id').all() as { data: string }[]).map(r => JSON.parse(r.data)) }
  private saveProject(p: Project) { this.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(p), p.id) }
  node<T extends GraphNode = GraphNode>(projectId: string, id: string, kind?: T['kind']): T {
    this.project(projectId)
    const row = this.db.prepare('SELECT data FROM nodes WHERE project_id=? AND id=?').get(projectId, id) as { data: string } | undefined
    if (!row) throw new HttpError(404, 'Node not found')
    const value = JSON.parse(row.data) as T
    if (kind && value.kind !== kind) throw new HttpError(404, `${kind} not found`)
    return value
  }
  private saveNode(node: GraphNode) {
    this.db.prepare('INSERT INTO nodes VALUES (?,?,?,?) ON CONFLICT(project_id,id) DO UPDATE SET data=excluded.data')
      .run(node.projectId, node.id, node.kind, JSON.stringify(node))
  }
  graph(id: string): Graph {
    const project = this.project(id)
    const all: GraphNode[] = (this.db.prepare('SELECT data FROM nodes WHERE project_id=? ORDER BY rowid').all(id) as { data: string }[]).map(r => JSON.parse(r.data))
    return { project, facts: all.filter((n): n is Fact => n.kind === 'fact' && !n.deleted), goals: all.filter((n): n is Goal => n.kind === 'goal'),
      steps: all.filter((n): n is Step => n.kind === 'step'), findings: all.filter((n): n is Finding => n.kind === 'finding'),
      hints: all.filter((n): n is Input => n.kind === 'hint' && !n.deleted), observations: all.filter((n): n is Input => n.kind === 'observation' && !n.deleted) }
  }
  graphAt(id: string, revision: number): Graph & { historyIncomplete: boolean } {
    const current = this.graph(id)
    if (!Number.isSafeInteger(revision) || revision < 1 || revision > current.project.revision) throw new HttpError(422, 'Invalid graph revision')
    const rows = this.db.prepare('SELECT revision,type,node_id,data FROM events WHERE project_id=? AND revision<=? ORDER BY revision').all(id, revision)
    const initial = JSON.parse(String(rows[0]?.data ?? '{}'))
    const historyIncomplete = !Array.isArray(initial.initialNodes)
    const project: Project = { ...current.project, ...initial, status: 'active', revision: 0, planningRevision: 0, decidedRevision: 0 }
    delete (project as Project & { initialNodes?: unknown }).initialNodes
    const nodes = new Map<string, GraphNode>()
    if (!historyIncomplete) for (const node of initial.initialNodes as GraphNode[]) nodes.set(node.id, node)
    else {
      const scope = current.facts.find(f => f.id === 'origin')
      if (scope) nodes.set(scope.id, scope)
      nodes.set('goal', { id: 'goal', kind: 'goal', projectId: id, createdAt: project.createdAt, creator: 'human', description: '历史目标（创建描述未记录）', parentId: null, status: 'open', evidenceIds: [] })
    }
    for (const row of rows) {
      const payload = JSON.parse(String(row.data)), type = String(row.type), nodeId = row.node_id as string | null
      project.revision = Number(row.revision)
      if (payload.kind && payload.id) nodes.set(payload.id, payload)
      if (payload.nodeSnapshot) nodes.set(payload.nodeSnapshot.id, payload.nodeSnapshot)
      if (type === 'fact.added' && payload.stepId) {
        const step = nodes.get(payload.stepId)
        if (step?.kind === 'step' && !step.factIds.includes(payload.id)) step.factIds.push(payload.id)
      }
      const step = nodeId ? nodes.get(nodeId) : undefined
      if (!payload.nodeSnapshot && step?.kind === 'step' && type.startsWith('execute.')) {
        const statuses: Record<string, Step['status']> = { started: 'running', succeeded: 'done', failed: 'blocked', unknown: 'blocked', paused: 'paused', cancelled: 'cancelled' }
        const status = statuses[type.slice(8)]
        if (status) step.status = status
      }
      if (type === 'project.completed') project.status = 'completed'
      if (type === 'project.stopped') project.status = 'stopped'
      if (type === 'project.active' || type === 'project.reopened') project.status = 'active'
      if (type === 'project.renamed') project.title = payload.title
    }
    const all = [...nodes.values()]
    return { project, facts: all.filter((n): n is Fact => n.kind === 'fact' && !n.deleted), goals: all.filter((n): n is Goal => n.kind === 'goal'),
      steps: all.filter((n): n is Step => n.kind === 'step'), findings: all.filter((n): n is Finding => n.kind === 'finding'),
      hints: all.filter((n): n is Input => n.kind === 'hint' && !n.deleted), observations: all.filter((n): n is Input => n.kind === 'observation' && !n.deleted), historyIncomplete }
  }
  private event(id: string, type: string, node: GraphNode | null, payload: unknown) {
    const planning = ['project.created', 'fact.added', 'execute.succeeded', 'execute.failed', 'project.active', 'project.reopened'].includes(type)
    const p = this.project(id); p.revision++; if (planning) p.planningRevision++
    this.saveProject(p)
    this.db.prepare('INSERT INTO events(project_id,revision,type,node_id,data,created_at) VALUES (?,?,?,?,?,?)')
      .run(id, p.revision, type, node?.id ?? null, JSON.stringify(node && payload && typeof payload === 'object' && !('kind' in payload) ? { ...payload, nodeSnapshot: node } : payload), now())
    this.pending.add(id)
  }
  events(projectId: string, after = 0, limit = 500): GraphEvent[] {
    this.project(projectId)
    return this.db.prepare('SELECT * FROM events WHERE project_id=? AND id>? ORDER BY id LIMIT ?').all(projectId, after, limit).map((row) => ({
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
    for (const fid of ids) if (this.node<Fact>(id, fid, 'fact').deleted) throw new HttpError(404, 'Fact not found')
    return ids
  }
  private evidenceIds(id: string, values: unknown, allowScope = false): string[] {
    if (!Array.isArray(values) || !values.length) throw new HttpError(422, 'Evidence references must be a non-empty array')
    const ids = values.map(v => requiredText(v, 'evidence id'))
    if (new Set(ids).size !== ids.length) throw new HttpError(422, 'Duplicate evidence references')
    for (const ref of ids) {
      const node = this.node(id, ref)
      if ((node.kind !== 'fact' && node.kind !== 'finding') || ('deleted' in node && node.deleted) || (!allowScope && ref === 'origin')) throw new HttpError(422, 'Expected a confirmed Fact or Finding in this project')
    }
    return ids
  }
  createProject(input: { title: string; origin: string; goal: string; bootstrap?: boolean; hints?: {content: string; creator: string}[] }): Graph {
    return this.transaction(() => {
      const title = requiredText(input.title, 'title'), origin = requiredText(input.origin, 'origin'), goal = requiredText(input.goal, 'goal')
      const id = this.next('', 'project', 'proj_'), createdAt = now()
      const p: Project = { id, title, status: 'active', bootstrap: input.bootstrap ?? false, createdAt, revision: 0, planningRevision: 0, decidedRevision: 0, retryAfter: 0 }
      this.db.prepare('INSERT INTO projects VALUES (?,?)').run(id, JSON.stringify(p))
      this.saveNode({ id: 'origin', projectId: id, kind: 'fact', description: origin, creator: 'human', createdAt, stepId: null, evidence: [] })
      this.saveNode({ id: 'goal', projectId: id, kind: 'goal', description: goal, creator: 'human', createdAt, parentId: null, status: 'open', evidenceIds: [] })
      this.event(id, 'project.created', null, { ...p, initialNodes: [this.node(id, 'origin'), this.node(id, 'goal')] })
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
  updateGoal(id: string, goalId: string, input: { description?: string; status?: Goal['status']; evidenceIds?: string[] }): Goal {
    return this.transaction(() => {
      this.writable(id); const goal = this.node<Goal>(id, goalId, 'goal')
      if (input.description !== undefined) goal.description = requiredText(input.description, 'description')
      if (input.status !== undefined) {
        if (!['open', 'achieved', 'cancelled'].includes(input.status)) throw new HttpError(422, 'Invalid goal status')
        if (goal.id === 'goal' && input.status === 'cancelled') throw new HttpError(409, 'Root goal cannot be deleted')
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
      if (goal.status === 'cancelled') {
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
  addStep(id: string, input: { description: string; sourceIds: string[]; goalId?: string; creator?: string; priority?: number; executionProfile?: Step['executionProfile']; capabilities?: string[]; bootstrap?: boolean }, maxSteps: number | null = null): Step {
    return this.transaction(() => {
      this.writable(id)
      if (maxSteps !== null && this.graph(id).steps.filter(s => ['pending', 'running', 'paused'].includes(s.status)).length >= maxSteps) throw new HttpError(409, 'Active Step limit reached')
      const goalId = input.goalId ?? 'goal'; if (this.node<Goal>(id, goalId, 'goal').status !== 'open') throw new HttpError(409, 'Goal is closed')
      const profile = input.executionProfile ?? 'direct'; if (!['direct', 'isolated'].includes(profile)) throw new HttpError(422, 'Invalid execution profile')
      if (input.capabilities && (!Array.isArray(input.capabilities) || input.capabilities.some(x => typeof x !== 'string'))) throw new HttpError(422, 'Invalid capabilities')
      const step: Step = { id: this.next(id, 'step', 'i'), projectId: id, kind: 'step', description: requiredText(input.description, 'description'),
        sourceIds: this.evidenceIds(id, input.sourceIds, true), goalId, creator: input.creator ?? 'decide', priority: integer(input.priority ?? 0, 'priority', -2147483648),
        status: 'pending', factIds: [], worker: null, executionProfile: profile, capabilities: input.capabilities ?? [], attempts: 0,
        endedAt: null, failure: null, createdAt: now(), bootstrap: input.bootstrap ?? false }
      this.saveNode(step); this.event(id, 'step.added', step, step); return step
    })
  }
  updateStep(id: string, stepId: string, input: { priority?: number; status?: 'cancelled' | 'pending'; executionProfile?: Step['executionProfile']; capabilities?: string[] }): Step {
    return this.transaction(() => {
      this.writable(id); const step = this.node<Step>(id, stepId, 'step')
      if (step.status === 'done') throw new HttpError(409, 'Step is already completed')
      if (input.priority !== undefined) step.priority = integer(input.priority, 'priority', -2147483648)
      if (input.executionProfile !== undefined || input.capabilities !== undefined) {
        if (step.status !== 'pending' || step.attempts) throw new HttpError(409, 'Execution settings freeze on claim')
        if (input.executionProfile !== undefined) {
          if (!['direct', 'isolated'].includes(input.executionProfile)) throw new HttpError(422, 'Invalid execution profile')
          step.executionProfile = input.executionProfile
        }
        if (input.capabilities !== undefined) {
          if (!Array.isArray(input.capabilities) || input.capabilities.some(x => typeof x !== 'string') || new Set(input.capabilities).size !== input.capabilities.length) throw new HttpError(422, 'Invalid capabilities')
          step.capabilities = input.capabilities
        }
      }
      if (input.status !== undefined) {
        if (!['cancelled', 'pending'].includes(input.status)) throw new HttpError(422, 'Invalid Step transition')
        if (input.status === 'pending' && !['blocked', 'cancelled'].includes(step.status)) throw new HttpError(409, 'Step cannot be retried')
        step.status = input.status; step.endedAt = input.status === 'cancelled' ? now() : null
      }
      this.saveNode(step); this.event(id, 'step.updated', step, step); return step
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
    return this.transaction(() => {
      if (['origin', 'goal'].includes(factId)) throw new HttpError(409, `${factId} cannot be released`)
      const fact = this.node<Fact>(id, factId, 'fact'), graph = this.graph(id)
      if (fact.deleted) throw new HttpError(404, 'Fact not found')
      if (graph.steps.some(s => !s.deleted && s.sourceIds.includes(factId)) || graph.goals.some(g => g.evidenceIds.includes(factId)) || graph.findings.some(f => f.factIds.includes(factId))) throw new HttpError(409, 'Fact is still referenced')
      fact.deleted = true; this.saveNode(fact); this.event(id, 'fact.deleted', fact, fact)
      // Preserve the producing action and its evidence in history; hide it only from the legacy projection.
      if (fact.stepId) { const step = this.node<Step>(id, fact.stepId, 'step'); if (step.factIds.every(fid => this.node<Fact>(id, fid, 'fact').deleted)) { step.deleted = true; this.saveNode(step); this.event(id, 'step.deleted', step, step) } }
    })
  }
  ownedRun(id: string, activity: Activity, worker: string, stepId: string | null = null): Run {
    const run = this.runs(id).find(r => r.activity === activity && r.stepId === stepId && r.status === 'running')
    if (!run || run.worker !== worker) throw new HttpError(409, 'Activity is not owned by this worker')
    return run
  }
  heartbeat(runId: string) { return this.transaction(() => { const run = this.run(runId); if (run.status !== 'running') throw new HttpError(409, 'Activity is not running'); run.heartbeatAt = now(); this.saveRun(run); return run }) }
  releaseRun(runId: string) {
    return this.transaction(() => {
      const run = this.run(runId)
      if (run.pendingTools.length) throw new HttpError(409, 'Unconfirmed tools prevent releasing this activity')
      this.finishRun(run.id, 'cancelled')
      if (run.stepId) { const step = this.node<Step>(run.projectId, run.stepId, 'step'); step.status = 'pending'; step.worker = null; step.endedAt = null; this.saveNode(step); this.event(run.projectId, 'step.updated', step, step) }
    })
  }
  outcome(id: string, worker: string, outcome: string, detail: string, stepId: string | null, options: { runtimeMs?: number; baseRevision?: number; contextRevision?: number } = {}) {
    return this.transaction(() => {
      const p = this.project(id), step = stepId ? this.node<Step>(id, stepId, 'step') : undefined
      if (p.status !== 'active' && !['success', 'cancelled'].includes(outcome)) throw new HttpError(403, `Project is ${p.status}`)
      if (options.contextRevision !== undefined && options.contextRevision > p.revision) throw new HttpError(409, 'Reason context revision is ahead of Blackboard')
      const run = this.runs(id).findLast(r => r.stepId === stepId && r.worker === worker)
      if (run?.pendingTools.length && !['success', 'cancelled'].includes(outcome)) throw new HttpError(409, 'Unconfirmed tool results require verification before retry')
      if (step) {
        step.runtimeMs = (step.runtimeMs ?? 0) + (options.runtimeMs ?? 0)
        this.saveNode(step); this.event(id, 'execute.outcome', step, { worker, outcome, detail, runtimeMs: options.runtimeMs ?? 0 })
        if (['success', 'cancelled'].includes(outcome)) return { circuitOpen: false, failureCount: 0 }
        if (step.status === 'done') return { circuitOpen: step.circuitOpen ?? false, failureCount: step.failureCount ?? 0 }
        if (run?.status === 'running') this.finishRun(run.id, 'failed', detail || outcome)
        const count = (step.failureCount ?? 0) + 1, blocked = !step.bootstrap && count >= 3
        step.failureCount = count; step.failure = outcome.slice(0, 100); step.retryAfter = blocked ? null : Date.now() / 1000 + [5, 15, 60][Math.min(count - 1, 2)]
        step.circuitOpen = blocked; step.status = blocked ? 'blocked' : 'pending'; step.worker = null; step.endedAt = null
        this.saveNode(step); this.event(id, 'step.updated', step, step)
        return { circuitOpen: blocked, failureCount: count, ...(blocked ? { state: 'blocked' } : { retryAfter: step.retryAfter }) }
      }
      if (run?.status === 'running') this.finishRun(run.id, outcome === 'success' ? 'succeeded' : outcome === 'cancelled' ? 'cancelled' : 'failed', detail || null)
      const current = this.project(id)
      current.contextRevision = Math.max(current.contextRevision ?? 0, options.contextRevision ?? 0)
      if (['success', 'cancelled'].includes(outcome)) {
        current.failureCount = 0; current.failureSignature = null; current.retryAfter = 0; current.circuitOpen = false
        if (outcome === 'success') current.decidedRevision = Math.max(current.decidedRevision, Math.min(options.baseRevision ?? current.planningRevision, current.planningRevision))
      } else {
        current.failureCount = (current.failureCount ?? 0) + 1; current.failureSignature = outcome.slice(0, 100); current.circuitOpen = current.failureCount >= 3
        current.retryAfter = current.circuitOpen ? 0 : Date.now() + [5, 15, 60][Math.min(current.failureCount - 1, 2)] * 1000
        if (current.circuitOpen) current.status = 'stopped'
      }
      this.saveProject(current); this.event(id, 'decide.outcome', null, { worker, outcome, detail })
      return { circuitOpen: current.circuitOpen, failureCount: current.failureCount, ...(current.retryAfter ? { retryAfter: current.retryAfter / 1000 } : {}) }
    })
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
        if (saved.status !== 'running' && metadata.status === 'running' && !(saved.status === 'paused' && this.runs(projectId).some(r => r.id === id && r.status === 'running'))) for (const key of ['status', 'ended_at', 'exit_code', 'timed_out', 'cancelled']) result[key] = saved[key] ?? null
        for (const key of ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']) result[key] = Math.max(Number(saved[key]) || 0, Number(metadata[key]) || 0)
        result.session_id ??= saved.session_id
      }
      this.db.prepare('INSERT INTO audit_runs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(id, projectId, JSON.stringify(result))
      for (const data of events) {
        const event: { [key: string]: Json } = { ...data, project_id: projectId, run_id: id, task_type: data.task_type ?? metadata.task_type, worker: data.worker ?? metadata.worker, provider: data.provider ?? metadata.provider }
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
      if (activity === 'decide' && this.runs(id).some(r => r.activity === 'decide' && r.status === 'running')) throw new HttpError(409, 'Decide already running')
      let step: Step | undefined
      if (activity === 'execute') {
        if (!stepId) throw new HttpError(422, 'Step required')
        step = this.node<Step>(id, stepId, 'step')
        if (!['pending', 'paused'].includes(step.status)) throw new HttpError(409, 'Step is not claimable')
        if (this.node<Goal>(id, step.goalId, 'goal').status !== 'open') throw new HttpError(409, 'Step goal is closed')
      }
      const paused = step?.status === 'paused' ? this.runs(id).find(r => r.stepId === stepId && r.status === 'paused') : undefined
      if (paused && (paused.worker !== worker.name || paused.backend !== worker.backend)) throw new HttpError(409, 'Resume must keep the original worker and backend')
      if (paused?.pendingTools.length) throw new HttpError(409, 'Unconfirmed tool results prevent automatic resume')
      const run: Run = paused ?? { id: `run-${randomUUID()}`, projectId: id, stepId, activity, worker: worker.name, backend: worker.backend, status: 'running', startedAt: now(), endedAt: null,
        baseRevision: p.planningRevision, checkpoint: null, pendingTools: [], error: null, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
      run.status = 'running'; run.endedAt = null
      this.saveRun(run)
      if (step) { step.status = 'running'; step.worker = worker.name; if (!paused) step.attempts++; this.saveNode(step) }
      this.event(id, `${activity}.started`, step ?? null, { runId: run.id }); return run
    })
  }
  finishRun(runId: string, status: Run['status'], error: string | null = null) {
    return this.transaction(() => {
      const run = this.run(runId)
      if (run.status !== 'running') return run
      run.status = status; run.error = error; run.endedAt = status === 'paused' ? null : now(); this.saveRun(run)
      if (run.stepId) {
        const step = this.node<Step>(run.projectId, run.stepId, 'step')
        if (step.status !== 'cancelled') step.status = status === 'succeeded' ? 'done' : status === 'paused' ? 'paused' : status === 'cancelled' ? 'cancelled' : 'blocked'
        step.failure = error; step.endedAt = run.endedAt; this.saveNode(step)
        this.event(run.projectId, `execute.${status}`, step, { runId, error })
      } else {
        const p = this.project(run.projectId)
        if (status === 'succeeded') { p.decidedRevision = Math.max(p.decidedRevision, run.baseRevision); p.retryAfter = 0 }
        else p.retryAfter = Date.now() + 5000
        this.saveProject(p); this.event(p.id, `decide.${status}`, null, { runId, error })
      }
      return run
    })
  }
  checkpoint(runId: string, checkpoint: Json) { this.transaction(() => { const run = this.run(runId); run.checkpoint = checkpoint; this.saveRun(run) }) }
  runEvent(runId: string, type: string, data: Json) {
    this.transaction(() => {
      const run = this.run(runId), timestamp = now()
      const inserted = this.db.prepare('INSERT INTO run_events(run_id,type,data,created_at) VALUES (?,?,?,?)').run(runId, type, JSON.stringify(data), timestamp)
      const value = data && typeof data === 'object' && !Array.isArray(data) ? data as Record<string, Json> : {}
      const event: { [key: string]: Json } = { event_uid: `native-${inserted.lastInsertRowid}`, run_sequence: Number(inserted.lastInsertRowid), timestamp, kind: type, data }
      if (type === 'tool.started') { event.kind = 'tool.started'; event.title = value.name ?? null; event.call_id = value.id ?? null; event.arguments = value.arguments ?? null }
      if (type === 'tool_execution_end') { event.kind = 'tool.completed'; event.title = value.toolName ?? null; event.call_id = value.toolCallId ?? null; event.error = value.isError ?? false; event.content = JSON.stringify(value.result ?? null) }
      const metadata = JSON.parse(String(this.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(runId)!.data))
      this.audit(metadata, conversationAuditEvents(event))
    })
  }
  toolStarted(runId: string, callId: string, data: Json) {
    this.transaction(() => { const run = this.run(runId); if (run.status !== 'running') throw new HttpError(409, 'Run is not running'); if (run.pendingTools.includes(callId)) throw new HttpError(409, 'Tool already started'); run.pendingTools.push(callId); this.saveRun(run); this.runEvent(runId, 'tool.started', data) })
  }
  toolEnded(runId: string, callId: string, data: Json) {
    this.transaction(() => { const run = this.run(runId); run.pendingTools = run.pendingTools.filter(id => id !== callId); this.saveRun(run); this.runEvent(runId, 'tool.ended', data) })
  }
  recover() {
    for (const run of this.runs().filter(r => r.status === 'running')) this.finishRun(run.id, 'unknown', run.pendingTools.length ? 'Process stopped with an unconfirmed tool result; do not replay automatically' : 'Process stopped before run completion')
  }
}
