import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createServer as createTcpServer, createConnection } from 'node:net'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { serveEngine } from '../src/index.ts'
import { executionResult } from '../src/execution-result.ts'
import { fixtureFrame } from './execution-fixture.ts'

test('resource operations use real HTTP, keep global provenance and enforce existing ownership contracts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-operations-')), wire: string[] = []
  const remote = createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c)
    if (req.url?.startsWith('/sessions')) { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ sessions: [{ id: 'ext-1', hostname: 'external-host' }] })) }
    if (req.url === '/payloads') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ target: 'https://adapter.test/payload', name: 'external.bin' })) }
    if (req.url === '/execute') { res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify(executionResult('external adapter verified', 0))) }
    const form = new URLSearchParams(Buffer.concat(chunks).toString()); wire.push(form.get('cmd') ?? '')
    if (form.get('cmd')?.includes("eval 'wait'")) return
    res.end(fixtureFrame(form.get('cmd') ?? '', /RT_[a-f0-9]+/.exec(form.get('cmd') ?? '')?.[0] ?? 'local adapter verified'))
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const engine = await serveEngine({ root, port: 0, autoStart: false }), url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const request = async (route: string, method = 'GET', b?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', ...headers }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) })
    return { status: res.status, data: res.status === 204 ? null : res.headers.get('content-type')?.includes('application/json') ? await res.json() as any : await res.text() }
  }
  const waitFor = async (id: string, status: string) => {
    for (let i = 0; i < 100 && engine.operations.task(id).status !== status; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal(engine.operations.task(id).status, status)
  }
  try {
    const { project } = engine.store.createProject({ title: 'Resources', origin: 'Fixture', goal: 'Verify adapter' }), base = `/projects/${project.id}`
    const tested = await request(base + '/webshell/test', 'POST', { target: `http://127.0.0.1:${(remote.address() as { port: number }).port}`, shell_type: 'custom', protocol: 'raw', command_param: 'cmd' })
    assert.equal(tested.status, 200); assert.equal(tested.data.ok, true); wire.length = 0
    const created = await request(base + '/resources', 'POST', { kind: 'webshell', name: 'Local fixture', target: `http://127.0.0.1:${(remote.address() as { port: number }).port}`, metadata: { command_param: 'cmd', protocol: 'raw' }, secret: { password: 'private' } })
    assert.equal(created.status, 201); const id = created.data.resource.id
    assert.equal(created.data.resource.has_secret, true); assert.equal(created.data.resource.secret, undefined)
    assert.equal((await request('/projects/_global/resources')).data.resources[0].source.project_id, project.id)
    const run = await request(`${base}/resources/${id}/tasks`, 'POST', { action: 'command', arguments: { command: 'echo fixture', publish_result: true } })
    assert.equal(run.status, 202); await waitFor(run.data.task.id, 'succeeded')
    assert.equal(wire.length, 1); assert.match(wire[0], /echo fixture/)
    const task = engine.operations.task(run.data.task.id), output = await request(task.result_ref)
    assert.equal(output.data, 'local adapter verified'); assert.equal(engine.store.graph(project.id).facts.length, 1)
    const worker = { 'X-RedTrace-Worker': 'worker-1' }
    assert.equal((await request(`${base}/resources/${id}/worker-control`, 'POST', { paused: true })).status, 200)
    assert.equal((await request(`${base}/resources/${id}/tasks`, 'POST', { action: 'command', arguments: { command: 'blocked' } }, worker)).status, 423)
    await request(`${base}/resources/${id}/worker-control`, 'POST', { paused: false })
    const approval = await request(`${base}/resources/${id}/tasks`, 'POST', { action: 'command', risk: 'high', arguments: { command: 'approved' } }, worker)
    assert.equal(approval.data.task.status, 'awaiting_approval')
    await request(`${base}/operations/tasks/${approval.data.task.id}/approval`, 'POST', { decision: 'approve' }); await waitFor(approval.data.task.id, 'succeeded')
    const slow = await request(`${base}/resources/${id}/tasks`, 'POST', { action: 'command', arguments: { command: 'wait' } })
    await waitFor(slow.data.task.id, 'running')
    await request(`${base}/operations/tasks/${slow.data.task.id}/cancel`, 'POST', {}); await waitFor(slow.data.task.id, 'cancelled')
    assert.ok((await request(`${base}/operations/audit`)).data.events.some((e: any) => e.action === 'operation.command' && e.status === 'succeeded'))

    const listener = await request(base + '/resources', 'POST', { kind: 'c2_listener', name: 'Beacon fixture', metadata: { listener_type: 'http_beacon' } })
    const checkin = await request(`/c2/checkin/${listener.data.resource.id}`, 'POST', { external_id: 'agent-1', hostname: 'host', os: 'linux', capabilities: ['command'] }, { 'X-RedTrace-Listener-Token': listener.data.secret_once })
    assert.equal(checkin.status, 200)
    assert.equal(engine.store.db.prepare("SELECT COUNT(*) AS n FROM resource_audit_events WHERE resource_id=? AND action='c2.session_online'").get(checkin.data.session_id)!.n, 1)
    const beaconTask = await request(`${base}/resources/${checkin.data.session_id}/tasks`, 'POST', { action: 'command', arguments: { command: 'id' } })
    const polled = await request(checkin.data.poll_path, 'POST', undefined, { 'X-RedTrace-Session-Token': checkin.data.session_token })
    assert.deepEqual(polled.data.tasks.map((t: any) => t.id), [beaconTask.data.task.id])
    const beaconResult = await request(`/c2/sessions/${checkin.data.session_id}/results/${beaconTask.data.task.id}`, 'POST', { ...executionResult('uid=1000', 0), attempt_id: beaconTask.data.task.attempt_id }, { 'X-RedTrace-Session-Token': checkin.data.session_token })
    assert.equal(beaconResult.data.task.status, 'succeeded')
    const longTask = await request(`${base}/resources/${checkin.data.session_id}/tasks`, 'POST', { action: 'command', arguments: { command: 'long output' } })
    const longPolled = await request(checkin.data.poll_path, 'POST', undefined, { 'X-RedTrace-Session-Token': checkin.data.session_token })
    assert.deepEqual(longPolled.data.tasks.map((t: any) => t.id), [longTask.data.task.id])
    const longOutput = 'A'.repeat(1101)
    const longResult = await request(`/c2/sessions/${checkin.data.session_id}/results/${longTask.data.task.id}`, 'POST', { ...executionResult(longOutput, 0), summary: longOutput.slice(0,1000), attempt_id: longTask.data.task.attempt_id }, { 'X-RedTrace-Session-Token': checkin.data.session_token })
    assert.equal(longResult.status, 200)
    assert.equal(longResult.data.task.status, 'succeeded')
    assert.equal(longResult.data.task.output_summary.length, 1000)
    assert.equal((await request(engine.operations.task(longTask.data.task.id).result_ref)).data, longOutput)
    assert.equal((await request(checkin.data.poll_path, 'POST', undefined, { 'X-RedTrace-Session-Token': 'wrong' })).status, 404)
    const recheckin = await request(`/c2/checkin/${listener.data.resource.id}`, 'POST', { external_id: 'agent-1', hostname: 'host', os: 'linux' }, { 'X-RedTrace-Listener-Token': listener.data.secret_once })
    assert.equal(engine.store.db.prepare("SELECT COUNT(*) AS n FROM resource_audit_events WHERE resource_id=? AND action='c2.session_checkin'").get(checkin.data.session_id)!.n, 1)

    const kinds = await request(`${base}/c2/listeners/${listener.data.resource.id}/oneliner-kinds`)
    assert.deepEqual(kinds.data.kinds, ['curl_beacon'])
    const generated = await request(`${base}/c2/payloads/oneliner`, 'POST', { listener_id: listener.data.resource.id, kind: 'curl_beacon' })
    assert.match(generated.data.oneliner, new RegExp(`/c2/checkin/${listener.data.resource.id}`)); assert.match(generated.data.oneliner, new RegExp(listener.data.secret_once.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const uploaded = await fetch(`${url}${base}/c2/payloads/upload?filename=fixture.bin&platform=linux&arch=amd64`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: 'payload-fixture' }), uploadedData: any = await uploaded.json()
    assert.equal(uploaded.status, 201); assert.equal(await (await fetch(url + uploadedData.payload.target)).text(), 'payload-fixture')
    const uploadedArtifact = JSON.parse(engine.operations.resource(uploadedData.payload.id).secret_json).artifact_path
    assert.equal((await request(`${base}/resources/${uploadedData.payload.id}`, 'DELETE')).status, 204); assert.equal(existsSync(uploadedArtifact), false)

    const staleRunning = await request(`${base}/resources/${checkin.data.session_id}/tasks`, 'POST', { action: 'command', arguments: { command: 'stale running' } })
    const staleRunningPoll = await request(recheckin.data.poll_path, 'POST', undefined, { 'X-RedTrace-Session-Token': recheckin.data.session_token })
    assert.deepEqual(staleRunningPoll.data.tasks.map((t: any) => t.id), [staleRunning.data.task.id])
    const staleQueued = await request(`${base}/resources/${checkin.data.session_id}/tasks`, 'POST', { action: 'command', arguments: { command: 'stale queued' } })
    engine.store.db.prepare("UPDATE shared_resources SET last_seen_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(checkin.data.session_id)
    assert.equal((await request(`${base}/resources/${checkin.data.session_id}`)).data.resource.status, 'offline')
    assert.equal(engine.operations.task(staleRunning.data.task.id).status, 'failed')
    assert.equal(engine.operations.task(staleQueued.data.task.id).status, 'failed')
    const offlineTask = await request(`${base}/resources/${checkin.data.session_id}/tasks`, 'POST', { action: 'command', arguments: { command: 'must not queue' } })
    assert.equal(offlineTask.status, 409)
    assert.equal(engine.store.db.prepare("SELECT COUNT(*) AS n FROM resource_audit_events WHERE resource_id=? AND action='c2.session_offline'").get(checkin.data.session_id)!.n, 1)

    const external = await request(base + '/resources', 'POST', { kind: 'c2_listener', name: 'External fixture', metadata: { listener_type: 'external_c2', adapter_endpoint: `http://127.0.0.1:${(remote.address() as { port: number }).port}`, sync_interval: 1 } })
    let externalSession: any
    for (let i = 0; i < 100 && !externalSession; i++) { externalSession = engine.store.db.prepare("SELECT * FROM shared_resources WHERE parent_resource_id=? AND kind='c2_session'").get(external.data.resource.id); if (!externalSession) await new Promise(r => setTimeout(r, 10)) }
    assert.equal(externalSession.target, 'ext-1')
    const externalTask = await request(`${base}/resources/${externalSession.id}/tasks`, 'POST', { action: 'command', arguments: { command: 'id' } }); await waitFor(externalTask.data.task.id, 'succeeded')
    assert.match(engine.operations.task(externalTask.data.task.id).output_summary, /external adapter verified/)
    const externalPayload = await request(`${base}/c2/payloads/external`, 'POST', { listener_id: external.data.resource.id, format: 'exe' })
    assert.equal(externalPayload.status, 201); assert.equal(externalPayload.data.payload.target, 'https://adapter.test/payload')

    const reserve = createTcpServer(); await new Promise<void>(resolve => reserve.listen(0, '127.0.0.1', resolve)); const port = (reserve.address() as { port: number }).port; await new Promise<void>(resolve => reserve.close(() => resolve()))
    const reverse = await request(base + '/resources', 'POST', { kind: 'c2_listener', name: 'TCP fixture', metadata: { listener_type: 'tcp_reverse', bind_host: '127.0.0.1', bind_port: port } })
    await new Promise(r => setTimeout(r, 20)); const channel = createConnection(port, '127.0.0.1'); await new Promise<void>((resolve, reject) => { channel.once('connect', resolve); channel.once('error', reject) }); channel.on('data', chunk => channel.write(fixtureFrame(chunk.toString(), 'raw channel verified')))
    let rawSession: any
    for (let i = 0; i < 100 && !rawSession; i++) { rawSession = engine.store.db.prepare("SELECT * FROM shared_resources WHERE parent_resource_id=? AND kind='c2_session'").get(reverse.data.resource.id); if (!rawSession) await new Promise(r => setTimeout(r, 10)) }
    const rawTask = await request(`${base}/resources/${rawSession.id}/tasks`, 'POST', { action: 'command', arguments: { command: 'whoami', timeout: 2 } }); await waitFor(rawTask.data.task.id, 'succeeded')
    assert.match(engine.operations.task(rawTask.data.task.id).output_summary, /raw channel verified/); channel.destroy()

    if (spawnSync('go', ['version']).status === 0) {
      const built = await request(`${base}/c2/payloads/build`, 'POST', { listener_id: listener.data.resource.id, callback_url: url, os: process.platform === 'win32' ? 'windows' : 'linux', arch: process.arch === 'arm64' ? 'arm64' : 'amd64' })
      assert.equal(built.status, 201); const binary = await fetch(url + built.data.payload.target); assert.equal((await binary.arrayBuffer()).byteLength, built.data.payload.metadata.size_bytes)
    }
    const exported = await (await fetch(`${url}${base}/export?format=yaml`)).text()
    assert.match(exported, /shared_resources:/); assert.match(exported, /operation_tasks:/); assert.doesNotMatch(exported, new RegExp(listener.data.secret_once.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    assert.equal((await fetch(`${url}${base}/export?format=json`)).status, 400)
  } finally {
    await engine.close(); remote.closeAllConnections(); await new Promise<void>(resolve => remote.close(() => resolve())); rmSync(root, { recursive: true, force: true })
  }
})
