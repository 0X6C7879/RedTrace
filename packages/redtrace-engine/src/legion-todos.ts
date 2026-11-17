import type { Store } from './store.ts'
import { HttpError, isScopeId } from './types.ts'
import type { Fact, Step } from './types.ts'

/** Per-Graph planning memory; never part of FGS. */
export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  acceptance?: string
  stepIds?: string[]
  factIds?: string[]
}

export class CommanderTodos {
  private readonly items = new Map<string, Todo[]>()
  private readonly store?: Store
  private readonly projectId?: string
  constructor(store?: Store, projectId?: string) { this.store=store; this.projectId=projectId }

  list(graphId: string): Todo[] {
    const row = this.store?.db.prepare('SELECT data FROM commander_todos WHERE project_id=? AND graph_id=?').get(this.projectId!, graphId)
    return (row ? JSON.parse(String(row.data)) as Todo[] : this.items.get(graphId) ?? []).map(item => structuredClone(item))
  }

  initialize(graphId: string, content: string) {
    const todos: Todo[] = [{ content, status: 'pending' }]
    if (this.store) this.store.db.prepare('INSERT OR IGNORE INTO commander_todos VALUES (?,?,?)').run(this.projectId!, graphId, JSON.stringify(todos))
    else if (!this.items.has(graphId)) this.items.set(graphId, todos)
  }

  replace(graphId: string, todos: Todo[], verify?: (fact: Fact) => void) {
    for (const item of todos) {
      if (item.status === 'completed' && (!item.acceptance?.trim() || !item.factIds?.length)) throw new HttpError(422, 'Completed Todo requires acceptance criteria and evidence-backed Fact IDs')
      if (!this.store) continue
      const scoped = this.store.forGraph(this.projectId!, graphId)
      for (const id of item.stepIds ?? []) scoped.node(this.projectId!, id, 'step')
      for (const id of item.factIds ?? []) {
        const fact = scoped.node<Fact>(this.projectId!, id, 'fact')
        if (isScopeId(id) || !fact.evidence.length) throw new HttpError(422, 'Todo requires actual target evidence, not Scope or a Worker claim')
        if (item.status === 'completed') {
          if (!fact.evidence.some(e => e.artifactId || e.runId && e.toolCallId)) throw new HttpError(422, 'Todo Fact must reference retained evidence or a real tool result')
          verify?.(fact)
        }
      }
    }
    const snapshot = structuredClone(todos)
    if (this.store) this.store.db.prepare('INSERT INTO commander_todos VALUES (?,?,?) ON CONFLICT(project_id,graph_id) DO UPDATE SET data=excluded.data').run(this.projectId!, graphId, JSON.stringify(snapshot))
    else this.items.set(graphId, snapshot)
  }
}

export const TASK_PLANNING_TOOLS = new Set(['TodoWrite', 'legion_todos', 'legion_goal', 'legion_update_goal', 'legion_accept', 'legion_confirm_transfer', 'legion_spawn', 'legion_step', 'legion_steps', 'legion_update_step', 'legion_task_stop'])

export function taskTodoPlanner(step: Step, store: Store): Step | undefined {
  if (!step.graphId) return undefined
  const candidates = store.forProject(step.projectId).nodes<Step>(step.projectId, ['step']).filter(s => s.graphId === step.graphId && !s.deleted && !s.parentStepId && !s.specialist && ['general', 'soldier'].includes(s.role ?? ''))
  // Once upgraded, only a General retains planning authority, including recovery and parking.
  const generals = candidates.filter(s => s.role === 'general')
  if (generals.length) return generals.find(s => !['done','cancelled'].includes(s.status)) ?? generals.at(-1)
  const soldiers = candidates.filter(s => s.status !== 'cancelled')
  return soldiers.find(s => s.status !== 'done') ?? soldiers[0]
}

export function taskTodoOwner(step: Step, store: Store): boolean {
  return taskTodoPlanner(step, store)?.id === step.id
}


/** The lifecycle's one-line Goal placeholder is not an authored attack plan. */
export function taskPlanReady(step: Step, store: Store): boolean {
  const todos=new CommanderTodos(store,step.projectId).list(step.graphId!)
  const goal=store.node<import('./types.ts').Goal>(step.projectId,store.projectGraph(step.projectId,step.graphId!).goalId,'goal')
  return todos.length>0 && !(todos.length===1&&todos[0].content===goal.description&&!todos[0].acceptance)
}
