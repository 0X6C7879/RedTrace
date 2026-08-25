/**
 * RedTrace Bootstrap preset: the Bootstrap task composition. Same security
 * toolchain as Explore (shell, filesystem, skills; sandbox when isolated),
 * with read-only shared-resource tools: resource registration stays an
 * Explore capability. The contract tools are registered globally by the
 * redtrace-contracts plugin and restricted per agent here.
 * @module redtrace-bootstrap
 */

import type { RuntimeTask, ScopedContext } from './types.js'
import { mount } from './loader.js'
import * as contracts from './contracts.js'
import { persona } from './prompt.js'

export const name = 'redtrace-bootstrap'
export const inject = ['systemPrompt', 'tools']

export interface PresetConfig {
  task: RuntimeTask
  cwd: string
  skillsDir: string
}

export async function apply(scoped: ScopedContext, config: PresetConfig): Promise<void> {
  for (const service of ['shell', 'shellEnv', 'fs', 'skills', 'sandbox', 'sandboxPolicy', 'approval']) {
    scoped = scoped.isolate(service)
  }
  scoped.systemPrompt.section({ name: 'redtrace:persona', order: 0, text: persona('bootstrap') })
  if (config.task.executionProfile === 'isolated') {
    await mount(scoped, 'vendor/deepseek-harness/packages/sandbox/sandbox-local/lib/index.js')
    await mount(scoped, 'vendor/deepseek-harness/packages/sandbox/sandbox-policy/lib/index.js', { mode: 'workspace-write', workspaceRoot: config.cwd })
    await mount(scoped, process.platform === 'win32'
      ? 'vendor/deepseek-harness/packages/shell/pwsh-sandbox/lib/index.js'
      : 'vendor/deepseek-harness/packages/shell/bash-sandbox/lib/index.js')
    await mount(scoped, 'vendor/deepseek-harness/packages/interaction/user-approval/lib/index.js', { policy: 'never' })
    await mount(scoped, 'vendor/deepseek-harness/packages/fs/fs-sandbox/lib/index.js')
  } else {
    await mount(scoped, process.platform === 'win32'
      ? 'vendor/deepseek-harness/packages/shell/pwsh-local/lib/index.js'
      : 'vendor/deepseek-harness/packages/shell/bash-local/lib/index.js', { cwd: config.cwd })
    await mount(scoped, 'vendor/deepseek-harness/packages/fs/fs-local/lib/index.js', { cwd: config.cwd })
  }
  await mount(scoped, 'vendor/deepseek-harness/packages/shell/shell-env/lib/index.js')
  await mount(scoped, process.platform === 'win32'
    ? 'vendor/deepseek-harness/packages/shell/tool-pwsh/lib/index.js'
    : 'vendor/deepseek-harness/packages/shell/tool-bash/lib/index.js')
  await mount(scoped, 'vendor/deepseek-harness/packages/fs/fs-observation-policy/lib/index.js')
  await mount(scoped, 'vendor/deepseek-harness/packages/fs/tool-fs/lib/index.js')
  await mount(scoped, 'vendor/deepseek-harness/packages/skill/skill/lib/index.js')
  await mount(scoped, 'vendor/deepseek-harness/packages/skill/skill-filesystem/lib/index.js', {
    includeDefaultRoots: false,
    customSkillDirs: [config.skillsDir],
  })
  await mount(scoped, 'vendor/deepseek-harness/packages/skill/tool-skill/lib/index.js')
  scoped.tools.restrict({
    deny: [...contracts.CONTRACTS.reason, ...contracts.CONTRACTS.explore, 'redtrace_resource_register'],
  })
}
