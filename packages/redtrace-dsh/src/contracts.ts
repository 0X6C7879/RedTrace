/**
 * RedTrace Contract Tools plugin: the structured contract tools each task
 * type commits through. Mounted into every agent's scoped context by the
 * task presets; in transition/probe mode (no shared runtime state) the tools
 * fall back to REDTRACE_* environment variables.
 * @module redtrace-contracts
 */

import type { CapabilityName, Json, RuntimeTask, TaskType } from './types.js'
import { state } from './state.js'

export const name = 'redtrace-contracts'
export const inject = ['tools']

export const CONTRACTS = {
  reason: [
    'redtrace_intent_create', 'redtrace_reason_noop', 'redtrace_project_complete',
    'redtrace_graph_node', 'redtrace_graph_context', 'redtrace_graph_path',
  ],
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

const intentSourceList = {
  ...stringList,
  description: 'Existing source Fact ids only; never include goal. Initial projects use origin.',
} as const

export const CAPABILITY_NAMES = [
  'common', 'web', 'pentest', 'binary', 'crypto', 'cloud', 'blockchain',
  'hardware', 'ai-security', 'defense',
] as const satisfies readonly CapabilityName[]

const capabilityList: Json = {
  type: 'array',
  items: { type: 'string', enum: [...CAPABILITY_NAMES] as string[] },
  minItems: 1,
  uniqueItems: true,
}

const intentInput: Json = {
  type: 'object',
  properties: { from: intentSourceList, description: text, capabilities: capabilityList },
  required: ['from', 'description', 'capabilities'],
  additionalProperties: false,
}

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

async function query(task: RuntimeTask, pathname: string, signal?: AbortSignal): Promise<Json> {
  const response = await fetch(`${server(task)}${pathname}`, {
    headers: {
      'X-RedTrace-Worker': task.worker,
      'X-RedTrace-Task': task.type,
      ...(task.intentId === undefined ? {} : { 'X-RedTrace-Intent': task.intentId }),
    },
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
    description: 'Create one or more validated RedTrace Intents in one planning decision from existing Fact ids; use the intents array for parallel directions, and never use goal as a source.',
    parameters: {
      type: 'object',
      properties: { intents: { type: 'array', items: intentInput, minItems: 1 } },
      required: ['intents'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, 'reason')
      const batch = Array.isArray(args.intents)
      const inputs: Json[] = batch ? args.intents as Json[] : [args]
      const created: Json[] = []
      try {
        for (const input of inputs) {
          if (typeof input !== 'object' || input === null || Array.isArray(input)) {
            throw new Error('redtrace_intent_create intents must contain objects')
          }
          created.push(await request(server(task), `/projects/${encodeURIComponent(task.projectId)}/intents`, {
            from: input.from,
            description: input.description,
            capabilities: input.capabilities,
            creator: task.worker,
            worker: null,
            ...(task.maxIntents === undefined ? {} : { max_active_intents: task.maxIntents }),
          }, execution.signal))
        }
        execution.concludeTurn?.()
        return committed(task, batch ? { accepted: true, data: { intents: created } } : created[0])
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        if (detail.startsWith('RedTrace API ')) {
          return batch
            ? { accepted: false, error: detail, data: { intents: created } }
            : { accepted: false, error: detail }
        }
        throw error
      }
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
  register(ctx, {
    name: 'redtrace_graph_node',
    description: 'Recall one exact historical Fact, Intent, or Hint from the canonical Blackboard.',
    parameters: {
      type: 'object',
      properties: { node_id: text },
      required: ['node_id'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, 'reason')
      return query(task, `/projects/${encodeURIComponent(task.projectId)}/blackboard/nodes/${encodeURIComponent(String(args.node_id))}`, execution.signal)
    },
  })
  register(ctx, {
    name: 'redtrace_graph_context',
    description: 'Recall a bounded neighborhood around one Blackboard node when the current delta lacks needed history.',
    parameters: {
      type: 'object',
      properties: {
        node_id: text,
        depth: { type: 'integer', minimum: 0, maximum: 3 },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['node_id'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, 'reason')
      const params = new URLSearchParams()
      if (typeof args.depth === 'number') params.set('depth', String(args.depth))
      if (typeof args.limit === 'number') params.set('limit', String(args.limit))
      const suffix = params.size === 0 ? '' : `?${params}`
      return query(task, `/projects/${encodeURIComponent(task.projectId)}/blackboard/context/${encodeURIComponent(String(args.node_id))}${suffix}`, execution.signal)
    },
  })
  register(ctx, {
    name: 'redtrace_graph_path',
    description: 'Recall the directed Blackboard path between two known node ids.',
    parameters: {
      type: 'object',
      properties: { source: text, target: text },
      required: ['source', 'target'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, 'reason')
      const params = new URLSearchParams({ source: String(args.source), target: String(args.target) })
      return query(task, `/projects/${encodeURIComponent(task.projectId)}/blackboard/path?${params}`, execution.signal)
    },
  })
}

function registerConclude(ctx: ToolContext, type: 'bootstrap' | 'explore'): void {
  // Bootstrap may end the Project in the same commit: when the Goal is
  // confirmed satisfied it passes complete_description and the server
  // concludes the Intent as a Fact and completes the Project from it
  // atomically. Explore conclusions never carry completion.
  const bootstrap = type === 'bootstrap'
  register(ctx, {
    name: bootstrap ? 'redtrace_bootstrap_conclude' : 'redtrace_explore_conclude',
    description: bootstrap
      ? 'Atomically conclude the bootstrap Intent as a formal Fact. When the Goal is confirmed satisfied, also pass complete_description (why the confirmed results prove the Goal) to complete the Project directly.'
      : `Atomically conclude the ${type} Intent as a formal Fact.`,
    parameters: {
      type: 'object',
      properties: bootstrap
        ? { description: text, complete_description: text }
        : { description: text },
      required: ['description'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, type)
      if (!task.intentId) throw new Error(`${type} contract requires an Intent`)
      const value = await request(
        server(task),
        `/projects/${encodeURIComponent(task.projectId)}/intents/${encodeURIComponent(task.intentId)}/conclude`,
        {
          worker: task.worker,
          description: args.description,
          ...(bootstrap && typeof args.complete_description === 'string'
            ? { complete_description: args.complete_description }
            : {}),
        },
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
