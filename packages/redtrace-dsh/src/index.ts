/**
 * RedTrace DSH bundle: mounts every RedTrace Cordis plugin onto the minimal
 * DSH Core. Deployments that want explicit per-plugin composition mount the
 * individual plugins from `profiles/redtrace/runtime.cordis.yml` instead.
 *
 * Plugin map (everything except the DSH Core is a plugin):
 * - redtrace-core      minimal DSH Core (agent, agent-loop, session, llm,
 *                      tools, system-prompt, event bus, plugin loader)
 * - redtrace-plugins   plugin manager: catalog, manifest, live lifecycle,
 *                      /__redtrace/plugins API (owns the composition below)
 * - redtrace-domain    RedTrace FastAPI client + hot-reload + MCP
 * - redtrace-prompt    Chinese persona + Rules (Cairn restored)
 * - redtrace-context   launch-prompt rendering + runtime hint injection
 * - redtrace-contracts contract tools (mounted per agent by the presets)
 * - redtrace-resource  shared-resource tools (mounted per agent)
 * - redtrace-bootstrap / redtrace-reason / redtrace-explore  task presets
 * - redtrace-audit     run audit + session event projection
 * - redtrace-scheduler worker-centric dispatch + orchestration
 * - redtrace-web       Web UI proxy
 * @module redtrace-dsh
 */

import type { RuntimeConfig, RuntimeContext, RuntimeTask, WorkerSpec } from './types.js'
import * as core from './core.js'
import * as domain from './domain.js'
import * as prompt from './prompt.js'
import * as context from './context.js'
import * as audit from './audit.js'
import * as web from './web.js'
import * as scheduler from './scheduler.js'
import * as contracts from './contracts.js'
import * as resource from './resource.js'

export const name = 'redtrace-dsh'
export const inject = ['tools', 'agents', 'sessions', 'sessionPersistence', 'systemPrompt', 'webServer']

export type { RuntimeConfig, RuntimeTask, WorkerSpec }
export { CONTRACTS, taskFor } from './contracts.js'
export { eventProjection, reportRun, cleanupSessionArtifacts } from './audit.js'
export { persona, concludeInstruction } from './prompt.js'
export { taskPrompt, hintMessage, isBootstrap, isInitial, schedulable } from './context.js'

export async function apply(ctx: RuntimeContext, config: RuntimeConfig = {}): Promise<void> {
  if (config.runtime !== true) {
    // Transition mode: register the tools for the task named by the
    // REDTRACE_* environment (probe profiles, standalone tool checks).
    const type = process.env.REDTRACE_TASK_TYPE as import('./types.js').TaskType | undefined
    await ctx.plugin(contracts, { types: type === undefined ? undefined : [type] }).await()
    return
  }
  ctx.plugin(core)
  ctx.plugin(prompt)
  ctx.plugin(context)
  ctx.plugin(contracts)
  ctx.plugin(resource)
  ctx.plugin(domain, config)
  ctx.plugin(audit)
  ctx.plugin(web)
  ctx.plugin(scheduler, config)
}
