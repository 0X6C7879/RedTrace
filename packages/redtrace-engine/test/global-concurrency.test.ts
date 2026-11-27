import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Configuration } from '../src/config.ts'
import { serveEngine } from '../src/index.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Store } from '../src/store.ts'

test('legacy global limits do not cap parallel Workers across projects', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-no-global-limit-')), configuration = new Configuration(root), store = new Store(':memory:')
  configuration.initialize()
  configuration.commit(configuration.read().revision, raw => {
    raw.runtime = { max_workers: 1, max_project_workers: 3, max_running_projects: 2 }
    raw.workers = ['a', 'b'].map(name => ({ name, provider: 'mock', roles: ['soldier'], max_running: 3 }))
  })
  const config = configuration.resolvedSnapshot().config
  const projects = ['A', 'B'].map(title => store.createProject({ title, origin: 'local fixture', goal: 'verify concurrency' }).project)
  for (const project of projects) for (let i = 0; i < 5; i++) store.addStep(project.id, { description: 'independent work ' + i, sourceIds: ['origin'] })
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve }), scheduler = new Scheduler(store, config, async () => held)
  try {
    scheduler.start()
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(scheduler.activeRuns.length, 6)
    for (const project of projects) assert.equal(scheduler.activeRuns.filter(run => run.projectId === project.id).length, 3)
    for (const worker of config.workers) assert.equal(scheduler.activeRuns.filter(run => run.worker === worker.name).length, 3)
  } finally { release(); await scheduler.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('runtime settings omit the global limit and save without it', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-runtime-capacity-')), engine = await serveEngine({ root, port: 0, autoStart: false })
  try {
    engine.configuration.commit(engine.configuration.read().revision, raw => { raw.runtime!.max_workers = 1 })
    const snapshot = engine.configuration.snapshot()
    assert.equal('max_workers' in snapshot.runtime, false)
    assert.equal('runtime_max_workers' in snapshot, false)
    const response = await fetch(`http://127.0.0.1:${(engine.server.address() as { port: number }).port}/worker-config/runtime-tasks`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expected_revision: snapshot.revision, runtime: { max_project_workers: 12, max_running_projects: 3 }, tasks: snapshot.tasks }),
    })
    assert.equal(response.status, 200, await response.text())
    assert.deepEqual(engine.configuration.read().raw.runtime, { max_project_workers: 12, max_running_projects: 3 })
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
