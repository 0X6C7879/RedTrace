import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkerShells, workerShellTools } from '../../redtrace-engine/src/worker-shell.ts'
import { refreshToolRegistrations } from '../../redtrace-engine/compat/cordis.mjs'

test('Shell plugin stop revokes live tools, closes sessions, and start permits fresh shells in same Run', async () => {
  const shells = new WorkerShells(), registered = new Set()
  const context = { run: { id: 'toggle' }, worker: { name: 'fixture' }, signal: new AbortController().signal }
  const tools = workerShellTools(context, shells, {}, '/tmp')
  const refresh = refreshToolRegistrations(tools, () => shells.enabled, t => { registered.add(t.name); return () => registered.delete(t.name) })
  try {
    refresh(); assert.equal(registered.size, 5)
    await shells.open('toggle', ['/bin/sh', '-i'], '/tmp')
    shells.enabled = false; await shells.closeAll(); refresh()
    assert.equal(registered.size, 0); assert.deepEqual(await shells.list('toggle'), { shells: [] })
    await assert.rejects(tools.find(t => t.name === 'shell_list').execute('', {}), /disabled/)
    shells.enabled = true; refresh(); assert.equal(registered.size, 5)
    await shells.open('toggle', ['/bin/sh', '-i'], '/tmp')
  } finally { await shells.dispose() }
})
