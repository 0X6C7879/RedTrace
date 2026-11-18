import path from 'node:path'
import type { RuntimeContext, RuntimeConfig } from './types.js'
import { load, mount } from './loader.js'

export const name = 'redtrace-spill'
export const inject = ['tools']

/** Fold only adjacent byte-identical lines; keep the line and its exact count. */
export function compactToolText(text: string): string {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [], result: string[] = []
  for (let i = 0; i < lines.length;) {
    let end = i + 1
    while (end < lines.length && lines[end] === lines[i]) end++
    const original = lines.slice(i, end).join('')
    const folded = lines[i] + '[上一行另重复 ' + (end - i - 1) + ' 次]\n'
    result.push(end - i >= 3 && folded.length < original.length ? folded : original)
    i = end
  }
  return result.join('')
}

export async function apply(ctx: RuntimeContext, config: RuntimeConfig): Promise<void> {
  if (!config.sessionRoot) throw new Error('redtrace-spill requires sessionRoot')
  await mount(ctx, 'vendor/deepseek-harness/packages/spill/spill-local/lib/index.js', {
    root: path.join(config.sessionRoot, 'spill'),
  })
  const { formatSpillNotice } = await load('vendor/deepseek-harness/packages/spill/spill-policy/lib/types/notice.js')
  // Run inside native retention: archive before folding; PTC values stay untouched.
  const compact = async (exec: any, content: any[], toolName: string, callId: string, label: string) => {
    if (!exec.agent || ['read', 'project_evidence_read', 'evidence_read', 'legion_evidence_read', 'read_execution'].includes(toolName) || content.some(b => b.type !== 'text')) return content
    const folded = content.map(b => ({ ...b, text: compactToolText(b.text) }))
    if (folded.every((b, i) => b.text === content[i].text)) return content
    const source = content.map(b => b.text).join('')
    const spillStore = ctx.get('spillStore') as any
    let ref
    try { ref = await spillStore.saveText({ owner: { sessionId: exec.agent.session.header.id }, source: { kind: 'tool', toolName, callId, label }, suggestedName: toolName + '.txt', content: source }) }
    catch (error) { ctx.logger?.warn('Tool deduplication: '+String(error)+'; keeping full output'); return content }
    const notice = formatSpillNotice({ kind: 'unknown' }, ref, 0)
    const compacted = [{ type: 'text', text: folded.map(b => b.text).join('') + '\n\n相邻相同行已按次数折叠，完整原文：\n' + notice }]
    return compacted.reduce((n, b) => n + b.text.length, 0) < source.length ? compacted : content
  }
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const decision = await next()
    if (decision.kind !== 'accept' || Object.hasOwn(decision, 'value') || exec.parent !== undefined) return decision
    return { ...decision, content: await compact(exec, decision.content ?? result.content, exec.name, exec.callId, 'result') }
  })
  ctx.on('tools/ptc-dispatch-log', async (dispatch, next) => compact(dispatch.exec, await next(), dispatch.name, dispatch.subCallId, 'dispatch'))
  await mount(ctx, 'vendor/deepseek-harness/packages/spill/spill-policy/lib/index.js', {
    maxInlineTokens: 12500,
  })
}
