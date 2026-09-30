/**
 * RedTrace Domain plugin: the bridge between the Cordis runtime and the
 * RedTrace Node engine. Owns the shared runtime state and mounts MCP clients.
 * @module redtrace-domain
 */

import type { CordisFiber, Json, RuntimeConfig, RuntimeContext, RuntimeOptions } from './types.js'
import { load, mount } from './loader.js'
import { initState, disposeState } from './state.js'

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
