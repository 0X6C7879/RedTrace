import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { graphUpdate } from '../src/runner.ts'

const cordisPath = '../compat/cordis.mjs'
const { listenGraphChanges } = await import(cordisPath)
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const worker = { name: 'fixture', backend: 'mock' as const }

test('committed Step notices coalesce, rollbacks stay silent, and subscriptions are project scoped', async () => {
  const store = new Store(':memory:')
  const a = store.createProject({ title: 'A', origin: 'Local', goal: 'Check' }).project.id
  const b = store.createProject({ title: 'B', origin: 'Local', goal: 'Check' }).project.id
  const step = store.addStep(a, { description: 'A', sourceIds: ['origin'] })
  const foreign = store.addStep(b, { description: 'B', sourceIds: ['origin'] })
  const run = store.claim(a, 'execute', worker, step.id)
  await turn()
  let checks = 0, reason = 0
  const off = listenGraphChanges(store, run, () => { checks++ })
  const offReason = listenGraphChanges(store, { projectId: a, stepId: null }, (id: string) => { if (id === a) reason++ })
  try {
    for (let i = 0; i < 1000; i++) store.updateStep(a, step.id, { priority: i })
    await turn(); assert.equal(checks, 1); assert.equal(reason, 1)
    store.updateStep(b, foreign.id, { priority: 1 })
    assert.throws(() => store.transaction(() => { store.updateStep(a, step.id, { priority: 9999 }); throw new Error('rollback') }), /rollback/)
    await turn(); assert.equal(checks, 1); assert.equal(reason, 1)
    assert.equal(store.node(a, step.id).kind, 'step')
    store.addFact(a, 'New evidence')
    await turn(); assert.equal(checks, 1); assert.equal(reason, 2)
    store.updateStep(a, step.id, { description: 'Replaced', mode: 'replace', expectedVersion: store.node(a, step.id).version })
    await turn(); assert.equal(checks, 2)
    assert.equal(graphUpdate(store, a, run.deliveredGraphCursor!, step.id, run.id).stopped, true)
  } finally { off(); offReason(); assert.equal(store.changes.eventNames().length, 0); store.close() }
})

test('Step scans use the scoped index and never parse unrelated FGS events', () => {
  const store = new Store(':memory:')
  const id = store.createProject({ title: 'Scan', origin: 'Local', goal: 'Check' }).project.id
  const step = store.addStep(id, { description: 'Explore', sourceIds: ['origin'] })
  const run = store.claim(id, 'execute', worker, step.id)
  try {
    for (let i = 0; i < 501; i++) store.addFact(id, `Evidence ${i}`)
    store.db.prepare("UPDATE events SET data='invalid JSON' WHERE project_id=? AND type='fact.added'").run(id)
    store.updateStep(id, step.id, { description: 'Amended', mode: 'amend', expectedVersion: store.node(id, step.id).version })
    const update = graphUpdate(store, id, run.deliveredGraphCursor!, step.id, run.id)
    assert.equal(update.planChanged, true); assert.deepEqual(update.counts, { 'step.revised': 1 })
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT * FROM events WHERE project_id=? AND node_id=? AND id>? ORDER BY id LIMIT ?').all(id, step.id, 0, 500)
    assert.ok(plan.some(row => String(row.detail).includes('events_step')), JSON.stringify(plan))
  } finally { store.close() }
})
