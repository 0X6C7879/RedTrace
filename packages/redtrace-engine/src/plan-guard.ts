import {originalTool} from '../../redtrace-dsh/src/tool-domains.ts'
import { isReportStep } from '../../redtrace-dsh/src/roles.ts'
import { taskTodoOwner, taskPlanReady } from './legion-todos.ts'
import type { Store } from './store.ts'
import type { Goal, Step } from './types.ts'

/** Bind proposals, including nested tool calls, to the contract used by their model turn. */
export function createPlanGuard(store: Store, runId: string) {
  const roots = new Map<string, number>()
  let turnVersion = store.run(runId).boundStepVersion ?? 1
  const safe = new Set(['read_graph', 'read_graph_delta', 'evidence_read', 'sync_step', 'submit_fact', 'submit_finding'])
  return {
    beginTurn() { turnVersion = store.run(runId).boundStepVersion ?? 1 },
    settled(rootCallId: string) { roots.delete(rootCallId) },
    check(exec: { name: string; rootCallId: string; arguments?:Record<string,unknown> }) {
      const name=originalTool(exec.name,exec.arguments?.action)??exec.name
      const run = store.run(runId)
      if (run.status !== 'running') return 'Activity has stopped'
      if (!run.stepId) return undefined
      const step = store.node<Step>(run.projectId, run.stepId, 'step')
      const status = store.project(run.projectId).status
      if (!(isReportStep(step) ? ['active','completed'].includes(status) : status === 'active')) return 'Activity has stopped'
      if (step.status !== 'running' || !isReportStep(step) && store.node<Goal>(run.projectId, step.goalId, 'goal').status !== 'open') return 'Step or Goal has stopped'
      if(store.project(run.projectId).mode==='benchmark'&&taskTodoOwner(step,store)&&!taskPlanReady(step,store)&&!safe.has(name)&&!name.startsWith('legion_')&&name!=='TodoWrite')return '执行前由任务 Planner 用 TodoWrite 写实际阶段/验收标准；初始 Goal 占位不算计划。'
      const version = roots.get(exec.rootCallId) ?? turnVersion
      roots.set(exec.rootCallId, version)
      if (!safe.has(name) && (version !== (step.planVersion ?? 1) || (run.boundStepVersion ?? 1) !== (step.planVersion ?? 1))) return `Plan changed: fgs_query({action:"overview",id:${JSON.stringify(step.id)}}), then sync_step({planVersion:${step.planVersion ?? 1}}). Old call trees cannot execute actions after synchronization.`
      return undefined
    },
  }
}
