import type { Json, MessageFactory, RuntimeOptions, RuntimeSnapshot, RuntimeTask, TaskType } from './types.js'

/**
 * State shared by the RedTrace Cordis plugins of the one long-lived runtime:
 * the launch config, the latest hot-reloaded snapshot, the live task index
 * (session id -> task) used by the contract and resource tools, and the DSH
 * message helpers. One runtime runs per process; the domain plugin owns the
 * lifecycle and resets the slot on dispose.
 */
export class RedTraceState {
  readonly tasks = new Map<string, RuntimeTask>()
  /** Task presets cleared for dispatch; the plugin manager toggles members live. */
  readonly presets = new Set<TaskType>(['commander','general','soldier','scout'])
  snapshot?: RuntimeSnapshot
  messages?: MessageFactory
  /** Signature of the currently mounted MCP configs; the domain plugin owns
   * the fibers and swaps them when a refreshed snapshot carries new configs. */
  mcpSignature = ''
  mcpStatuses?: () => Array<{ name: string; state: string; toolCount?: number; lastError?: string }>
  remountMcp?: (configs: Array<Record<string, Json>>) => Promise<void>
  constructor(readonly config: RuntimeOptions) {}
}

let current: RedTraceState | undefined

export function initState(config: RuntimeOptions): RedTraceState {
  current = new RedTraceState(config)
  return current
}

export function state(): RedTraceState | undefined {
  return current
}

export function disposeState(): void {
  current = undefined
}
