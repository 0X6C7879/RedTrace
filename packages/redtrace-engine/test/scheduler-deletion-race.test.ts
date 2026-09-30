import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import type { EngineConfig } from '../src/types.ts'

// Deleting an active project aborts its in-flight runs; project deletion then removes the
// rows those completion handlers still read. Both dispatch and run completion must tolerate
// the vanished project instead of crashing the engine with an unhandled 404.
test('aborted runs survive their project being deleted mid-flight', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-race-'))
  try {
    const store = new Store(path.join(root, 'engine.db'))
    const config: EngineConfig = {
      workers: [{ name: 'fake-reason', provider: 'mock', model: 'mock', enabled: true, reason: true, explore: false, bootstrap: false, maxRunning: 1, priority: 0, backend: 'dsh' }],
      providers: {}, maxWorkers: 2, maxProjectWorkers: 1, maxRunningProjects: 2, maxSteps: null,
      decideTimeout: 60000, executeTimeout: 60000, concludeTimeout: 60000, bootstrapTimeout: 60000, bootstrapConcludeTimeout: 60000,
      workspaceRoot: path.join(root, 'workspaces'),
    }
    const scheduler = new Scheduler(store, config, async ({ signal }) => {
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))))
    })
    scheduler.start()
    const { project } = store.createProject({ title: 'Race', origin: 'o', goal: 'g' })
    for (let i = 0; i < 100 && !store.runs(project.id).some(r => r.activity === 'decide' && r.status === 'running'); i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(store.runs(project.id).length, 1)
    store.transaction(() => store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id))
    store.changes.emit('change', project.id)
    await new Promise(r => setTimeout(r, 20))
    await scheduler.close()
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(store.runs(), [])
    store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})
