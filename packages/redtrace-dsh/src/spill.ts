import path from 'node:path'
import type { RuntimeContext, RuntimeConfig } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-spill'
export const inject = ['tools']

export async function apply(ctx: RuntimeContext, config: RuntimeConfig): Promise<void> {
  if (!config.sessionRoot) throw new Error('redtrace-spill requires sessionRoot')
  await mount(ctx, 'vendor/deepseek-harness/packages/spill/spill-local/lib/index.js', {
    root: path.join(config.sessionRoot, 'spill'),
  })
  await mount(ctx, 'vendor/deepseek-harness/packages/spill/spill-policy/lib/index.js', {
    maxInlineTokens: 12500,
  })
}
