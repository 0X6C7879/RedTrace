import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, symlinkSync, rmSync, readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Configuration } from '../src/config.ts'

const root = path.resolve(import.meta.dirname, '../../..')

test('shipped DSH composition executes Bootstrap, Reason and direct/isolated Explore; pauses and resumes natively', { timeout: 60000 }, async () => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-loop-'))
  symlinkSync(path.join(root, 'static'), path.join(work, 'static'))
  const requests: any[] = []
  let held = false, holdObserved = false, timeoutHeld = false, timeoutGuardSent = false
  let planFixture = false, followerId = '', followerHeld = false, producerHeld = false, reasonHeld = false
  let releaseFollower: (() => void) | undefined, releaseProducer: (() => void) | undefined, releaseReason: (() => void) | undefined
  const sendTool = (res: any, name: string, args: unknown) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'plan', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `plan-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  }
  const model = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const b = JSON.parse(raw); requests.push({ ...b, authorization: req.headers.authorization })
    const names = (b.tools ?? []).map((t: any) => t.function.name)
    const previous = b.messages.flatMap((m: any) => m.tool_calls ?? []).map((c: any) => c.function.name)
    const text = b.messages.filter((m: any) => m.role === 'user').map((m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).join('\n')
    let name: string, args: unknown
    if (!names.length) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end('data: {"id":"probe","object":"chat.completion.chunk","created":1,"model":"fixture","choices":[{"index":0,"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
      return
    }
    if (planFixture && names.includes('finish_decide')) {
      if (!reasonHeld) { reasonHeld = true; releaseReason = () => sendTool(res, 'read_graph_delta', {}); return }
      if (!previous.includes('read_graph_delta')) { name = 'read_graph_delta'; args = {} }
      else {
        const seqs = [...JSON.stringify(b.messages).matchAll(/\\?"evidenceSeq\\?":\s*(\d+)/g)].map(m => Number(m[1]))
        name = 'finish_decide'; args = { throughEvidenceSeq: Math.max(0, ...seqs) }
      }
    }
    else if (planFixture && text.includes('plan follower')) {
      if (!followerHeld) { followerHeld = true; releaseFollower = () => sendTool(res, 'bash', { command: 'printf forbidden-old-direction' }); return }
      if (!previous.includes('read_graph')) { name = 'read_graph'; args = { id: followerId } }
      else if (!previous.includes('sync_step')) { name = 'sync_step'; args = { planVersion: 2 } }
      else if (previous.filter((n: string) => n === 'bash').length < 2) { name = 'bash'; args = { command: 'printf latest-plan-direction' } }
      else if (!previous.includes('submit_fact')) { name = 'submit_fact'; args = { description: 'Follower executed latest-plan-direction', evidence: [{ description: 'bash returned latest-plan-direction' }] } }
      else { name = 'finish_step'; args = { summary: 'Followed amended contract' } }
    }
    else if (planFixture && text.includes('evidence producer') && previous.includes('submit_fact') && !producerHeld) {
      producerHeld = true; releaseProducer = () => sendTool(res, 'finish_step', { summary: 'Producer finished after live notification' }); return
    }
    else if (names.includes('finish_decide')) { name = 'finish_decide'; args = {} }
    else if (!previous.includes('bash')) { name = 'bash'; args = { command: 'printf native-dsh-fixture' } }
    else if (text.includes('timeout fixture') && !timeoutHeld) { timeoutHeld = true; return }
    else if (text.includes('timeout fixture') && !timeoutGuardSent) { timeoutGuardSent = true; name = 'bash'; args = { command: 'printf forbidden-conclude-side-effect' } }
    else if (text.includes('pause fixture') && !held) { held = true; holdObserved = true; return }
    else if (!previous.includes('submit_fact')) { name = 'submit_fact'; args = { description: 'Native DSH executed harmless printf', evidence: [{ description: 'bash returned native-dsh-fixture' }] } }
    else { name = 'finish_step'; args = { summary: 'Native DSH fixture completed' } }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ id: 'native', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: `call-${requests.length}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ id: 'native', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>(resolve => model.listen(0, '127.0.0.1', resolve))
  const c = new Configuration(work); c.initialize(); c.commit(c.read().revision, raw => {
    raw.providers = { fixture: { api: 'openai-completions', base_url: `http://127.0.0.1:${(model.address() as any).port}/v1`, api_key: 'fixture-key', models: [{ id: 'fixture', context_window: 20000, max_tokens: 1000, reasoning_efforts: false, reasoning: 'off' }] } }
    raw.workers = [{ name: 'fixture', provider: 'fixture', model: 'fixture', backend: 'pi', max_running: 2 }]
    raw.runtime = { max_workers: 2, max_project_workers: 2, max_running_projects: 1 }
    raw.tasks = { reason: { timeout: 15, conclude_timeout: 3 }, explore: { timeout: 15, conclude_timeout: 3 }, bootstrap: { timeout: 15, conclude_timeout: 3 } }
  })
  const reservation = createServer(); await new Promise<void>(resolve => reservation.listen(0, '127.0.0.1', resolve))
  const port = (reservation.address() as any).port; await new Promise<void>(resolve => reservation.close(() => resolve()))
  const child = spawn(process.execPath, [path.join(root, 'scripts/run-redtrace-node.mjs'), '--root', work, '--host', '127.0.0.1', '--port', String(port)], { cwd: root,
    env: { ...process.env, DSH_HOME: path.join(work, '.dsh'), REDTRACE_SOURCE_ROOT: root, REDTRACE_CODE_ROOT: root, REDTRACE_DATA_ROOT: path.join(work, '.redtrace') }, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = '', exited = false
  const closed = new Promise<void>(resolve => child.once('close', () => { exited = true; resolve() }))
  for (const s of [child.stdout, child.stderr]) s.on('data', b => { logs = (logs + b).slice(-50000) })
  const url = `http://127.0.0.1:${port}`
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + route, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }), signal: AbortSignal.timeout(10000) })
    const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value as any
  }
  const until = async (read: () => Promise<any>, check: (value: any) => boolean, label: string) => {
    for (let i = 0; i < 200; i++) { const value = await read(); if (check(value)) return value; if (exited) break; await delay(50) }
    throw new Error(label + '\n' + logs + '\n' + JSON.stringify(await read()))
  }
  try {
    for (let i = 0; i < 100 && !exited; i++) { try { await call('/__redtrace/plugins'); break } catch { await delay(100) } }
    assert.ok(!exited, logs)
    const plugins = await call('/__redtrace/plugins'), entries = Array.isArray(plugins) ? plugins : plugins.plugins
    assert.ok(entries.some((p: any) => p.id === 'llm-pi-ai'))
    assert.equal(entries.some((p: any) => p.id === 'llm-deepseek'), false)
    assert.ok(entries.some((p: any) => p.id === 'redtrace-attachment' && p.status === 'running'))
    let snapshot = await call('/worker-config')
    assert.equal(snapshot.workers[0].type, 'dsh')
    const probe = { expected_revision: snapshot.revision, name: 'draft-fixture', provider: 'fixture', model: 'fixture', priority: 0, max_running: 1 }
    assert.equal((await call('/worker-config/test', 'POST', probe)).ok, true)
    assert.equal((await call('/worker-config')).revision, snapshot.revision)
    assert.equal((await call('/runtime/config')).env && JSON.stringify(await call('/runtime/config')).includes('fixture-key'), false)
    const created = await call('/v2/projects', 'POST', { title: 'Native DSH', origin: 'Harmless local native loop fixture', goal: 'Verify executor', bootstrap: true })
    const id = created.project.id, base = `/v2/projects/${id}`
    await until(() => call(base + '/runs'), runs => runs.some((r: any) => r.activity === 'decide' && r.status === 'succeeded'), 'Bootstrap/Reason did not complete')
    const bootRuns = await call(base + '/runs')
    assert.ok(bootRuns.every((r: any) => r.backend === 'dsh'))
    assert.ok(bootRuns.some((r: any) => r.activity === 'execute' && r.status === 'succeeded'))
    for (const executionProfile of ['direct', 'isolated']) {
      const step = await call(base + '/steps', 'POST', { description: `${executionProfile} native fixture`, sourceIds: ['origin'], executionProfile })
      const runs = await until(() => call(base + `/steps/${step.id}/runs`), rows => rows.some((r: any) => r.status === 'succeeded' || r.status === 'failed'), executionProfile + ' did not complete')
      assert.equal(runs[0].status, 'succeeded', JSON.stringify(runs))
      assert.deepEqual(runs[0].checkpoint, { sessionId: runs[0].id })
      const events = await call(base + `/runs/${runs[0].id}/events?limit=500`)
      assert.ok(events.some((e: any) => e.kind === 'tool.completed' && !e.error && String(e.content).includes('native-dsh-fixture')), JSON.stringify(events))
      const starts = events.filter((e: any) => e.kind === 'tool.started').map((e: any) => e.call_id)
      assert.equal(new Set(starts).size, starts.length, 'tool lifecycle was audited twice')
      assert.ok(runs[0].inputTokens > 0 && runs[0].outputTokens > 0)
    }
    c.commit(c.read().revision, raw => { raw.tasks!.explore.timeout = 1 })
    await delay(100)
    await call('/runtime/config')
    const timeoutStep = await call(base + '/steps', 'POST', { description: 'timeout fixture', sourceIds: ['origin'] })
    const timeoutRuns = await until(() => call(base + `/steps/${timeoutStep.id}/runs`), rows => rows[0]?.status === 'succeeded' || rows[0]?.status === 'failed', 'conclude fixture did not finish')
    assert.equal(timeoutRuns[0].status, 'succeeded', JSON.stringify(timeoutRuns))
    const timeoutEvents = await call(base + `/runs/${timeoutRuns[0].id}/events?limit=500`)
    assert.ok(timeoutGuardSent)
    assert.ok(timeoutEvents.some((e: any) => e.kind === 'tool.completed' && e.error && String(e.content).includes('only summarize')), JSON.stringify(timeoutEvents))
    assert.ok(!timeoutEvents.some((e: any) => e.kind === 'tool.completed' && !e.error && String(e.content).includes('forbidden-conclude-side-effect')))
    c.commit(c.read().revision, raw => { raw.tasks!.explore.timeout = 15 })
    await delay(100)
    await call('/runtime/config')
    const step = await call(base + '/steps', 'POST', { description: 'pause fixture', sourceIds: ['origin'] })
    await until(async () => holdObserved, Boolean, 'pause fixture did not reach model boundary')
    await call(base + '/status', 'PUT', { status: 'stopped' })
    const paused = await until(() => call(base + `/steps/${step.id}/runs`), rows => rows[0]?.status === 'paused', 'native session did not pause')
    assert.deepEqual(paused[0].pendingTools, [])
    await call(base + '/status', 'PUT', { status: 'active' })
    const resumed = await until(() => call(base + `/steps/${step.id}/runs`), rows => rows[0]?.status === 'succeeded' || rows[0]?.status === 'failed', 'native session did not resume')
    assert.equal(resumed[0].status, 'succeeded', JSON.stringify(resumed))
    assert.equal(resumed[0].id, paused[0].id)
    const resumedEvents = await call(base + `/runs/${resumed[0].id}/events?limit=500`)
    assert.equal(resumedEvents.filter((e: any) => e.kind === 'tool.started' && e.title === 'bash').length, 1, 'resume replayed the completed side effect')
    c.commit(c.read().revision, raw => { raw.workers![0].max_running = 4; raw.runtime = { max_workers: 4, max_project_workers: 4, max_running_projects: 1 } })
    await call('/runtime/config')
    planFixture = true
    const follower = await call(base + '/steps', 'POST', { description: 'plan follower', sourceIds: ['origin'] }); followerId = follower.id
    await until(async () => followerHeld, Boolean, 'follower model request did not start')
    const currentFollower = await call(base + `/nodes/${followerId}`)
    await call(base + `/steps/${followerId}`, 'PATCH', { description: 'plan follower amended strategy', expectedVersion: currentFollower.version, mode: 'amend' })
    const producer = await call(base + '/steps', 'POST', { description: 'evidence producer', sourceIds: ['origin'] })
    await until(async () => reasonHeld && producerHeld, Boolean, 'Fact did not wake Reason while producer remained running')
    const runningBefore = await call(base + '/runs')
    assert.equal(runningBefore.findLast((r: any) => r.stepId === producer.id).status, 'running')
    assert.equal(runningBefore.filter((r: any) => r.activity === 'decide' && r.status === 'running').length, 1)
    await call(base + '/facts', 'POST', { description: 'Second evidence while Reason is busy', evidence: [{ description: 'Isolated HTTP fixture' }] })
    await delay(100)
    releaseReason!(); releaseFollower!(); releaseProducer!()
    const followerRuns = await until(() => call(base + `/steps/${followerId}/runs`), rows => rows[0]?.status === 'succeeded' || rows[0]?.status === 'failed', 'amended native session did not finish')
    assert.equal(followerRuns.length, 1, 'amend rebuilt the session')
    assert.equal(followerRuns[0].status, 'succeeded', JSON.stringify(followerRuns))
    const followerEvents = await call(base + `/runs/${followerRuns[0].id}/events?limit=500`)
    assert.ok(followerEvents.some((e: any) => e.kind === 'tool.completed' && e.error && String(e.content).includes('Plan changed')), JSON.stringify(followerEvents))
    assert.ok(!followerEvents.some((e: any) => e.kind === 'tool.completed' && !e.error && String(e.content).includes('forbidden-old-direction')))
    assert.ok(followerEvents.some((e: any) => e.kind === 'tool.completed' && !e.error && String(e.content).includes('latest-plan-direction')))
    await until(() => call(base), state => state.project.evidenceSeq === state.project.acknowledgedEvidenceSeq, 'Reason did not acknowledge delivered incremental evidence')
    assert.ok(requests.some(r => JSON.stringify(r.messages).includes('新增确认的 Fact/Finding')), 'busy Reason received no compact evidence reminder')
    const canonical = await call(base + '/facts', 'POST', { description: 'Archive fixture', evidence: [{ description: 'Fixture' }] })
    await call(base + '/evidence/manage', 'POST', { operation: 'archive', id: canonical.id, expectedVersion: canonical.version, reason: 'No active references' })
    assert.equal((await call(base + '/facts')).some((f: any) => f.id === canonical.id), false)
    assert.equal((await call(base + '/facts?includeInactive=true')).some((f: any) => f.id === canonical.id), true)
    planFixture = false
    snapshot = await call('/worker-config')
    await call('/worker-config/providers/fixture' , 'PUT', { expected_revision: snapshot.revision, name: 'fixture', api: 'openai-completions', base_url: `http://127.0.0.1:${(model.address() as any).port}/v1`, api_key: 'rotated-key', models: [{ id: 'fixture', context_window: 20000, max_tokens: 1000, reasoning_efforts: false, reasoning: 'off' }] })
    await call('/runtime/config')
    snapshot = await call('/worker-config')
    await call('/worker-config/test', 'POST', { ...probe, expected_revision: snapshot.revision })
    assert.equal(requests.at(-1).authorization, 'Bearer rotated-key')
    const afterRotation = requests.length
    const rotatedStep = await call(base + '/steps', 'POST', { description: 'rotated native fixture', sourceIds: ['origin'] })
    const rotatedRuns = await until(() => call(base + `/steps/${rotatedStep.id}/runs`), rows => rows[0]?.status === 'succeeded' || rows[0]?.status === 'failed', 'rotated native task did not finish')
    assert.equal(rotatedRuns[0].status, 'succeeded', JSON.stringify(rotatedRuns))
    assert.ok(requests.slice(afterRotation).every(r => r.authorization === 'Bearer rotated-key'))
    assert.ok(!JSON.stringify(await call('/runtime/config')).includes('rotated-key'))
    const sessionFiles = readdirSync(path.join(work, '.redtrace/sessions'))
    assert.ok(sessionFiles.length > 0)
    assert.ok(!readFileSync(path.join(work, '.redtrace/redtrace.yaml'), 'utf8').includes('rotated-key'))
    assert.ok(requests.some(r => r.tools?.some((t: any) => t.function.name === 'finish_decide') && !r.tools?.some((t: any) => t.function.name === 'bash')))
  } finally {
    if (!exited) child.kill('SIGTERM')
    await Promise.race([closed, delay(5000)])
    if (!exited) { child.kill('SIGKILL'); await closed }
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    rmSync(work, { recursive: true, force: true })
  }
})
