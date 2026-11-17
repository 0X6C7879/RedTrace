import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Configuration } from '../src/config.ts'
import { providerProfiles } from '../src/models.ts'
const { installModelPolling, apply, probeModel } = await import(new URL('../compat/llm.mjs', import.meta.url).href)

const finish = (code = 'SERVER', status?: number) => ({ type: 'finish', reason: { kind: 'error', failure: { code, message: 'fixture failure', ...(status ? { status } : {}) } } })
const success = [{ type: 'text-delta', index: 0, text: 'OK' }, { type: 'finish', reason: { kind: 'stop' }, replayState: { response: 'opaque' } }]
const request = (extra = {}) => ({ provider: 'a', model: 'shared', messages: [], ...extra })
const collect = async (stream: AsyncIterable<any>) => { const chunks = []; for await (const chunk of stream) chunks.push(chunk); return chunks }
function fixture(replies: Record<string, any>, providers = ['a', 'b'], polling = {}) {
  let recovery: any
  let listener: any = (_options: any, next: any) => next()
  const calls: any[] = [], events: any[] = [], warnings: any[] = []
  const llm = { stream: (options: any): AsyncIterable<any> => listener(options, async function* () {
    calls.push(options)
    const reply = replies[options.provider] ?? success
    yield* typeof reply === 'function' ? reply(options) : reply
  }) }
  installModelPolling({ on: (event: string, fn: any) => { if(event==='llm/stream')listener = fn;else recovery=fn }, get: (key: string) => key === 'llm' ? llm : { get: () => ({ append: (...args: any[]) => events.push(args) }) }, logger: { warn: (...args: any[]) => warnings.push(args) } },
    Object.fromEntries(providers.map(provider => [provider, { models: [{ id: 'shared' }] }])), polling)
  return { llm, calls, events, warnings, recover: (failure:any,next:any)=>recovery({failure},next) }
}

test('same model rotates across providers, deduplicates entries and keeps single routes unchanged', async () => {
  const f = fixture({}, ['a', 'b', 'c'])
  for (let i = 0; i < 4; i++) await collect(f.llm.stream(request()))
  assert.deepEqual(f.calls.map(c => c.provider), ['a', 'b', 'c', 'a'])
  await collect(f.llm.stream(request({ model: 'other' })))
  assert.equal(f.calls.at(-1).provider, 'a')
  const single = fixture({}, ['a'])
  assert.deepEqual(await collect(single.llm.stream(request())), success)
  assert.equal(single.events.length, 0)
})

test('eligible failures switch before content, retaining billable usage and actual route audit', async () => {
  for (const [code, status] of [['RATE_LIMIT', 429], ['AUTH', 401], ['QUOTA_EXCEEDED', 402], ['AUTH', 403], ['PI_AI_ERROR', 404], ['TIMEOUT', 408], ['SERVER', 503], ['TRANSPORT', undefined], ['MISSING_CREDENTIAL', undefined], ['EMPTY_RESPONSE', undefined]] as const) {
    const f = fixture({ a: [{ type: 'usage', usage: { inputTokens: 2, outputTokens: 0, totalTokens: 2 } }, finish(code, status)], b: [success[0], { type: 'usage', usage: { inputTokens: 3, outputTokens: 1, totalTokens: 4 } }, success[1]] })
    const result = await collect(f.llm.stream(request({ sessionId: 'fixture' })))
    assert.deepEqual(f.calls.map(c => c.provider), ['a', 'b'])
    assert.equal(result.at(-1).reason.kind, 'stop')
    assert.deepEqual(result.find(c => c.type === 'usage').usage, { inputTokens: 5, outputTokens: 1, totalTokens: 6 })
    assert.deepEqual(f.events.filter(e => e[0] === 'llm/polling').map(e => e[1].provider), ['a', 'b'])
    assert.equal(f.warnings.length, 1)
  }
})

test('request errors, cancellation, partial text/reasoning/tools and plugin throws never replay', async () => {
  for (const [code, status] of [['INVALID_REQUEST', 400], ['INVALID_REQUEST', 413], ['CONTEXT_WINDOW_EXCEEDED', undefined], ['UNSUPPORTED_CONTENT', undefined], ['ABORTED', undefined]] as const) {
    const f = fixture({ a: [finish(code, status)] })
    await collect(f.llm.stream(request()))
    assert.equal(f.calls.length, 1)
  }
  const overflow = finish('CONTEXT_WINDOW_EXCEEDED'); overflow.reason.failure.message = 'model 503 context exceeded'
  const invalid = fixture({ a: [overflow] }); await collect(invalid.llm.stream(request())); assert.equal(invalid.calls.length, 1)
  for (const partial of [{ type: 'block-start', index: 0, blockType: 'text' }, success[0], { type: 'reasoning-delta', index: 0, text: 'thinking' }, { type: 'tool-call-delta', index: 0, id: 't', name: 'tool', argumentsDelta: '{' }]) {
    const f = fixture({ a: [partial, finish()] })
    assert.deepEqual(await collect(f.llm.stream(request())), [partial, finish()])
    assert.equal(f.calls.length, 1)
  }
  const controller = new AbortController(); controller.abort()
  const cancelled = fixture({})
  const aborted = await collect(cancelled.llm.stream(request({ signal: controller.signal })))
  assert.equal(aborted.at(-1).reason.kind, 'aborted')
  assert.equal(cancelled.calls.length, 0)
  const thrown = fixture({ a: async function* () { throw new Error('plugin failed') } })
  await assert.rejects(collect(thrown.llm.stream(request())), /plugin failed/)
  assert.equal(thrown.calls.length, 1)
})

test('exhaustion attempts each same-model provider once and retains a recoverable failure for native bounded retry', async () => {
  const f = fixture({ a: [finish('SERVER', 503)], b: [finish('AUTH', 401)] })
  assert.deepEqual(await collect(f.llm.stream(request())), [{ type: 'finish', reason: finish('SERVER', 503).reason, replayState: undefined }])
  assert.deepEqual(f.calls.map(c => c.provider), ['a', 'b'])
})

test('cross-provider calls strip opaque replay state without mutating frozen requests', async () => {
  const f = fixture({})
  await collect(f.llm.stream(request()))
  const source = Object.freeze({ kind: 'model', provider: 'a', model: 'shared', replayState: { response: 'secret-state' } })
  const options = Object.freeze(request({ messages: Object.freeze([Object.freeze({ role: 'assistant', content: [], source })]) }))
  const result = await collect(f.llm.stream(options))
  assert.equal(f.calls.at(-1).provider, 'b')
  assert.equal(f.calls.at(-1).messages[0].source.replayState, undefined)
  assert.equal(result.at(-1).replayState, undefined)
  assert.equal(source.replayState.response, 'secret-state')
})

test('concurrent requests rotate without serializing model calls', async () => {
  let active = 0, peak = 0
  async function* reply() { active++; peak = Math.max(peak, active); await new Promise(resolve => setImmediate(resolve)); active--; yield* success }
  const f = fixture({ a: reply, b: reply })
  await Promise.all(Array.from({ length: 20 }, () => collect(f.llm.stream(request()))))
  assert.deepEqual(f.calls.map(c => c.provider), Array.from({ length: 20 }, (_, i) => i % 2 ? 'b' : 'a'))
  assert.equal(peak, 20)
})

test('native adapter rotates endpoints, fails over on 401, probes only the selected endpoint and reloads cleanly', async () => {
  const { Context } = await import(new URL('../../../vendor/deepseek-harness/vendor/cordis/lib/index.js', import.meta.url).href)
  const { mount } = await import('../../redtrace-dsh/lib/loader.js')
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-polling-')), calls: string[] = []
  let offline = false
  const server = createServer(async (req, res) => {
    for await (const _ of req) {}
    const provider = req.url!.split('/')[1]; calls.push(provider)
    assert.equal(req.headers.authorization, 'Bearer ' + provider + '-key')
    if (offline && provider === 'a') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '401 invalid key' } })); return }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: '+JSON.stringify({id:'c',object:'chat.completion.chunk',created:1,model:'shared',choices:[{index:0,delta:{content:provider},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const configuration = new Configuration(root); configuration.initialize()
  configuration.commit(configuration.read().revision, raw => {
    raw.providers = Object.fromEntries(['a','b'].map(provider => [provider, { api: 'openai-completions' as const, base_url: 'http://127.0.0.1:' + (server.address() as any).port + '/' + provider + '/v1', api_key: provider + '-key', models: [{ id: 'shared', context_window: 20000, max_tokens: 1000, reasoning_efforts: false }] }]))
    raw.workers = [{ name: 'fixture', provider: 'a', model: 'shared' }]
  })
  const ctx = new Context(), config = configuration.resolve(configuration.read().raw)
  const mountAdapter = async () => { const adapter = ctx.plugin({ name: 'fixture-polling', apply }, { providers: providerProfiles(config).providers, polling: config.llmPolling, credentialSource: { root, filename: configuration.filename, revision: configuration.read().revision } }); await adapter.await(); return adapter }
  const invoke = async () => {
    const prepared = await ctx.get('llm').prepareCall({ provider: 'a', model: 'shared' })
    return collect(prepared.stream(Object.freeze(request({ ...prepared.config, sessionId: 'polling-fixture', messages: [{ role: 'user', content: [{ type: 'text', text: 'OK' }] }], signal: AbortSignal.timeout(5000) }))))
  }
  try {
    await mount(ctx, 'vendor/deepseek-harness/packages/llm/llm/lib/index.js')
    await mount(ctx, 'vendor/deepseek-harness/packages/core/session/lib/index.js')
    const nativeEvents: any[] = []
    ctx.on('session/event', (_session: any, event: any) => nativeEvents.push(event))
    ctx.get('sessions').create('polling-fixture', { meta: { cwd: root } })
    let adapter = await mountAdapter()
    assert.equal((await invoke()).at(-1).reason.kind, 'stop')
    assert.equal((await invoke()).at(-1).reason.kind, 'stop')
    assert.deepEqual(calls, ['a', 'b']); calls.length = 0; offline = true
    assert.equal((await invoke()).at(-1).reason.kind, 'stop')
    assert.deepEqual(calls, ['a', 'b']); calls.length = 0
    assert.ok(nativeEvents.some((event: any) => event.type === 'llm/polling' && event.data.provider === 'b'))
    assert.ok(nativeEvents.some((event: any) => event.type === 'llm/polling-failed' && event.data.provider === 'a'))
    await assert.rejects(probeModel(ctx, configuration, config, config.workers[0], AbortSignal.timeout(5000)), /401/)
    assert.deepEqual(calls, ['a']); calls.length = 0
    const controller = new AbortController(); controller.abort()
    assert.equal((await collect(ctx.get('llm').stream(request({ signal: controller.signal })))).at(-1).reason.kind, 'aborted')
    assert.deepEqual(calls, [])
    await adapter.dispose(); adapter = await mountAdapter()
    assert.equal((await invoke()).at(-1).reason.kind, 'stop')
    assert.deepEqual(calls, ['a', 'b']); calls.length = 0
    await adapter.dispose(); config.llmPolling = { enabled: false, models: { shared: ['b','a'] } }; adapter = await mountAdapter()
    assert.equal((await invoke()).at(-1).reason.kind, 'error'); assert.deepEqual(calls, ['a']); calls.length = 0
    await adapter.dispose(); config.llmPolling = { enabled: true, models: { shared: ['b','a'] } }; adapter = await mountAdapter()
    assert.equal((await invoke()).at(-1).reason.kind, 'stop'); assert.deepEqual(calls, ['b'])
  } finally { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})

test('polling settings disable rotation, control initial order and exclude unselected suppliers', async () => {
  const off = fixture({}, ['a','b'], { enabled: false });
  for (let i = 0; i < 2; i++) await collect(off.llm.stream(request()));
  assert.deepEqual(off.calls.map(c => c.provider), ['a','a']);
  const ordered = fixture({}, ['a','b','c'], { enabled: true, models: { shared: ['b','a'] } });
  for (let i = 0; i < 3; i++) await collect(ordered.llm.stream(request()));
  assert.deepEqual(ordered.calls.map(c => c.provider), ['b','a','b']);
  const direct = fixture({ a: [finish()] }, ['a','b'], { enabled: true, models: { shared: ['b'] } });
  await collect(direct.llm.stream(request()));
  assert.deepEqual(direct.calls.map(c => c.provider), ['a']);
})

test('partial responses veto native request retries, preserving the original failure',async()=>{
 const error=finish('TIMEOUT'),f=fixture({a:[success[0],error]})
 await collect(f.llm.stream(request()))
 assert.throws(()=>f.recover(error.reason.failure,()=>{throw Error('unsafe retry')}),(e:any)=>e.code==='PARTIAL_RESPONSE'&&e.failure===error.reason.failure)
 const untouched=finish('TIMEOUT').reason.failure
 assert.equal(f.recover(untouched,()=> 'native bounded retry'),'native bounded retry')
})
