import type { Store } from './store.ts'
import type { Step } from './types.ts'

/** Per-Graph planning memory; never part of FGS. */
export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export class CommanderTodos {
  private readonly items = new Map<string, Todo[]>()
  private readonly store?: Store
  private readonly projectId?: string
  constructor(store?: Store, projectId?: string) { this.store=store; this.projectId=projectId }

  list(graphId: string): Todo[] {
    const row = this.store?.db.prepare('SELECT data FROM commander_todos WHERE project_id=? AND graph_id=?').get(this.projectId!, graphId)
    return (row ? JSON.parse(String(row.data)) as Todo[] : this.items.get(graphId) ?? []).map(item => ({ ...item }))
  }

  replace(graphId: string, todos: Todo[]) {
    const snapshot = todos.map(item => ({ ...item }))
    if (this.store) this.store.db.prepare('INSERT INTO commander_todos VALUES (?,?,?) ON CONFLICT(project_id,graph_id) DO UPDATE SET data=excluded.data').run(this.projectId!, graphId, JSON.stringify(snapshot))
    else this.items.set(graphId, snapshot)
  }
}

export function taskTodoOwner(step: Step): boolean {
  return !!step.graphId && !step.parentStepId && step.role === 'general'
}
