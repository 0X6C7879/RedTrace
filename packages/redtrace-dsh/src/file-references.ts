/**
 * File-reference plugin: the DSH `@`-mention discovery service
 * (`ctx.fileReferences`). Ranks workspace file candidates for one agent's
 * working directory, so file-aware surfaces can offer path-only references
 * instead of inlining file contents. A seam for interactive clients —
 * RedTrace's headless workers do not type mentions, so the index stays
 * untouched until something queries it.
 * @module redtrace-file-references
 */

import type { RuntimeContext } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-file-references'

export async function apply(ctx: RuntimeContext): Promise<void> {
  await mount(ctx, 'vendor/deepseek-harness/packages/context/file-reference-local/lib/index.js')
}
