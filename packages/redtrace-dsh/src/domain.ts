/**
 * RedTrace Domain plugin: the bridge between the Cordis runtime and the
 * RedTrace FastAPI server. Owns the shared runtime state, mounts MCP
 * clients, pulls the hot-reloadable worker-centric runtime config, and
 * pushes the derived pi-ai provider profiles into the settings namespace.
 * @module redtrace-domain
 */

import type { Json, RuntimeConfig, RuntimeContext, RuntimeOptions, RuntimeSnapshot } from './types.js'
import { load, mount } from './loader.js'
import { initState, disposeState, state } from './state.js'

export const name = 'redtrace-domain'

interface SettingsService {
  replace(ns: string, section: object): Promise<void>
}

export async function api<T>(config: RuntimeOptions, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.server}${pathname}`, init)
  const body = await response.text()
  if (!response.ok) throw new Error(`RedTrace API ${response.status} ${pathname}: ${body.slice(0, 500)}`)
  return (body === '' ? null : JSON.parse(body)) as T
}

export class Domain {
  private providersRevision = ''

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: RuntimeOptions,
  ) {}

  /** Pull the latest worker-derived runtime config; workers, task limits, and
   * concurrency limits apply to tasks launched after the swap. */
  async refresh(): Promise<void> {
    const shared = state()
    if (shared === undefined) return
    const next = await api<RuntimeSnapshot>(this.config, '/runtime/config')
    if (!Array.isArray(next.workers)) throw new Error('redtrace runtime: /runtime/config did not return a workers array')
    const changed = next.revision !== shared.snapshot?.revision
    shared.snapshot = next
    if (changed) {
      for (const [name, value] of Object.entries(next.env ?? {})) process.env[name] = value
    }
    await this.syncProviders(next)
  }

  /** Push the provider profiles into the llm-pi-ai settings namespace; API
   * keys live in process.env (pi-ai resolves them per request). Retried on
   * later refreshes while the settings service is unavailable or refused. */
  private async syncProviders(snapshot: RuntimeSnapshot): Promise<void> {
    if (snapshot.providers === undefined || snapshot.revision === this.providersRevision) return
    const service = this.ctx.get('settings') as SettingsService | undefined
    if (service === undefined || typeof service.replace !== 'function') return
    try {
      await service.replace('llm-pi-ai', { providers: snapshot.providers })
      this.providersRevision = snapshot.revision
    } catch (error) {
      this.ctx.logger?.warn(error)
    }
  }
}

export async function apply(ctx: RuntimeContext, config: RuntimeConfig = {}): Promise<void> {
  for (const key of ['server', 'root', 'sessionRoot', 'skillsDir', 'workspacesDir'] as const) {
    if (typeof config[key] !== 'string' || config[key]?.trim() === '') throw new Error(`redtrace runtime: ${key} is required`)
  }
  const shared = initState(config as RuntimeOptions)
  const llm = await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js') as {
    createUserMessage(value: Record<string, unknown>): unknown
  }
  const session = await load('vendor/deepseek-harness/packages/core/session/lib/index.js') as {
    SessionId(value: string): unknown
  }
  shared.messages = {
    createUserMessage: llm.createUserMessage,
    SessionId: session.SessionId,
  }
  for (const mcp of config.mcpConfigs ?? []) {
    await mount(ctx, 'vendor/deepseek-harness/packages/mcp/mcp-client/lib/index.js', mcp as Record<string, Json>)
  }
  ctx.effect(() => () => {
    disposeState()
  }, 'redtrace domain state')
}
