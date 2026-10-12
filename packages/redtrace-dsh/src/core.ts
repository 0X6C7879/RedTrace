/**
 * Minimal DSH Core composition: exactly the runtime backbone the RedTrace
 * plugins build on — LLM service, Session, System Prompt assembly, Tool
 * runtime, Agent registry, and the Agent Loop (plus the LLM retry policy the
 * loop's provider adapters expect), and since DSH 0.2.1-alpha.2 the host-plane
 * filesystem, working-directory services and native file recovery tools. Everything
 * else in a RedTrace deployment is a separately mounted plugin; the scheduler
 * mounts shell, filesystem, skill, sandbox, and contract plugins per agent.
 * @module redtrace-core
 */

import type { RuntimeContext } from './types.js'
import { load, repoRoot } from './loader.js'

export const name = 'redtrace-core'

export async function apply(ctx: RuntimeContext): Promise<void> {
  const LlmRuntime = await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js')
  const SessionStore = await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
  const SystemPrompt = await load('vendor/deepseek-harness/packages/core/system-prompt/lib/index.js')
  const ToolRuntime = await load('vendor/deepseek-harness/packages/core/tools/lib/index.js')
  const AgentRegistry = await load('vendor/deepseek-harness/packages/core/agent/lib/index.js')
  const llmRetry = await load('vendor/deepseek-harness/packages/llm/llm-retry/lib/index.js')
  const AgentLoop = await load('vendor/deepseek-harness/packages/core/agent-loop/lib/index.js')
  const FsLocal = await load('vendor/deepseek-harness/packages/fs/fs-local/lib/index.js')
  const WorkingDirectory = await load('vendor/deepseek-harness/packages/session/working-directory/lib/index.js')
  const ToolFs = await load('vendor/deepseek-harness/packages/fs/tool-fs/lib/index.js')
  ctx.plugin(LlmRuntime.default ?? LlmRuntime)
  ctx.plugin(SessionStore.default ?? SessionStore)
  ctx.plugin(SystemPrompt.default ?? SystemPrompt, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: '',
  })
  ctx.plugin(ToolRuntime.default ?? ToolRuntime)
  ctx.plugin(AgentRegistry.default ?? AgentRegistry)
  ctx.plugin(llmRetry.default ?? llmRetry)
  ctx.plugin(AgentLoop.default ?? AgentLoop, { agents: [] })
  // DSH ≥0.2.1-alpha.2 makes every tool and the file-reference service inject
  // `workingDirectory`. One host-plane singleton serves all sessions: the
  // effective directory resolves per Session from its committed projection,
  // seeded by the header cwd the engine passes at activation. Session scopes
  // keep isolating `fs`; this host copy only backs the directory service.
  ctx.plugin(FsLocal.default ?? FsLocal, { cwd: repoRoot })
  ctx.plugin(WorkingDirectory.default ?? WorkingDirectory)
  // Execute shadows these tools with its own filesystem; Reason allows only read.
  ctx.plugin(ToolFs.default ?? ToolFs)
}
