import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'

test('startup releases legacy Worker approval waits, not cancelled or human tasks', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'operations-unattended-')), store = new Store(':memory:')
  let ops = new Operations(store, root)
  try {
    const project = store.createProject({ title: 'Local migration fixture', origin: 'Fixture', goal: 'Resume queued work' }).project
    const resource = ops.create(project.id, { kind: 'webshell', name: 'fixture', target: 'http://127.0.0.1:1', metadata: { protocol: 'raw', command_param: 'cmd' } }).resource
    const create = (actor_type: string) => ops.createTask(project.id, resource.id, { actor_type, actor: 'fixture', action: 'command', arguments: { command: 'echo fixture' } })
    const worker = create('worker'), cancelled = create('worker'), human = create('human')
    store.db.prepare("UPDATE operation_tasks SET status='awaiting_approval',requires_approval=1").run()
    store.db.prepare('UPDATE operation_tasks SET cancel_requested=1 WHERE id=?').run(cancelled.id)
    await ops.close()
    ops = new Operations(store, root)
    assert.equal(ops.task(worker.id).status, 'queued'); assert.equal(ops.task(worker.id).requires_approval, 0)
    assert.equal(ops.task(worker.id).attempt_id, worker.attempt_id)
    assert.equal(ops.task(cancelled.id).status, 'awaiting_approval')
    assert.equal(ops.task(human.id).status, 'awaiting_approval')
    assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM resource_audit_events WHERE task_id=? AND action='operation.approval_removed'").get(worker.id)!.n, 1)
  } finally { await ops.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})
