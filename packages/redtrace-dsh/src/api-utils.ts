/**
 * Shared plumbing for RedTrace worker-facing tools: the live-task lookup,
 * the engine HTTP helpers, and the ToolRuntime registration shape. The tools
 * themselves live in their provider plugins (redtrace-webshell,
 * redtrace-c2); this module carries the common vocabulary.
 * @module redtrace-api-utils
 */

import { domainTools } from './tool-domains.js'
import { load } from './loader.js'
import type { Json, RuntimeTask, TaskType } from './types.js'
import { state } from './state.js'

export interface ToolExecution {
  readonly signal?: AbortSignal
  readonly agent?: { readonly id: string }
  concludeTurn?(): void
}

export interface ToolDefinition {
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
  readonly tools: { register(definition: ToolDefinition & { redtrace: true }, options?: { when: () => boolean }): void }
  [key: string]: unknown
}

export const text = { type: 'string' } as const

export function register(ctx: ToolContext, definition: Omit<ToolDefinition, 'output'>, enabled?: (name: string) => boolean): void {
  ctx.tools.register({
    ...definition,
    redtrace: true,
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
  }, enabled ? { when: () => enabled(definition.name) } : undefined)
}

function runtimeValue(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required for RedTrace tools`)
  return value
}

/** Resolve the live RuntimeTask for a tool execution. Inside the engine host
 * the session's task is read from the shared index; the REDTRACE_* env
 * fallback only covers tool-level checks without a runtime. */
export function taskFor(execution: ToolExecution, expected: TaskType | TaskType[]): RuntimeTask {
  const allowed = Array.isArray(expected) ? expected : [expected]
  const live = execution.agent === undefined
    ? undefined
    : state()?.tasks.get(String(execution.agent.id))
  if (live !== undefined) {
    if (!allowed.includes(live.type)) throw new Error(`${expected} tools are not available to ${live.type}`)
    return live
  }
  const type = runtimeValue('REDTRACE_TASK_TYPE') as TaskType
  if (!allowed.includes(type)) throw new Error(`${expected} tools are not available to ${type}`)
  return {
    type,
    projectId: runtimeValue('REDTRACE_PROJECT_ID'),
    intentId: process.env.REDTRACE_INTENT_ID,
    worker: runtimeValue('REDTRACE_WORKER'),
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

/** Read from the engine API with the RedTrace worker identity headers. */
export async function query(
  task: RuntimeTask,
  pathname: string,
  signal?: AbortSignal,
): Promise<Json> {
  const response = await fetch(`${serverOf(task)}${pathname}`, {
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

export function serverOf(task: RuntimeTask): string {
  return task.server ?? runtimeValue('REDTRACE_SERVER')
}

export function registerDomain(ctx:ToolContext, definitions:Omit<ToolDefinition,'output'>[], enabled?:(name:string)=>boolean) {
  const actions=definitions.map(definition=>({...definition,async execute(args:Record<string,Json>,execution:ToolExecution){
    const {validateJsonSchemaValue}=await load('vendor/deepseek-harness/packages/core/tools/lib/index.js')
    const errors=validateJsonSchemaValue({...definition.parameters,additionalProperties:false},args,'arguments')
    if(errors.length)throw new Error(errors.join('; '))
    return definition.execute(args,execution)
  }}))
  for(const tool of domainTools(actions,enabled))register(ctx,tool,enabled)
}
