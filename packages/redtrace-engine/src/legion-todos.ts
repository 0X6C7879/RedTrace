/** ARTEX Planner scratchpad: memory only, one list per Graph in one Commander runtime. */
export interface Todo {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
}

export class CommanderTodos {
  private readonly items = new Map<string, Todo[]>()

  list(graphId: string): Todo[] {
    return (this.items.get(graphId) ?? []).map(item => ({ ...item }))
  }

  replace(graphId: string, todos: Todo[]) {
    this.items.set(graphId, todos.map(item => ({ ...item })))
  }
}
