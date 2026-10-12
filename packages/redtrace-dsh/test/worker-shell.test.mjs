import test from 'node:test'
import assert from 'node:assert/strict'
import { WorkerShells, workerShellTools, shellInstructions } from '../../redtrace-engine/src/worker-shell.ts'
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

test('Shell rules are split without dropping credential, completion or lifecycle boundaries', () => {
 const tools=workerShellTools({run:{id:'descriptions'},worker:{name:'fixture'},signal:new AbortController().signal},new WorkerShells(),{},'/tmp')
 assert.ok(!tools.find(t=>t.name==='shell_open').description.includes(shellInstructions))
 for(const rule of [/shell_id/,/credential_id/,/不代表.*成功/,/远端后台进程/,/WebShell.*无状态/])assert.match(shellInstructions,rule)
 for(const [name,rule] of [['shell_open',/argv.*cwd/],['shell_send',/credential_id/],['shell_read',/process_exit_code/],['shell_list',/Run/],['shell_close',/远端|remote/]])assert.match(tools.find(t=>t.name===name).description,rule)
})
