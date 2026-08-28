/**
 * RedTrace Domain plugin: the bridge between the Cordis runtime and the
 * RedTrace FastAPI server. Owns the shared runtime state, mounts MCP
 * clients, pulls the hot-reloadable worker-centric runtime config, and
 * pushes the derived pi-ai provider profiles into the settings namespace.
 * @module redtrace-domain
 */

import type { CordisFiber, Json, RuntimeConfig, RuntimeContext, RuntimeOptions, RuntimeSnapshot } from './types.js'
import { load, mount } from './loader.js'
import { initState, disposeState, state } from './state.js'

export const name = 'redtrace-domain'

const MCP_CLIENT = 'vendor/deepseek-harness/packages/mcp/mcp-client/lib/index.js'

/** Order-insensitive config signature so boot-time env configs and refreshed
 * snapshot configs compare equal however the JSON was serialized. */
export function mcpSignature(configs: Array<Record<string, Json>>): string {
  const canonical = (value: Json): Json => {
    if (Array.isArray(value)) return value.map(canonical)
    if (value !== null && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, Json>)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([key, item]) => [key, canonical(item)]),
      )
    }
    return value
  }
  return JSON.stringify(canonical(configs))
}

interface SettingsService {
  replace(ns: string, section: object): Promise<void>
}

export async function api<T>(config: RuntimeOptions, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.server}${pathname}`, init)
  const body = await response.text()
  if (!response.ok) throw new Error(`RedTrace API ${response.status} ${pathname}: ${body.slice(0, 500)}`)
  return (body === '' ? null : JSON.parse(body)) as T
}

/** Forward worker-facing common_env into worker shells. Values land in the
 * runtime's environment and their names in the DSH_FORWARD_ENV allowlist,
 * because the subprocess credential scrub drops credential-shaped ambient
 * names (…TOKEN/KEY/…) from children unless explicitly allowlisted there. */
export function applyCommonEnv(
  commonEnv: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const previous = (env.DSH_FORWARD_ENV ?? '').split(',').filter(name => name !== '')
  const entries = Object.entries(commonEnv ?? {})
  const names = new Set(entries.map(([name]) => name))
  for (const name of previous) {
    if (!names.has(name)) delete env[name]
  }
  for (const [name, value] of entries) env[name] = value
  env.DSH_FORWARD_ENV = [...names].sort().join(',')
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
      applyCommonEnv(next.commonEnv)
    }
    await this.syncProviders(next)
    if (next.mcpConfigs !== undefined && mcpSignature(next.mcpConfigs) !== shared.mcpSignature) {
      await shared.remountMcp?.(next.mcpConfigs)
    }
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
  const mcpFibers: CordisFiber[] = []
  for (const mcp of config.mcpConfigs ?? []) {
    mcpFibers.push(await mount(ctx, MCP_CLIENT, mcp as Record<string, Json>))
  }
  shared.mcpSignature = mcpSignature((config.mcpConfigs ?? []) as Array<Record<string, Json>>)
  // Owned here because the fibers mount on this plugin's context; the
  // scheduler's Domain calls it when a refreshed snapshot carries new configs.
  shared.remountMcp = async (configs) => {
    for (const fiber of mcpFibers.splice(0)) {
      await fiber.dispose().catch(error => { ctx.logger?.warn(error) })
    }
    for (const mcp of configs) {
      try {
        mcpFibers.push(await mount(ctx, MCP_CLIENT, mcp))
      } catch (error) {
        // A broken MCP config must not take down the scheduler tick; the
        // domain keeps running with the remaining mounts.
        ctx.logger?.warn(`redtrace runtime: MCP ${String(mcp.serverName)} remount failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    shared.mcpSignature = mcpSignature(configs)
  }
  ctx.effect(() => () => {
    disposeState()
  }, 'redtrace domain state')
}
