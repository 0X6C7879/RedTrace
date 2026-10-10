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
import { operationSupported } from './operation-execution.ts'
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
  /** Additional runtime plugins that must also be live. */
  requiresPlugins?: string[]
  /** Guidance returned when no channel exists yet. */
  establish: string
  /** Placeholder adapters declare verbs but dispatch nothing yet. */
  stub?: boolean
}

const timeoutSchema = Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 300 }))
const viaSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 64 }))
const targetSchema = Type.Optional(Type.String({ minLength: 1, maxLength: 2048 }))
const pathSchema = Type.String({ minLength: 1, maxLength: 1024 })
const fencingSchema = Type.Integer({ minimum: 1 })

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
    description: 'Run a shell command on a remote target. The runtime reuses an available channel automatically; pass via (resource id) to force one, or target (host) to select by host. Establish a supported channel first when none exists.',
    parameters: Type.Object({ command: Type.String({ minLength: 1 }), cwd: Type.Optional(pathSchema), timeout: timeoutSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ command: args.command, cwd: args.cwd, timeout: args.timeout }),
  },
  {
    id: 'remote.session.probe', action: 'probe_info', risk: 'low',
    description: 'Probe a registered channel for minimal host, identity, working-directory, and architecture data; successful output promotes only runtime-verified capabilities.',
    parameters: Type.Object({ timeout: timeoutSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ timeout: args.timeout }),
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
    parameters: Type.Object({ path: pathSchema, content: Type.String(), overwrite: Type.Optional(Type.Boolean()), target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path, overwrite: args.overwrite === true, content_base64: Buffer.from(String(args.content), 'utf8').toString('base64') }),
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
    id: 'remote.file.stat', action: 'stat_file', risk: 'low',
    description: 'Read remote file metadata through a channel that has verified file capability.',
    parameters: Type.Object({ path: pathSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path }),
  },
  {
    id: 'remote.file.hash', action: 'hash_file', risk: 'low',
    description: 'Calculate a remote file SHA-256 through a channel that has verified file capability.',
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
  {
    id: 'remote.file.upload', action: 'upload_file', risk: 'medium',
    description: 'Upload a managed File resource through verified SFTP with resumable temporary transfer, SHA-256 verification, and atomic publication.',
    parameters: Type.Object({ artifact_id: Type.String({ minLength: 1, maxLength: 64 }), path: pathSchema, overwrite: Type.Optional(Type.Boolean()), timeout: timeoutSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ artifact_id: args.artifact_id, path: args.path, overwrite: args.overwrite === true, timeout: args.timeout }),
  },
  {
    id: 'remote.file.download', action: 'download_file', risk: 'low',
    description: 'Download a remote file through verified SFTP into the controlled Artifact store and return a reusable File resource.',
    parameters: Type.Object({ path: pathSchema, timeout: timeoutSchema, target: targetSchema, via: viaSchema }),
    arguments: args => ({ path: args.path, timeout: args.timeout }),
  },
  {
    id: 'remote.terminal.open', action: 'terminal.open', risk: 'medium', description: 'Open a persistent SSH terminal resource and acquire its exclusive write lease.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), name: Type.Optional(Type.String()), rows: Type.Optional(Type.Integer({ minimum: 2, maximum: 500 })), cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 1000 })), ttl_seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 3600 })) }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.read', action: 'terminal.read', risk: 'low', description: 'Read bounded remote terminal output from a cursor.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), cursor: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 262144 })) }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.claim', action: 'terminal.claim', risk: 'medium', description: 'Claim an existing persistent terminal for this Run and receive a fresh fencing token.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), ttl_seconds: Type.Optional(Type.Integer({ minimum: 5, maximum: 3600 })) }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.release', action: 'terminal.release', risk: 'low', description: 'Release this Run’s terminal lease without closing the remote terminal.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), fencing_token: fencingSchema }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.send', action: 'terminal.send', risk: 'medium', description: 'Write to a persistent terminal using its live fencing token.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), data: Type.String(), fencing_token: fencingSchema, cursor: Type.Optional(Type.Integer({ minimum: 0 })) }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.expect', action: 'terminal.expect', risk: 'low', description: 'Wait for literal bounded terminal text and distinguish match, timeout, and EOF.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), text: Type.String({ minLength: 1, maxLength: 4096 }), cursor: Type.Optional(Type.Integer({ minimum: 0 })), timeout: timeoutSchema }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.resize', action: 'terminal.resize', risk: 'low', description: 'Resize a persistent PTY using its live fencing token.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), rows: Type.Integer({ minimum: 2, maximum: 500 }), cols: Type.Integer({ minimum: 2, maximum: 1000 }), fencing_token: fencingSchema }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.signal', action: 'terminal.signal', risk: 'medium', description: 'Send an allowed POSIX signal to a persistent terminal.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), signal: Type.Union(['INT', 'TERM', 'HUP', 'KILL', 'QUIT'].map(v => Type.Literal(v))), fencing_token: fencingSchema }), arguments: args => ({ ...args }),
  },
  {
    id: 'remote.terminal.close', action: 'terminal.close', risk: 'medium', description: 'Close a persistent terminal using its live fencing token.',
    parameters: Type.Object({ via: Type.String({ minLength: 1 }), fencing_token: fencingSchema }), arguments: args => ({ ...args }),
  },
]

const ADAPTERS: readonly AdapterDefinition[] = [
  {
    id: 'webshell', label: 'WebShell', pluginId: 'redtrace-webshell',
    verbs: [...fileVerbs, 'remote.file.read', 'remote.file.write', 'remote.file.list', 'remote.file.mkdir', 'remote.file.touch', 'remote.file.stat', 'remote.file.hash', 'remote.file.move', 'remote.file.delete', 'remote.task'],
    kinds: ['webshell'],
    establish: '先取得一个可用的 WebShell 并用 webshell_register 注册(或经 Web UI 资源页登记),即可自动复用。',
  },
  {
    id: 'c2', label: 'C2 会话', pluginId: 'redtrace-c2',
    verbs: [...fileVerbs, 'remote.file.read', 'remote.file.write', 'remote.file.list', 'remote.file.mkdir', 'remote.file.touch', 'remote.file.stat', 'remote.file.hash', 'remote.file.move', 'remote.file.delete', 'remote.task'],
    kinds: ['c2_session'],
    establish: '先创建 C2 listener 并等待会话上线(Web UI 运维页或 c2_* 工具),会话即成为可复用通道。',
  },
  {
    id: 'ssh-sftp', label: 'SSH/SFTP', pluginId: 'redtrace-c2',
    verbs: ['remote.file.upload', 'remote.file.download'], kinds: ['c2_session'],
    establish: '先验证 direct SSH Session 的 SFTP 子系统，再使用受控 Artifact 进行上传或下载。',
  },
  {
    id: 'session-probe-webshell', label: 'WebShell 会话探测', pluginId: 'redtrace-session-probe', requiresPlugins: ['redtrace-webshell'],
    verbs: ['remote.session.probe'], kinds: ['webshell'],
    establish: '先登记 WebShell 配置，再通过 remote.session.probe 验证真实能力。',
  },
  {
    id: 'session-probe-c2', label: 'C2 会话探测', pluginId: 'redtrace-session-probe', requiresPlugins: ['redtrace-c2'],
    verbs: ['remote.session.probe'], kinds: ['c2_session'],
    establish: '先等待 C2/SSH 会话真实上线，再通过 remote.session.probe 验证。',
  },
  {
    id: 'proxy', label: '代理/Pivot', pluginId: 'redtrace-pivot', verbs: ['pivot.socks', 'pivot.validate', 'pivot.paths', 'pivot.close'],
    kinds: ['proxy'],
    establish: '使用 pivot.socks 建立受管 SSH Forward、Chisel 或 Ligolo 路径。',
  },
  {
    id: 'remote-terminal', label: '远程终端', pluginId: 'redtrace-remote-terminal',
    verbs: ['remote.terminal.open', 'remote.terminal.read', 'remote.terminal.claim', 'remote.terminal.release', 'remote.terminal.send', 'remote.terminal.expect', 'remote.terminal.resize', 'remote.terminal.signal', 'remote.terminal.close'],
    kinds: ['c2_session', 'terminal'], establish: '先登记并验证 SSH Session，再用 remote.terminal.open 建立跨 Step 终端。',
  },
]

const STUB_VERBS: readonly VerbDefinition[] = [
  {
    id: 'pivot.socks', action: 'pivot.socks', risk: 'medium',
    description: 'Establish a managed SSH Forward or Chisel process (Ligolo is disabled). Worker calls require matching project preauthorization.',
    parameters: Type.Object({ provider: Type.Union(['ssh-forward', 'chisel'].map(v => Type.Literal(v))), socks_endpoint: Type.Optional(Type.String()), source_session_id: Type.Optional(Type.String()), mode: Type.Optional(Type.Union([Type.Literal('server'), Type.Literal('client')])), bind: Type.Optional(Type.String()), bind_host: Type.Optional(Type.String()), bind_port: Type.Optional(Type.Integer()), server: Type.Optional(Type.String()), remote: Type.Optional(Type.String()), target_scope: Type.Optional(Type.String()), protocols: Type.Optional(Type.Array(Type.Union([Type.Literal('tcp'), Type.Literal('udp')]))), name: Type.Optional(Type.String()) }),
    arguments: args => ({ ...args }),
  },
  { id: 'pivot.validate', action: 'pivot.validate', risk: 'low', description: 'Validate the actual managed route endpoint.', parameters: Type.Object({ via: Type.String(), host: Type.Optional(Type.String()), port: Type.Optional(Type.Integer({ minimum: 1, maximum: 65535 })), url: Type.Optional(Type.String()), timeout: timeoutSchema }), arguments: args => ({ ...args }) },
  { id: 'pivot.paths', action: 'pivot.paths', risk: 'low', description: 'List live directional routes matching a target scope.', parameters: Type.Object({ target: Type.String() }), arguments: args => ({ ...args }) },
  { id: 'pivot.close', action: 'pivot.close', risk: 'medium', description: 'Stop a managed route and mark it offline.', parameters: Type.Object({ via: Type.String() }), arguments: args => ({ ...args }) },
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
  return (!adapter.pluginId || gate(adapter.pluginId)) && (adapter.requiresPlugins ?? []).every(gate)
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

interface ChannelRow { id: string; kind: string; name: string; target: string; last_seen_at: string | null; metadata_json: string }

function channelSupports(row: ChannelRow, verb: string): boolean {
  const metadata = JSON.parse(row.metadata_json || '{}'), verified = Array.isArray(metadata.verified_capabilities) ? metadata.verified_capabilities : undefined
  if (verb === 'pivot.validate' || verb === 'pivot.close') return row.kind === 'proxy'
  if (verb === 'remote.terminal.open') return row.kind === 'c2_session' && metadata.connection_type === 'direct' && metadata.shell_type === 'ssh' && verified?.includes('remote.command') === true
  if (verb.startsWith('remote.terminal.')) return row.kind === 'terminal' && metadata.interactive === true
  if (verb === 'remote.session.probe') return row.kind === 'webshell' || metadata.connection_type === 'direct' && metadata.shell_type === 'ssh' || (metadata.reported_capabilities ?? metadata.capabilities ?? []).includes('command')
  if (row.kind === 'c2_session' && verb.startsWith('remote.file.') && !['direct', 'external_c2'].includes(metadata.connection_type)) return false
  if (verified) return verified.includes(verb)
  return false
}

function candidateChannels(runtime: VerbRuntime, verb: string, projectId?: string): ChannelRow[] {
  const kinds = [...new Set(availableAdapters(runtime, verb).flatMap(adapter => adapter.kinds))]
  if (!kinds.length) return []
  const rows = runtime.operations.store.db
    .prepare(`SELECT id,kind,name,target,last_seen_at,metadata_json FROM shared_resources WHERE kind IN (${kinds.map(() => '?').join(',')}) AND (status='available' ${verb==='pivot.validate' ? "OR status='degraded'" : ''}) ORDER BY last_seen_at DESC`)
    .all(...kinds) as unknown as ChannelRow[]
  const action = verbRegistry.find(entry => entry.id === verb)?.action
  return rows.filter(row => {
    const resource = runtime.operations.resource(row.id)
    return (projectId === undefined || resource.project_id === null || resource.project_id === projectId)
      && channelSupports(row, verb)
      && (!action || action.startsWith('pivot.') || action.startsWith('terminal.') || operationSupported(resource, action))
  })
}

export class VerbDispatchError extends Error {
  readonly hint: { available: Array<{ id: string; kind: string; target: string }>; establish: string[] }
  constructor(hint: { available: Array<{ id: string; kind: string; target: string }>; establish: string[] }, message: string) { super(message); this.hint = hint }
}

/** Pick the channel for one verb call: explicit `via`, host-matching
 * `target`, or the single unambiguous candidate. Never guesses silently. */
function selectChannel(runtime: VerbRuntime, verb: string, args: { via?: unknown; target?: unknown }, projectId?: string): ChannelRow {
  const candidates = candidateChannels(runtime,verb,projectId)
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
    if (matched.length > 1) return fail(`目标 ${args.target} 有多个真实可用通道，请显式指定 via。`)
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
export async function dispatchVerb(runtime: VerbRuntime, verb: string, args: Record<string, unknown>, context: { projectId: string; worker: string; stepId: string | null; runId?: string; signal: AbortSignal }): Promise<any> {
  const definition = verbRegistry.find(entry => entry.id === verb)
  if (!definition) throw new Error(`Unknown capability verb: ${verb}`)
  if (verb === 'remote.task') return verbTask(runtime, String(args.task_id ?? ''))
  const adapters = availableAdapters(runtime, verb)
  const establish = [...new Set(ADAPTERS.filter(adapter => adapter.verbs.includes(verb)).map(adapter => adapter.establish))]
  if (!adapters.length) throw new VerbDispatchError({ available: [], establish }, `动词 ${verb} 当前没有可用适配器(插件已停用或尚未接入)。`)
  if (verb === 'pivot.socks') {
    const source = typeof args.source_session_id === 'string' ? runtime.operations.resource(args.source_session_id) : { id: '', target: String(args.target_scope ?? '') }
    if ('project_id' in source && source.project_id !== null && source.project_id !== context.projectId) throw new Error('Source session belongs to another project')
    if (!runtime.operations.authorized(context.projectId, 'pivot.open', source)) return { status: 'authorization_required', error_code: 'AUTH_FAILED', note: 'A trusted human must issue a matching project authorization before a worker opens a route.' }
    return runtime.operations.pivots.open(context.projectId, { ...args, actor_type: 'worker', actor: context.worker })
  }
  if (verb === 'pivot.paths') return { target: args.target, paths: runtime.operations.pivots.paths(context.projectId, String(args.target)) }
  const channel = selectChannel(runtime,verb,args as {via?:unknown;target?:unknown},context.projectId)
  const resource = runtime.operations.resource(channel.id)
  if (resource.project_id !== null && resource.project_id !== context.projectId) throw new Error('Channel belongs to another project')
  runtime.operations.available(resource,{actor_type:'worker',actor:context.worker})
  if (verb === 'pivot.validate') {
    const lease=runtime.operations.lease(resource,{owner_type:'worker',owner:context.worker,run_id:context.runId,ttl_seconds:60})
    try { return await runtime.operations.pivots.validate(channel.id,args) }
    finally { runtime.operations.releaseLease(runtime.operations.resource(channel.id),{actor_type:'worker',actor:context.worker,fencing_token:lease.fencing_token}) }
  }
  if (verb === 'pivot.close') return { route_id: channel.id, closed: await runtime.operations.pivots.close(channel.id) }
  if (verb.startsWith('remote.terminal.')) {
    const actor = { actor_type: 'worker', actor: context.worker }
    if (!runtime.operations.authorized(context.projectId, definition.action, runtime.operations.resource(channel.id))) throw new Error('Remote terminal operation requires explicit project authorization')
    if (verb === 'remote.terminal.open') return runtime.operations.terminals.open(context.projectId, channel.id, { ...args, ...actor, run_id: context.runId })
    if (verb === 'remote.terminal.read') return runtime.operations.terminals.read(channel.id, Number(args.cursor ?? 0), Number(args.limit ?? 65536))
    if (verb === 'remote.terminal.claim') return { terminal_id: channel.id, lease: runtime.operations.lease(resource, { owner_type: 'worker', owner: context.worker, run_id: context.runId, ttl_seconds: Number(args.ttl_seconds ?? 120) }) }
    if (verb === 'remote.terminal.release') { runtime.operations.releaseLease(resource, { ...actor, fencing_token: args.fencing_token }); return { terminal_id: channel.id, released: true } }
    if (verb === 'remote.terminal.send') return runtime.operations.terminals.send(channel.id, { ...args, ...actor })
    if (verb === 'remote.terminal.expect') return runtime.operations.terminals.expect(channel.id, args)
    if (verb === 'remote.terminal.resize') return runtime.operations.terminals.resize(channel.id, { ...args, ...actor })
    if (verb === 'remote.terminal.signal') return runtime.operations.terminals.signal(channel.id, { ...args, ...actor })
    if (verb === 'remote.terminal.close') return { terminal_id: channel.id, closed: await runtime.operations.terminals.close(channel.id, 'agent request', { ...args, ...actor }) }
  }
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
      return { task_id: task.id, attempt_id: current.attempt_id, channel: { resource_id: channel.id, kind: channel.kind, target: channel.target }, status: current.status as string, output, result: JSON.parse(current.result_json || '{}'), result_ref: current.result_ref ?? null }
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
  return { task_id: task.id, attempt_id: task.attempt_id, resource_id: task.resource_id, action: task.action, status: task.status, output: output ?? task.output_summary ?? null, result: JSON.parse(task.result_json || '{}'), result_ref: task.result_ref ?? null }
}

/** Available channels for a Step's declared verbs, for the launch prompt slice. */
export function channelsFor(runtime: VerbRuntime, requires: readonly string[], limit = 8, projectId?: string) {
  const kinds = [...new Set(requires.flatMap(verb => availableAdapters(runtime, verb).flatMap(adapter => adapter.kinds)))]
  if (!kinds.length) return []
  const rows = runtime.operations.store.db
    .prepare(`SELECT id,kind,name,target,status,last_seen_at,metadata_json FROM shared_resources WHERE kind IN (${kinds.map(() => '?').join(',')}) AND status='available' ORDER BY last_seen_at DESC`)
    .all(...kinds) as unknown as Array<ChannelRow & { status: string }>
  return rows.filter(row => (projectId === undefined || runtime.operations.resource(row.id).project_id === null || runtime.operations.resource(row.id).project_id === projectId) && requires.some(verb => channelSupports(row, verb))).slice(0, limit).map(({ metadata_json: _metadata, name: _name, last_seen_at: _seen, ...row }) => row)
}

// ─── Agent tool factory ───────────────────────────────────────────────────────

const toolName = (verb: string) => verb.replaceAll('.', '_')
export const verbToolAvailable = (runtime: VerbRuntime, name: string) => {
  if (name === 'remote_task') return true // Polling an existing task remains useful after its channel plugin stops.
  const verb = verbRegistry.find(item => toolName(item.id) === name)
  return !verb || availableAdapters(runtime, verb.id).length > 0
}

function verbTool<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal) => unknown | Promise<unknown>): AgentTool<T> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, args, signal) => {
    const value = await execute(args, signal)
    return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value } as AgentToolResult<unknown>
  } }
}

const wrapDispatch = (runtime: VerbRuntime, context: TaskContext) => async (verb: string, args: Record<string, unknown>) => {
  try {
    return await dispatchVerb(runtime, verb, args, { projectId: context.run.projectId, worker: context.worker.name, stepId: context.run.stepId, runId: context.run.id, signal: context.signal })
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
      'Register a shared resource for cross-Step reuse: channels (webshell, c2_listener, c2_session), materials (c2_payload, c2_profile, credential_ref, proxy, file). secret stores credentials server-side (never returned); use a structured family tool when available. Everything registered here is visible on the operations pages.',
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
        const metadata = { ...args.metadata }; for (const key of ['runtime_verified','verification_version','verified_at','verified_endpoint','verified_capabilities']) delete metadata[key]
        const created = ops.create(context.run.projectId, { ...args, target: args.target ?? '', summary: args.summary ?? '', metadata, secret: args.secret ?? {}, ...worker })
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
    const adapters = ADAPTERS.map(adapter => ({ id: adapter.id, label: adapter.label, verbs: adapter.verbs, kinds: adapter.kinds, plugin_id: adapter.pluginId ?? null, requires_plugins: adapter.requiresPlugins ?? [], available: adapterLive(adapter, gate), stub: !!adapter.stub, establish: adapter.establish }))
    const verbs = verbRegistry.map(verb => {
      const serving = ADAPTERS.filter(adapter => adapter.verbs.includes(verb.id))
      return { id: verb.id, description: verb.description, risk: verb.risk, adapters: serving.map(adapter => adapter.id), available: serving.some(adapter => adapterLive(adapter, gate)), channels: candidateChannels(runtime, verb.id).length }
    })
    return { verbs, adapters }
  })
}
