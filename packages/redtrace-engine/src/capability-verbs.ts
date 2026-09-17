/**
 * The verb capability layer: a registry of action verbs the system can
 * perform, the adapters that serve them, and the dispatcher that maps a verb
 * call onto the best available channel. Agents describe WHAT they need
 * (remote.command, remote.file.read); the runtime decides HOW it runs by
 * reusing an existing WebShell / C2 session resource when one matches.
 *
 * Steps declare required verbs through `requires`; the runner exposes only
 * the matching verb tools to that Execute agent. Adapter availability is
 * gated by the Cordis plugin that owns the channel family, so stopping the
 * plugin removes its adapters from dispatch without touching this module.
 * @module redtrace-capability-verbs
 */

import { Type } from 'typebox'
import type { TSchema, Static } from 'typebox'
import type { AgentTool, AgentToolResult } from '@earendil-works/pi-agent-core'
import { resourceKinds } from './operations.ts'
import type { Operations } from './operations.ts'
import type { Router } from './http.ts'
import type { TaskContext } from './scheduler.ts'
import type { Step } from './types.ts'

export type VerbRisk = 'low' | 'medium' | 'high' | 'critical'

export interface VerbDefinition {
  /** Dotted verb id exposed to agents, e.g. `remote.command`. */
  id: string
  description: string
  risk: VerbRisk
  /** Operation task action the verb maps onto. */
  action: string
  parameters: TSchema
  /** Build the operation arguments from the tool call. */
  arguments: (args: Record<string, unknown>) => Record<string, unknown>
}

export interface AdapterDefinition {
  id: string
  label: string
  verbs: string[]
  /** Resource kinds this adapter routes verbs through. */
  kinds: string[]
  /** The Cordis plugin whose running state gates this adapter. */
  pluginId?: string
  /** Guidance returned when no channel exists yet. */
  establish: string
  /** Placeholder adapters declare verbs but dispatch nothing yet. */
  stub?: boolean
}

const timeoutSchema = Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 300 }))
const viaSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 64 }))
const targetSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 2048 }))
const pathSchema = Type.String({ minLength: 1, maxLength: 1024 })

const fileVerbs = ['remote.command']

const VERBS: readonly VerbDefinition[] = [
  {
    id: 'remote.task', action: 'task', risk: 'low',
    description: 'Poll one operation task: status, output, and result reference. Use it after an awaiting-approval submission or a still-running dispatch.',
    parameters: Type.Object({ task_id: Type.String({ minLength: 1, maxLength: 64 }) }),
    arguments: () => ({}),
  },
  {
    id: 'remote.command', action: 'command', risk: 'medium',
    description: 'Run a shell command on a remote target. The runtime reuses an existing WebShell or C2 session channel automatically; pass via (resource id) to force one, or target (host) to select by host. Establish a channel first (webshell_register, c2_session_create, or the Web UI resource page) when none exists.',
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), timeout: timeoutSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ command: args.command, timeout: args.timeout }),
  },
  {
    id: 'remote.file.read', action: 'read_file', risk: 'low',
    description: 'Read a remote file (base64) over an existing WebShell or C2 session channel; channel selection matches remote.command.',
    parameters: Type.Object({ path: pathSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path }),
  },
  {
    id: 'remote.file.write', action: 'write_file', risk: 'medium',
    description: 'Write text content to a remote file over an existing WebShell or C2 session channel; channel selection matches remote.command.',
    parameters: Type.Object({ path: pathSchema, content: Type.String({ minLength: 1 }), target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path, content_base64: Buffer.from(String(args.content), 'utf8').toString('base64') }),
  },
  {
    id: 'remote.file.list', action: 'list_files', risk: 'low',
    description: 'List a remote directory over an existing WebShell or C2 session channel; channel selection matches remote.command.',
    parameters: Type.Object({ path: pathSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path }),
  },
  {
    id: 'remote.file.mkdir', action: 'create_directory', risk: 'medium',
    description: 'Create a remote directory over an existing WebShell or C2 session channel; channel selection matches remote.command.',
    parameters: Type.Object({ path: pathSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path }),
  },
  {
    id: 'remote.file.touch', action: 'create_file', risk: 'medium',
    description: 'Create an empty remote file over an existing WebShell or C2 session channel; channel selection matches remote.command.',
    parameters: Type.Object({ path: pathSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path }),
  },
  {
    id: 'remote.file.move', action: 'move_file', risk: 'medium',
    description: 'Move or rename a remote file or directory over an existing WebShell or C2 session channel; channel selection matches remote.command.',
    parameters: Type.Object({ path: pathSchema, destination: Type.String({ minLength: 1, maxLength: 1024 }), target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path, destination: args.destination }),
  },
  {
    id: 'remote.file.delete', action: 'delete_file', risk: 'high',
    description: 'Delete a remote file or directory over an existing WebShell or C2 session channel. High risk: worker calls enter human approval. Channel selection matches remote.command.',
    parameters: Type.Object({ path: pathSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path }),
  },
]

const ADAPTERS: readonly AdapterDefinition[] = [
  {
    id: 'webshell', label: 'WebShell', pluginId: 'redtrace-webshell',
    verbs: [...fileVerbs, 'remote.file.read', 'remote.file.write', 'remote.file.list', 'remote.file.mkdir', 'remote.file.touch', 'remote.file.move', 'remote.file.delete', 'remote.task'],
    kinds: ['webshell'],
    establish: '先取得一个可用的 WebShell 并用 webshell_register 注册(或经 Web UI 资源页登记),即可自动复用。',
  },
  {
    id: 'c2', label: 'C2 会话', pluginId: 'redtrace-c2',
    verbs: [...fileVerbs, 'remote.file.read', 'remote.file.write', 'remote.file.list', 'remote.file.mkdir', 'remote.file.touch', 'remote.file.move', 'remote.file.delete', 'remote.task'],
    kinds: ['c2_session'],
    establish: '先创建 C2 listener 并等待会话上线(Web UI 运维页或 c2_* 工具),会话即成为可复用通道。',
  },
  {
    id: 'proxy', label: '代理/Pivot(占位)', stub: true, verbs: ['pivot.socks'],
    kinds: [],
    establish: '代理适配器尚未接入:chisel/ligolo 通道管理落地后可用(规划中)。',
  },
]

const STUB_VERBS: readonly VerbDefinition[] = [
  {
    id: 'pivot.socks', action: 'pivot.socks', risk: 'medium',
    description: 'Establish a SOCKS pivot through a managed proxy channel (placeholder; not yet dispatchable).',
    parameters: Type.Object({ target: targetSchema }),
    arguments: args => ({ ...args }),
  },
]

export const verbRegistry = [...VERBS, ...STUB_VERBS]
export const verbIds = verbRegistry.map(verb => verb.id)

export interface VerbRuntime {
  operations: Operations
  /** Live adapter gate: receives the owning Cordis plugin id. Adapters
   * without a plugin (or with no gate wired) stay available. */
  isAdapterAvailable?: (pluginId: string) => boolean
}

function adapterLive(adapter: AdapterDefinition, gate: (pluginId: string) => boolean): boolean {
  if (adapter.stub) return false
  return adapter.pluginId ? gate(adapter.pluginId) : true
}

function availableAdapters(runtime: VerbRuntime, verb: string): AdapterDefinition[] {
  const gate = runtime.isAdapterAvailable ?? (() => true)
  return ADAPTERS.filter(adapter => adapter.verbs.includes(verb) && adapterLive(adapter, gate))
}

/** Normalize a target or resource target down to a comparable host. */
function hostOf(value: string): string {
  const raw = value.trim()
  try { return new URL(raw).hostname.toLowerCase() } catch { /* not a URL */ }
  const hostPort = /^\[?([^\]]+?)\]?:(\d+)$/.exec(raw)
  return (hostPort ? hostPort[1] : raw).toLowerCase()
}

interface ChannelRow { id: string; kind: string; name: string; target: string; last_seen_at: string | null }

function candidateChannels(runtime: VerbRuntime, verb: string): ChannelRow[] {
  const kinds = [...new Set(availableAdapters(runtime, verb).flatMap(adapter => adapter.kinds))]
  if (!kinds.length) return []
  const rows = runtime.operations.store.db
    .prepare(`SELECT id,kind,name,target,last_seen_at FROM shared_resources WHERE kind IN (${kinds.map(() => '?').join(',')}) AND status='available' ORDER BY last_seen_at DESC`)
.all(...kinds) as unknown as ChannelRow[]
  return rows
}

export class VerbDispatchError extends Error {
  readonly hint: { available: Array<{ id: string; kind: string; target: string }>; establish: string[] }
  constructor(hint: { available: Array<{ id: string; kind: string; target: string }>; establish: string[] }, message: string) { super(message); this.hint = hint }
}

/** Pick the channel for one verb call: explicit `via`, host-matching
 * `target`, or the single unambiguous candidate. Never guesses silently. */
function selectChannel(runtime: VerbRuntime, verb: string, args: { via?: unknown; target?: unknown }): ChannelRow {
  const candidates = candidateChannels(runtime, verb)
  const listing = () => candidates.map(row => ({ id: row.id, kind: row.kind, target: row.target }))
  const establish = [...new Set(availableAdapters(runtime, verb).map(adapter => adapter.establish))]
  const fail = (message: string): never => { throw new VerbDispatchError({ available: listing(), establish }, message) }
  if (typeof args.via === 'string' && args.via !== '') {
    const chosen = candidates.find(row => row.id === args.via)
    if (!chosen) return fail(`Channel ${args.via} 不在可用通道列表内。`)
    return chosen
  }
  if (typeof args.target === 'string' && args.target.trim() !== '') {
    const wanted = hostOf(args.target)
    const matched = candidates.filter(row => row.target && hostOf(row.target) === wanted)
    if (!matched.length) return fail(`没有匹配目标 ${args.target} 的可用通道。`)
    return matched[0]!
  }
  if (candidates.length === 1) return candidates[0]!
  if (!candidates.length) return fail('当前没有可用通道。')
  return fail('存在多个可用通道,未指定 target 或 via,无法自动选择。')
}

const TERMINAL = ['succeeded', 'failed', 'cancelled', 'rejected']
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
  const abort = () => { clearTimeout(timer); reject(new Error('Operation cancelled')) }
  if (signal.aborted) abort()
  else signal.addEventListener('abort', abort, { once: true })
})

/** Dispatch one verb call through the operation queue: channel selection,
 * task creation (risk carries the approval policy), and in-process polling. */
export async function dispatchVerb(runtime: VerbRuntime, verb: string, args: Record<string, unknown>, context: { projectId: string; worker: string; stepId: string | null; signal: AbortSignal }) {
  const definition = verbRegistry.find(entry => entry.id === verb)
  if (!definition) throw new Error(`Unknown capability verb: ${verb}`)
  const adapters = availableAdapters(runtime, verb)
  const establish = [...new Set(ADAPTERS.filter(adapter => adapter.verbs.includes(verb)).map(adapter => adapter.establish))]
  if (!adapters.length) throw new VerbDispatchError({ available: [], establish }, `动词 ${verb} 当前没有可用适配器(插件已停用或尚未接入)。`)
  const channel = selectChannel(runtime, verb, args as { via?: unknown; target?: unknown })
  const task = runtime.operations.createTask(context.projectId, channel.id, {
    action: definition.action,
    arguments: definition.arguments(args),
    actor_type: 'worker',
    actor: context.worker,
    intent_id: context.stepId,
    risk: definition.risk,
  })
  const waitSeconds = Math.min(300, Math.max(30, Number(args.timeout ?? 60) + 30))
  const deadline = Date.now() + waitSeconds * 1000
  while (Date.now() < deadline && !context.signal.aborted) {
    await sleep(200, context.signal)
    const current = runtime.operations.task(task.id)
    if (current.status === 'awaiting_approval') {
      return { task_id: task.id, channel: { resource_id: channel.id, kind: channel.kind, target: channel.target }, status: current.status as string, note: '操作等待人工审批;审批后用 remote.task 查询结果。' }
    }
    if (TERMINAL.includes(current.status)) {
      const output = current.status === 'succeeded' ? String(current.output_summary ?? '') : undefined
      return { task_id: task.id, channel: { resource_id: channel.id, kind: channel.kind, target: channel.target }, status: current.status as string, output, result_ref: current.result_ref ?? null }
    }
  }
  return { task_id: task.id, channel: { resource_id: channel.id, kind: channel.kind, target: channel.target }, status: runtime.operations.task(task.id).status as string, note: '任务仍在排队或执行;稍后用 remote.task(task_id) 查询结果。' }
}

/** The polling verb registered alongside any dispatchable remote verb. */
export async function verbTask(runtime: VerbRuntime, taskId: string): Promise<Record<string, unknown>> {
  const task = runtime.operations.task(taskId)
  const result = task.status === 'succeeded'
    ? runtime.operations.store.db.prepare('SELECT content FROM operation_results WHERE task_id=?').get(task.id) as { content?: string } | undefined
    : undefined
  const output = result?.content && result.content.length > 64 * 1024 ? result.content.slice(0, 64 * 1024) + '\n[truncated]' : result?.content
  return { task_id: task.id, resource_id: task.resource_id, action: task.action, status: task.status, output: output ?? task.output_summary ?? null, result_ref: task.result_ref ?? null }
}

/** Available channels for a Step's declared verbs, for the launch prompt slice. */
export function channelsFor(runtime: VerbRuntime, requires: readonly string[], limit = 8) {
  const kinds = [...new Set(requires.flatMap(verb => availableAdapters(runtime, verb).flatMap(adapter => adapter.kinds)))]
  if (!kinds.length) return []
  const rows = runtime.operations.store.db
    .prepare(`SELECT id,kind,target,status FROM shared_resources WHERE kind IN (${kinds.map(() => '?').join(',')}) AND status='available' ORDER BY last_seen_at DESC LIMIT ?`)
    .all(...kinds, limit) as unknown as Array<{ id: string; kind: string; target: string; status: string }>
  return rows
}

// ─── Agent tool factory ───────────────────────────────────────────────────────

const toolName = (verb: string) => verb.replaceAll('.', '_')

function verbTool<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal) => unknown | Promise<unknown>): AgentTool<T> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, args, signal) => {
    const value = await execute(args, signal)
    return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value } as AgentToolResult<unknown>
  } }
}

const wrapDispatch = (runtime: VerbRuntime, context: TaskContext) => async (verb: string, args: Record<string, unknown>) => {
  try {
    return await dispatchVerb(runtime, verb, args, { projectId: context.run.projectId, worker: context.worker.name, stepId: context.run.stepId, signal: context.signal })
  } catch (error) {
    if (error instanceof VerbDispatchError) {
      return { error: error.message, available_channels: error.hint.available, establish: error.hint.establish }
    }
    throw error
  }
}

/** Build the verb tools a Step requires. remote.task is registered alongside
 * any dispatchable remote verb so approval waits and long tasks stay pollable. */
export function verbTools(context: TaskContext, runtime: VerbRuntime, step?: Step): AgentTool[] {
  const requires = step?.requires ?? []
  if (!requires.length) return []
  const dispatch = wrapDispatch(runtime, context)
  const tools: AgentTool[] = []
  for (const verb of verbRegistry) {
    if (!requires.includes(verb.id)) continue
    tools.push(verbTool(toolName(verb.id), verb.description, verb.parameters, async args => dispatch(verb.id, args as Record<string, unknown>)))
  }
  if (requires.some(verb => verb.startsWith('remote.')) && !requires.includes('remote.task')) {
    const task = verbRegistry.find(entry => entry.id === 'remote.task')!
    tools.push(verbTool('remote_task', task.description, task.parameters, async args => verbTask(runtime, String((args as Record<string, unknown>).task_id))))
  }
  return tools
}

// ─── Resource registry tools ──────────────────────────────────────────────────

const registerableKinds = resourceKinds.filter(kind => kind !== 'result')

/** The generic shared-resource registry surface: register (with secret),
 * list, and get. In-process over the Operations store; the results appear on
 * the Web UI resource pages exactly like human-created entries. Replaces the
 * retired redtrace-resource Cordis plugin. */
export function resourceTools(context: TaskContext, runtime: VerbRuntime): AgentTool[] {
  const ops = runtime.operations, worker = { actor_type: 'worker', actor: context.worker.name, worker: context.worker.name, intent_id: context.run.stepId }
  return [
    verbTool('resource_register',
      'Register a shared resource for cross-Step reuse: channels (webshell, c2_listener, c2_session), materials (c2_payload, c2_profile, credential_ref, proxy, file). secret stores credentials server-side (never returned); prefer the family tools (webshell_register, c2_session_create, c2_credential_create) for their structured forms. Everything registered here is visible on the operations pages.',
      Type.Object({
        kind: Type.Union(registerableKinds.map(kind => Type.Literal(kind))),
        name: Type.String({ minLength: 1, maxLength: 160 }),
        target: Type.Optional(Type.String({ maxLength: 4096 })),
        summary: Type.Optional(Type.String({ maxLength: 2000 })),
        metadata: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
        secret: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
      }),
      args => {
        if (!context.run.stepId) throw new Error('resource_register requires an active Step')
        const created = ops.create(context.run.projectId, { ...args, target: args.target ?? '', summary: args.summary ?? '', metadata: args.metadata ?? {}, secret: args.secret ?? {}, ...worker })
        return { resource: created.resource, ...(created.resource.kind === 'c2_session' && created.secret_once ? { secret_once: created.secret_once } : {}) }
      }),
    verbTool('resource_list',
      'List shared resources; filter by kind and a free-text query.',
      Type.Object({ kind: Type.Optional(Type.String()), q: Type.Optional(Type.String()), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      args => {
        const clauses: string[] = [], values: unknown[] = []
        if (typeof args.kind === 'string' && args.kind !== '') { clauses.push('kind=?'); values.push(args.kind) }
        if (typeof args.q === 'string' && args.q.trim() !== '') { clauses.push('(name LIKE ? OR target LIKE ? OR summary LIKE ?)'); values.push(...Array(3).fill(`%${args.q.trim()}%`)) }
        const rows = ops.store.db.prepare(`SELECT * FROM shared_resources ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ?`)
          .all(...values as never[], args.limit ?? 200) as unknown as Array<Record<string, unknown>>
        ops.audit(context.run.projectId, null, null, { actor_type: 'worker', actor: context.worker.name, intent_id: context.run.stepId }, 'resource.list', 'succeeded', { kinds: args.kind ? [args.kind] : [], count: rows.length })
        return { resources: rows.map(row => ops.publicResource(row)) }
      }),
    verbTool('resource_get',
      'Fetch one shared resource with its recent operation tasks and audit trail.',
      Type.Object({ resource_id: Type.String({ minLength: 1, maxLength: 64 }) }),
      args => {
        const row = ops.resource(String(args.resource_id))
        return {
          resource: ops.publicResource(row),
          tasks: (ops.store.db.prepare('SELECT * FROM operation_tasks WHERE resource_id=? ORDER BY created_at DESC LIMIT 50').all(row.id) as unknown as Array<Record<string, unknown>>).map(task => ops.publicTask(task)),
          audit: (ops.store.db.prepare('SELECT * FROM resource_audit_events WHERE resource_id=? ORDER BY id DESC LIMIT 100').all(row.id) as unknown as Array<Record<string, unknown>>).map(({ detail_json, ...event }) => ({ ...event, detail: JSON.parse(String(detail_json)) })),
        }
      }),
  ]
}

// ─── HTTP API ─────────────────────────────────────────────────────────────────

/** GET /capabilities/verbs: the registry with live adapter availability and
 * channel counts, for the capabilities page and Decide-side discovery. */
export function verbRoutes(router: Router, operations: Operations, isAdapterAvailable?: (adapter: string) => boolean) {
  const gate = isAdapterAvailable ?? (() => true)
  const runtime: VerbRuntime = { operations, isAdapterAvailable: gate }
  router.add('GET', '/capabilities/verbs', () => {
    const adapters = ADAPTERS.map(adapter => ({ id: adapter.id, label: adapter.label, verbs: adapter.verbs, kinds: adapter.kinds, plugin_id: adapter.pluginId ?? null, available: adapterLive(adapter, gate), stub: !!adapter.stub, establish: adapter.establish }))
    const verbs = verbRegistry.map(verb => {
      const serving = ADAPTERS.filter(adapter => adapter.verbs.includes(verb.id))
      return { id: verb.id, description: verb.description, risk: verb.risk, adapters: serving.map(adapter => adapter.id), available: serving.some(adapter => adapterLive(adapter, gate)), channels: candidateChannels(runtime, verb.id).length }
    })
    return { verbs, adapters }
  })
}
