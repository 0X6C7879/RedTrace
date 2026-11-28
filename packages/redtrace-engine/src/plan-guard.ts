import { createRequire } from 'node:module'
import {originalTool} from '../../redtrace-dsh/src/tool-domains.ts'
import { isReportStep } from '../../redtrace-dsh/src/roles.ts'
import { taskTodoOwner, taskPlanReady } from './legion-todos.ts'
import type { Store } from './store.ts'
import type { Goal, Step } from './types.ts'

/** Bind proposals, including nested tool calls, to the contract used by their model turn. */
export function createPlanGuard(store: Store, runId: string) {
  const { NativePlanGuard } = createRequire(import.meta.url)('./native/redtrace_native.node') as { NativePlanGuard: new (version: number) => { beginTurn(version: number): void; settled(root: string): void; check(name: string, root: string, required: boolean, ready: boolean, version: number, bound: number, id: string): string | null } }
  const guard = new NativePlanGuard(store.run(runId).boundStepVersion ?? 1)
  return {
    beginTurn() { guard.beginTurn(store.run(runId).boundStepVersion ?? 1) },
    settled(rootCallId: string) { guard.settled(rootCallId) },
    check(exec: { name: string; rootCallId: string; arguments?:Record<string,unknown> }) {
      const name=originalTool(exec.name,exec.arguments?.action)??exec.name
      const run = store.run(runId)
      if (run.status !== 'running') return 'Activity has stopped'
      if (!run.stepId) return undefined
      const step = store.node<Step>(run.projectId, run.stepId, 'step')
      const status = store.project(run.projectId).status
      if (!(isReportStep(step) ? ['active','completed'].includes(status) : status === 'active')) return 'Activity has stopped'
      if (step.status !== 'running' || !isReportStep(step) && store.node<Goal>(run.projectId, step.goalId, 'goal').status !== 'open') return 'Step or Goal has stopped'
      const required = store.project(run.projectId).mode === 'benchmark' && taskTodoOwner(step, store)
      return guard.check(name, exec.rootCallId, required, !required || taskPlanReady(step, store), step.planVersion ?? 1, run.boundStepVersion ?? 1, JSON.stringify(step.id)) ?? undefined
    },
  }
}
