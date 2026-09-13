import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { Configuration } from '../src/config.ts'
import { runPi } from '../src/runner.ts'

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
      raw.providers = { fixture: { api: 'openai-completions', base_url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, api_key: 'fixture-key', models: [{ id: 'fixture', context_window: 20000, max_tokens: 1000, reasoning_efforts: false, reasoning: 'off' }] } }
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
