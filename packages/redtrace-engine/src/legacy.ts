import { Store, ACTIVE_NODE_SQL } from './store.ts'
import type { Project, Run, Step } from './types.ts'

export function legacyIntent(step: Step, run?: Run) {
  const state = { pending: 'open', running: 'working', paused: 'open', parked: 'parked', blocked: 'blocked', done: 'concluded', cancelled: 'dropped' }[step.status]
  return { id: step.id, from: step.sourceGoalId ? [step.sourceGoalId] : step.sourceIds, to: step.status === 'done' ? step.resultGoalId ?? step.factIds.at(-1) ?? null : null, description: step.description, creator: step.creator, worker: step.status === 'paused' ? null : step.worker,
    role: step.role ?? 'soldier', initial_mission: !!step.bootstrap, execution_profile: step.executionProfile, last_heartbeat_at: run ? run.heartbeatAt ?? run.startedAt : null,
    created_at: step.createdAt, concluded_at: step.endedAt, failure_count: step.failureCount ?? (step.failure ? 1 : 0), failure_signature: step.failure,
    retry_after: step.retryAfter ?? null, circuit_open: step.circuitOpen ?? false, state, attempt_count: step.attempts, cumulative_runtime_ms: step.runtimeMs ?? 0, fact_yield: step.factIds.length, last_progress_at: null }
}
export function legacyProjectInfo(p: Project, _historicalRun?: Run) {
  return { id: p.id, mode:p.mode, title: p.title, status: p.status, initial_mission_enabled: p.bootstrap, bootstrap_enabled: p.bootstrap, created_at: p.createdAt, planning_revision: p.planningRevision }
}
export function legacyProject(store: Store, id: string) {
  const graph = store.graph(id), p = graph.project, runs = store.runs(id)
  const decide = runs.find(r => r.activity === 'decide' && r.status === 'running'), latest = new Map<string, Run>()
  for (const run of runs) if (run.stepId) latest.set(run.stepId, run)
  const project = legacyProjectInfo(p, decide)
  return { project, facts: [...graph.facts.map(f => ({ id: f.id, description: f.description })), ...graph.goals.filter(g=>!g.parentId).map(g=>({id:g.id,description:g.description}))],
    intents: graph.steps.filter(s => !s.deleted).map(s => legacyIntent(s, latest.get(s.id))),
    hints: graph.hints.map(h => ({ id: h.id, content: h.content, creator: h.creator, created_at: h.createdAt })), blackboard_revision: p.revision }
}
export function legacySummary(store: Store, id: string) {
  const project = legacyProjectInfo(store.project(id), store.runsByStatus('running', id).find(r => r.activity === 'decide'))
  const counts = store.db.prepare(`SELECT SUM(kind='fact') AS facts, SUM(kind='step') AS steps,
    SUM(kind='step' AND status='running') AS working,
    SUM(kind='step' AND status IN ('pending','paused')) AS unclaimed,
    SUM(kind='hint') AS hints FROM nodes WHERE project_id=? AND ${ACTIVE_NODE_SQL}`).get(id)!
  return { ...project, fact_count: Number(counts.facts ?? 0) + 1, intent_count: Number(counts.steps ?? 0),
    working_intent_count: Number(counts.working ?? 0), unclaimed_intent_count: Number(counts.unclaimed ?? 0), hint_count: Number(counts.hints ?? 0) }
}
