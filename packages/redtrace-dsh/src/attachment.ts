/**
 * Attachment plugin: the DSH durable attachment store (`ctx.attachments`).
 * Gives binary attachments (images and files like APK/PCAP/ELF samples) a
 * content-addressed home outside the append-only session log; messages keep
 * references the backend resolves for provider requests. The service is a
 * seam for attachment-aware surfaces — RedTrace's own pipeline does not
 * submit attachments yet, so the store stays idle until one does.
 * @module redtrace-attachment
 */

import type { RuntimeContext } from './types.js'
import { mount } from './loader.js'

export const name = 'redtrace-attachment'

export async function apply(ctx: RuntimeContext): Promise<void> {
  await mount(ctx, 'vendor/deepseek-harness/packages/attachment/attachment-local/lib/index.js')
}
