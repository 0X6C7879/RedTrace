import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Configuration } from '../src/config.ts'
import { providerProfiles } from '../src/models.ts'
import { load, mount } from '../../redtrace-dsh/lib/loader.js'

for (const signature of ['', 'signed-fixture']) test(`native Anthropic tool rounds preserve ${signature ? 'signed' : 'unsigned'} thinking`, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-thinking-')), requests: any[] = []
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b
    const input = JSON.parse(raw); requests.push(input)
    const assistants = input.messages.filter((m: any) => m.role === 'assistant')
    if (assistants.some((m: any) => !m.content.some((b: any) => b.type === 'thinking' && b.thinking === 'fixture reasoning' && b.signature === signature))) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: 'The reasoning_content in the thinking mode must be passed back to the API.' } })); return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (type: string, data: any) => res.write('event: ' + type + '\ndata: ' + JSON.stringify(data) + '\n\n')
    event('message_start', { type: 'message_start', message: { id: 'm' + requests.length, type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature } })
    event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'fixture reasoning' } })
    event('content_block_stop', { type: 'content_block_stop', index: 0 })
    const tool = requests.length < 3
    event('content_block_start', { type: 'content_block_start', index: 1, content_block: tool ? { type: 'tool_use', id: 'call-' + requests.length, name: 'fixture_tool', input: {} } : { type: 'text', text: '' } })
    if (!tool) event('content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'OK' } })
    event('content_block_stop', { type: 'content_block_stop', index: 1 })
    event('message_delta', { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
    event('message_stop', { type: 'message_stop' }); res.end()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const c = new Configuration(root); c.initialize()
  c.commit(c.read().revision, raw => {
    raw.providers = { fixture: { api: 'anthropic-messages', base_url: 'http://127.0.0.1:' + (server.address() as any).port, api_key: 'fixture', models: [{ id: 'fixture', context_window: 30000, max_tokens: 8192, reasoning_efforts: { high: 'high' } }] } }
  })
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'), ctx = new Context()
  try {
    await mount(ctx, 'vendor/deepseek-harness/packages/llm/llm/lib/index.js')
    await mount(ctx, 'packages/redtrace-engine/compat/llm.mjs', { providers: providerProfiles(c.resolvedSnapshot().config).providers, credentialSource: { root, filename: c.filename, revision: c.read().revision } })
    const messages: any[] = [{ role: 'user', content: [{ type: 'text', text: 'Use fixture_tool twice, then answer OK.' }] }]
    for (let round = 0; round < 3; round++) {
      const content: any[] = []; let finish: any
      for await (const chunk of ctx.get('llm').stream({ provider: 'fixture', model: 'fixture', reasoningEffort: 'high', messages, tools: [{ name: 'fixture_tool', description: 'Local fixture only', parameters: { type: 'object', properties: {} } }], maxTokens: 8192, signal: AbortSignal.timeout(5000) })) {
        if (chunk.type === 'block-end') content.push(chunk.block)
        if (chunk.type === 'finish') finish = chunk
      }
      assert.equal(finish.reason.kind, round < 2 ? 'tool-calls' : 'stop', JSON.stringify(finish.reason))
      messages.push({ role: 'assistant', content, source: { kind: 'model', provider: 'fixture', model: 'fixture', replayState: finish.replayState } })
      if (round < 2) messages.push({ role: 'tool', toolCallId: 'call-' + (round + 1), source: { kind: 'tool', callId: 'call-' + (round + 1) }, content: [{ type: 'text', text: 'fixture result' }], isError: false })
    }
    assert.equal(requests.length, 3)
    assert.equal(requests[2].messages.filter((m: any) => m.role === 'assistant').length, 2)
  } finally { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})

test('workbench exposes stopped Commander errors without hiding active Workers or stale recovered state', () => {
  const root = path.resolve(import.meta.dirname, '../../..'), context = vm.createContext({ window: {} })
  vm.runInContext(readFileSync(root + '/static/workbench.js', 'utf8'), context)
  const a = context.window.redtraceWorkbench
  a.legion = { campaign: { status: 'stopped', failureCode: 'INVALID_REQUEST', error: 'fixture failure' } }
  assert.equal(a.commanderError(), 'fixture failure')
  a.legion.campaign.status = 'running'; assert.equal(a.commanderError(), '')
  a.legion.campaign.status = 'idle'; assert.equal(a.commanderError(), '')
  a.legion = null; assert.equal(a.commanderError(), '')
  const html = readFileSync(root + '/static/index.html', 'utf8')
  assert(html.includes("commanderError() ? '调度失败'"))
  assert(html.includes('role="alert" x-show="commanderError()"'))
})
