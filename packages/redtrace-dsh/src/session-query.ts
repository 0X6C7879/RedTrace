/** Native DSH session history; Project isolation is the committed Session cwd. */
import path from 'node:path'
import type { RuntimeContext, RuntimeConfig } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-session-query'
export const inject = ['sessions', 'tools', 'systemPrompt', 'sessionProjections']

export const SESSION_QUERY_TOOLS = ['session_search', 'session_event_search', 'session_event_read', 'session_trace', 'session_event_trace'] as const

export async function apply(ctx: RuntimeContext, config: RuntimeConfig): Promise<void> {
  if (!config.sessionRoot) throw new Error('redtrace-session-query requires sessionRoot')
  await mount(ctx, 'vendor/deepseek-harness/packages/session-query/session-query-sqlite/lib/index.js', {
    path: path.join(config.sessionRoot, 'session-query.sqlite'),
    openAt: 'first-search',
  })
  await mount(ctx, 'vendor/deepseek-harness/packages/experimental/tool-session-query/lib/index.js')
}
