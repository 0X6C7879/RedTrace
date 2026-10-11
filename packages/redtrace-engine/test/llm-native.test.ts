import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Configuration } from '../src/config.ts'

const native = async (file: string) => import(new URL('../../../vendor/deepseek-harness/' + file, import.meta.url).href)
const { Context } = await native('vendor/cordis/lib/index.js')
const { probeModel, admitToolImages, apply } = await import(new URL('../compat/llm.mjs', import.meta.url).href)
const { providerProfiles } = await import('../src/models.ts')
const { mount } = await import(new URL('../../redtrace-dsh/lib/loader.js', import.meta.url).href)

test('only the native llm-pi-ai adapter probes all three protocols and projects admitted screenshots', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-llm-')), requests: any[] = []
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const b of req) raw += b
    requests.push({ url: req.url, body: JSON.parse(raw), headers: req.headers })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const event = (type: string, data: any) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    if (req.url?.endsWith('/responses')) {
      const response = { id: 'r', object: 'response', created_at: 1, model: 'fixture', status: 'completed', output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'OK', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
      event('response.created', { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } })
      event('response.output_item.added', { type: 'response.output_item.added', output_index: 0, item: { ...response.output[0], content: [] } })
      event('response.content_part.added', { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
      event('response.output_text.delta', { type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'OK' })
      event('response.output_item.done', { type: 'response.output_item.done', output_index: 0, item: response.output[0] })
      event('response.completed', { type: 'response.completed', response })
    } else if (new URL(req.url!, 'http://fixture').pathname.endsWith('/messages')) {
      event('message_start', { type: 'message_start', message: { id: 'm', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } })
      event('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })
      event('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } })
      event('content_block_stop', { type: 'content_block_stop', index: 0 })
      event('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })
      event('message_stop', { type: 'message_stop' })
    } else {
      res.write('data: {"id":"c","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
    }
    res.end()
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const c = new Configuration(root); c.initialize()
  c.commit(c.read().revision, raw => {
    raw.providers = Object.fromEntries((['openai-completions', 'openai-responses', 'anthropic-messages'] as const).map(api => [api, { api, base_url: `http://127.0.0.1:${(model.address() as any).port}${api === 'anthropic-messages' ? '' : '/v1'}`, api_key: 'native-secret', models: [{ id: 'fixture', context_window: 20000, max_tokens: 1000, reasoning_efforts: false }] }]))
    raw.workers = Object.keys(raw.providers!).map(provider => ({ name: provider, provider, model: 'fixture', backend: 'pi' }))
  })
  const ctx = new Context(), config = c.resolve(c.read().raw)
  try {
    for (const worker of config.workers) { try { await probeModel(ctx, c, config, worker, AbortSignal.timeout(5000)) } catch (error) { throw new Error(worker.provider + ': ' + String(error) + ' urls=' + requests.map(r => r.url).join(',')) } }
    assert.deepEqual(requests.map(r => new URL(r.url, 'http://fixture').pathname), ['/v1/chat/completions', '/v1/responses', '/v1/messages'])
    assert.equal(requests[0].headers.authorization, 'Bearer native-secret')
    assert.equal(requests[2].headers['x-api-key'], 'native-secret')
    assert.ok(!Object.keys(process.env).some(key => key.startsWith('REDTRACE_DSH_KEY_')))
    assert.equal(ctx.get('llm'), undefined, 'probe leaked its model service')
    await mount(ctx, 'vendor/deepseek-harness/packages/llm/llm/lib/index.js')
    await mount(ctx, 'vendor/deepseek-harness/packages/attachment/attachment-local/lib/index.js', { dshHome: path.join(root, '.dsh') })
    const adapter = ctx.plugin({ name: 'fixture-adapter', apply }, { providers: providerProfiles(config).providers, credentialSource: { root, filename: c.filename, revision: c.read().revision } }); await adapter.await()
    const sharp = createRequire(new URL('../../../vendor/deepseek-harness/packages/attachment/attachment-local/package.json', import.meta.url))('sharp')
    const png = (await sharp({ create: { width: 10, height: 10, channels: 3, background: '#ffffff' } }).png().toBuffer()).toString('base64')
    const result = await admitToolImages(ctx.get('attachments'), { content: [{ type: 'text', text: 'screenshot' }, { type: 'image', data: png, mimeType: 'image/png' }], details: { fixture: true } })
    assert.equal(result.content[0].text, 'screenshot'); assert.equal(result.details.fixture, true)
    assert.ok(result.content[1].attachment); assert.equal(result.content[1].data, undefined)
    const stored = await ctx.get('attachments').readImage(result.content[1].attachment); assert.ok(stored.data.byteLength > 0)
    for await (const _ of ctx.get('llm').stream({ provider: 'openai-completions', model: 'fixture', messages: [{ role: 'user', content: result.content }], signal: AbortSignal.timeout(5000) })) {}
    assert.ok(requests.at(-1).body.messages.some((m: any) => Array.isArray(m.content) && m.content.some((b: any) => b.type === 'image_url' && b.image_url.url.startsWith('data:image/'))))
    await assert.rejects(admitToolImages(ctx.get('attachments'), { content: [{ type: 'image', data: 'not-image', mimeType: 'image/png' }] }))
    await assert.rejects(admitToolImages(undefined, { content: [{ type: 'image', data: png, mimeType: 'image/png' }] }), /attachment service/)
  } finally { await ctx.fiber.dispose(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
