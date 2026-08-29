/**
 * RedTrace Reason preset: the Reason task composition. Reason receives only
 * its contract tools plus command execution and the common Skill catalog for
 * short planning probes; filesystem and MCP tools stay hidden.
 * @module redtrace-reason
 */

import type { RuntimeTask, ScopedContext } from './types.js'
import { mount } from './loader.js'
import * as contracts from './contracts.js'
import { persona } from './prompt.js'

export const name = 'redtrace-reason'
export const inject = ['systemPrompt', 'tools']

export interface PresetConfig {
  task: RuntimeTask
  cwd: string
  skillsDir: string
}

export async function apply(scoped: ScopedContext, config: PresetConfig): Promise<void> {
  for (const service of ['shell', 'shellEnv', 'skills']) scoped = scoped.isolate(service)
  scoped.systemPrompt.section({ name: 'redtrace:persona', order: 0, text: persona('reason') })
  await mount(scoped, process.platform === 'win32'
    ? 'vendor/deepseek-harness/packages/shell/pwsh-local/lib/index.js'
    : 'vendor/deepseek-harness/packages/shell/bash-local/lib/index.js', { cwd: config.cwd })
  await mount(scoped, 'vendor/deepseek-harness/packages/shell/shell-env/lib/index.js')
  await mount(scoped, process.platform === 'win32'
    ? 'vendor/deepseek-harness/packages/shell/tool-pwsh/lib/index.js'
    : 'vendor/deepseek-harness/packages/shell/tool-bash/lib/index.js')
  await mount(scoped, 'vendor/deepseek-harness/packages/skill/skill/lib/index.js')
  await mount(scoped, 'vendor/deepseek-harness/packages/skill/skill-filesystem/lib/index.js', {
    includeDefaultRoots: false,
    customSkillDirs: [config.skillsDir],
  })
  await mount(scoped, 'vendor/deepseek-harness/packages/skill/tool-skill/lib/index.js')
  scoped.tools.restrict({ allow: [...contracts.CONTRACTS.reason] })
}
