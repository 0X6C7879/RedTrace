/**
 * Code-runtime plugin: the DSH worker-thread TypeScript runtime
 * (`ctx.codeRuntime`). Runs model-authored `run_code` programs in fresh
 * worker threads with busy-time and wall-time budgets — a containment
 * substrate, not a security boundary. Mounted at the host plane because the
 * tool registry's PTC transport resolves it from the host context; the
 * per-session presentation (`run_code` beside the native tools) is mounted
 * by the execution toolchain whenever the redtrace-ptc plugin is running.
 * @module redtrace-code-runtime
 */

import type { RuntimeContext } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-code-runtime'

export async function apply(ctx: RuntimeContext): Promise<void> {
  await mount(ctx, 'vendor/deepseek-harness/packages/code-runtime/code-runtime-worker-thread/lib/index.js')
}
