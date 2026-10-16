import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { ExecutionError, errorResult, executionResult } from '../src/execution-result.ts'
import { verbTools } from '../src/capability-verbs.ts'
import { activityPrompt } from '../src/runner.ts'

test('explicit authentication failure is visible, invalidates channel, and marks tool failure', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'c2-auth-')), store = new Store(':memory:'), ops = new Operations(store, root)
  ops.wake = () => {} // No external dispatch: inject the same adapter result as the recorded failure.
  const { project } = store.createProject({ title: 'C2 fixture', origin: 'Local fixture', goal: 'Verify feedback' })
  try {
    const session = ops.create(project.id, { kind: 'c2_session', name: 'fixture', target: '127.0.0.1', metadata: { connection_type: 'direct', shell_type: 'ssh' } }).resource
    assert.equal(session.last_seen_at, null)
    const task = ops.createTask(project.id, session.id, { action: 'probe_info', actor_type: 'human', actor: 'fixture' })
    const done = ops.finish(task.id, errorResult(new ExecutionError('AUTH_FAILED', 'All configured authentication methods failed')))
    assert.equal(done.output_summary, 'AUTH_FAILED: All configured authentication methods failed')
    assert.equal(done.result.combined_output, '') // Do not fabricate remote stdout.
    assert.equal(ops.resource(session.id).status, 'degraded')
    assert.equal(JSON.parse(ops.resource(session.id).metadata_json).runtime_verified, false)
    const context = { store, run: { projectId: project.id, stepId: null }, worker: { name: 'fixture' }, signal: new AbortController().signal } as any
    const poll = verbTools(context, { operations: ops }).find(t => t.name === 'remote_task')!
    const failed = await poll.execute('fixture', { task_id: task.id }, context.signal)
    assert.ok('isError' in failed); assert.equal(failed.isError, true)
    const session2 = ops.create(project.id, { kind: 'c2_session', name: 'success', target: '127.0.0.1', metadata: { connection_type: 'direct', shell_type: 'ssh' } }).resource
    const task2 = ops.createTask(project.id, session2.id, { action: 'probe_info', actor_type: 'human', actor: 'fixture' })
    ops.finish(task2.id, executionResult('hostname=fixture\nos=Linux\n', 0))
    assert.equal(JSON.parse(ops.resource(session2.id).metadata_json).runtime_verified, true)
    const succeeded = await poll.execute('fixture', { task_id: task2.id }, context.signal)
    assert.ok(!('isError' in succeeded) || succeeded.isError !== true)
    assert.doesNotMatch(activityPrompt('execute'), /SSH 返回 AUTH_FAILED/)
    assert.ok(Buffer.byteLength(activityPrompt('execute')) <= 8000)
    const source = readFileSync(new URL('../../redtrace-dsh/src/c2.ts', import.meta.url), 'utf8')
    assert.match(source, /Registration is not connection or authentication success/)
    const webshell = readFileSync(new URL('../../redtrace-dsh/src/webshell.ts', import.meta.url), 'utf8')
    assert.match(webshell, /not speculative endpoints or batches of guessed passwords/)
    assert.match(webshell, /Do not blindly repeat the same failed probe/)
  } finally { await ops.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('direct sessions show unverified until explicit verification; other resource states unchanged', async () => {
  const ctx = vm.createContext({})
  vm.runInContext(readFileSync(new URL('../../../static/operations.js', import.meta.url), 'utf8') + '\nglobalThis.page = operationsPage()', ctx)
  const page = ctx.page as any
  const session = { kind: 'c2_session', status: 'available', metadata: { connection_type: 'direct' } }
  assert.equal(page.statusLabel(page.resourceStatus(session)), '已登记 · 待验证')
  assert.equal(page.resourceStatus({ ...session, metadata: { ...session.metadata, runtime_verified: true } }), 'available')
  assert.equal(page.resourceStatus({ ...session, status: 'degraded' }), 'degraded')
  assert.equal(page.resourceStatus({ kind: 'c2_listener', status: 'available' }), 'available')
  assert.equal(page.resourceStatus({ kind: 'c2_session', status: 'available', metadata: { connection_type: 'reverse' } }), 'available')
  const html = readFileSync(new URL('../../../static/index.html', import.meta.url), 'utf8')
  assert.match(html, /statusLabel\(resourceStatus\(currentResource\(\)\)\)/)
  page.active = true; page.projectId = () => 'fixture'; page.selectedResourceId = 'old'; page.terminalOutput = 'old authentication error'
  page.api = async () => ({ resource: session, tasks: [] })
  await page.selectResource('new')
  assert.equal(page.terminalOutput, '')
})
