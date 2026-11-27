import assert from 'node:assert/strict'
import test from 'node:test'
import { auditSummaries } from '../src/audit-projection.ts'

function original(rows: { id: number; data: Buffer }[]) {
  return rows.map(row => {
    const event = JSON.parse(row.data.toString())
    return { id: row.id, kind: event.kind, title: event.title, callId: event.call_id, timestamp: event.timestamp, error: event.error, summary: typeof event.content === 'string' ? event.content.slice(0, 180) : undefined, detailAvailable: true }
  })
}

test('Rust audit summaries match JSON.parse and UTF-16 slice for recorded fields and payload boundaries', () => {
  let seed = 923847
  const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  const content: unknown[] = [undefined, null, false, 42, [], {}, '', '中文😀', '𐏿', 'x'.repeat(179) + '😀tail', 'x'.repeat(179) + '😀', '\n\t\\"\b\f\r'.repeat(70)]
  for (let i = 0; i < 600; i++) content.push(Array.from({ length: next() % 600 }, () => String.fromCharCode(next() & 0xffff)).join(''))
  const rows = content.map((value, id) => ({ id, data: Buffer.from(JSON.stringify({ kind: 'tool.completed', title: id % 2 ? null : 'read', call_id: id, error: false, timestamp: '2026-11-27T00:00:00.000Z', content: value, arguments: { body: 'unused '.repeat(1024) } })) }))
  assert.deepEqual(auditSummaries(rows), original(rows))
  assert.deepEqual(auditSummaries([{ id: 1, data: Buffer.from('{}') }]), original([{ id: 1, data: Buffer.from('{}') }]))
  assert.deepEqual(auditSummaries([]), [])
})

test('Rust audit projection validates the complete JSON beyond the summary prefix', () => {
  assert.throws(() => auditSummaries([{ id: 1, data: Buffer.from('{"content":"' + 'x'.repeat(200) + '","invalid":') }]), /Invalid audit JSON/)
})
