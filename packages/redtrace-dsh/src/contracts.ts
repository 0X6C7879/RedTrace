/**
 * RedTrace Contract Tools plugin: the structured contract tools each task
 * type commits through. Mounted into every agent's scoped context by the
 * task presets; in transition/probe mode (no shared runtime state) the tools
 * fall back to REDTRACE_* environment variables.
 * @module redtrace-contracts
 */

import type { Json, RuntimeTask, TaskType } from './types.js'
import { state } from './state.js'

export const name = 'redtrace-contracts'
export const inject = ['tools']

export const CONTRACTS = {
  reason: ['redtrace_intent_create', 'redtrace_reason_noop', 'redtrace_project_complete'],
  bootstrap: ['redtrace_bootstrap_conclude'],
  explore: ['redtrace_explore_conclude'],
} as const

interface ToolExecution {
  readonly signal?: AbortSignal
  readonly agent?: { readonly id: string }
  concludeTurn?(): void
}

interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, Json>
  readonly output: {
    readonly schema: Record<string, Json>
    readonly render: (args: unknown, value: Json) => Array<{ type: 'text'; text: string }>
  }
  readonly execute: (args: Record<string, Json>, execution: ToolExecution) => Promise<Json>
}

export interface ToolContext {
  readonly tools: { register(definition: ToolDefinition): void }
  [key: string]: unknown
}

const text = { type: 'string' } as const
const stringList = {
  type: 'array',
  items: { type: 'string' },
} as const

function runtimeValue(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for RedTrace contract tools`)
  return value
}

export function taskFor(execution: ToolExecution, expected: TaskType | TaskType[]): RuntimeTask {
  const allowed = Array.isArray(expected) ? expected : [expected]
  const live = execution.agent === undefined
    ? undefined
    : state()?.tasks.get(String(execution.agent.id))
  if (live !== undefined) {
    if (!allowed.includes(live.type)) throw new Error(`${expected} contract is not available to ${live.type}`)
    return live
  }
  const type = runtimeValue('REDTRACE_TASK_TYPE') as TaskType
  if (!allowed.includes(type)) throw new Error(`${expected} contract is not available to ${type}`)
  return {
    type,
    projectId: runtimeValue('REDTRACE_PROJECT_ID'),
    intentId: process.env.REDTRACE_INTENT_ID,
    worker: runtimeValue('REDTRACE_WORKER'),
    maxIntents: Number(process.env.REDTRACE_REASON_MAX_INTENTS) || undefined,
    committed: false,
  }
}

export async function request(
  server: string,
  path: string,
  body: Record<string, Json>,
  signal?: AbortSignal,
): Promise<Json> {
  const response = await fetch(`${server}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  const payload = await response.json() as Json
  if (!response.ok) throw new Error(`RedTrace API ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}

export function server(task: RuntimeTask): string {
  return task.server ?? runtimeValue('REDTRACE_SERVER')
}

export function committed(task: RuntimeTask, value: Json): Json {
  task.committed = true
  return value
}

function register(ctx: ToolContext, definition: Omit<ToolDefinition, 'output'>): void {
  ctx.tools.register({
    ...definition,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  })
}

function registerReason(ctx: ToolContext): void {
  register(ctx, {
    name: 'redtrace_intent_create',
    description: 'Create one validated RedTrace Intent from existing Fact ids.',
    parameters: {
      type: 'object',
      properties: { from: stringList, description: text },
      required: ['from', 'description'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, 'reason')
      const value = await request(server(task), `/projects/${encodeURIComponent(task.projectId)}/intents`, {
        from: args.from,
        description: args.description,
        creator: task.worker,
        worker: null,
        ...(task.maxIntents === undefined ? {} : { max_active_intents: task.maxIntents }),
      }, execution.signal)
      execution.concludeTurn?.()
      return committed(task, value)
    },
  })
  register(ctx, {
    name: 'redtrace_reason_noop',
    description: 'Confirm that the current frontier needs no new Intent.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    async execute(_args, execution) {
      execution.concludeTurn?.()
      return committed(taskFor(execution, 'reason'), { accepted: true, data: {} })
    },
  })
  register(ctx, {
    name: 'redtrace_project_complete',
    description: 'Complete the project from validated source Fact ids.',
    parameters: {
      type: 'object',
      properties: { from: stringList, description: text },
      required: ['from', 'description'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, 'reason')
      const value = await request(server(task), `/projects/${encodeURIComponent(task.projectId)}/complete`, {
        from: args.from,
        description: args.description,
        worker: task.worker,
      }, execution.signal)
      execution.concludeTurn?.()
      return committed(task, value)
    },
  })
}

function registerConclude(ctx: ToolContext, type: 'bootstrap' | 'explore'): void {
  register(ctx, {
    name: type === 'bootstrap' ? 'redtrace_bootstrap_conclude' : 'redtrace_explore_conclude',
    description: `Atomically conclude the ${type} Intent as a formal Fact.`,
    parameters: {
      type: 'object',
      properties: { description: text },
      required: ['description'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, type)
      if (!task.intentId) throw new Error(`${type} contract requires an Intent`)
      const value = await request(
        server(task),
        `/projects/${encodeURIComponent(task.projectId)}/intents/${encodeURIComponent(task.intentId)}/conclude`,
        { worker: task.worker, description: args.description },
        execution.signal,
      )
      execution.concludeTurn?.()
      return committed(task, value)
    },
  })
}

export function apply(ctx: ToolContext, config: { types?: TaskType[] } = {}): void {
  const types = new Set(config.types)
  if (types.size === 0 || types.has('reason')) registerReason(ctx)
  if (types.size === 0 || types.has('bootstrap')) registerConclude(ctx, 'bootstrap')
  if (types.size === 0 || types.has('explore')) registerConclude(ctx, 'explore')
}
