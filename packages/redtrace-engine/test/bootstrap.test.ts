import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Configuration } from '../src/config.ts'
import { activityLimits, activityPrompt, graphTools } from '../src/runner.ts'
import type { EngineConfig, Worker } from '../src/types.ts'

const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const until = async (predicate: () => boolean, turns = 50) => { for (let i = 0; i < turns && !predicate(); i++) await turn() }
const worker = (name: string, capabilities: Partial<Pick<Worker, 'reason' | 'explore' | 'bootstrap'>>, priority = 0): Worker =>
  ({ name, backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: false, bootstrap: false, maxRunning: 4, priority, ...capabilities })
const engineConfig = (workers: Worker[]): EngineConfig =>
  ({ workers, providers: {}, maxWorkers: 4, maxProjectWorkers: 4, maxRunningProjects: 2, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 60, bootstrapConcludeTimeout: 7, workspaceRoot: '.' })
const bootstrapProject = (s: Store) => s.createProject({ title: 'Bootstrap', origin: 'Scope', goal: 'Verified result', bootstrap: true }).project.id

test('the bootstrap Step owns the first move and hands the project to Decide when it settles', async () => {
  const s = new Store(':memory:')
  const id = bootstrapProject(s)
  const seen: string[] = [], gates: Array<() => void> = []
  const release = async () => { for (let i = 0; i < 10 && gates.length; i++) { gates.splice(0).forEach(gate => gate()); await turn() } }
  const scheduler = new Scheduler(s, engineConfig([worker('bootstrap-1', { bootstrap: true }), worker('reason-1', { reason: true })]),
    ({ store, run }) => {
      seen.push(run.activity)
      return new Promise<void>(resolve => gates.push(() => {
        if (run.activity === 'execute') store.addFact(run.projectId, 'Bootstrap result', { runId: run.id, creator: run.worker, evidence: [{ description: 'verified by bootstrap' }] })
        resolve()
      }))
    })
  try {
    scheduler.start(); await until(() => seen.length > 0); await turn()
    assert.deepEqual(seen, ['execute'], 'Decide must not race the bootstrap Step')
    const run = s.runs(id)[0], step = s.graph(id).steps[0]
    assert.equal(step.bootstrap, true); assert.equal(run.stepId, step.id); assert.equal(run.worker, 'bootstrap-1')
    await release()
    assert.deepEqual(seen, ['execute', 'decide'], 'Decide takes over once the bootstrap Step succeeds')
    assert.equal(s.runs(id).at(-1)!.worker, 'reason-1')
    assert.equal(s.graph(id).steps[0].status, 'done')
  } finally { await release(); await scheduler.close(); s.close() }
})

test('Reason stays blocked when bootstrap returns without a Fact', async () => {
  const s = new Store(':memory:')
  const id = bootstrapProject(s), seen: string[] = []
  const scheduler = new Scheduler(s, engineConfig([worker('bootstrap-1', { bootstrap: true }), worker('reason-1', { reason: true })]),
    async ({ run }) => { seen.push(run.activity) })
  try {
    scheduler.start(); await until(() => s.runs(id).some(run => run.status !== 'running'))
    for (let i = 0; i < 10; i++) await turn()
    assert.deepEqual(seen, ['execute'])
    assert.equal(s.graph(id).steps[0].status, 'blocked')
    assert.match(s.runs(id)[0].error ?? '', /Fact/)
  } finally { await scheduler.close(); s.close() }
})

test('Reason stays blocked when bootstrap fails', async () => {
  const s = new Store(':memory:')
  const id = bootstrapProject(s), seen: string[] = []
  const scheduler = new Scheduler(s, engineConfig([worker('bootstrap-1', { bootstrap: true }), worker('reason-1', { reason: true })]),
    async ({ run }) => { seen.push(run.activity); if (run.activity === 'execute') throw new Error('bootstrap failed') })
  try {
    scheduler.start(); await until(() => s.runs(id).some(run => run.status === 'failed'))
    for (let i = 0; i < 10; i++) await turn()
    assert.deepEqual(seen, ['execute'])
    assert.equal(s.graph(id).steps[0].status, 'blocked')
  } finally { await scheduler.close(); s.close() }
})

test('a project without bootstrap goes directly to Reason', async () => {
  const s = new Store(':memory:')
  const id = s.createProject({ title: 'Direct', origin: 'Scope', goal: 'Verified result', bootstrap: false }).project.id
  const seen: string[] = []
  const scheduler = new Scheduler(s, engineConfig([worker('bootstrap-1', { bootstrap: true }), worker('reason-1', { reason: true })]),
    async ({ run }) => { seen.push(run.activity) })
  try {
    scheduler.start(); await until(() => seen.length > 0)
    assert.deepEqual(seen, ['decide'])
    assert.equal(s.runs(id)[0].worker, 'reason-1')
  } finally { await scheduler.close(); s.close() }
})

test('the Bootstrap agent contract requires a Fact and uses Bootstrap limits', async () => {
  const s = new Store(':memory:')
  const id = bootstrapProject(s), step = s.graph(id).steps[0]
  const bootstrapWorker = worker('bootstrap-1', { bootstrap: true })
  const config = engineConfig([bootstrapWorker]), run = s.claim(id, 'execute', bootstrapWorker, step.id)
  let finished = false
  const finish = graphTools({ store: s, run, worker: bootstrapWorker, config, signal: new AbortController().signal }, () => { finished = true })
    .find(tool => tool.name === 'finish_step')!
  try {
    assert.match(activityPrompt('execute', step), /Bootstrap.*submit_fact/s)
    assert.deepEqual(activityLimits(config, 'execute', step), { timeout: 60, concludeTimeout: 7 })
    await assert.rejects(finish.execute('finish-empty', { summary: 'done' }), /at least one Fact/)
    assert.equal(finished, false)
    s.addFact(id, 'Bootstrap result', { runId: run.id, creator: bootstrapWorker.name, evidence: [{ description: 'verified' }] })
    await finish.execute('finish-with-fact', { summary: 'done' })
    assert.equal(finished, true)
  } finally { s.close() }
})

test('bootstrap Steps only ever reach bootstrap workers, whatever the priority', async () => {
  const s = new Store(':memory:')
  bootstrapProject(s)
  const seen: Array<{ worker: string; activity: string }> = []
  // The explore worker is free and wins every tie-break; capability must still outrank it.
  const scheduler = new Scheduler(s, engineConfig([worker('explore-1', { explore: true }), worker('bootstrap-1', { bootstrap: true }, 5)]),
    ({ run }) => { seen.push({ worker: run.worker, activity: run.activity }); return Promise.resolve() })
  try {
    scheduler.start(); await until(() => seen.length > 0); await turn()
    assert.deepEqual(seen, [{ worker: 'bootstrap-1', activity: 'execute' }])
  } finally { await scheduler.close(); s.close() }
})

test('a bootstrap Step waits for a bootstrap worker instead of falling back or letting Decide plan', async () => {
  const s = new Store(':memory:')
  const id = bootstrapProject(s)
  const seen: string[] = []
  const scheduler = new Scheduler(s, engineConfig([worker('explore-1', { explore: true }), worker('reason-1', { reason: true })]),
    ({ run }) => { seen.push(run.activity); return Promise.resolve() })
  try {
    scheduler.start()
    for (let i = 0; i < 20; i++) await turn()
    assert.deepEqual(seen, [], 'no activity may start while the bootstrap Step has no bootstrap worker')
    assert.equal(s.graph(id).steps[0].status, 'pending')
  } finally { await scheduler.close(); s.close() }
})

test('bootstrap-only workers never claim ordinary Steps', async () => {
  const s = new Store(':memory:')
  const id = s.createProject({ title: 'Ordinary', origin: 'Scope', goal: 'Verified result' }).project.id
  s.addStep(id, { description: 'Work', sourceIds: ['origin'] })
  const seen: string[] = []
  const scheduler = new Scheduler(s, engineConfig([worker('bootstrap-1', { bootstrap: true }), worker('explore-1', { explore: true }, 5)]),
    ({ run }) => { seen.push(run.worker); return Promise.resolve() })
  try {
    scheduler.start(); await until(() => seen.length > 0); await turn()
    assert.deepEqual(seen, ['explore-1'])
  } finally { await scheduler.close(); s.close() }
})

test('worker capability flags survive configuration resolve and the settings snapshot', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-worker-config-'))
  try {
    const filename = path.join(root, 'redtrace.yaml')
    writeFileSync(filename, ['workers:',
      '  - name: bootstrap-1', '    provider: mock', '    bootstrap: true', '    reason: false', '    explore: false', '    max_running: 1', '    priority: 0',
      '  - name: explore-1', '    provider: mock', '    bootstrap: false', '    reason: false', '    explore: true', '    max_running: 2', '    priority: 1',
      'tasks:', '  bootstrap:', '    timeout: 123', '    conclude_timeout: 17', ''].join('\n'))
    const configuration = new Configuration(root, filename)
    const resolved = configuration.resolve(configuration.read().raw)
    assert.deepEqual(resolved.workers.map(w => [w.name, w.reason, w.explore, w.bootstrap]),
      [['bootstrap-1', false, false, true], ['explore-1', false, true, false]])
    assert.deepEqual(configuration.snapshot().workers.map(w => [w.name, w.reason, w.explore, w.bootstrap, w.task_types]),
      [['bootstrap-1', false, false, true, ['bootstrap']], ['explore-1', false, true, false, ['explore']]])
    assert.equal(resolved.bootstrapTimeout, 123)
    assert.equal(resolved.bootstrapConcludeTimeout, 17)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
