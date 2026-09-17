/**
 * RedTrace WebShell plugin: the WebShell channel family. Registers the
 * operator surface for the family — connectivity probe and structured
 * channel registration with the connection secret — so an Explore agent
 * that obtains a WebShell can register it for every task to reuse; verb
 * dispatch (remote.command, remote.file.*) picks it up automatically and the
 * Web UI operations page lists it like a human-created entry.
 * @module redtrace-webshell
 */

import type { TaskType } from './types.js'
import { register, request, serverOf, taskFor, text, type ToolContext } from './api-utils.js'

export const name = 'redtrace-webshell'
export const inject = ['tools']

export function apply(ctx: ToolContext, config: { types?: TaskType[] } = {}): void {
  const types: TaskType[] = config.types ?? ['bootstrap', 'explore']
  register(ctx, {
    name: 'webshell_register',
    description: 'Register a WebShell as a shared resource so remote.command / remote.file.* can reuse it. target is the shell URL; password and parameters must match how the shell is reached. Use webshell_test first to verify the connection.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        name: { type: 'string' },
        password: { type: 'string' },
        shell_type: { type: 'string', enum: ['php', 'asp', 'aspx', 'jsp', 'custom'] },
        protocol: { type: 'string', enum: ['auto', 'eval', 'antsword', 'raw'] },
        method: { type: 'string', enum: ['POST', 'GET'] },
        command_param: { type: 'string' },
        password_param: { type: 'string' },
        target_os: { type: 'string', enum: ['auto', 'linux', 'windows'] },
        encoding: { type: 'string', enum: ['auto', 'utf-8', 'gbk', 'gb18030'] },
        verify_tls: { type: 'boolean' },
        summary: { type: 'string' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      if (!task.intentId) throw new Error('webshell_register requires an Intent')
      const name = typeof args.name === 'string' && args.name.trim() !== '' ? args.name.trim() : String(args.target).trim()
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/resources`, {
        kind: 'webshell',
        name,
        target: String(args.target),
        summary: args.summary === undefined ? '' : String(args.summary),
        metadata: {
          command_param: args.command_param === undefined ? 'cmd' : String(args.command_param),
          password_param: args.password_param === undefined ? '' : String(args.password_param),
          shell_type: args.shell_type === undefined ? 'php' : String(args.shell_type),
          protocol: args.protocol === undefined ? 'auto' : String(args.protocol),
          os: args.target_os === undefined ? 'auto' : String(args.target_os),
          encoding: args.encoding === undefined ? 'auto' : String(args.encoding),
          method: args.method === undefined ? 'POST' : String(args.method),
          verify_tls: Boolean(args.verify_tls),
        },
        ...(args.password === undefined || args.password === '' ? {} : { secret: { password: String(args.password) } }),
        actor_type: 'worker',
        actor: task.worker,
        worker: task.worker,
        intent_id: task.intentId,
        publish_fact: false,
      }, execution.signal)
    },
  })
  register(ctx, {
    name: 'webshell_test',
    description: 'Probe a WebShell endpoint before registering it. A successful probe means webshell_register can reuse this configuration.',
    parameters: {
      type: 'object',
      properties: {
        target: { type: 'string' },
        password: { type: 'string' },
        shell_type: { type: 'string', enum: ['php', 'asp', 'aspx', 'jsp', 'custom'] },
        protocol: { type: 'string', enum: ['auto', 'eval', 'antsword', 'raw'] },
        method: { type: 'string', enum: ['POST', 'GET'] },
        command_param: { type: 'string' },
        password_param: { type: 'string' },
        target_os: { type: 'string', enum: ['auto', 'linux', 'windows'] },
        encoding: { type: 'string', enum: ['auto', 'utf-8', 'gbk', 'gb18030'] },
        verify_tls: { type: 'boolean' },
      },
      required: ['target'],
      additionalProperties: false,
    },
    async execute(args, execution) {
      const task = taskFor(execution, types)
      return request(serverOf(task), `/projects/${encodeURIComponent(task.projectId)}/webshell/test`, {
        target: String(args.target),
        ...(args.password === undefined ? {} : { password: String(args.password) }),
        ...(args.shell_type === undefined ? {} : { shell_type: String(args.shell_type) }),
        ...(args.protocol === undefined ? {} : { protocol: String(args.protocol) }),
        ...(args.method === undefined ? {} : { method: String(args.method) }),
        ...(args.command_param === undefined ? {} : { command_param: String(args.command_param) }),
        ...(args.password_param === undefined ? {} : { password_param: String(args.password_param) }),
        ...(args.target_os === undefined ? {} : { target_os: String(args.target_os) }),
        ...(args.encoding === undefined ? {} : { encoding: String(args.encoding) }),
        ...(args.verify_tls === undefined ? {} : { verify_tls: Boolean(args.verify_tls) }),
      }, execution.signal)
    },
  })
}
