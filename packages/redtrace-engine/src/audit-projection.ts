import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/** SQLite buffers stay outside the JS heap; only the bounded index is decoded. */
export function auditSummaries(rows: Record<string, unknown>[]) {
  const native = require('./native/redtrace_native.node') as { projectAuditEvents(rows: Uint8Array[]): string }
  const events = JSON.parse(native.projectAuditEvents(rows.map(row => row.data as Uint8Array))) as Record<string, any>[]
  return events.map((event, index) => ({ id: Number(rows[index].id), kind: event.kind, title: event.title, callId: event.callId, timestamp: event.timestamp, error: event.error, summary: event.summary as string | undefined, detailAvailable: true }))
}
