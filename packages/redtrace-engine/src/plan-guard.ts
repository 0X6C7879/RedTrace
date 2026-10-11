import type { Store } from './store.ts'
import type { Goal, Step } from './types.ts'

/** Bind proposals, including PTC descendants, to the contract used by their model turn. */
export function createPlanGuard(store: Store, runId: string) {
  const roots = new Map<string, number>()
  let turnVersion = store.run(runId).boundStepVersion ?? 1
  const safe = new Set(['run_code', 'read_graph', 'read_graph_delta', 'evidence_read', 'sync_step', 'submit_fact', 'submit_finding'])
  return {
    beginTurn() { turnVersion = store.run(runId).boundStepVersion ?? 1 },
    settled(rootCallId: string) { roots.delete(rootCallId) },
    check(exec: { name: string; rootCallId: string }) {
      const run = store.run(runId)
      if (run.status !== 'running' || store.project(run.projectId).status !== 'active') return 'Activity has stopped'
      if (!run.stepId) return undefined
      const step = store.node<Step>(run.projectId, run.stepId, 'step')
      if (step.status !== 'running' || store.node<Goal>(run.projectId, step.goalId, 'goal').status !== 'open') return 'Step or Goal has stopped'
      const version = roots.get(exec.rootCallId) ?? turnVersion
      roots.set(exec.rootCallId, version)
      if (!safe.has(exec.name) && (version !== (step.planVersion ?? 1) || (run.boundStepVersion ?? 1) !== (step.planVersion ?? 1))) return `Plan changed: read_graph({id:${JSON.stringify(step.id)}}), then sync_step({planVersion:${step.planVersion ?? 1}}). Old call trees cannot execute actions after synchronization.`
      return undefined
    },
  }
}
