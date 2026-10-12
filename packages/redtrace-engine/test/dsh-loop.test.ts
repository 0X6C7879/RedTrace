import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, symlinkSync, rmSync, readdirSync, readFileSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { setTimeout as delay } from 'node:timers/promises'
import { Configuration } from '../src/config.ts'

const root = path.resolve(import.meta.dirname, '../../..')
const shellName = process.platform === 'win32' ? 'pwsh' : 'bash'
const print = (text: string) => process.platform === 'win32' ? `Write-Output '${text}'` : `printf ${text}`

test('shipped DSH composition executes Bootstrap, Reason and direct/isolated Explore; pauses and resumes natively', { timeout: 60000 }, async (t) => {
  const work = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-loop-'))
  symlinkSync(path.join(root, 'static'), path.join(work, 'static'))
  const requests: any[] = []
  let held = false, holdObserved = false, timeoutHeld = false, timeoutGuardSent = false
  let taskPluginPlans = 0
  let noticeStepId = '', noticeFixture = false, pauseNoticeHeld = false, resumeNotice = false
  const noticeRelease = path.join(work, 'release-notice-tool')
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
    if (noticeFixture && text.includes('notice fixture') && names.includes('finish_decide')) {
      if (text.includes('HUMAN_ONLY_NOTIFY') && !resumeNotice) {
        if (!previous.includes('read_graph_delta')) { name = 'read_graph_delta'; args = {} }
        else if (previous.filter((n: string) => n === 'notify_explore').length < 2) { name = 'notify_explore'; args = { stepId: noticeStepId, message: 'EVALUATED_HINT_PATH: a useful alternate method; objective unchanged.' } }
        else {
          const seq = (key: string) => Math.max(0, ...[...JSON.stringify(b.messages).matchAll(new RegExp('\\\\?"' + key + '\\\\?":\\s*(\\d+)', 'g'))].map(m => Number(m[1])))
          name = 'finish_decide'; args = { throughEvidenceSeq: seq('evidenceSeq'), throughHintSeq: seq('hintSeq') }
        }
      } else { name = 'finish_decide'; args = {} }
    }
    else if (noticeFixture && text.includes('notice fixture') && names.includes('finish_step')) {
      if (text.includes('notice pause follower')) {
        if (!pauseNoticeHeld) { pauseNoticeHeld = true; return }
        assert.ok(!text.includes('[RedTrace Reason]'), 'unread notification was replayed on resume')
        sendTool(res, 'finish_step', { summary: 'Resumed without replaying stale notice' }); return
      }
      const isFollower = text.includes('notice follower'), calls = previous.filter((n: string) => n === shellName).length
      if (!calls) { name = shellName; args = { command: process.platform === 'win32' ? `Write-Output notice-tool-start; while (-not (Test-Path -LiteralPath '${noticeRelease}')) { Start-Sleep -Milliseconds 20 }; Write-Output notice-tool-end` : `printf notice-tool-start; while [ ! -f '${noticeRelease}' ]; do sleep 0.02; done; printf notice-tool-end`, description: 'Bounded local delivery continuity fixture' } }
      else if (isFollower && calls === 1) {
        assert.ok(text.includes('EVALUATED_HINT_PATH'), 'next native request did not contain Reason notification')
        assert.ok(!text.includes('HUMAN_ONLY_NOTIFY'), 'raw human Hint leaked to Explore')
        name = shellName; args = { command: print('notice-adjusted-method'), description: 'Use the supplemental path without Step amendment' }
      } else {
        if (!isFollower) assert.ok(!text.includes('EVALUATED_HINT_PATH'), 'notification reached wrong Explore')
        name = 'finish_step'; args = { summary: 'Continued original native session' }
      }
    }
    else if (text.includes('task plugin fixture') && names.includes('finish_decide')) {
      if (taskPluginPlans < 2) {
        name = 'add_step'; args = { description: taskPluginPlans === 0 ? 'selected REA' : 'ordinary task', sourceIds: ['origin'], ...(taskPluginPlans === 0 ? { plugins: ['redtrace-reverse'] } : {}) }
        taskPluginPlans++
      } else { name = 'finish_decide'; args = {} }
    }
    else if (text.includes('task plugin fixture') && names.includes('finish_step')) {
      if (text.includes('selected REA') && !previous.includes('skill')) { name = 'skill'; args = { name: 'reverse-engineer-anything' } }
      else if (text.includes('selected REA') && !previous.includes('mcp__rea__binary_session')) { name = 'mcp__rea__binary_session'; args = {} }
      else { name = 'finish_step'; args = { summary: 'Task-scoped plugin fixture completed' } }
    }
    else if (planFixture && names.includes('finish_decide')) {
      if (!reasonHeld) { reasonHeld = true; releaseReason = () => sendTool(res, 'read_graph_delta', {}); return }
      if (!previous.includes('read_graph_delta')) { name = 'read_graph_delta'; args = {} }
      else {
        const seqs = [...JSON.stringify(b.messages).matchAll(/\\?"evidenceSeq\\?":\s*(\d+)/g)].map(m => Number(m[1]))
        name = 'finish_decide'; args = { throughEvidenceSeq: Math.max(0, ...seqs) }
      }
    }
    else if (planFixture && text.includes('plan follower')) {
      if (!followerHeld) { followerHeld = true; releaseFollower = () => sendTool(res, shellName, { command: print('forbidden-old-direction'), description: 'Old plan fixture' }); return }
      if (!previous.includes('read_graph')) { name = 'read_graph'; args = { id: followerId } }
      else if (!previous.includes('sync_step')) { name = 'sync_step'; args = { planVersion: 2 } }
      else if (previous.filter((n: string) => n === shellName).length < 2) { name = shellName; args = { command: print('latest-plan-direction'), description: 'Current plan fixture' } }
      else if (!previous.includes('submit_fact')) { name = 'submit_fact'; args = { description: 'Follower executed latest-plan-direction', evidence: [{ description: 'bash returned latest-plan-direction' }] } }
      else { name = 'finish_step'; args = { summary: 'Followed amended contract' } }
    }
    else if (planFixture && text.includes('evidence producer') && previous.includes('submit_fact') && !producerHeld) {
      producerHeld = true; releaseProducer = () => sendTool(res, 'finish_step', { summary: 'Producer finished after live notification' }); return
    }
    else if (names.includes('finish_decide')) { name = 'finish_decide'; args = {} }
    else if (!previous.includes(shellName)) { name = shellName; args = { command: print('native-dsh-fixture'), description: 'Harmless native fixture' } }
    else if (text.includes('timeout fixture') && !timeoutHeld) { timeoutHeld = true; return }
    else if (text.includes('timeout fixture') && !timeoutGuardSent) { timeoutGuardSent = true; name = shellName; args = { command: print('forbidden-conclude-side-effect'), description: 'Timeout guard fixture' } }
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
  // The first-run import copies <root>/skills into the managed store, so the
  // jev-decision fixture must exist here before the child boots: with the jev
  // plugin default-off, boot must park the skill in the disabled root.
  mkdirSync(path.join(work, 'skills/jev-decision'), { recursive: true })
  writeFileSync(path.join(work, 'skills/jev-decision/SKILL.md'), '---\nname: jev-decision\ndescription: Jev advisory fixture\n---\nJev fixture body\n')
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
    assert.ok(entries.some((p: any) => p.id === 'redtrace-jev' && p.status === 'stopped'))
    assert.ok(existsSync(path.join(work, '.redtrace/disabled-skills/jev-decision/SKILL.md')), 'stopped jev plugin must park its skill in the disabled root')
    assert.ok(!existsSync(path.join(work, '.redtrace/skills/jev-decision')), 'stopped jev plugin must not leave its skill in the catalog root')
    let snapshot = await call('/worker-config')
    assert.equal(snapshot.workers[0].type, 'dsh')
    const probe = { expected_revision: snapshot.revision, name: 'draft-fixture', provider: 'fixture', model: 'fixture', priority: 0, max_running: 1 }
    assert.equal((await call('/worker-config/test', 'POST', probe)).ok, true)
    assert.equal((await call('/worker-config')).revision, snapshot.revision)
    assert.equal((await call('/runtime/config')).env && JSON.stringify(await call('/runtime/config')).includes('fixture-key'), false)
    const created = await call('/v2/projects', 'POST', { title: 'Native DSH', origin: 'Harmless local native loop fixture {{unknown}} 中文 \"quoted\"', goal: 'Verify executor {{unknown}}', hints:[{content:'Unverified initial {{unknown}} hint 中文',creator:'fixture'}], bootstrap: true })
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
    assert.equal(resumedEvents.filter((e: any) => e.kind === 'tool.started' && e.title === shellName).length, 1, 'resume replayed the completed side effect')
    c.commit(c.read().revision, raw => { raw.workers![0].max_running = 4; raw.runtime = { max_workers: 4, max_project_workers: 4, max_running_projects: 1 } })
    await call('/runtime/config')
    planFixture = true
    const follower = await call(base + '/steps', 'POST', { description: 'plan follower', sourceIds: ['origin'] }); followerId = follower.id
    await until(async () => followerHeld, Boolean, 'follower model request did not start')
    const currentFollower = await call(base + `/nodes/${followerId}`)
    await call(base + `/steps/${followerId}`, 'PATCH', { description: 'plan follower amended strategy', expectedVersion: currentFollower.version, mode: 'amend' })
    const producer = await call(base + '/steps', 'POST', { description: 'evidence producer', sourceIds: ['origin'] })
    await until(async () => ({ reasonHeld, producerHeld,
      runs: (await call(base + '/runs')).map((r: any) => ({ activity: r.activity, status: r.status, error: r.error })),
      steps: (await call(base)).steps.map((s: any) => ({ description: s.description, status: s.status })),
      project: (await call(base)).project,
      runtimeLimits: (await call('/runtime/config')).limits,
      workers: (await call('/worker-config')).workers.map((w: any) => ({ name: w.name, maxRunning: w.max_running })),
      producerEvents: await call(base + `/runs/${(await call(base + `/steps/${producer.id}/runs`))[0].id}/events?limit=100`).then(rows => rows.filter((e: any) => e.kind === 'tool.completed').map((e: any) => ({ title: e.title, error: e.error, content: String(e.content).slice(0, 1000) }))),
    }), state => state.reasonHeld && state.producerHeld, 'Fact did not wake Reason while producer remained running')
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
    for (const role of ['Bootstrap','Explore']) {
      const first=requests.find(r=>r.messages.some((m:any)=>m.role==='system'&&JSON.stringify(m.content).includes(`你是 ${role}`)))
      assert.ok(first,role)
      const system=JSON.stringify(first.messages.filter((m:any)=>m.role==='system'))
      const user=JSON.stringify(first.messages.filter((m:any)=>m.role==='user'))
      assert.ok(!system.includes('当前执行契约'), 'moving execution data must not be a System section')
      assert.ok(user.includes('当前执行契约（以本快照为准）'), 'required context disappeared with runtime contexts disabled')
      assert.ok(user.includes('{{unknown}}'), 'literal text was interpreted as a template')
      const launch=first.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>typeof m.content==='string'?[m.content]:m.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text)).find((text:string)=>text.startsWith('{"projectId"'))
      assert.ok(launch)
      const projected=JSON.parse(launch)
      assert.equal(projected.scope.description,'Harmless local native loop fixture {{unknown}} 中文 "quoted"')
      if(role==='Bootstrap')assert.equal(projected.hints.items[0].content,'Unverified initial {{unknown}} hint 中文')
      else assert.equal(projected.hints,undefined,'Human hints must be evaluated by Reason, not injected at Explore launch')
      assert.equal('step' in projected,false);assert.equal('goal' in projected,false)
    }
    const sessionFiles = readdirSync(path.join(work, '.redtrace/sessions'))
    assert.ok(sessionFiles.length > 0)
    assert.ok(!readFileSync(path.join(work, '.redtrace/redtrace.yaml'), 'utf8').includes('rotated-key'))
    assert.ok(requests.some(r => r.tools?.some((t: any) => t.function.name === 'finish_decide') && !r.tools?.some((t: any) => t.function.name === shellName)))
    c.commit(c.read().revision, raw => { raw.tasks!.explore.timeout = 30 })
    await call('/runtime/config')
    await call(base + '/status', 'PUT', { status: 'stopped' })
    const pluginStart = requests.length
    const taskProject = await call('/v2/projects', 'POST', { title: 'Task plugins', origin: 'task plugin fixture', goal: 'Verify scoped native REA', bootstrap: false })
    const taskBase = `/v2/projects/${taskProject.project.id}`
    const taskGraph = await until(() => call(taskBase), g => g.steps.length === 2 && g.steps.every((s: any) => s.status === 'done'), 'Reason-selected native REA Steps did not finish')
    assert.deepEqual(taskGraph.steps.find((s: any) => s.description === 'selected REA').plugins, ['redtrace-reverse'])
    assert.equal(taskGraph.steps.find((s: any) => s.description === 'ordinary task').plugins, undefined)
    const fixtureRequests = requests.slice(pluginStart).filter(r => JSON.stringify(r.messages).includes('task plugin fixture'))
    const reasons = fixtureRequests.filter(r => r.tools?.some((t: any) => t.function.name === 'finish_decide'))
    const ordinary = fixtureRequests.filter(r => r.messages.some((m: any) => m.role === 'user' && JSON.stringify(m.content).includes('ordinary task')))
    assert.ok(reasons.length && ordinary.length)
    for (const r of [...reasons, ...ordinary]) assert.equal(r.tools.some((t: any) => t.function.name.startsWith('mcp__rea__')), false)
    assert.ok(fixtureRequests.some(r => r.tools?.some((t: any) => t.function.name === 'mcp__rea__binary_session')))
    const pluginRows = await call('/__redtrace/plugins'), pluginEntries = Array.isArray(pluginRows) ? pluginRows : pluginRows.plugins
    assert.equal(pluginEntries.find((p: any) => p.id === 'redtrace-reverse').status, 'stopped', 'Reason must not start the global feature')
    const taskRuns = await call(taskBase + '/runs')
    for (const r of taskRuns.filter((r: any) => r.activity === 'execute')) {
      assert.equal(r.status, 'succeeded')
      const events = await call(taskBase + `/runs/${r.id}/events?limit=500`)
      assert.equal(events.some((e: any) => e.kind === 'tool.completed' && e.error), false, JSON.stringify(events))
    }
    await call(taskBase + '/status', 'PUT', { status: 'stopped' })
    c.commit(c.read().revision, raw => {
      raw.providers!.fixture.models!.push({ ...raw.providers!.fixture.models![0], id: 'fixture-alt' })
      raw.workers = [
        { name: 'notice-reason', provider: 'fixture', model: 'fixture', backend: 'dsh', max_running: 1, reason: true, explore: false, bootstrap: false },
        { name: 'notice-alpha', provider: 'fixture', model: 'fixture', backend: 'dsh', max_running: 1, reason: false, explore: true, bootstrap: false, priority: 0 },
        { name: 'notice-beta', provider: 'fixture', model: 'fixture-alt', backend: 'dsh', max_running: 1, reason: false, explore: true, bootstrap: false, priority: 1 },
      ]
      raw.runtime = { max_workers: 3, max_project_workers: 3, max_running_projects: 1 }
      raw.tasks!.reason.timeout = 30; raw.tasks!.explore.timeout = 30
    })
    await call('/runtime/config'); noticeFixture = true
    const noticeProject = await call('/v2/projects', 'POST', { title: 'Notice', origin: 'notice fixture, harmless local commands only', goal: 'Verify targeted live communication', bootstrap: false })
    const noticeBase = `/v2/projects/${noticeProject.project.id}`
    await until(() => call(noticeBase + '/runs'), rs => rs.some((r: any) => r.activity === 'decide' && r.status === 'succeeded'), 'initial notification planning did not finish')
    const followerNotice = await call(noticeBase + '/steps', 'POST', { description: 'notice follower', sourceIds: ['origin'] }); noticeStepId = followerNotice.id
    const bystander = await call(noticeBase + '/steps', 'POST', { description: 'notice bystander', sourceIds: ['origin'] })
    const liveRuns = await until(() => call(noticeBase + '/runs'), rs => rs.filter((r: any) => r.activity === 'execute' && r.pendingTools.length).length === 2, 'both native tools did not start')
    const followerRun = liveRuns.find((r: any) => r.stepId === followerNotice.id), bystanderRun = liveRuns.find((r: any) => r.stepId === bystander.id)
    assert.notEqual(followerRun.model, bystanderRun.model)
    const localFact = await call(noticeBase + '/facts', 'POST', { description: 'NOTICE_FACT_NEVER_BROADCAST', evidence: [{ description: 'Local API fixture' }] })
    await call(noticeBase + '/findings', 'POST', { title: 'NOTICE_FINDING_NEVER_BROADCAST', description: 'Local deliverable', factIds: [localFact.id] })
    await until(() => call(noticeBase), g => g.project.evidenceSeq === g.project.acknowledgedEvidenceSeq, 'Fact/Finding did not wake Reason')
    await call(noticeBase + '/hints', 'POST', { content: 'HUMAN_ONLY_NOTIFY: evaluate the alternate method for the follower', creator: 'human' })
    const queuedRows = await until(async () => {
      const rs = await call(noticeBase + '/runs')
      const rows = await Promise.all(rs.filter((r: any) => r.activity === 'decide').map((r: any) => call(noticeBase + `/runs/${r.id}/events?limit=500`)))
      return rows.flat()
    }, rows => rows.some((e: any) => e.kind === 'tool.completed' && e.title === 'notify_explore' && String(e.content).includes('queued')) && rows.some((e: any) => e.kind === 'tool.completed' && e.title === 'notify_explore' && String(e.content).includes('duplicate')), 'Reason did not queue and deduplicate the live notification')
    assert.equal(queuedRows.filter((e: any) => e.kind === 'explore.notification.queued').length, 1)
    const stillRunning = await call(noticeBase + '/runs')
    for (const r of [followerRun, bystanderRun]) {
      const current = stillRunning.find((row: any) => row.id === r.id)
      assert.equal(current.status, 'running'); assert.equal(current.pendingTools.length, 1)
      assert.equal(current.boundStepVersion, 1)
    }
    assert.equal((await call(noticeBase + `/nodes/${followerNotice.id}`)).planVersion, 1)
    writeFileSync(noticeRelease, 'continue')
    await until(() => call(noticeBase + '/runs'), rs => rs.filter((r: any) => r.activity === 'execute' && r.status === 'succeeded').length === 2, 'native sessions did not continue to completion')
    const followerHistory = await call(noticeBase + `/steps/${followerNotice.id}/runs`)
    assert.equal(followerHistory.length, 1); assert.equal(followerHistory[0].id, followerRun.id)
    assert.equal(followerHistory[0].checkpoint.sessionId, followerRun.id)
    const followerNoticeEvents = await call(noticeBase + `/runs/${followerRun.id}/events?limit=500`)
    assert.ok(followerNoticeEvents.some((e: any) => e.kind === 'tool.completed' && !e.error && String(e.content).includes('notice-tool-end')))
    assert.ok(followerNoticeEvents.some((e: any) => e.kind === 'tool.completed' && !e.error && String(e.content).includes('notice-adjusted-method')))
    assert.equal(followerNoticeEvents.some((e: any) => e.title === 'sync_step'), false)
    const exploreRequests = requests.filter(r => JSON.stringify(r.messages).includes('notice fixture') && r.tools?.some((t: any) => t.function.name === 'finish_step'))
    assert.ok(exploreRequests.length > 0)
    for (const r of exploreRequests) {
      const users = JSON.stringify(r.messages.filter((m: any) => m.role === 'user'))
      assert.ok(!/HUMAN_ONLY_NOTIFY|NOTICE_FACT_NEVER_BROADCAST|NOTICE_FINDING_NEVER_BROADCAST/.test(users))
      assert.ok(!users.includes('[RedTrace FGS]'))
    }
    await until(() => call(noticeBase), g => g.project.hintSeq === g.project.acknowledgedHintSeq, 'Hint acknowledgement did not settle')
    const pauseStep = await call(noticeBase + '/steps', 'POST', { description: 'notice pause follower', sourceIds: ['origin'] }); noticeStepId = pauseStep.id
    await until(async () => pauseNoticeHeld, Boolean, 'pause target did not enter model request')
    await call(noticeBase + '/hints', 'POST', { content: 'HUMAN_ONLY_NOTIFY: fresh input for pause delivery test', creator: 'human' })
    const noticeAudit = async () => {
      const rs = await call(noticeBase + '/runs')
      return (await Promise.all(rs.filter((r: any) => r.activity === 'decide').map((r: any) => call(noticeBase + `/runs/${r.id}/events?limit=500`)))).flat()
    }
    await until(noticeAudit, rows => rows.some((e: any) => e.kind === 'explore.notification.queued' && e.data?.stepId === pauseStep.id), 'pause notification never queued')
    await call(noticeBase + '/status', 'PUT', { status: 'stopped' })
    const pausedNoticeRuns = await until(() => call(noticeBase + `/steps/${pauseStep.id}/runs`), rs => rs[0]?.status === 'paused', 'notification target did not pause')
    assert.equal(pausedNoticeRuns[0].pendingTools.length, 0)
    await until(noticeAudit, rows => rows.some((e: any) => e.kind === 'explore.notification.discarded' && e.data?.stepId === pauseStep.id), 'unread pause notification was not audited as discarded')
    resumeNotice = true
    await call(noticeBase + '/status', 'PUT', { status: 'active' })
    const resumedNoticeRuns = await until(() => call(noticeBase + `/steps/${pauseStep.id}/runs`), rs => rs[0]?.status === 'succeeded', 'notification target did not resume in original session')
    assert.equal(resumedNoticeRuns.length, 1); assert.equal(resumedNoticeRuns[0].id, pausedNoticeRuns[0].id)

  } finally {
    if (!exited) child.kill('SIGTERM')
    await Promise.race([closed, delay(5000)])
    if (!exited) { child.kill('SIGKILL'); await closed }
    model.closeAllConnections(); await new Promise<void>(resolve => model.close(() => resolve()))
    rmSync(work, { recursive: true, force: true })
    const metrics = ['Bootstrap', 'Reason', 'Explore'].map(role => {
      const rows = requests.filter(r => JSON.stringify(r.messages.filter((m: any) => m.role === 'system')).includes(`你是 ${role}`))
      const first = rows[0], users = first?.messages.filter((m: any) => m.role === 'user') ?? []
      const text = (m: any) => typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
      const notices = new Set(rows.flatMap(r => r.messages.filter((m: any) => m.role === 'user').map(text)).filter((s: string) => /共享 FGS|新增确认的 Fact\/Finding|\[RedTrace FGS\]/.test(s)))
      const calls=new Map(rows.flatMap(r=>r.messages.flatMap((m:any)=>m.tool_calls??[])).map((c:any)=>[c.id,c.function.name]))
      return { role, requests: rows.length, calls:Object.fromEntries(['read_graph','read_graph_delta','sync_step'].map(name=>[name,[...calls.values()].filter(n=>n===name).length])), firstSystemBytes: Buffer.byteLength(first?.messages.filter((m: any) => m.role === 'system').map(text).join('\n') ?? ''),
        firstUserBytes: Buffer.byteLength(users.map(text).join('\n')), notices: notices.size,
        graphReads: rows.filter(r => r.messages.at(-1)?.role === 'tool' && /read_graph/.test(JSON.stringify(r.messages.at(-2)))).length }
    })
    const conversations=new Map<string,{role:string;stepId?:string;requests:number;notices:Set<string>}>()
    for(const request of requests) {
      const role=['Bootstrap','Reason','Explore'].find(role=>request.messages.some((m:any)=>m.role==='system'&&JSON.stringify(m.content).includes(`你是 ${role}`)))
      if(!role)continue
      const texts=request.messages.filter((m:any)=>m.role==='user').flatMap((m:any)=>typeof m.content==='string'?[m.content]:m.content.filter((c:any)=>c.type==='text').map((c:any)=>c.text))
      const launch=texts.find((text:string)=>text.startsWith('{"projectId"')||text.startsWith('{"project"'))
      assert.ok(launch,'every fixture conversation retains its launch message')
      const stepId=texts.join('\n').match(/当前执行契约[^：]*：\s*\{\s*"id":"([^"]+)"/)?.[1]??JSON.parse(launch).step?.id
      if(role!=='Reason')assert.ok(stepId,'execution conversation must expose its live Step identity')
      const key=role+launch+(stepId??''), row=conversations.get(key)??{role,stepId,requests:0,notices:new Set<string>()}
      row.requests++;for(const text of texts)if(/共享 FGS|新增确认的 Fact\/Finding|\[RedTrace FGS\]/.test(text))row.notices.add(text)
      conversations.set(key,row)
    }
    const perConversation=[...conversations.values()].map((row,index)=>({fixtureConversation:index+1,role:row.role,stepId:row.stepId,requests:row.requests,notificationsEnteredRequests:row.notices.size}))
    t.diagnostic(`INJECTION_METRICS ${JSON.stringify({ kind: 'local-protocol-fixture-not-real-token-usage', metrics,perConversation })}`)
  }
})

test('10,000 changes skip ten native Explore listeners; only the affected Step is checked', async () => {
 const {load}=await import('../../redtrace-dsh/lib/loader.js')
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
 const host=new Context()
 const projections=await load('vendor/deepseek-harness/packages/session/session-projection/lib/index.js')
 const core=await load('packages/redtrace-dsh/lib/core.js')
 await host.plugin(projections.default??projections).await();await host.plugin(core.default??core).await()
 for(let i=0;i<500&&!host.get('agents');i++)await delay(10)
 const {SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
 const handles:any[]=[]
 const {createUserMessage}=await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js')
 const message=(text:string)=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})
 const cordisPath='../compat/cordis.mjs'
 const {queueGraphNotice,listenGraphChanges}=await import(cordisPath)
 const {Store}=await import('../src/store.ts')
 const store=new Store(':memory:')
 const project=store.createProject({title:'Concurrent',origin:'Local',goal:'Check'}).project
 const agents:any[]=[], runs:any[]=[], cursors:number[]=[], unlisteners:(()=>void)[]=[], checks:number[]=[]
 const worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'',enabled:true,reason:false,explore:true,bootstrap:false,maxRunning:4,priority:0}
 const {graphUpdate}=await import('../src/runner.ts')
 try {
  for(let i=0;i<10;i++) {
    const step=store.addStep(project.id,{description:`Worker ${i}`,sourceIds:['origin']})
    const run=store.claim(project.id,'execute',{...worker,name:`Worker ${i}`},step.id);runs.push(run);cursors.push(graphUpdate(store,project.id,0,step.id,run.id).cursor)
    const handle=await host.get('agents').create({sessionId:SessionId(run.id),meta:{cwd:root},agentOptions:{},setup(){}})
    handles.push(handle)
    const inbox=handle.agent.inbox
    agents.push({status:'running',inbox,wakes:0,inject(message:any){inbox.append('next-step',message)},steer(message:any){this.wakes++;inbox.append('next-step',message)}})
  }
  await delay(0)
  for(let j=0;j<10;j++) {
    checks[j]=0
    unlisteners.push(listenGraphChanges(store,runs[j],()=>{
      checks[j]++
      const update=graphUpdate(store,project.id,cursors[j]!,runs[j].stepId,runs[j].id)
      cursors[j]=update.cursor;queueGraphNotice(agents[j],update,message)
    }))
  }
  const unrelated=store.addStep(project.id,{description:'Unclaimed',sourceIds:['origin']})
  assert.equal(store.changes.listenerCount('change'),0)
  for(let i=0;i<10000;i++) {
    const run=runs[i%10]
    if(i%5===0)store.addInput(project.id,'observation',`noise ${i}`)
    else if(i%5===1)store.addInput(project.id,'hint',`hint ${i}`,'human',run.stepId)
    else if(i%5===2)store.updateStep(project.id,unrelated.id,{priority:i})
    else if(i%5===3)store.addFact(project.id,`evidence ${i}`,{stepId:run.stepId})
    else store.recordCriticalSignal(project.id,`critical ${i}`,{kind:'route.verified'})
    await Promise.resolve() // Deliberately unbatched delivery, not a best-case burst.
  }
  assert.deepEqual(checks,Array(10).fill(0))
  const revised=store.node(project.id,runs[0].stepId)
  store.updateStep(project.id,revised.id,{description:'Latest contract',mode:'amend',expectedVersion:revised.version})
  await Promise.resolve()
  assert.deepEqual(checks,[1,...Array(9).fill(0)])
  assert.equal(agents[0].inbox.nextStep.length,1)
  agents[0].inbox.remove(agents[0].inbox.nextStep[0].id)
  for(let i=0;i<10;i++) {
    const agent=agents[i]
    assert.equal(agent.inbox.nextStep.length,0)
    assert.equal(store.run(runs[i].id).deliveredGraphCursor,runs[i].deliveredGraphCursor)
    store.addFact(project.id,`New batch ${i}`,{})
    const update=graphUpdate(store,project.id,cursors[i]!,runs[i].stepId,runs[i].id)
    queueGraphNotice(agent,update,message)
    assert.equal(agent.inbox.nextStep.length,0)
    const minimal={...update,relevant:true,nodeIds:[],counts:{},after:100,cursor:101,evidenceSeq:0,criticalSeq:0,wake:false}
    queueGraphNotice(agent,minimal,message);assert.equal(agent.inbox.nextStep.length,1)
    agent.status='idle';const before=agent.wakes
    queueGraphNotice(agent,{...minimal,after:101,cursor:102,criticalSeq:2001,wake:true},message)
    assert.equal(agent.wakes,before+1);assert.equal(agent.inbox.nextStep.length,1)
    agent.status='running'
    const replace=agent.inbox.replace.bind(agent.inbox)
    agent.inbox.replace=()=>{agent.inbox.claim('next-step',3);agent.inbox.replace=replace;return false}
    queueGraphNotice(agent,{...minimal,after:102,cursor:103},message)
    assert.equal(JSON.parse(agent.inbox.nextStep[0].content[0].text.split('\n')[0].slice('[RedTrace FGS] '.length)).after,102)
    queueGraphNotice(agent,{...minimal,stopped:true},message);assert.equal(agent.inbox.nextStep.length,0)
  }
  assert.equal(store.project(project.id).acknowledgedCriticalSeq??0,0)
 } finally {for(const unlisten of unlisteners)unlisten();assert.equal(store.changes.eventNames().length,0);for(const handle of handles)await handle.dispose();await host.fiber.dispose();store.close()}
})
