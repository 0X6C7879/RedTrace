/**
 * RedTrace DSH package: the Cordis plugins and helpers the FGS engine's
 * Node compatibility host (packages/redtrace-engine/compat/cordis.mjs)
 * mounts through the plugin manager. The standalone DSH runtime composition
 * was retired; this package is the adapter surface of the engine host only.
 *
 * Plugin map:
 * - redtrace-core      minimal DSH Core (agent, agent-loop, session, llm,
 *                      tools, system-prompt, event bus, plugin loader)
 * - redtrace-plugins   plugin manager: catalog, manifest, live lifecycle,
 *                      /__redtrace/plugins API (owns the composition below)
 * - redtrace-webshell  WebShell channel family tools (capability adapter)
 * - redtrace-c2        C2 channel family tools (capability adapter)
 * - redtrace-credentials / attachment / file-references / ptc
 *                      host-plane DSH native capability services
 * - web / jobs / terminal / fs-search / spill / tool-timeout /
 *   repeat-reminder / lsp
 *                      session-scoped DSH native capability stacks the
 *                      execution toolchain mounts per Execute agent
 * - redtrace-domain    engine API bridge + hot-reload + MCP
 * - redtrace-scheduler FGS engine dispatch lifecycle
 * @module redtrace-dsh
 */

export type {
  Agent, AgentHandle, CordisFiber, ExecutionProfile, Json, LlmService,
  MessageFactory, ReasoningPolicy, RuntimeConfig, RuntimeContext, RuntimeOptions, RuntimeSnapshot,
  RuntimeTask, ScopedContext, SessionEvent, TaskLimits, TaskType, TaskUsage, WorkerRoute, WorkerSpec,
} from './types.js'
export { activateAgent, resolveReasoningEffort } from './agent.js'
export type { EngineSchedulerHandle } from './scheduler.js'
export { accumulateUsage, eventProjection } from './audit.js'
export { mountExecutionTools } from './execution-tools.js'
export { PluginManager, PluginError, registerPluginRoutes } from './plugins.js'
export type { PluginManifest, PluginView, UserEntry } from './plugins.js'
export { initState, state, disposeState } from './state.js'
