/**
 * RedTrace audit projection: folds DSH session events onto the compact
 * RedTrace audit timeline. The Node engine host consumes these helpers
 * directly and commits rows to its own store — there is no separate audit
 * reporter process.
 * @module redtrace-audit
 */

import type { RuntimeTask, SessionEvent, TaskUsage } from './types.js'

/**
 * Fold one session event's provider usage into the task's cumulative totals.
 * assistant/message carries the step's TokenUsage when the adapter reported
 * accounting; buckets are disjoint so plain addition cannot double-count.
 */
export function accumulateUsage(task: RuntimeTask, event: SessionEvent): void {
  if (event.type !== 'assistant/message') return
  const usage = (event.data ?? {}).usage as Partial<TaskUsage> | undefined
  if (usage === undefined || usage === null) return
  const current = task.usage ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }
  task.usage = {
    inputTokens: current.inputTokens + (usage.inputTokens ?? 0),
    outputTokens: current.outputTokens + (usage.outputTokens ?? 0),
    cacheReadTokens: current.cacheReadTokens + (usage.cacheReadTokens ?? 0),
    cacheWriteTokens: current.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
  }
}

function textBlocksOf(blocks: Array<{ type?: string; text?: string }> | undefined): string {
  return (blocks ?? []).filter(block => block.type === 'text').map(block => block.text ?? '').join('')
}

function reasoningBlocksOf(blocks: Array<{ type?: string; text?: string }> | undefined): string {
  return (blocks ?? []).filter(block => block.type === 'reasoning').map(block => block.text ?? '').join('')
}

const TOOL_RESULT_TEXT_LIMIT = 64 * 1024

function clipText(value: string): string {
  return value.length <= TOOL_RESULT_TEXT_LIMIT ? value : `${value.slice(0, TOOL_RESULT_TEXT_LIMIT)}…[truncated]`
}

export function eventProjection(task: RuntimeTask, event: SessionEvent): Record<string, unknown>[] {
  const data = event.data ?? {}
  const base = {
    event_uid: `${task.sessionId}-${event.seq ?? crypto.randomUUID()}`,
    run_sequence: event.seq ?? 0,
    timestamp: event.ts ?? new Date().toISOString(),
  }
  if (event.type === 'request/header') {
    // The request header carries the exact system prompt the model received;
    // it is logged on the first step and whenever the assembly changes. A
    // config/tool-only change re-logs the same prompt, so dedupe per task.
    const system = (data.header as { system?: string } | undefined)?.system ?? ''
    if (system === '' || system === task.projectedSystem) return []
    task.projectedSystem = system
    return [{ ...base, kind: 'system.prompt', role: 'system', content: system }]
  }
  if (event.type === 'user/message') {
    // Plugin-owned messages (runtime-context refreshes) are bookkeeping, not
    // part of the user-visible conversation.
    if ((data as { source?: { kind?: string } }).source?.kind === 'plugin') return []
    const content = textBlocksOf(data.content as Array<{ type?: string; text?: string }> | undefined)
    return content === '' ? [] : [{ ...base, kind: 'user.message', role: 'user', content }]
  }
  if (event.type === 'assistant/chunk') {
    const chunk = data.chunk as Record<string, unknown> | undefined
    if (chunk?.type === 'text-delta') {
      task.streamedText = true
      return [{ ...base, kind: 'assistant.delta', content: chunk.text ?? '' }]
    }
    if (chunk?.type === 'reasoning-delta') {
      task.streamedThinking = true
      return [{ ...base, kind: 'thinking.delta', content: chunk.text ?? '' }]
    }
    return []
  }
  if (event.type === 'assistant/message') {
    const value = data.message as { content?: Array<{ type?: string; text?: string }> } | undefined
    const blocks = value?.content ?? []
    const reasoning = reasoningBlocksOf(blocks)
    const content = textBlocksOf(blocks)
    // One assistant/message can project two durable rows (reasoning + text).
    // The store dedupes by event_uid, so the text row needs its own id
    // whenever it shares this session event with a reasoning row; the
    // reasoning row keeps the bare id so existing rows stay stable.
    const textUid = reasoning !== '' ? `${base.event_uid}-text` : base.event_uid
    const projected: Record<string, unknown>[] = []
    if (reasoning !== '') {
      projected.push({ ...base, kind: 'thinking.message', content: reasoning, ...(task.streamedThinking ? { persist_only: true } : {}) })
    }
    task.streamedThinking = false
    if (content !== '') {
      projected.push({ ...base, event_uid: textUid, kind: 'assistant.message', role: 'assistant', content, ...(task.streamedText ? { persist_only: true } : {}) })
    }
    task.streamedText = false
    return projected
  }
  if (event.type === 'tool/call') {
    const callId = String(data.callId ?? '')
    if (callId !== '') {
      task.toolNames ??= new Map<string, string>()
      task.toolNames.set(callId, String(data.name ?? ''))
    }
    return [{ ...base, kind: 'tool.started', title: data.name, call_id: data.callId, arguments: data.arguments }]
  }
  if (event.type === 'tool/result') {
    const message = data.message as {
      toolCallId?: string
      isError?: boolean
      content?: Array<{ type?: string; text?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> }>
      source?: { callId?: string }
    } | undefined
    const callId = message?.toolCallId ?? message?.source?.callId ?? data.callId as string | undefined
    const blocks = message?.content ?? []
    // New DSH messages store result blocks directly; accept the old wrapper too.
    const wrapper = blocks.find(candidate => candidate.type === 'tool-result')
    const text = textBlocksOf(wrapper?.content ?? blocks)
    // The UI hides a tool.started once its completion arrives, so the tool
    // name must travel on the completion for the block header to show it.
    const name = callId === undefined ? undefined : task.toolNames?.get(String(callId))
    return [{
      ...base,
      kind: 'tool.completed',
      title: name,
      call_id: callId,
      error: Boolean(data.error) || Boolean(message?.isError) || Boolean(wrapper?.isError),
      ...(text === '' ? {} : { content: clipText(text) }),
    }]
  }
  if (event.type === 'turn/end') return [{ ...base, kind: 'turn.completed' }]
  return []
}
