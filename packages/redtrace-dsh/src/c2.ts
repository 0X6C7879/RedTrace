/**
 * RedTrace C2 plugin: the C2 channel family. Registers the operator surface
 * for the family — listener creation, direct sessions with credentials,
 * credential and malleable-profile registration, payload generation (oneliner,
 * Go beacon, external adapter) — so an Explore agent
 * that establishes C2 infrastructure registers it through the audited
 * resource API; every entry is visible on the Web UI operations pages and
 * online sessions become reusable remote.command channels automatically.
 * @module redtrace-c2
 */

import type { TaskType } from './types.js'
import { query, registerDomain, request, serverOf, taskFor, text, type ToolContext } from './api-utils.js'

export const name = 'redtrace-c2'
export const inject = ['tools']

export function apply(ctx: ToolContext, config: { types?: TaskType[]; toolEnabled?: (name: string) => boolean } = {}): void {
  const definitions: Parameters<typeof registerDomain>[1] = []
  const types: TaskType[] = config.types ?? ['soldier']
  const resourceBody = (task: ReturnType<typeof taskFor>, kind: string, name: string, rest: Record<string, unknown>) => ({
    kind, name, ...rest, actor_type: 'worker', actor: task.worker, worker: task.worker, ...(task.intentId === undefined ? {} : { intent_id: task.intentId }), publish_fact: false,
  })
  definitions.push({
    name: 'c2_listener_create',
    description: "创建共享 C2 listener。listener_type 支持 http_beacon/https_beacon/tcp_reverse/tcp_bind/external_c2；TCP 用 bind_host/bind_port，beacon 用 callback_host。external_c2 仅注册 adapter_endpoint，须显式读取会话并用 resource_register 注册 connection_type=external_c2、secret.endpoint=<adapter>/execute。TCP/beacon 连入后可作 remote.command 通道。",
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
  definitions.push({
    name: 'c2_session_create',
    description: "注册 SSH/Evil-WinRM/PsExec/WMI/自定义命令会话：target 加 secret_type 材料（password/hash/private_key_path）或 credential_id。注册≠认证/连接成功；凭据须有具体来源，不批量猜测。同凭据复用资源，用 remote_session_probe 验证。AUTH_FAILED 后停止该认证分支，有新凭据证据才继续；改名/重注册不能修复失败。",
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
  definitions.push({
    name: 'c2_credential_create',
    description: "注册共享凭据（host/web/database/Active Directory/cloud/ssh_key/token/certificate/hash/ticket/custom）；secret 仅存服务端供终端/Worker 复用，会话用 credential_id 引用。",
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
  definitions.push({
    name: 'c2_profile_create',
    description: "注册共享流量 profile（User-Agent、beacon URI、jitter、响应头）；listener 用 profile_id 引用。",
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
  definitions.push({
    name: 'c2_listener_kinds',
    description: "列出 C2 listener 兼容的 oneliner 类型及 Shell/平台。",
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
  definitions.push({
    name: 'c2_payload_oneliner',
    description: "生成并注册 listener 的 oneliner Payload；先用 c2_listener_kinds 查合法类型。",
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
  definitions.push({
    name: 'c2_payload_build',
    description: "编译并注册 listener 的 Go beacon；服务端需 Go 工具链。",
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
  definitions.push({
    name: 'c2_payload_external',
    description: "通过 external_c2 listener 的 adapter 生成并注册 Payload；listener 必须有 adapter endpoint。",
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
  registerDomain(ctx,definitions,config.toolEnabled)
}
