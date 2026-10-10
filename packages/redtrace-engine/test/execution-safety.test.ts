import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer, createConnection } from 'node:net'
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { executeWebshell, executeOperation } from '../src/operation-execution.ts'
import { ExecutionError, executionResult, commandFrame, parseCommandFrame, validateExecutionResult } from '../src/execution-result.ts'
import { dispatchVerb, VerbDispatchError } from '../src/capability-verbs.ts'
import { fixtureFrame, fixtureAuthorize } from './execution-fixture.ts'
import { serveEngine } from '../src/index.ts'

test('local SSH transport preserves remote exit/stdout/stderr/cwd and rejects failed authentication', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const clients = new Set<any>(), commands: string[] = []
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => ctx.method === 'password' && ctx.username === 'fixture' && ctx.password === 'local-only' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', accept => {
      accept().on('exec', (accept, _reject, info) => {
        commands.push(info.command)
        const stream = accept(); stream.write('stdout 中文'); stream.stderr.write('stderr fixture'); stream.exit(7); stream.end()
      })
    }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const resource = { id: 'local-ssh-fixture', kind: 'c2_session', target: '127.0.0.1', metadata_json: JSON.stringify({ connection_type: 'direct', shell_type: 'ssh', port: (server.address() as { port: number }).port }), secret_json: JSON.stringify({ username: 'fixture', password: 'local-only' }) }
  const task = { action: 'command', input_json: JSON.stringify({ command: 'fixture-command-only', cwd: '/fixture dir', timeout: 3 }) }
  try {
    const result = await executeOperation(resource, task, '.', new AbortController().signal)
    assert.equal(result.completion, 'known'); assert.equal(result.exit_code, 7); assert.equal(result.error_code, 'COMMAND_FAILED')
    assert.equal(result.stdout, 'stdout 中文'); assert.equal(result.stderr, 'stderr fixture')
    assert.equal(result.execution_context.cwd, '/fixture dir'); assert.equal(commands[0], "cd -- '/fixture dir' && fixture-command-only")
    await assert.rejects(executeOperation({ ...resource, secret_json: JSON.stringify({ username: 'fixture', password: 'wrong' }) }, task, '.', new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof ExecutionError); assert.equal(error.result.error_code, 'AUTH_FAILED'); return true
    })
    assert.equal(commands.length, 1)
  } finally { for (const client of clients) client.end(); await new Promise<void>(r => server.close(() => r())) }
})

test('file UI accepts SFTP JSON and legacy listings; editor explicitly requests overwrite', async () => {
  let copied = '', requested = ''
  const page = runInNewContext(readFileSync(new URL('../../../static/operations.js', import.meta.url), 'utf8') + ';operationsPage()', {
    navigator: { clipboard: { async writeText(value: string) { copied = value } } }, window: { setTimeout() {} },
  })
  page.fileDirectoryPath = '/fixture'
  const entries = page.parseFileListing(JSON.stringify([{ name: '空 文件', size: 0, directory: false }, { name: '目录', directory: true }]))
  assert.equal(entries[0].kind, 'd'); assert.equal(entries[1].path, '/fixture/空 文件'); assert.equal(entries[1].size, 0)
  assert.equal(page.parseFileListing('f\tlegacy\tdate\t5\t644')[0].size, 5)
  assert.equal(page.parseFileListing('[]').length, 0)
  page.projectId = () => 'project fixture'
  page.api = async (url: string) => { requested = url; return { command: 'private fixture' } }
  await page.copyPayload({ id: 'payload fixture', metadata: {} })
  assert.equal(requested, '/projects/project%20fixture/resources/payload%20fixture/material'); assert.equal(copied, 'private fixture')
  page.fileEditorPath = '/fixture/file'; page.fileContent = ''; page.encodeBase64 = () => ''; page.loadDirectory = async () => {}
  page.runFileTask = async (_action: string, input: any) => { assert.equal(input.overwrite, true); assert.equal(input.content_base64, '') }
  await page.saveCurrentFile(); assert.equal(page.fileMessage, '文件已保存')
})

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-execution-safety-'))
  const store = new Store(':memory:'), operations = new Operations(store, root)
  const { project } = store.createProject({ title: 'Execution safety', origin: 'local fixture only', goal: 'Verify safeguards' })
  const resource = operations.create(project.id, { kind: 'c2_session', name: 'inert beacon fixture', target: 'fixture-host', metadata: { connection_type: 'beacon' } }).resource
  return { root, store, operations, project, resource, async close() { await operations.close(); store.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('result contracts reject malformed adapters; unknown completion never proves success', () => {
  const r = executionResult('partial evidence', null, { error_code: null })
  assert.equal(validateExecutionResult(r).error_code, 'UNKNOWN_RESULT')
  assert.throws(() => validateExecutionResult({ version: 1, completion: 'known' }), ExecutionError)
  assert.throws(() => validateExecutionResult({ ...r, exit_code: 999 }), ExecutionError)
  assert.throws(() => validateExecutionResult({ ...r, completion: 'success' }), ExecutionError)
  const frame = commandFrame('printf harmless')
  assert.equal(parseCommandFrame(`${frame.begin}\r\nUnicode 中文\r\n${frame.end}:7\r\n`, frame)?.exit_code, 7)
  assert.equal(parseCommandFrame(`${frame.begin}\nempty\n${frame.end}:0\n`, frame)?.combined_output, 'empty')
  assert.equal(parseCommandFrame(`echo ${frame.begin}\n${frame.end}:0\n`, frame), undefined)
})

test('HTTP 200 missing a result frame is a protocol error; raw output remains unknown', async () => {
  const server = createServer((_req, res) => res.end('<html>not executed</html>'))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const target = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  try {
    await assert.rejects(executeWebshell(target, { shell_type: 'php', protocol: 'eval' }, {}, 'command', { command: 'echo harmless' }), (e: unknown) => {
      assert.ok(e instanceof ExecutionError); assert.equal(e.result.error_code, 'PROTOCOL_ERROR'); assert.match(e.result.combined_output, /not executed/); return true
    })
    const raw = await executeWebshell(target, { shell_type: 'custom', protocol: 'raw' }, {}, 'command', { command: 'echo harmless' })
    assert.equal(raw.completion, 'unknown'); assert.equal(raw.exit_code, null); assert.equal(raw.error_code, 'UNKNOWN_RESULT')
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())) }
})

test('TCP output delayed by 850ms is collected through its completion boundary', async () => {
  const f = fixture()
  const server = createTcpServer()
  const connected = new Promise<import('node:net').Socket>(r => server.once('connection', r))
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const peer = createConnection((server.address() as { port: number }).port, '127.0.0.1')
  await new Promise<void>(r => peer.once('connect', r))
  const accepted = await connected
  peer.once('data', chunk => {
    const framed = fixtureFrame(chunk.toString(), 'first\nsecond'), split = framed.indexOf('second')
    peer.write(framed.slice(0, split)); setTimeout(() => peer.write(framed.slice(split)), 850)
  })
  try {
    const start = Date.now(), result = await (f.operations as any).executeChannel(accepted, 'echo harmless', 2, new AbortController().signal)
    assert.equal(result.combined_output, 'first\nsecond'); assert.equal(result.completion, 'known'); assert.equal(result.exit_code, 0)
    assert.ok(Date.now() - start >= 800); assert.equal(result.stdout, null); assert.equal(result.stderr, null)
  } finally { peer.destroy(); accepted.destroy(); await new Promise<void>(r => server.close(() => r())); await f.close() }
})

test('leases serialize conflict domains and preserve monotonic fencing after release', async () => {
  const f = fixture()
  try {
    const a = f.operations.create(f.project.id, { kind: 'terminal', name: 'A', metadata: { conflict_key: 'shared-stream' } }).resource
    const b = f.operations.create(f.project.id, { kind: 'terminal', name: 'B', metadata: { conflict_key: 'shared-stream' } }).resource
    const lease = f.operations.lease(f.operations.resource(a.id), { owner_type: 'worker', owner: 'worker-a', run_id: 'run-a' })
    assert.equal(lease.fencing_token, 1)
    assert.throws(() => f.operations.lease(f.operations.resource(b.id), { owner_type: 'worker', owner: 'worker-b' }), /lease belongs/)
    f.operations.releaseLease(f.operations.resource(a.id), { actor_type: 'worker', actor: 'worker-a', fencing_token: 1 })
    const next = f.operations.lease(f.operations.resource(b.id), { owner_type: 'human', owner: 'admin' })
    assert.equal(next.fencing_token, 2)
    assert.throws(() => f.operations.checkLease(f.operations.resource(a.id), { actor_type: 'worker', actor: 'worker-a', fencing_token: 1 }), /foreign fencing/)
    f.operations.releaseLease(f.operations.resource(b.id), { actor_type: 'human', actor: 'admin', fencing_token: 2 })
    const third = f.operations.lease(f.operations.resource(a.id), { owner_type: 'worker', owner: 'worker-a', run_id: 'run-a' })
    assert.equal(third.fencing_token, 3)
    f.operations.updateResource(a.id, { worker_paused: 1 })
    assert.throws(() => f.operations.checkLease(f.operations.resource(a.id), { actor_type: 'worker', actor: 'worker-a', fencing_token: 3 }), /paused/)
    f.operations.releaseRunLeases('run-a'); f.operations.updateResource(a.id, { worker_paused: 0 })
    assert.throws(() => f.operations.checkLease(f.operations.resource(a.id), { actor_type: 'worker', actor: 'worker-a', fencing_token: 3 }), /live resource lease/)
  } finally { await f.close() }
})

test('risk cannot be lowered; revocation and exact target/route scope apply before dispatch', async () => {
  const f = fixture()
  try {
    const awaiting = f.operations.createTask(f.project.id, f.resource.id, { action: 'command', actor_type: 'worker', actor: 'w', risk: 'low', requires_approval: false, arguments: { command: 'echo harmless' } })
    assert.equal(awaiting.status, 'awaiting_approval'); assert.equal(awaiting.risk, 'high')
    fixtureAuthorize(f.operations, f.project.id, f.resource.id, ['command'])
    const queued = f.operations.createTask(f.project.id, f.resource.id, { action: 'command', actor_type: 'worker', actor: 'w', arguments: { command: 'echo harmless' } })
    assert.equal(queued.status, 'queued'); f.store.db.prepare('UPDATE operation_authorizations SET revoked_at=?').run(new Date().toISOString())
    assert.equal(f.operations.beforeDispatch(f.operations.task(queued.id), f.operations.resource(f.resource.id)), false)
    const denied = f.operations.publicTask(f.operations.task(queued.id))
    assert.equal(denied.result.error_code, 'AUTH_FAILED'); assert.ok(denied.result_ref)
    f.store.db.prepare('INSERT INTO operation_authorizations VALUES (?,?,?,?,?,?,?,?,?,?)').run('exact', f.project.id, '["command"]', '[]', '["10.0.0.1"]', '["route-a"]', 'admin', new Date(Date.now()+60000).toISOString(), null, new Date().toISOString())
    assert.equal(f.operations.authorized(f.project.id, 'command', { id: 'x', target: '10.0.0.10', metadata_json: '{"route_id":"route-a"}' }), false)
    assert.equal(f.operations.authorized(f.project.id, 'command', { id: 'x', target: '10.0.0.1', metadata_json: '{"route_id":"route-b"}' }), false)
    assert.equal(f.operations.authorized(f.project.id, 'command', { id: 'x', target: '10.0.0.1', metadata_json: '{"route_id":"route-a"}' }), true)
  } finally { await f.close() }
})

test('unsupported file actions reject before enqueue; worker claims and credentials stay private', async () => {
  const f = fixture()
  try {
    assert.throws(() => f.operations.createTask(f.project.id, f.resource.id, { action: 'read_file', arguments: { path: '/tmp/fixture' } }), /CAPABILITY_UNSUPPORTED/)
    f.operations.updateResource(f.resource.id, { metadata_json: JSON.stringify({ connection_type: 'beacon', verified_capabilities: ['remote.file.read'] }) })
    await assert.rejects(dispatchVerb({ operations: f.operations }, 'remote.file.read', { via: f.resource.id, path: '/tmp/fixture' }, { projectId: f.project.id, worker: 'w', stepId: null, signal: new AbortController().signal }), VerbDispatchError)
    const r = f.operations.create(f.project.id, { kind: 'webshell', name: 'worker claim', actor_type: 'worker', metadata: { verified_capabilities: ['remote.command'], verified_at: 'now', conflict_key: 'forged' } }).resource
    assert.equal(r.metadata.verified_capabilities, undefined); assert.equal(r.metadata.conflict_key, undefined)
    const secret = f.operations.create(f.project.id, { kind: 'credential_ref', name: 'secret fixture', secret: { password: 'not-public' } }).resource
    assert.equal(secret.secret, undefined); assert.equal(secret.has_secret, true)
    assert.equal(f.store.db.prepare('SELECT COUNT(*) AS n FROM operation_tasks').get()!.n, 0)
  } finally { await f.close() }
})

test('unknown, failed, cancelled and large results retain bounded, retrievable evidence', async () => {
  const f = fixture()
  try {
    for (const [result, expected] of [[executionResult('partial', null, { error_code: null }), 'failed'], [executionResult('command failed', 7), 'failed'], [executionResult('known', 0), 'succeeded']] as const) {
      const t = f.operations.createTask(f.project.id, f.resource.id, { action: 'command', arguments: { command: 'echo harmless' } })
      const done = f.operations.finish(t.id, result); assert.equal(done.status, expected); assert.ok(done.result_ref)
    }
    assert.equal(f.operations.resource(f.resource.id).status, 'available')
    const t = f.operations.createTask(f.project.id, f.resource.id, { action: 'command', arguments: { command: 'echo harmless' } })
    f.store.db.prepare("UPDATE operation_tasks SET status='cancelled',cancel_requested=1 WHERE id=?").run(t.id)
    const output = 'A'.repeat(100000), done = f.operations.finish(t.id, executionResult(output, null, { error_code: 'CANCELLED' }))
    assert.equal(done.status, 'cancelled'); assert.equal(done.result.combined_output.length, 32768); assert.equal(done.result.saved_bytes, 100000)
    assert.equal((f.store.db.prepare('SELECT content FROM operation_results WHERE task_id=?').get(t.id) as any).content, output)
    assert.equal(done.result.execution_context.resource_id, f.resource.id)
  } finally { await f.close() }
})

test('migration snapshots legacy DB, keeps FGS schema 2 and never restores fake connections', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-migration-')), dbFile = path.join(root, 'fixture.db')
  let store = new Store(dbFile), operations = new Operations(store, root)
  try {
    const { project } = store.createProject({ title: 'Migration fixture', origin: 'fixture', goal: 'Preserve data' })
    const listener = operations.create(project.id, { kind: 'c2_listener', name: 'inert listener' }).resource
    const r = operations.create(project.id, { kind: 'c2_session', name: 'persisted metadata', metadata: { connection_type: 'reverse', verified_capabilities: ['remote.command'] }, parent_resource_id: listener.id }).resource
    const t = operations.createTask(project.id, r.id, { action: 'command', arguments: { command: 'echo harmless' } })
    store.db.prepare("UPDATE operation_tasks SET status='running' WHERE id=?").run(t.id)
    await operations.close(); store.db.exec('ALTER TABLE operation_tasks DROP COLUMN result_json; ALTER TABLE operation_tasks DROP COLUMN attempt_id'); store.close()
    store = new Store(dbFile); operations = new Operations(store, root)
    assert.ok(readdirSync(root).some(name => name.includes('operations-v1') && name.endsWith('.snapshot')))
    assert.equal(operations.resource(r.id).status, 'offline')
    const restored = operations.publicTask(operations.task(t.id))
    assert.equal(restored.status, 'failed'); assert.equal(restored.result.completion, 'unknown'); assert.ok(restored.result_ref)
    assert.equal(store.project(project.id).title, 'Migration fixture')
    assert.equal(store.db.prepare("SELECT value FROM metadata WHERE key='schema'").get()!.value, '2')
  } finally { await operations.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('beacon ingress gates plugins, serializes tasks, rejects stale attempts and worker self-approval', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-ingress-safety-')); let enabled = true
  const engine = await serveEngine({ root, autoStart: false, port: 0, adapterAvailability: () => () => enabled })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const request = async (route: string, data: unknown = {}, headers: Record<string, string> = {}) => {
    const response = await fetch(url + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) })
    return { status: response.status, data: await response.json() as any }
  }
  try {
    const { project } = engine.store.createProject({ title: 'Ingress', origin: 'fixture', goal: 'Gate ingress' }), base = `/projects/${project.id}`
    const listener = engine.operations.create(project.id, { kind: 'c2_listener', name: 'inert fixture listener' })
    const checkin = await request(`/c2/checkin/${listener.resource.id}`, { version: 1, external_id: 'inert-fixture', capabilities: ['command'] }, { 'X-RedTrace-Listener-Token': listener.secret_once! })
    assert.equal(checkin.status, 200)
    const session = checkin.data, headers = { 'X-RedTrace-Session-Token': session.session_token }
    const a = engine.operations.createTask(project.id, session.session_id, { action: 'command', arguments: { command: 'echo harmless' } })
    const b = engine.operations.createTask(project.id, session.session_id, { action: 'command', arguments: { command: 'echo harmless' } })
    assert.equal((await request(session.poll_path, {}, headers)).data.tasks.length, 1)
    assert.deepEqual((await request(session.poll_path, {}, headers)).data.tasks, [])
    const resultPath = `/c2/sessions/${session.session_id}/results/${a.id}`
    assert.equal((await request(resultPath, { output: 'legacy without proof' }, headers)).status, 422)
    assert.equal((await request(resultPath, { ...executionResult('fixture', 0), attempt_id: 'old-attempt' }, headers)).status, 409)
    assert.equal((await request(resultPath, { ...executionResult('fixture', 0), attempt_id: a.attempt_id }, headers)).status, 200)
    assert.equal((await request(resultPath, { ...executionResult('late overwrite', 0), attempt_id: a.attempt_id }, headers)).status, 409)
    assert.equal((await request(session.poll_path, {}, headers)).data.tasks[0].id, b.id)
    const worker = { 'X-RedTrace-Worker': 'worker-1' }
    const payload = engine.operations.create(project.id, { kind: 'c2_payload', name: 'private material fixture', metadata: { payload_type: 'command' }, secret: { command: 'private fixture token' } }).resource
    assert.equal(payload.metadata.command, undefined)
    const listed = await fetch(`${url}${base}/resources/${payload.id}`).then(r => r.text())
    assert.ok(!listed.includes('private fixture token'))
    assert.equal((await request(`${base}/resources/${payload.id}/material`, {}, worker)).status, 403)
    assert.equal((await request(`${base}/resources/${payload.id}/material`)).data.command, 'private fixture token')
    const queued = await request(`${base}/resources/${session.session_id}/tasks`, { action: 'command', actor_type: 'human', risk: 'low', requires_approval: false, arguments: { command: 'echo harmless' } }, worker)
    assert.equal(queued.data.task.status, 'awaiting_approval')
    assert.equal((await request(`${base}/operations/tasks/${queued.data.task.id}/approval`, {}, worker)).status, 403)
    assert.equal((await request(`${base}/resources/${session.session_id}/tasks`, { action: 'command' }, { 'X-RedTrace-Worker': 'unknown' })).status, 403)
    enabled = false
    assert.equal((await request(session.poll_path, {}, headers)).status, 409)
    assert.equal((await request(`/c2/checkin/${listener.resource.id}`, { external_id: 'new' }, { 'X-RedTrace-Listener-Token': listener.secret_once! })).status, 409)
    // Results of a legitimately dispatched task remain accepted after stop.
    assert.equal((await request(`/c2/sessions/${session.session_id}/results/${b.id}`, { ...executionResult('existing evidence', 0), attempt_id: b.attempt_id }, headers)).status, 200)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
