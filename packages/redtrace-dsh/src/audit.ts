/**
 * RedTrace Audit plugin: projects DSH session events onto the RedTrace audit
 * stream and reports run outcomes. The DSH session event log stays the
 * source of truth for the full agent trajectory; only the compact UI
 * projection is written to RedTrace.
 * @module redtrace-audit
 */

import { mkdir, rm, rmdir } from 'node:fs/promises'
import path from 'node:path'
import type { AuditRun, RuntimeConfig, RuntimeOptions, RuntimeTask, RuntimeContext, SessionEvent, SessionPersistence, TaskUsage } from './types.js'
import { state } from './state.js'

export const name = 'redtrace-audit'

async function api<T>(config: RuntimeConfig & { server: string }, pathname: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${config.server}${pathname}`, init)
  const body = await response.text()
  if (!response.ok) throw new Error(`RedTrace API ${response.status} ${pathname}: ${body.slice(0, 500)}`)
  return (body === '' ? null : JSON.parse(body)) as T
}

export async function reportRun(
  config: RuntimeOptions,
  task: RuntimeTask,
  status: string,
  events: Record<string, unknown>[] = [],
): Promise<void> {
  if (task.runId === undefined || task.sessionId === undefined || task.startedAt === undefined) return
  const cwd = path.join(config.workspacesDir, safeId(task.projectId))
  await api(config, '/audit/events', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      run: {
        id: task.runId, project_id: task.projectId, intent_id: task.intentId ?? null,
        task_type: task.type, phase: task.type, worker: task.worker,
        provider: task.route?.provider ?? 'dsh', engine: 'dsh', model: task.route?.model ?? null,
        execution_profile: task.executionProfile ?? 'direct', session_id: task.sessionId,
        workspace_kind: 'local', workspace_ref: cwd, workspace_root: cwd,
        status, started_at: new Date(task.startedAt).toISOString(),
        ended_at: status === 'running' ? null : new Date().toISOString(),
        cancelled: status === 'cancelled', timed_out: status === 'timeout',
        ...usageBody(task.usage),
      },
      events,
    }),
  })
}

/** Cumulative usage for the run metadata; totals are what the server stores. */
function usageBody(usage: TaskUsage | undefined): Record<string, number> {
  if (usage === undefined) return {}
  return {
    input_tokens: usage.inputTokens,
    output_tokens: usage.outputTokens,
    cache_read_tokens: usage.cacheReadTokens,
    cache_write_tokens: usage.cacheWriteTokens,
  }
}

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
      content?: Array<{ type?: string; isError?: boolean; content?: Array<{ type?: string; text?: string }> }>
      source?: { callId?: string }
    } | undefined
    const callId = message?.source?.callId
    const block = message?.content?.find(candidate => candidate.type === 'tool-result')
    const text = textBlocksOf(block?.content)
    // The UI hides a tool.started once its completion arrives, so the tool
    // name must travel on the completion for the block header to show it.
    const name = callId === undefined ? undefined : task.toolNames?.get(String(callId))
    return [{
      ...base,
      kind: 'tool.completed',
      title: name,
      call_id: callId,
      error: Boolean(data.error) || Boolean(block?.isError),
      ...(text === '' ? {} : { content: clipText(text) }),
    }]
  }
  if (event.type === 'turn/end') return [{ ...base, kind: 'turn.completed' }]
  return []
}

function safeId(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 48)
  return clean || 'project'
}

export async function cleanupSessionArtifacts(
  sessionRoot: string,
  runs: readonly AuditRun[],
  persistence?: SessionPersistence,
): Promise<void> {
  if (persistence?.supportsRawArtifacts !== true) return
  const root = path.resolve(sessionRoot)
  const parents = new Set<string>()
  for (const id of new Set(runs.map(run => run.session_id).filter((value): value is string => Boolean(value)))) {
    const raw = await persistence.readRaw(id)
    const location = raw === undefined ? undefined : persistence.locate(raw.meta)
    if (location === undefined) continue
    const artifact = path.resolve(location.path)
    if (!artifact.startsWith(`${root}${path.sep}`)) throw new Error(`session artifact is outside session root: ${artifact}`)
    const directory = path.dirname(artifact)
    if (directory === root) throw new Error(`session artifact has no owned directory: ${artifact}`)
    parents.add(path.dirname(directory))
    await rm(directory, { recursive: true, force: true })
  }
  for (const parent of parents) {
    if (parent !== root && parent.startsWith(`${root}${path.sep}`)) {
      await rmdir(parent).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT' && error.code !== 'ENOTEMPTY') throw error
      })
    }
  }
}

export function apply(ctx: RuntimeContext): void {
  // Events must reach the server in session order: concurrent POSTs race and
  // scramble the live timeline, so each session gets a serial fetch chain.
  const chains = new Map<string, Promise<void>>()
  ctx.on('session/event', (value: { id?: string }, event: SessionEvent) => {
    const shared = state()
    const session = String(value.id ?? '')
    const task = shared?.tasks.get(session)
    if (shared === undefined || task === undefined) return
    accumulateUsage(task, event)
    const events = eventProjection(task, event)
    if (events.length === 0) return
    const next = (chains.get(session) ?? Promise.resolve())
      .then(() => reportRun(shared.config, task, 'running', events))
      .catch(error => { ctx.logger?.warn(error) })
      .finally(() => { if (chains.get(session) === next) chains.delete(session) })
    chains.set(session, next)
  })
}
