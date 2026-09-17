/**
 * RedTrace C2 plugin: the C2 channel family. Registers the operator surface
 * for the family — listener creation, direct sessions with credentials,
 * credential and malleable-profile registration, payload generation (oneliner,
 * Go beacon, external adapter), and session listing — so an Explore agent
 * that establishes C2 infrastructure registers it through the audited
 * resource API; every entry is visible on the Web UI operations pages and
 * online sessions become reusable remote.command channels automatically.
 * @module redtrace-c2
 */

import type { TaskType } from './types.js'
import { query, register, request, serverOf, taskFor, text, type ToolContext } from './api-utils.js'

export const name = 'redtrace-c2'
export const inject = ['tools']

export function apply(ctx: ToolContext, config: { types?: TaskType[] } = {}): void {
  const types: TaskType[] = config.types ?? ['bootstrap', 'explore']
  const resourceBody = (task: ReturnType<typeof taskFor>, kind: string, name: string, rest: Record<string, unknown>) => ({
    kind, name, ...rest, actor_type: 'worker', actor: task.worker, worker: task.worker, ...(task.intentId === undefined ? {} : { intent_id: task.intentId }), publish_fact: false,
  })
  register(ctx, {
    name: 'c2_listener_create',
    description: 'Create a C2 listener as a shared resource. listener_type is one of http_beacon, https_beacon, tcp_reverse, tcp_bind, external_c2; TCP listeners take bind_host/bind_port, beacon listeners take callback_host, external_c2 takes adapter_endpoint. Online sessions of the listener become reusable remote.command channels.',
    parameters: {
      type: 'object',
      properties: {
        listener_type: { type: 'string', enum: ['http_beacon', 'https_beacon', 'tcp_reverse', 'tcp_bind', 'external_c2'] },
        name: text,
        bind_host: { type: 'string' },
        bind_port: { type: 'number' },
        target_host: { type: 'string' },
        target_port: { type: 'number' },
        callback_host: { type: 'string' },
        profile_id: { type: 'string' },
        adapter_endpoint: { type: 'string' },
        adapter_token: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['listener_type', 'name'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      if (!task.intentId) throw new Error('c2_listener_create requires an Intent')
      const bindHost = args.bind_host === undefined ? '127.0.0.1' : String(args.bind_host)
      const bindPort = args.bind_port === undefined ? undefined : Number(args.bind_port)
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/resources`, resourceBody(task, 'c2_listener', String(args.name), {
        target: `${bindHost}:${bindPort ?? ''}`,
        summary: args.summary === undefined ? '' : String(args.summary),
        metadata: {
          listener_type: String(args.listener_type),
          bind_host: bindHost,
          ...(bindPort === undefined ? {} : { bind_port: bindPort }),
          ...(args.target_host === undefined ? {} : { target_host: String(args.target_host) }),
          ...(args.target_port === undefined ? {} : { target_port: Number(args.target_port) }),
          ...(args.callback_host === undefined ? {} : { callback_host: String(args.callback_host) }),
          ...(args.profile_id === undefined ? {} : { profile_id: String(args.profile_id) }),
          ...(args.adapter_endpoint === undefined ? {} : { adapter_endpoint: String(args.adapter_endpoint) }),
        },
        ...(args.adapter_endpoint === undefined || args.adapter_endpoint === '' ? {} : { secret: { adapter_endpoint: String(args.adapter_endpoint), ...(args.adapter_token === undefined ? {} : { token: String(args.adapter_token) }) } }),
      }), execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_session_create',
    description: 'Register a direct-access session (SSH, Evil-WinRM, PsExec, WMI, or a custom command client) as a shared resource. Provide the target plus either secret_type material (password / hash / private_key_path) or a credential_id referencing a registered credential. Direct sessions become reusable remote.command channels immediately.',
    parameters: {
      type: 'object',
      properties: {
        shell_type: { type: 'string', enum: ['ssh', 'evil_winrm', 'psexec', 'wmi', 'custom'] },
        target: { type: 'string' },
        name: text,
        port: { type: 'number' },
        username: { type: 'string' },
        domain: { type: 'string' },
        secret_type: { type: 'string', enum: ['password', 'hash', 'private_key_path'] },
        secret: { type: 'string' },
        credential_id: { type: 'string' },
        executable: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['shell_type', 'target'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      if (!task.intentId) throw new Error('c2_session_create requires an Intent')
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : `${String(args.shell_type)}:${String(args.target)}`
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/resources`, resourceBody(task, 'c2_session', name, {
        target: String(args.target),
        summary: args.summary === undefined ? '' : String(args.summary),
        metadata: {
          shell_type: String(args.shell_type),
          connection_type: 'direct',
          ...(args.username === undefined ? {} : { username: String(args.username) }),
          ...(args.domain === undefined ? {} : { domain: String(args.domain) }),
          ...(args.port === undefined ? {} : { port: Number(args.port) }),
          ...(args.executable === undefined ? {} : { executable: String(args.executable) }),
          ...(args.credential_id === undefined ? {} : { credential_id: String(args.credential_id) }),
        },
        ...(args.secret === undefined || args.secret === '' ? {} : { secret: { [String(args.secret_type ?? 'password')]: String(args.secret) } }),
      }), execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_credential_create',
    description: 'Register a credential (host, web, database, Active Directory, cloud, ssh_key, token, certificate, hash, ticket, or custom) as a shared resource. The secret value is stored server-side for terminal and Worker reuse; sessions can reference it by credential_id.',
    parameters: {
      type: 'object',
      properties: {
        name: text,
        credential_type: { type: 'string', enum: ['host', 'web', 'database', 'active_directory', 'cloud', 'ssh_key', 'token', 'certificate', 'hash', 'ticket', 'custom'] },
        target: { type: 'string' },
        username: { type: 'string' },
        domain: { type: 'string' },
        secret: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['name', 'secret'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      if (!task.intentId) throw new Error('c2_credential_create requires an Intent')
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/resources`, resourceBody(task, 'credential_ref', String(args.name), {
        target: args.target === undefined ? '' : String(args.target),
        summary: args.summary === undefined ? '' : String(args.summary),
        metadata: {
          credential_type: String(args.credential_type ?? 'host'),
          ...(args.username === undefined ? {} : { username: String(args.username) }),
          ...(args.domain === undefined ? {} : { domain: String(args.domain) }),
        },
        secret: { value: String(args.secret) },
      }), execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_profile_create',
    description: 'Register a malleable traffic profile (User-Agent, beacon URIs, jitter, response headers) as a shared resource; reference it from listeners via profile_id.',
    parameters: {
      type: 'object',
      properties: {
        name: text,
        user_agent: { type: 'string' },
        beacon_uris: { type: 'array', items: { type: 'string' } },
        jitter_min_ms: { type: 'number' },
        jitter_max_ms: { type: 'number' },
        response_headers: { type: 'object', additionalProperties: true },
        summary: { type: 'string' },
      },
      required: ['name'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      if (!task.intentId) throw new Error('c2_profile_create requires an Intent')
      const name = String(args.name)
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/resources`, resourceBody(task, 'c2_profile', name, {
        target: `profile://${name}`,
        summary: args.summary === undefined ? '' : String(args.summary),
        metadata: {
          ...(args.user_agent === undefined ? {} : { user_agent: String(args.user_agent) }),
          ...(args.beacon_uris === undefined ? {} : { beacon_uris: Array.isArray(args.beacon_uris) ? args.beacon_uris.map(String) : [] }),
          ...(args.jitter_min_ms === undefined ? {} : { jitter_min_ms: Number(args.jitter_min_ms) }),
          ...(args.jitter_max_ms === undefined ? {} : { jitter_max_ms: Number(args.jitter_max_ms) }),
          ...(args.response_headers === undefined ? {} : { response_headers: args.response_headers }),
        },
      }), execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_listener_kinds',
    description: 'List the one-liner payload kinds compatible with a C2 listener (shell and platform availability).',
    parameters: {
      type: 'object',
      properties: { listener_id: text },
      required: ['listener_id'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      return query(task, `/projects/${encodeURIComponent(task.projectId)}/c2/listeners/${encodeURIComponent(String(args.listener_id))}/oneliner-kinds`, execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_payload_oneliner',
    description: 'Generate a one-liner payload command for a C2 listener and register it as a payload resource. Discover valid kinds with c2_listener_kinds first.',
    parameters: {
      type: 'object',
      properties: { listener_id: text, kind: text, callback_host: { type: 'string' } },
      required: ['listener_id', 'kind'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/c2/payloads/oneliner`, {
        listener_id: String(args.listener_id),
        kind: String(args.kind),
        ...(args.callback_host === undefined ? {} : { callback_host: String(args.callback_host) }),
      }, execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_payload_build',
    description: 'Compile the Go beacon binary for a C2 listener and register it as a payload resource. Requires the Go toolchain on the server.',
    parameters: {
      type: 'object',
      properties: {
        listener_id: text,
        os: { type: 'string', enum: ['linux', 'windows', 'darwin'] },
        arch: { type: 'string', enum: ['amd64', 'arm64', '386'] },
        sleep_seconds: { type: 'number' },
      },
      required: ['listener_id'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/c2/payloads/build`, {
        listener_id: String(args.listener_id),
        ...(args.os === undefined ? {} : { os: String(args.os) }),
        ...(args.arch === undefined ? {} : { arch: String(args.arch) }),
        ...(args.sleep_seconds === undefined ? {} : { sleep_seconds: Number(args.sleep_seconds) }),
      }, execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_payload_external',
    description: 'Generate a payload through an external_c2 listener\'s adapter framework and register it as a payload resource. The listener must carry an adapter endpoint.',
    parameters: {
      type: 'object',
      properties: { listener_id: text, format: text, options: { type: 'object', additionalProperties: true } },
      required: ['listener_id'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/c2/payloads/external`, {
        listener_id: String(args.listener_id),
        ...(args.format === undefined ? {} : { format: String(args.format) }),
        ...(args.options === undefined ? {} : { options: args.options }),
      }, execution.signal)
    },
  })
  register(ctx, {
    name: 'c2_sessions',
    description: 'List C2 sessions (online and offline) with their resource ids, targets, and status.',
    parameters: {
      type: 'object',
      properties: { q: { type: 'string' }, limit: { type: 'number' } },
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      const search = new URLSearchParams([['kind', 'c2_session']])
      if (typeof args.q === 'string' && args.q !== '') search.set('q', args.q)
      if (typeof args.limit === 'number') search.set('limit', String(Math.min(500, Math.max(1, Math.floor(args.limit)))))
      return query(task, `/projects/${encodeURIComponent(task.projectId)}/resources?${search}`, execution.signal)
    },
  })
}
