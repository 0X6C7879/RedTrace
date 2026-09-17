import { Store } from './store.ts'
import type { Graph, Run, Step } from './types.ts'

export function legacyIntent(step: Step, run?: Run) {
  const state = { pending: 'open', running: 'working', paused: 'open', blocked: 'blocked', done: 'concluded', cancelled: 'dropped' }[step.status]
  return { id: step.id, from: step.sourceGoalId ? [step.sourceGoalId] : step.sourceIds, to: step.status === 'done' ? step.resultGoalId ?? step.factIds.at(-1) ?? null : null, description: step.description, creator: step.creator, worker: step.status === 'paused' ? null : step.worker,
    execution_profile: step.executionProfile, requires: step.requires ?? [], last_heartbeat_at: run ? run.heartbeatAt ?? run.startedAt : null,
    created_at: step.createdAt, concluded_at: step.endedAt, failure_count: step.failureCount ?? (step.failure ? 1 : 0), failure_signature: step.failure,
    retry_after: step.retryAfter ?? null, circuit_open: step.circuitOpen ?? false, state, attempt_count: step.attempts, cumulative_runtime_ms: step.runtimeMs ?? 0, fact_yield: step.factIds.length, last_progress_at: null }
}
export function legacyProject(store: Store, id: string) {
  const graph = store.graph(id), p = graph.project, runs = store.runs(id)
  const decide = runs.find(r => r.activity === 'decide' && r.status === 'running')
  const project = { id: p.id, title: p.title, status: p.status, bootstrap_enabled: p.bootstrap, created_at: p.createdAt,
    reason: decide ? { worker: decide.worker, trigger: decide.trigger ?? `planning_revision:${decide.baseRevision}`, started_at: decide.startedAt, last_heartbeat_at: decide.heartbeatAt ?? decide.startedAt } : null,
    reason_failure_count: p.failureCount ?? 0, reason_failure_signature: p.failureSignature ?? null, reason_retry_after: p.retryAfter ? p.retryAfter / 1000 : null, reason_circuit_open: p.circuitOpen ?? false,
    planning_revision: p.planningRevision, reason_evaluated_revision: p.decidedRevision, reason_context_revision: p.contextRevision ?? 0 }
  return { project, facts: [...graph.facts.map(f => ({ id: f.id, description: f.description })), { id: 'goal', description: graph.goals.find(g => g.id === 'goal')!.description }],
    intents: graph.steps.filter(s => !s.deleted).map(s => legacyIntent(s, runs.findLast(r => r.stepId === s.id))),
    hints: graph.hints.map(h => ({ id: h.id, content: h.content, creator: h.creator, created_at: h.createdAt })), blackboard_revision: p.revision }
}
export function legacySummary(store: Store, id: string) {
  const detail = legacyProject(store, id)
  return { ...detail.project, fact_count: detail.facts.length, intent_count: detail.intents.length,
    working_intent_count: detail.intents.filter(i => i.state === 'working').length, unclaimed_intent_count: detail.intents.filter(i => i.state === 'open').length, hint_count: detail.hints.length }
}
export function graphEdges(graph: Graph) {
  return graph.steps.filter(s => !s.deleted).flatMap(s => [...(s.sourceGoalId ? [s.sourceGoalId] : s.sourceIds).map(id => ({ from: id, to: s.id, relation: 'source' })), ...(s.resultGoalId ? [s.resultGoalId] : s.factIds).map(id => ({ from: s.id, to: id, relation: 'result' }))])
}
