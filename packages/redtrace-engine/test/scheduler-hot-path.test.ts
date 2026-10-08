import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import { graphUpdate } from '../src/runner.ts'
import type { EngineConfig, Worker } from '../src/types.ts'

const worker: Worker = { name: 'hot-path', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: true, explore: true, bootstrap: false, maxRunning: 8, priority: 0 }
const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 8, maxProjectWorkers: 8, maxRunningProjects: 2, maxSteps: null,
  decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: os.tmpdir() }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await turn() } assert.fail('Condition did not settle') }

test('schema 2 rejects an old engine database instead of migrating it implicitly', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-schema-')), filename = path.join(root, 'engine.db')
  try {
    const db = new DatabaseSync(filename); db.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES ('schema','1')"); db.close()
    assert.throws(() => new Store(filename), /Unsupported engine schema 1.*remove the old engine database/)
    const unchanged = new DatabaseSync(filename, { readOnly: true })
    assert.equal(unchanged.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name='nodes_project_kind'").get(), undefined); unchanged.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('Step and Goal selection uses the project-kind index', () => {
  const store = new Store(':memory:')
  try {
    const plan = store.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM nodes WHERE project_id=? AND kind IN ('step','goal') ORDER BY rowid").all('proj_001')
    assert.ok(plan.some(row => String(row.detail).includes('nodes_project_kind')), JSON.stringify(plan))
  } finally { store.close() }
})

test('Pi and Cordis shared notification scan drains more than 500 events without reading the graph', () => {
  const store = new Store(':memory:'), id = store.createProject({ title: 'Events', origin: 'Scope', goal: 'Goal' }).project.id
  try {
    for (let i = 0; i < 501; i++) store.addInput(id, 'observation', `noise ${i}`)
    store.addInput(id, 'hint', 'relevant update')
    ;(store as Store & { graph: Store['graph'] }).graph = (() => { throw new Error('full graph must not be read') }) as Store['graph']
    const update = graphUpdate(store, id, 0, null)
    assert.equal(update.relevant, true)
    assert.equal(store.events(id, update.cursor).length, 0)
  } finally { store.close() }
})

test('dispatch health and scheduling never load the full graph with 20,083 nodes', async () => {
  const store = new Store(':memory:'), id = store.createProject({ title: 'Large', origin: 'Scope', goal: 'Goal' }).project.id
  const initial = store.claim(id, 'decide', worker); store.finishRun(initial.id, 'succeeded')
  store.addStep(id, { description: 'Wait for shutdown', sourceIds: ['origin'] })
  const insert = store.db.prepare('INSERT INTO nodes VALUES (?,?,?,?)')
  store.db.exec('BEGIN')
  for (let i = 0; i < 20_080; i++) insert.run(id, `bulk-${i}`, 'fact', JSON.stringify({ id: `bulk-${i}`, projectId: id, kind: 'fact', description: 'bulk', stepId: null, evidence: [], creator: 'test', createdAt: '' }))
  store.db.exec('COMMIT')
  let graphCalls = 0
  const graph = store.graph.bind(store)
  ;(store as Store & { graph: Store['graph'] }).graph = ((...args: Parameters<Store['graph']>) => { graphCalls++; return graph(...args) }) as Store['graph']
  const scheduler = new Scheduler(store, config, async ({ run, signal }) => {
    if (run.activity === 'execute') await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  try {
    scheduler.start(); await until(() => scheduler.activeRuns.some(run => run.activity === 'execute'))
    store.addInput(id, 'hint', 'Trigger another dispatch'); await turn(); await turn()
    assert.equal(graphCalls, 0)
  } finally { await scheduler.close(); assert.equal(graphCalls, 0); store.close() }
})
