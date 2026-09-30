import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { Configuration } from '../src/config.ts'
import { runPi } from '../src/runner.ts'
import { JevService } from '../src/jev.ts'

test('public Pi Agent executes real file and graph tools through the model HTTP adapter', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-pi-')), store = new Store(path.join(root, 'engine.db'))
  let calls = 0
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString()), actions = [
      ['write', { path: 'verified.txt', content: 'Pi file tool verified' }],
      ['submit_fact', { description: 'Verified file created', evidence: [{ description: 'write tool returned success', path: 'verified.txt' }] }],
      ['submit_finding', { title: 'Pi result', description: 'Created a file using the public Agent', factIds: ['f001'] }],
      ['finish_step', { summary: 'Verified file and finding submitted' }],
    ] as const
    const [name, args] = actions[calls++] ?? ['finish_step', { summary: 'Stop fixture' }]
    assert.equal(request.messages[0].role, 'system')
    assert.ok(request.tools.some((t: any) => t.function.name === name))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    const chunk = (delta: unknown, finish_reason: string | null = null, usage?: unknown) => res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }], usage })}\n\n`)
    chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call-${calls}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] })
    chunk({}, 'tool_calls', { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 }); res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const c = new Configuration(root); c.initialize()
    c.commit(c.read().revision, raw => {
      raw.providers = { fixture: { api: 'openai-completions', base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api_key: 'fixture-key', models: [{ id: 'fixture', context_window: 20000, max_tokens: 1000, reasoning: 'off' }] } }
      raw.workers = [{ name: 'fixture', provider: 'fixture', model: 'fixture' }]
    })
    const config = c.resolve(c.read().raw), worker = config.workers[0]
    const { project } = store.createProject({ title: 'Pi', origin: 'Fixture input', goal: 'Produce a verified file', bootstrap: false }), step = store.addStep(project.id, { description: 'Create a verified file', sourceIds: ['origin'] })
    const run = store.claim(project.id, 'execute', worker, step.id)
    await runPi({ store, run, config, worker, signal: new AbortController().signal })
    store.finishRun(run.id, 'succeeded')
    assert.equal(calls, 4)
    assert.equal(store.graph(project.id).findings.length, 1)
    assert.equal(readFileSync(path.join(config.workspaceRoot, project.id, 'verified.txt'), 'utf8'), 'Pi file tool verified')
    assert.equal(store.run(run.id).inputTokens, 48)
    assert.deepEqual(store.run(run.id).pendingTools, [])
    assert.ok((store.run(run.id).checkpoint as any).messages.length > 4)
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('Pi shell keeps its log while Jev shortens the model-visible result', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-pi-jev-')), store = new Store(path.join(root, 'engine.db'))
  const previousKey = process.env.TYPESAFE_API_KEY
  const requests: any[] = []
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(request)
    const [name, args] = requests.length === 1
      ? ['shell', { command: 'for i in {1..120}; do echo "marker $i abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz"; done' }]
      : ['finish_step', { summary: 'Captured the shell output' }]
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const c = new Configuration(root); c.initialize()
    c.commit(c.read().revision, raw => {
      raw.providers = { fixture: { api: 'openai-completions', base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api_key: 'fixture-key', models: [{ id: 'fixture', context_window: 20000, max_tokens: 1000, reasoning_efforts: false, reasoning: 'off' }] } }
      raw.workers = [{ name: 'fixture', provider: 'fixture', model: 'fixture' }]
    })
    const config = c.resolve(c.read().raw), worker = config.workers[0]
    const { project } = store.createProject({ title: 'Pi Jev', origin: 'Fixture scope', goal: 'Inspect output', bootstrap: false })
    const step = store.addStep(project.id, { description: 'Inspect the marker output', sourceIds: ['origin'] })
    const run = store.claim(project.id, 'execute', worker, step.id)
    const jev = new JevService(store, config.workspaceRoot, async (_url, init) => {
      const request = JSON.parse(String(init?.body)), criteria = Object.keys(request.questions.relevant.criteria)
      const choice = criteria.find(item => item.startsWith('c')) ?? 'none'
      return Response.json({ model: 'jev-1.13.0', answers: { relevant: { type: 'choice', choice, confidence: 0.99, probabilities: Object.fromEntries(criteria.map(item => [item, Number(item === choice)])) } }, usage: { input_tokens: 120 } })
    })
    jev.setScenes({ tool_filter: true }); jev.setEnabled(true)
    await runPi({ store, run, config, worker, signal: new AbortController().signal, jev })
    const toolMessage = requests[1].messages.findLast((message: any) => message.role === 'tool')
    const text = typeof toolMessage.content === 'string' ? toolMessage.content : JSON.stringify(toolMessage.content)
    assert.match(text, /Jev excerpt/, JSON.stringify((await jev.evaluations(project.id)).map(item => item.status)))
    assert.match(text, /outputPath/)
    const recovery = text.match(/\.redtrace-output\/jev\/[a-f0-9]+\.txt/)?.[0]
    assert.ok(recovery)
    const raw = readFileSync(path.join(config.workspaceRoot, project.id, recovery), 'utf8')
    assert.match(raw, /marker 1 /)
    assert.match(raw, /marker 120 /)
    jev.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('Pi refreshes Jev prompt and tool schemas between turns in one run', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-pi-toggle-')), store = new Store(path.join(root, 'engine.db'))
  const requests: any[] = []
  let jev: JevService
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk)
    const request = JSON.parse(Buffer.concat(chunks).toString())
    requests.push(request)
    const on = requests.length !== 2
    assert.equal(request.tools.some((tool: any) => tool.function.name === 'jev_choose'), on)
    assert.equal(JSON.stringify(request.messages[0]).includes('jev_choose'), on)
    if (requests.length === 1) jev.setEnabled(false)
    if (requests.length === 2) jev.setEnabled(true)
    if (requests.length === 4) assert.match(JSON.stringify(request.messages.findLast((message: any) => message.role === 'tool')), /invalid_candidates/)
    const name = requests.length === 4 ? 'finish_step' : requests.length === 3 ? 'jev_choose' : 'read_graph'
    const args = name === 'finish_step' ? { summary: 'Toggle verified' }
      : name === 'jev_choose' ? { kind: 'web', objective: 'Choose a source', candidates: [
        { id: 'same', title: 'A', reference: 'https://example.test/a' }, { id: 'same', title: 'B', reference: 'https://example.test/b' },
      ] } : {}
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id: 'test', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const c = new Configuration(root); c.initialize()
    c.commit(c.read().revision, raw => {
      raw.providers = { fixture: { api: 'openai-completions', base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api_key: 'fixture-key', models: [{ id: 'fixture', context_window: 20000, max_tokens: 1000, reasoning: 'off' }] } }
      raw.workers = [{ name: 'fixture', provider: 'fixture', model: 'fixture' }]
    })
    const config = c.resolve(c.read().raw), worker = config.workers[0]
    const { project } = store.createProject({ title: 'Pi toggle', origin: 'Fixture scope', goal: 'Check hot toggle', bootstrap: false })
    const step = store.addStep(project.id, { description: 'Read graph twice', sourceIds: ['origin'] })
    const run = store.claim(project.id, 'execute', worker, step.id)
    jev = new JevService(store, config.workspaceRoot)
    jev.setEnabled(true)
    await runPi({ store, run, config, worker, signal: new AbortController().signal, jev })
    assert.equal(requests.length, 4)
    jev.close()
  } finally {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
