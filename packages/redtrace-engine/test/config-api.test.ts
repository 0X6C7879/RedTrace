import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { serveEngine } from '../src/index.ts'
import { Configuration } from '../src/config.ts'

test('initialization copies seed configuration into the managed root and encrypts its secrets in place', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-config-copy-')), source = path.join(root, 'legacy.yaml')
  const plaintext = 'providers: {}\nworkers: []\ncommon_env:\n  API_TOKEN: legacy-secret\n'
  writeFileSync(source, plaintext)
  try {
    const config = new Configuration(root)
    config.initialize(source)
    assert.equal(readFileSync(source, 'utf8'), plaintext)
    assert.doesNotMatch(readFileSync(config.filename, 'utf8'), /legacy-secret/)
    assert.deepEqual(config.snapshot().common_env, [{ name: 'API_TOKEN', value: 'legacy-secret' }])
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('worker mutations probe the live model before commit and retain the old snapshot contract', async () => {
  let probes = 0
  const model = createServer(async (req, res) => {
    for await (const _ of req) {}
    probes++; res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-config-api-')), engine = await serveEngine({ root, port: 0, autoStart: false })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const call = async (route: string, method = 'GET', data?: unknown) => { const response = await fetch(url + route, { method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) }); return { status: response.status, data: await response.json() as any } }
  try {
    let snapshot = (await call('/worker-config')).data
    assert.equal((await call('/worker-config/common-env', 'PUT', { expected_revision: snapshot.revision, entries: [{ name: 'bad-name', value: 'x' }] })).status, 422)
    snapshot = (await call('/worker-config/common-env', 'PUT', { expected_revision: snapshot.revision, entries: [{ name: 'API_TOKEN', value: 'token-at-rest' }, { name: 'PUBLIC_URL', value: 'https://example.test' }] })).data
    const persistedEnvironment = readFileSync(path.join(root, '.redtrace/redtrace.yaml'), 'utf8')
    assert.doesNotMatch(persistedEnvironment, /token-at-rest/); assert.match(persistedEnvironment, /REDTRACE_SECRET/)
    assert.deepEqual(snapshot.common_env, [{ name: 'API_TOKEN', value: 'token-at-rest' }, { name: 'PUBLIC_URL', value: 'https://example.test' }])
    snapshot = (await call('/worker-config/providers', 'POST', { expected_revision: snapshot.revision, name: 'fixture', api: 'openai-completions', base_url: `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`, api_key: 'fixture-key', models: [{ id: 'fixture', context_window: 10000, max_tokens: 1000 }] })).data
    assert.doesNotMatch(readFileSync(path.join(root, '.redtrace/redtrace.yaml'), 'utf8'), /fixture-key/)
    const worker = { expected_revision: snapshot.revision, name: 'worker', provider: 'fixture', model: 'fixture', priority: 0, max_running: 1 }
    const saved = await call('/worker-config/workers', 'POST', worker)
    assert.equal(saved.status, 201); assert.equal(probes, 1); assert.equal(saved.data.engine, 'dsh'); assert.equal(saved.data.workers[0].type, 'dsh')
    snapshot = (await call('/worker-config/providers', 'POST', { expected_revision: saved.data.revision, name: 'offline', api: 'openai-completions', base_url: 'http://127.0.0.1:1/v1', api_key: 'x', models: [{ id: 'offline' }] })).data
    assert.equal((await call('/worker-config/workers', 'POST', { ...worker, expected_revision: snapshot.revision, name: 'bad', provider: 'offline', model: 'offline' })).status, 422)
    assert.equal((await call('/worker-config')).data.workers.some((item: any) => item.name === 'bad'), false)
  } finally { await engine.close(); model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
