/**
 * Code-runtime plugin: the DSH process TypeScript runtime
 * (`ctx.ptcRuntime`). Defaults to full filesystem access, including isolated
 * Steps; elapsed-time/output budgets and native session policy overrides remain.
 * Mounted at the host plane because the
 * tool registry's PTC transport resolves it from the host context; the
 * per-session presentation (`run_code` as the session's only direct tool) is
 * mounted by the execution toolchain whenever the redtrace-ptc plugin is
 * running. The host `fs` service comes from redtrace-core.
 * @module redtrace-code-runtime
 */

import type { RuntimeContext } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-code-runtime'

export async function apply(ctx: RuntimeContext): Promise<void> {
  await mount(ctx, 'vendor/deepseek-harness/packages/sandbox/sandbox-local/lib/index.js')
  await mount(ctx, 'vendor/deepseek-harness/packages/sandbox/sandbox-policy/lib/index.js', { mode: 'danger-full-access' })
  await mount(ctx, 'vendor/deepseek-harness/packages/ptc-runtime/ptc-runtime-node/lib/index.js')
}
