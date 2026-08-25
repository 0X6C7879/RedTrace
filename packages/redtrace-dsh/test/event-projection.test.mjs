import assert from 'node:assert/strict'
import test from 'node:test'

import { eventProjection } from '../lib/audit.js'

test('does not duplicate a streamed assistant message', () => {
  const task = { sessionId: 'rt-test', type: 'reason', projectId: 'proj_test', worker: 'reasoner', committed: false }
  assert.equal(eventProjection(task, {
    type: 'assistant/chunk', seq: 1, data: { chunk: { type: 'text-delta', text: 'hello' } },
  }).length, 1)
  assert.deepEqual(eventProjection(task, {
    type: 'assistant/message', seq: 2, ts: '2026-01-01T00:00:00Z',
    data: { message: { content: [{ type: 'text', text: 'hello' }] } },
  }), [{
    event_uid: 'rt-test-2', run_sequence: 2, timestamp: '2026-01-01T00:00:00Z',
    kind: 'assistant.message', role: 'assistant', content: 'hello', persist_only: true,
  }])
})

test('projects user messages but not plugin-owned context refreshes', () => {
  const task = { sessionId: 'rt-test', type: 'bootstrap', projectId: 'proj_test', worker: 'boot', committed: false }
  assert.deepEqual(eventProjection(task, {
    type: 'user/message', seq: 3, ts: '2026-01-01T00:00:01Z',
    data: { role: 'user', content: [{ type: 'text', text: '任务指令' }], source: { kind: 'user' } },
  }), [{
    event_uid: 'rt-test-3', run_sequence: 3, timestamp: '2026-01-01T00:00:01Z',
    kind: 'user.message', role: 'user', content: '任务指令',
  }])
  assert.deepEqual(eventProjection(task, {
    type: 'user/message', seq: 4,
    data: { role: 'user', content: [{ type: 'text', text: 'Current runtime context: …' }], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt' } },
  }), [])
  // tool-result messages entering the loop are covered by tool/result, not user.message
  assert.deepEqual(eventProjection(task, {
    type: 'user/message', seq: 5,
    data: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [] }], source: { kind: 'tool', callId: 'c1' } },
  }), [])
})

test('projects streamed thinking and its durable copy', () => {
  const task = { sessionId: 'rt-test', type: 'reason', projectId: 'proj_test', worker: 'reasoner', committed: false }
  assert.deepEqual(eventProjection(task, {
    type: 'assistant/chunk', seq: 1, ts: '2026-01-01T00:00:00Z', data: { chunk: { type: 'reasoning-delta', text: '思考' } },
  }), [{
    event_uid: 'rt-test-1', run_sequence: 1, timestamp: '2026-01-01T00:00:00Z',
    kind: 'thinking.delta', content: '思考',
  }])
  assert.deepEqual(eventProjection(task, {
    type: 'assistant/message', seq: 2, ts: '2026-01-01T00:00:00Z',
    data: { message: { content: [{ type: 'reasoning', text: '思考' }, { type: 'text', text: '结论' }] } },
  }), [{
    event_uid: 'rt-test-2', run_sequence: 2, timestamp: '2026-01-01T00:00:00Z',
    kind: 'thinking.message', content: '思考', persist_only: true,
  }, {
    event_uid: 'rt-test-2', run_sequence: 2, timestamp: '2026-01-01T00:00:00Z',
    kind: 'assistant.message', role: 'assistant', content: '结论',
  }])
})

test('projects tool call arguments and result text', () => {
  const task = { sessionId: 'rt-test', type: 'explore', projectId: 'proj_test', worker: 'explorer', committed: false }
  assert.deepEqual(eventProjection(task, {
    type: 'tool/call', seq: 7, ts: '2026-01-01T00:00:01Z',
    data: { callId: 'c1', name: 'bash', arguments: '{"command":"pwd"}' },
  }), [{
    event_uid: 'rt-test-7', run_sequence: 7, timestamp: '2026-01-01T00:00:01Z',
    kind: 'tool.started', title: 'bash', call_id: 'c1', arguments: '{"command":"pwd"}',
  }])
  assert.deepEqual(eventProjection(task, {
    type: 'tool/result', seq: 8, ts: '2026-01-01T00:00:02Z',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'c1', isError: false, content: [{ type: 'text', text: '/workspace' }] }],
        source: { kind: 'tool', callId: 'c1' },
      },
    },
  }), [{
    event_uid: 'rt-test-8', run_sequence: 8, timestamp: '2026-01-01T00:00:02Z',
    kind: 'tool.completed', title: 'bash', call_id: 'c1', error: false, content: '/workspace',
  }])
})

test('tool result without a matching call carries no title', () => {
  const task = { sessionId: 'rt-test', type: 'reason', projectId: 'proj_test', worker: 'reasoner', committed: false }
  assert.deepEqual(eventProjection(task, {
    type: 'tool/result', seq: 9, ts: '2026-01-01T00:00:03Z',
    data: {
      message: {
        role: 'user',
        content: [{ type: 'tool-result', toolCallId: 'cX', isError: true, content: [{ type: 'text', text: 'boom' }] }],
        source: { kind: 'tool', callId: 'cX' },
      },
    },
  }), [{
    event_uid: 'rt-test-9', run_sequence: 9, timestamp: '2026-01-01T00:00:03Z',
    kind: 'tool.completed', title: undefined, call_id: 'cX', error: true, content: 'boom',
  }])
})
