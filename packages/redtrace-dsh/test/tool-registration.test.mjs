import test from 'node:test'
import assert from 'node:assert/strict'
import { verbToolAvailable } from '../../redtrace-engine/src/capability-verbs.ts'
import { refreshToolRegistrations } from '../../redtrace-engine/compat/cordis.mjs'

test('channel plugin toggle updates live remote tool registrations', () => {
  const enabled = new Set(['redtrace-webshell']), visible = new Set()
  const runtime = { isAdapterAvailable: id => enabled.has(id) }
  const refresh = refreshToolRegistrations([{ name: 'remote_command' }, { name: 'remote_task' }],
    tool => verbToolAvailable(runtime, tool.name), tool => { visible.add(tool.name); return () => visible.delete(tool.name) })
  refresh()
  assert.deepEqual([...visible], ['remote_command', 'remote_task'])
  enabled.clear(); refresh()
  assert.deepEqual([...visible], ['remote_task'])
  enabled.add('redtrace-c2'); refresh()
  assert.deepEqual([...visible].sort(), ['remote_command', 'remote_task'])
})
