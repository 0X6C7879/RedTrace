/**
 * Credentials plugin: the DSH credential document service. Resolves
 * credential references (like DEEPSEEK_API_KEY for web search) from the
 * managed `$DSH_HOME/.credentials.yaml` over inherited environment with
 * project and user `.env` fallbacks; nothing is materialized into the
 * process environment. Mounted at the host plane so every capability
 * (current and user-added) resolves through one store.
 * @module redtrace-credentials
 */

import type { RuntimeContext } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-credentials'

export async function apply(ctx: RuntimeContext): Promise<void> {
  await mount(ctx, 'vendor/deepseek-harness/packages/credentials/credentials-local/lib/index.js')
}
