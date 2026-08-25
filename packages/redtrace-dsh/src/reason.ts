/**
 * RedTrace Reason preset: the Reason task composition. Minimal tool
 * permissions — the inherited global surface is restricted to the Reason
 * contract tools only; no shell, filesystem, skill, or MCP access. The
 * contract tools themselves are registered globally by the
 * redtrace-contracts plugin. Stable Chinese persona and Rules come from the
 * prompt plugin; the graph context arrives as user messages.
 * @module redtrace-reason
 */

import type { RuntimeTask, ScopedContext } from './types.js'
import * as contracts from './contracts.js'
import { persona } from './prompt.js'

export const name = 'redtrace-reason'
export const inject = ['systemPrompt', 'tools']

export interface PresetConfig {
  task: RuntimeTask
  cwd?: string
  skillsDir?: string
}

export async function apply(scoped: ScopedContext, _config: PresetConfig): Promise<void> {
  scoped.systemPrompt.section({ name: 'redtrace:persona', order: 0, text: persona('reason') })
  scoped.tools.restrict({ allow: [...contracts.CONTRACTS.reason] })
}
