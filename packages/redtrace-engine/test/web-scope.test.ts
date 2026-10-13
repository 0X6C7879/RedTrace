import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { webTools, closeWebSessions } from '../src/web.ts'
import type { EngineConfig, Worker } from '../src/types.ts'

const worker: Worker = { name: 'browser-test', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }
test('HTTP accepts hosts absent from Scope; URL and session validation remain', async () => {
  const server = createServer((_req, res) => res.end('unlisted fixture'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-web-unlisted-'))
  const store = new Store(':memory:'), project = store.createProject({ title: 'Web', origin: 'No enumerated hosts', goal: 'Inspect local fixture' }).project
  const step = store.addStep(project.id, { description: 'Browse', sourceIds: ['origin'] }), run = store.claim(project.id, 'execute', worker, step.id)
  run.workspaceRoot = root
  try {
    const tools = webTools({ store, run, worker, config: {} as EngineConfig, signal: new AbortController().signal })
    const batch = tools.find(tool => tool.name === 'http_batch')!, open = tools.find(tool => tool.name === 'web_open')!
    const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`
    const result = await batch.execute('batch', { session: 'unlisted', requests: [{ url }] }) as any
    assert.deepEqual(result.results.map((item: any) => item.status), [200])
    await assert.rejects(open.execute('open', { url, session: 'bad session' }), /session must be/)
    for (const invalid of ['file:///etc/passwd', 'http://user:pass@localhost/', 'not-a-url']) {
      await assert.rejects(batch.execute('invalid', { session: 'unlisted', requests: [{ url: invalid }] }), /HTTP\(S\)|absolute URL/)
    }
  } finally { await closeWebSessions(store); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
