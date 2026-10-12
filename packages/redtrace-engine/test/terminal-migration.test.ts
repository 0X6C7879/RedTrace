import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Operations, resourceKinds } from '../src/operations.ts'
import { verbIds, dispatchVerb } from '../src/capability-verbs.ts'
import type { Step, StepStatus } from '../src/types.ts'

test('native Terminal migration changes only unfinished Step requirements and is idempotent', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-terminal-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const filename = path.join(root, 'engine.db')
  let store = new Store(filename)
  let projectId: string, runId: string, beforeRuns: unknown, beforeEvents: unknown, revision: number
  const originals: Step[] = []
  try {
    projectId = store.createProject({ title: 'Legacy terminals', origin: 'Fixture', goal: 'Keep task contracts', bootstrap: false }).project.id
    for (const status of ['pending', 'running', 'paused', 'blocked', 'done', 'cancelled', 'deleted'] as const) {
      const step = store.addStep(projectId, { description: `Legacy ${status}`, sourceIds: ['origin'], requires: ['remote.command'], executionProfile: 'isolated' })
      if (status === 'running') {
        const run = store.claim(projectId, 'execute', { name: 'fixture', backend: 'mock' }, step.id)
        run.pendingTools = ['old-terminal-write']; run.status = 'unknown'
        store.db.prepare('UPDATE runs SET status=?,data=? WHERE id=?').run(run.status, JSON.stringify(run), run.id)
        runId = run.id
      }
      const legacy = { ...store.node<Step>(projectId, step.id), status: status === 'deleted' ? 'pending' : status as StepStatus,
        requires: ['remote.terminal.open', 'remote.command', 'remote.terminal.send'], ...(status === 'deleted' ? { deleted: true } : {}) }
      store.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify(legacy), projectId, step.id)
      originals.push(legacy)
    }
    beforeRuns = store.db.prepare('SELECT * FROM runs').all()
    beforeEvents = store.events(projectId)
    revision = store.project(projectId).revision
  } finally { store.close() }
  store = new Store(filename)
  try {
    for (const prior of originals) {
      const step = JSON.parse(String(store.db.prepare('SELECT data FROM nodes WHERE project_id=? AND id=?').get(projectId!, prior.id)!.data))
      if (prior.deleted || ['done', 'cancelled'].includes(prior.status)) assert.deepEqual(step, prior)
      else assert.deepEqual(step, { ...prior, requires: ['remote.command'], version: (prior.version ?? 1) + 1, planVersion: (prior.planVersion ?? 1) + 1 })
    }
    assert.deepEqual(store.db.prepare('SELECT * FROM runs').all(), beforeRuns)
    assert.deepEqual(store.run(runId!).pendingTools, ['old-terminal-write'])
    assert.equal(store.run(runId!).status, 'unknown')
    const events = store.events(projectId!)
    assert.deepEqual(events.slice(0, -4), beforeEvents)
    assert.ok(events.slice(-4).every(e => e.type === 'step.revised' && /DSH Terminal/.test(String((e.payload as any).reason))))
    assert.equal(store.project(projectId!).revision, revision! + 4)
    assert.throws(() => store.addStep(projectId!, { description: 'Removed verb', sourceIds: ['origin'], requires: ['remote.terminal.open'] }), /Unknown capability verb/)
    assert.throws(() => store.updateStep(projectId!, originals[0].id, { requires: ['remote.terminal.read'] }), /Invalid requires/)
  } finally { store.close() }
  store = new Store(filename)
  try {
    assert.equal(store.project(projectId!).revision, revision! + 4)
    assert.equal(store.events(projectId!).length, (beforeEvents as any[]).length + 4)
  } finally { store.close() }
})

test('retired terminal Resources remain readable offline but cannot be created or dispatched', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-terminal-history-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const store = new Store(':memory:')
  let operations = new Operations(store, root)
  try {
    const project = store.createProject({ title: 'History', origin: 'Fixture', goal: 'Preserve resources' }).project
    const ids = ['available', 'degraded', 'retired'].map(status => {
      const row = operations.create(project.id, { kind: 'proxy', name: `Legacy ${status}`, status, metadata: { interactive: true, verified_capabilities: ['remote.terminal.send'] } }).resource
      store.db.prepare("UPDATE shared_resources SET kind='terminal' WHERE id=?").run(row.id)
      operations.audit(project.id, row.id, null, { actor_type: 'human', actor: 'fixture' }, 'terminal.open', 'succeeded')
      return row.id
    })
    const history = store.db.prepare('SELECT * FROM resource_audit_events').all()
    await operations.close()
    operations = new Operations(store, root)
    for (const [index, id] of ids.entries()) {
      const row = operations.publicResource(operations.resource(id))
      assert.equal(row.kind, 'terminal')
      assert.equal(row.status, index === 2 ? 'retired' : 'offline')
      if (index < 2) assert.deepEqual(row.metadata.verified_capabilities, [])
    }
    assert.deepEqual(store.db.prepare('SELECT * FROM resource_audit_events').all(), history)
    assert.equal(resourceKinds.includes('terminal'), false)
    assert.equal(verbIds.some(id => id.startsWith('remote.terminal.')), false)
    assert.throws(() => operations.create(project.id, { kind: 'terminal', name: 'New PTY' }), /Unsupported resource kind/)
    await assert.rejects(dispatchVerb({ operations }, 'remote.terminal.open', {}, { projectId: project.id, worker: 'fixture', stepId: null, signal: new AbortController().signal }), /Unknown capability verb/)
  } finally { await operations.close(); store.close() }
})
