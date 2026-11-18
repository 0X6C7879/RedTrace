import {domainFixtureRequest} from './domain-fixture.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, symlinkSync, rmSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Configuration } from '../src/config.ts'

const root = path.resolve(import.meta.dirname, '../../..'), work = mkdtempSync(path.join(os.tmpdir(), 'redtrace-reporter-native-'))
symlinkSync(root+'/static', work+'/static')
let child, api, projectId, findingId, target, logs = '', ended = false, requests = 0
const pending = new Set(), reportCalls = [], modelErrors = []
const output = message => {
  const text = typeof message.content === 'string' ? message.content : (message.content ?? []).filter(b => b.type === 'text').map(b => b.text).join('')
  return /^[\s]*[\[{]/.test(text) ? JSON.parse(text) : text
}
const victim = createServer((req, res) => {
  // Deliberately vulnerable loopback-only fixture; not a real target or secret.
  if (req.url === '/private?debug=1') { res.writeHead(200); res.end('FIXTURE_ONLY_NOT_A_SECRET\n') }
  else { res.writeHead(401); res.end('fixture login required\n') }
})
const model = createServer(async (req, res) => {
  pending.add(res); res.on('close', () => pending.delete(res))
  try {
    let raw = ''; for await (const bytes of req) raw += bytes
    const b = domainFixtureRequest(JSON.parse(raw),res), names = (b.tools ?? []).map(t => t.function.name), system = b.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
    const calls = b.messages.flatMap(m => m.tool_calls ?? []), toolOutputs = b.messages.filter(m => m.role === 'tool').map(m => ({ call: calls.find(c => c.id === m.tool_call_id), value: output(m) }))
    const graph = await (await fetch(api+'/v2/projects/'+projectId)).json()
    const reporter = system.includes('漏洞报告撰写 agent')
    let name, args
    if (!reporter) {
      assert.match(system, /You are WORKER/)
      const facts = graph.facts.filter(f => f.id !== 'origin')
      if (!calls.some(c => c.function.name === 'bash')) {
        name = 'bash'; args = { command: `curl -sS -i '${target}/private' > baseline.http; curl -sS -i '${target}/private?debug=1' > proof.http; cat baseline.http proof.http`, description: 'Verify authorized loopback-only fixture baseline and proof' }
      } else if (facts.length < 2) {
        const proof = facts.length === 1
        name = 'submit_fact'; args = { title: proof ? 'Debug bypass verified' : 'Baseline requires login', description: proof ? 'Loopback fixture debug request returned HTTP 200 and dummy marker without login' : 'Loopback fixture baseline returned HTTP 401', doc: proof ? 'Executed curl -sS -i '+target+'/private?debug=1; full response in proof.http. Fixture only.' : 'Executed curl -sS -i '+target+'/private; full response in baseline.http. Fixture only.', evidence: [{ path: proof ? 'proof.http' : 'baseline.http', description: proof ? 'Real loopback fixture proof response' : 'Real loopback fixture baseline response' }] }
      } else if (!graph.findings.length) {
        name = 'submit_finding'; args = { title: 'Local fixture debug authentication bypass', type: 'CWE-287', severity: 'low', description: 'Verified only in the intentionally vulnerable local fixture: debug query exposes a dummy marker without login', assetIds: [target+'/private'], factIds: facts.map(f => f.id) }
      } else { await fetch(api+'/v2/projects/'+projectId+'/findings/'+graph.findings[0].id+'/report',{method:'POST'}); name = 'finish_step'; args = { summary: 'Verified fixture; user explicitly requested the Worker report workflow' } }
    } else {
      for (const forbidden of ['bash','read','write','edit','submit_fact','submit_finding','legion_spawn','http_request']) assert.ok(!names.includes(forbidden), 'Reporter unexpectedly has '+forbidden)
      for (const section of ['## 摘要','## 内容']) assert.ok(system.includes(section))
      findingId = graph.findings[0].id
      const detail = toolOutputs.find(o => o.call?.function.name === 'read_graph')?.value
      const listed = toolOutputs.find(o => o.call?.function.name === 'read_execution' && !JSON.parse(o.call.function.arguments).run_id)?.value
      const trace = toolOutputs.find(o => o.call?.function.name === 'read_execution' && JSON.parse(o.call.function.arguments).run_id)?.value
      const artifacts = detail?.facts.flatMap(f => [f.doc, ...f.evidence].filter(e => e?.artifactId)) ?? []
      const read = toolOutputs.filter(o => o.call?.function.name === 'project_evidence_read')
      const remaining = artifacts.find(a => !read.some(o => o.value.id === a.artifactId))
      if (!detail) { name = 'read_graph'; args = { id: findingId, detail: 'doc' } }
      else if (!listed) { name = 'read_execution'; args = {} }
      else if (!trace) { name = 'read_execution'; args = { run_id: listed.runs.find(r => r.intent_id === detail.stepId).id } }
      else if (remaining) { name = 'project_evidence_read'; args = { artifact_id: remaining.artifactId } }
      else {
        const baseline = read.map(o => o.value.content).find(s => s.startsWith('HTTP/1.1 401')), proof = read.map(o => o.value.content).find(s => s.startsWith('HTTP/1.1 200'))
        assert.ok(baseline && proof); assert.match(proof, /FIXTURE_ONLY_NOT_A_SECRET/)
        assert.ok(trace.events.some(e => e.kind === 'tool.completed' && e.title === 'bash'))
        const report = `## 摘要\n本地故意脆弱测试夹具的 debug 参数绕过认证，仅用于回归。\n\n## 内容\n1. 执行 curl -sS -i '${target}/private'，实际返回 401。证据 ${artifacts[1].artifactId}。\n2. 执行 curl -sS -i '${target}/private?debug=1'，实际返回 200 和虚拟标记。证据 ${artifacts[3].artifactId}。\n原始基线响应：\n${baseline}\n原始利用响应：\n${proof}\nProducer Run: ${listed.runs.find(r => r.intent_id === detail.stepId).id}。\n`
        name = 'update_finding_report'; args = { finding_id: findingId, expectedVersion: detail.version, report }
      }
      reportCalls.push(name)
    }
    assert.ok(names.includes(name), 'Missing native tool '+name)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: '+JSON.stringify({ id: 'reporter-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-'+(++requests), type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } })+'\n\ndata: [DONE]\n\n')
  } catch (error) { modelErrors.push(String(error.stack)); res.writeHead(500); res.end(String(error)) }
})
try {
  await new Promise(r => victim.listen(0, '127.0.0.1', r)); target = 'http://127.0.0.1:'+victim.address().port
  await new Promise(r => model.listen(0, '127.0.0.1', r))
  const configuration = new Configuration(work); configuration.initialize(); configuration.commit(configuration.read().revision, raw => {
    raw.providers = { fixture: { api: 'openai-completions', base_url: 'http://127.0.0.1:'+model.address().port+'/v1', api_key: 'fixture-not-secret', models: [{ id: 'fixture', context_window: 100000, max_tokens: 4000, reasoning: 'off', reasoning_efforts: false }] } }
    raw.workers = [{ name: 'fixture-worker', roles: ['worker'], provider: 'fixture', model: 'fixture', max_running: 2 }]
    raw.runtime = { max_workers: 2, max_project_workers: 2, max_running_projects: 1 }
    raw.tasks = { soldier: { timeout: 30, conclude_timeout: 3 } }
  })
  const reservation = createServer(); await new Promise(r => reservation.listen(0, '127.0.0.1', r)); const port = reservation.address().port; await new Promise(r => reservation.close(r)); api = 'http://127.0.0.1:'+port
  child = spawn(process.execPath, [root+'/scripts/run-redtrace-node.mjs', '--root', work, '--host', '127.0.0.1', '--port', String(port)], { cwd: root, env: { ...process.env, DSH_HOME: work+'/.dsh', REDTRACE_DATA_ROOT: work+'/.redtrace', REDTRACE_SOURCE_ROOT: root }, stdio: ['ignore','pipe','pipe'] })
  child.once('close', () => { ended = true }); for (const stream of [child.stdout, child.stderr]) stream.on('data', b => { logs = (logs+b).slice(-100000) })
  const until = async (fn, ready) => { const deadline = Date.now()+45000; while (Date.now()<deadline) { if (ended || modelErrors.length) throw Error(logs+'\n'+modelErrors.join('\n')); const value = await fn(); if (ready(value)) return value; await delay(40) }; throw Error('Fixture timed out\n'+logs) }
  await until(async () => { try { return (await fetch(api+'/health')).ok } catch { return false } }, Boolean)
  const call = async (route, body) => { const response = await fetch(api+route, body ? { method: 'POST', headers: { 'Content-Type':'application/json' }, body: JSON.stringify(body) } : {}); const value = await response.json(); assert.ok(response.ok, JSON.stringify(value)); return value }
  const created = await call('/v2/projects', { mode: 'general', title: 'Fact / Finding / Reporter native fixture', origin: 'Authorized intentionally vulnerable loopback fixture only: '+target, goal: 'Verify retained baseline, proof and report', bootstrap: false }); projectId = created.project.id
  await call('/v2/projects/'+projectId+'/steps', { role: 'worker', taskKey: 'fixture', description: 'Verify local fixture auth baseline and debug bypass, then register supporting Facts and Finding', sourceIds: ['origin'] })
  const graph = await until(() => call('/v2/projects/'+projectId), g => g.findings[0]?.report && g.steps.every(s => s.status === 'done'))
  assert.equal(graph.facts.length, 3); assert.equal(graph.steps.length, 2); assert.ok(graph.steps.some(s => !!s.reportFindingId))
  const runs = await call('/v2/projects/'+projectId+'/runs'); assert.equal(runs.length, 2); assert.ok(runs.every(r => r.status === 'succeeded')); assert.notEqual(runs[0].id, runs[1].id)
  const report = await call('/v2/projects/'+projectId+'/evidence/'+graph.findings[0].report.artifactId)
  assert.equal(report.nextOffset, null); assert.match(report.content, /HTTP\/1.1 401/); assert.match(report.content, /HTTP\/1.1 200/); assert.match(report.content, /FIXTURE_ONLY_NOT_A_SECRET/)
  const titleGraph = await call('/v2/projects/'+projectId+'/graph'); assert.ok(titleGraph.facts.every(f => !('description' in f))); assert.ok(titleGraph.findings.every(f => !('details' in f) && !('report' in f)))
  assert.equal(titleGraph.nodes.filter(n => n.nodeType === 'fact' && n.folded).length, 2)
  for (const name of ['read_graph','read_execution','project_evidence_read','update_finding_report']) assert.ok(reportCalls.includes(name))
  assert.ok(readFileSync(work+'/.redtrace/engine.db').length > 0)
  if (process.argv.includes('--hold')) {
    console.log('UI_READY '+JSON.stringify({ api, work, projectId, findingId, reportArtifactId: graph.findings[0].report.artifactId }))
    if (process.env.REPORTER_FIXTURE_READY) writeFileSync(process.env.REPORTER_FIXTURE_READY, JSON.stringify({ api, work, projectId, findingId }))
    await new Promise(r => process.once('SIGTERM', r))
  }
  console.log('REPORTER_RUNTIME_OK=true; sessions=2; real_loopback_baseline=401; real_loopback_proof=200; facts=2; finding=1; original_audit_read=true; retained_evidence_read=true; body_sections=2; report_artifact_linked=true; raw_facts_preserved=true; model=local-protocol-fixture; live_model=false')
} catch (error) { console.error(logs); throw error }
finally {
  if (child && !ended) { child.kill('SIGTERM'); await new Promise(r => child.once('close', r)) }
  for (const response of pending) response.destroy()
  await Promise.all([new Promise(r => model.close(r)), new Promise(r => victim.close(r))])
  rmSync(work, { recursive: true, force: true })
}
