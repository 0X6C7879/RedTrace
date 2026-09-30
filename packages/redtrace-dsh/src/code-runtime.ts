/**
 * Code-runtime plugin: the DSH process TypeScript runtime
 * (`ctx.ptcRuntime`). Runs `run_code` programs under the session sandbox
 * policy with elapsed-time and output budgets. Mounted at the host plane because the
 * tool registry's PTC transport resolves it from the host context; the
 * per-session presentation (`run_code` beside the native tools) is mounted
 * by the execution toolchain whenever the redtrace-ptc plugin is running.
 * @module redtrace-code-runtime
 */

import type { RuntimeContext } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-code-runtime'

export async function apply(ctx: RuntimeContext): Promise<void> {
  await mount(ctx, 'vendor/deepseek-harness/packages/fs/fs-local/lib/index.js')
  await mount(ctx, 'vendor/deepseek-harness/packages/sandbox/sandbox-local/lib/index.js')
  await mount(ctx, 'vendor/deepseek-harness/packages/sandbox/sandbox-policy/lib/index.js', { mode: 'read-only' })
  await mount(ctx, 'vendor/deepseek-harness/packages/ptc-runtime/ptc-runtime-node/lib/index.js')
}
