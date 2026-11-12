import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createEngine } from '../src/index.ts'
import { Store } from '../src/store.ts'
import { dispatchVerb } from '../src/capability-verbs.ts'
import { fixtureFrame } from './execution-fixture.ts'

test('generic Explore endings preserve the fact-driven wake contract', () => {
  const store = new Store(':memory:')
  try {
    for (const status of ['failed', 'unknown'] as const) {
      const project = store.createProject({ title: status, origin: 'fixture', goal: 'recover' }).project
      const planning = store.claim(project.id, 'decide', { name: 'fixture', backend: 'mock' })
      store.finishRun(planning.id, 'succeeded')
      const step = store.addStep(project.id, { description: 'fixture', sourceIds: ['origin'] })
      const run = store.claim(project.id, 'execute', { name: 'fixture', backend: 'mock' }, step.id)
      store.finishRun(run.id, status, 'fixture failure')
      store.finishRun(run.id, status, 'fixture failure')
      assert.equal(store.project(project.id).criticalSeq ?? 0, 0)
      assert.equal(store.project(project.id).factSeq, 0)
      assert.equal(store.run(run.id).status, status)
    }
  } finally { store.close() }
})

test('missing TCP transport fails explicitly and persisted route metadata is not fresh verification', async () => {
  const root = mkdtempSync('/tmp/redtrace-boundary-'), engine = await createEngine({ root, autoStart: false })
  try {
    const project = engine.store.createProject({ title: 'fixture', origin: 'fixture', goal: 'reconnect' }).project
    const listener = engine.operations.create(project.id, { kind: 'c2_listener', name: 'inert' }).resource
    const raw = engine.operations.create(project.id, { kind: 'c2_session', name: 'disconnected', parent_resource_id: listener.id,
      metadata: { connection_type: 'reverse', capabilities: ['command'] } }).resource
    const task = engine.operations.createTask(project.id, raw.id, { action: 'command', arguments: { command: 'echo fixture' } })
    await new Promise<void>(resolve => setImmediate(resolve))
    const result = engine.operations.publicTask(engine.operations.task(task.id))
    assert.equal(result.status, 'failed')
    assert.equal(result.result.error_code, 'TRANSPORT_ERROR')
    engine.operations.create(project.id, { kind: 'proxy', name: 'persisted only', target: 'fixture',
      metadata: { provider: 'ssh-forward', runtime_verified: true, verified_at: new Date().toISOString(), target_scope: 'fixture' } })
    assert.deepEqual(engine.operations.pivots.paths(project.id, 'fixture'), [])
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})

test('remote command has no implicit probe and explicit session probe remains available', async () => {
  const root = mkdtempSync('/tmp/redtrace-boundary-'), wire: string[] = []
  const remote = createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk }); req.on('end', () => {
      const command = new URLSearchParams(body).get('cmd') ?? ''; wire.push(command)
      res.end(fixtureFrame(command, 'version=1\nos=Linux\nhostname=fixture'))
    })
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const engine = await createEngine({ root, autoStart: false })
  try {
    const project = engine.store.createProject({ title: 'fixture', origin: 'fixture', goal: 'explicit tools' }).project
    const shell = engine.operations.create(project.id, { kind: 'webshell', name: 'fixture', target: `http://127.0.0.1:${(remote.address() as AddressInfo).port}`,
      metadata: { command_param: 'cmd', protocol: 'raw' } }).resource
    const context = { projectId: project.id, worker: 'fixture', stepId: null, signal: new AbortController().signal }
    assert.equal((await dispatchVerb({ operations: engine.operations }, 'remote.command', { via: shell.id, command: 'echo requested' }, context)).status, 'succeeded')
    assert.equal(wire.length, 1)
    assert.deepEqual(engine.store.db.prepare('SELECT action FROM operation_tasks ORDER BY rowid').all().map(row => row.action), ['command'])
    assert.equal((await dispatchVerb({ operations: engine.operations }, 'remote.session.probe', { via: shell.id }, context)).status, 'succeeded')
    assert.equal(wire.length, 2)
  } finally { await engine.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
