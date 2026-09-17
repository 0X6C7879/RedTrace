/**
 * RedTrace Scheduler plugin: the FGS engine dispatch lifecycle. The Node
 * engine host owns the real loop (packages/redtrace-engine/src/scheduler.ts);
 * this plugin starts and stops it with the plugin manager so dispatch can be
 * toggled live from the plugins page. Stopping aborts running activities
 * into their paused state and blocks new claims until restarted.
 * @module redtrace-scheduler
 */

import type { RuntimeContext } from './types.js'

export const name = 'redtrace-scheduler'

/** The engine scheduler handle the compatibility host passes through the
 * runtime config; start is idempotent, close aborts and drains. */
export interface EngineSchedulerHandle {
  start(): void
  close(): Promise<void>
}

export function apply(ctx: RuntimeContext, config: { engineScheduler?: EngineSchedulerHandle } = {}): void {
  const scheduler = config.engineScheduler
  if (scheduler === undefined) {
    throw new Error('redtrace-scheduler requires the RedTrace Node engine host')
  }
  scheduler.start()
  ctx.effect(() => () => { void scheduler.close() }, 'redtrace engine scheduler')
}
