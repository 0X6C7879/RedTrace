/**
 * RedTrace Resource plugin: cross-Worker, cross-Session shared long-lived
 * domain state. Explore agents register non-secret reusable resources and
 * read them back (list/get); the context plugin injects the relevant
 * resource summary at agent startup so only full details need `get`.
 * @module redtrace-resource
 */

import type { Json, RuntimeTask, TaskType } from './types.js'
import { request, server, taskFor, type ToolContext } from './contracts.js'

export const name = 'redtrace-resource'
export const inject = ['tools']

const text = { type: 'string' } as const

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

function register(ctx: ToolContext, definition: Omit<ToolDefinition, 'output'>): void {
  ctx.tools.register({
    ...definition,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  })
}

async function get(
  task: RuntimeTask,
  path: string,
  signal?: AbortSignal,
): Promise<Json> {
  const response = await fetch(`${server(task)}${path}`, {
    headers: { 'x-redtrace-worker': task.worker },
    signal,
  })
  const payload = await response.json() as Json
  if (!response.ok) throw new Error(`RedTrace API ${response.status}: ${JSON.stringify(payload)}`)
  return payload
}

export function apply(ctx: ToolContext, config: { register?: boolean; types?: TaskType[] } = {}): void {
  const types: TaskType[] = config.types ?? ['bootstrap', 'explore']
  if (config.register !== false) {
    register(ctx, {
      name: 'redtrace_resource_register',
      description: 'Register a non-secret resource for sharing across Workers, Sessions, and Intents. kind must be one of: webshell, c2_listener, c2_session, c2_payload, c2_profile, proxy, file, credential_ref, result.',
      parameters: {
        type: 'object',
        properties: {
          kind: text,
          name: text,
          target: { type: 'string' },
          summary: { type: 'string' },
          metadata: { type: 'object', additionalProperties: true },
        },
        required: ['kind', 'name'],
        additionalProperties: false,
      },
      async execute(args, execution) {
        const task = taskFor(execution, types)
        if (!task.intentId) throw new Error('resource contract requires an Intent')
        return request(server(task), `/projects/${encodeURIComponent(task.projectId)}/resources`, {
          ...args,
          actor_type: 'worker',
          actor: task.worker,
          worker: task.worker,
          intent_id: task.intentId,
          publish_fact: false,
        }, execution.signal)
      },
    })
  }
  register(ctx, {
    name: 'redtrace_resource_list',
    description: 'List shared resources; filter by kind and a free-text query.',
    parameters: {
      type: 'object',
      properties: {
        kind: text,
        q: { type: 'string' },
        limit: { type: 'number' },
      },
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      const query = new URLSearchParams()
      if (typeof args.kind === 'string' && args.kind !== '') query.set('kind', args.kind)
      if (typeof args.q === 'string' && args.q !== '') query.set('q', args.q)
      if (typeof args.limit === 'number') query.set('limit', String(Math.min(500, Math.max(1, Math.floor(args.limit)))))
      return get(task, `/projects/${encodeURIComponent(task.projectId)}/resources${query.size > 0 ? `?${query}` : ''}`, execution.signal)
    },
  })
  register(ctx, {
    name: 'redtrace_resource_get',
    description: 'Fetch the full details of one shared resource by id.',
    parameters: {
      type: 'object',
      properties: { resource_id: text },
      required: ['resource_id'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      return get(
        task,
        `/projects/${encodeURIComponent(task.projectId)}/resources/${encodeURIComponent(String(args.resource_id))}`,
        execution.signal,
      )
    },
  })
}
