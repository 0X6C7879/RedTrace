import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.ts'
import { webTools } from '../src/web.ts'
import type { EngineConfig, Worker } from '../src/types.ts'

const worker: Worker = { name: 'browser-test', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }

test('browser navigation and HTTP requests reject hosts outside explicit project Scope before launch', async () => {
  const store = new Store(':memory:'), project = store.createProject({ title: 'Scoped web', origin: 'Authorized URL: http://127.0.0.1:8080', goal: 'Inspect the authorized test service' }).project
  const step = store.addStep(project.id, { description: 'Browse the service', sourceIds: ['origin'] }), run = store.claim(project.id, 'execute', worker, step.id)
  try {
    const context = { store, run, worker, config: {} as EngineConfig, signal: new AbortController().signal }, tools = webTools(context)
    const open = tools.find(tool => tool.name === 'web_open')!, batch = tools.find(tool => tool.name === 'http_batch')!
    await assert.rejects(open.execute('open', { url: 'http://127.0.0.1:8081/', session: 'scoped' }), /not present in the project Scope/)
    await assert.rejects(batch.execute('batch', { session: 'scoped', requests: [{ url: 'http://127.0.0.1:8081/' }] }), /not present in the project Scope/)
    await assert.rejects(open.execute('open', { url: 'http://127.0.0.1:8080/', session: 'bad session' }), /session must be/)
  } finally { store.close() }
})
