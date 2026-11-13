import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { graphTools } from '../src/runner.ts'
import { graphContent, foldedFactIds } from '../src/graph-content.ts'
import { ProjectEvidence } from '../src/project-evidence.ts'
import { createPlanGuard } from '../src/plan-guard.ts'
import { legionMission } from '../src/legion-missions.ts'
import type { EngineConfig, Fact, Finding, Step } from '../src/types.ts'
import { serveEngine } from '../src/index.ts'
import vm from 'node:vm'
import { isUtf8 } from 'node:buffer'

const worker = { name: 'fixture', provider: 'mock', model: 'fixture', enabled: true, maxRunning: 4, priority: 0, backend: 'mock' as const, roles: ['soldier' as const] }
function fixture(t: test.TestContext) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-fact-layers-')), store = new Store(':memory:')
  const project = store.createProject({ title: 'fixture', origin: 'Authorized local fixture only', goal: 'Verify fixture' }).project
  mkdirSync(path.join(root, project.id))
  const config = { workspaceRoot: root, maxSteps: null } as EngineConfig
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const activate = (step: Step) => {
    const run = store.claim(project.id, 'execute', worker, step.id)
    let finished = false
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal }, () => { finished = true })
    return { run, tools, finished: () => finished, call: async (name: string, args: unknown) => (await tools.find(t => t.name === name)!.execute('fixture', args)).details as any }
  }
  return { root, store, project, config, activate }
}

test('Fact stores title/summary plus immutable external doc, file bytes and producer provenance', async t => {
  const { root, store, project, activate } = fixture(t)
  const { run, call } = activate(store.addStep(project.id, { description: 'verify', sourceIds: ['origin'] }))
  writeFileSync(path.join(root, project.id, 'proof.txt'), 'literal fixture proof\n')
  store.runEvent(run.id, 'tool_execution_end', { toolName: 'bash', toolCallId: 'proof-call', result: { stdout: 'literal fixture proof\n' } })
  const fact: Fact = await call('submit_fact', { title: 'Proof verified', description: 'A literal fixture proof was read', doc: '# Execution\ncat proof.txt\n\nOutput: literal fixture proof', evidence: [{ description: 'Saved output', path: 'proof.txt', toolCallId: 'proof-call' }] })
  assert.equal(fact.title, 'Proof verified'); assert.ok(fact.doc?.artifactId); assert.ok(fact.evidence[0].artifactId)
  assert.equal(fact.evidence[0].runId, run.id); assert.equal(fact.evidence[0].toolCallId, 'proof-call')
  const index = await call('read_graph', {})
  const indexed = index.facts.find((f: any) => f.id === fact.id)
  for (const key of ['description', 'doc', 'evidence']) assert.equal(indexed[key], undefined)
  const summary = await call('read_graph', { id: fact.id })
  assert.equal(summary.description, fact.description); assert.equal(summary.doc, undefined)
  const doc = await call('read_graph', { id: fact.id, detail: 'doc' })
  rmSync(path.join(root, project.id, 'proof.txt'))
  assert.match((await call('project_evidence_read', { artifact_id: doc.doc.artifactId })).content, /cat proof.txt/)
  assert.equal((await call('project_evidence_read', { artifact_id: doc.evidence[0].artifactId })).content, 'literal fixture proof\n')
  assert.match(JSON.stringify(await call('read_execution', { run_id: run.id })), /proof-call.*literal fixture proof/)
  const delta = await call('read_graph_delta', { after: 0 })
  assert.equal(delta.nodes.find((n: any) => n.id === fact.id).description, undefined)
  assert.equal(new ProjectEvidence(store, root).promoteFacts(project.id).factsReady, true)
})

test('many-to-many Finding folding preserves raw Facts, active dependencies and SQL pagination', async t => {
  const { store, project, activate } = fixture(t), id = project.id
  const a = store.addFact(id, 'Summary A', { title: 'Title A' }), b = store.addFact(id, 'Summary B', { title: 'Title B' })
  const finding = store.addFinding(id, { title: 'Combined', description: 'Two proven facts', factIds: [a.id, b.id], details: { historical: 'untouched' } })
  store.addFinding(id, { title: 'Shared support', description: 'Same fact reused', factIds: [a.id] })
  const dependency = store.addStep(id, { description: 'Independent use of A', sourceIds: [a.id] })
  const { call } = activate(dependency)
  assert.deepEqual([...foldedFactIds(store.graph(id))], [b.id])
  const index = await call('read_graph', { kinds: ['fact'], offset: 1, limit: 1 })
  assert.deepEqual(index.facts.map((f: any) => f.id), [a.id]); assert.equal(index.nextOffsets.fact, null)
  const summary = await call('read_graph', { id: finding.id })
  assert.deepEqual(summary.facts.map((f: any) => f.description), ['Summary A', 'Summary B'])
  assert.equal(summary.details, undefined); assert.ok(summary.facts.every((f: any) => !('evidence' in f)))
  assert.equal(store.node<Fact>(id, b.id).description, 'Summary B')
  assert.deepEqual(store.node<Finding>(id, finding.id).details, { historical: 'untouched' })
  store.updateStep(id, dependency.id, { status: 'cancelled' })
  assert.equal(graphContent(store.graph(id)).facts.length, 1, 'only Scope remains unfolded')
  assert.equal(store.graph(id).facts.length, 3)
})

test('structured Finding auto-registers one independent Reporter, saves/updates a report Artifact and never produces Facts', async t => {
  const { root, store, project, activate } = fixture(t), id = project.id
  const a = store.addFact(id, 'Local fixture returned literal proof', { title: 'Fixture proof', evidence: [{ description: 'fixture stdout, not live vulnerability proof' }] })
  const finding = store.addFinding(id, { title: 'Fixture vulnerability', description: 'Verified deterministic fixture only', type: 'fixture', severity: 'low', assetIds: ['fixture-target'], factIds: [a.id] })
  const step = store.nodes<Step>(id, ['step'])[0]
  assert.equal(step.role, 'reporter'); assert.deepEqual(step.sourceIds, [finding.id])
  assert.equal(store.requestFindingReport(id, finding.id).id, step.id)
  // Reporting is post-verification work: Goal acceptance must not cancel its pending Session.
  store.updateGoal(id, 'goal', { status: 'achieved', evidenceIds: [finding.id] })
  const { run, call, tools, finished } = activate(store.node<Step>(id, step.id))
  assert.equal(store.project(id).status, 'completed')
  assert.equal(createPlanGuard(store, run.id).check({ name: 'read_graph', rootCallId: 'read' }), undefined)
  for (const name of ['submit_fact', 'submit_finding', 'finish_step', 'bash', 'legion_spawn', 'http_request']) assert.ok(!tools.some(t => t.name === name))
  const detail = await call('read_graph', { id: finding.id, detail: 'doc' })
  assert.equal(detail.facts[0].evidence[0].description, a.evidence[0].description)
  const headers = ['概述','影响与危害','受影响范围','复现步骤','证据','PoC','根因分析','修复建议']
  const report = headers.map(h => '## '+h+'\n'+(h === '证据' ? 'Fixture stdout: literal proof (not live target proof)' : '未提供；仅为确定性测试夹具')).join('\n\n')
  const conflict = await call('update_finding_report', { finding_id: finding.id, expectedVersion: 999, report })
  assert.equal(conflict.ok, false); assert.match(conflict.error, /version conflict/); assert.equal(finished(), false)
  await call('update_finding_report', { finding_id: finding.id, expectedVersion: detail.version, report })
  assert.equal(finished(), true); assert.equal(store.finishRun(run.id, 'succeeded').status, 'succeeded')
  const saved = store.node<Finding>(id, finding.id), artifact = new ProjectEvidence(store, root).read(id, saved.report!.artifactId!)
  assert.equal(artifact.content, report); assert.equal(store.nodeCount(id, 'fact'), 2)
  assert.equal(graphContent(store.graph(id)).findings[0].report, undefined)
  const fresh = store.requestFindingReport(id, finding.id)
  assert.notEqual(fresh.id, step.id)
  const updating = activate(fresh), latest = await updating.call('read_graph', { id: finding.id })
  await updating.call('update_finding_report', { finding_id: finding.id, expectedVersion: latest.version, report: report+'\n\n已核对同一原始证据。' })
  store.finishRun(updating.run.id, 'succeeded')
  assert.notEqual(store.node<Finding>(id, finding.id).report!.artifactId, saved.report!.artifactId)
  assert.equal(new ProjectEvidence(store, root).read(id, saved.report!.artifactId!).content, report, 'prior report bytes remain immutable')
  const incomplete = activate(store.requestFindingReport(id, finding.id))
  assert.equal(store.finishRun(incomplete.run.id, 'succeeded').status, 'failed', 'a previous report is not proof this regeneration saved a report')
})

test('legacy migration is once-only, preserves descriptions/details/factIds and never invents reports', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-title-upgrade-')), db = path.join(root, 'old.db')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let store = new Store(db)
  const id = store.createProject({ title: 'legacy', origin: 'Original scope', goal: 'verify' }).project.id
  const description = '历史事实第一句。完整原始描述\n更多细节与证据绝不覆盖。'
  const fact = store.addFact(id, description), finding = store.addFinding(id, { title: 'Legacy finding', description: 'Original finding summary', factIds: [fact.id], details: { untouched: ['original detail'] } })
  store.db.prepare("UPDATE nodes SET data=json_remove(data,'$.title') WHERE kind='fact'").run()
  store.db.prepare("DELETE FROM metadata WHERE key='fact-titles'").run(); store.close()
  store = new Store(db)
  try {
    assert.equal(store.node<Fact>(id, fact.id).title, '历史事实第一句')
    assert.equal(store.node<Fact>(id, fact.id).description, description)
    assert.deepEqual(store.node(id, finding.id), finding)
    assert.equal(store.nodes<Step>(id, ['step']).length, 0)
    assert.equal(store.node<Finding>(id, finding.id).report, undefined)
    assert.throws(() => store.requestFindingReport(id, finding.id), /Legacy Finding/)
  } finally { store.close() }
})

test('Reporter rejects incomplete completion; retained Doc corruption is visible', async t => {
  const { root, store, project, activate } = fixture(t), id = project.id
  const file = new ProjectEvidence(store, root).publish(id, Buffer.from('original doc'), { description: 'immutable doc' })
  const fact = store.addFact(id, 'Proof', { doc: { artifactId: file.id, description: 'doc' } })
  const finding = store.addFinding(id, { title: 'Fixture', description: 'Fixture', type: 'fixture', severity: 'low', factIds: [fact.id] })
  const { run } = activate(store.nodes<Step>(id, ['step'])[0])
  assert.equal(store.finishRun(run.id, 'succeeded').status, 'failed')
  writeFileSync(path.join(root, id, file.path), 'corrupt')
  const result = new ProjectEvidence(store, root).promoteFacts(id)
  assert.equal(result.factsReady, false); assert.match(result.unresolved[0].reason, /Doc.*hash mismatch/)
  assert.equal(store.node<Finding>(id, finding.id).report, undefined)
})

test('Fact Doc and Reporter evidence retain existing cross-Graph boundaries', async t => {
  const { root, store, config } = fixture(t)
  const p = store.createProject({ mode: 'benchmark', title: 'isolated fixtures', origin: 'local only', goal: 'verify' }).project
  mkdirSync(path.join(root, p.id))
  const a = store.createGraph(p.id, { taskKey: 'a', title: 'a', origin: 'a', goal: 'a' }), b = store.createGraph(p.id, { taskKey: 'b', title: 'b', origin: 'b', goal: 'b' })
  const left = store.forGraph(p.id, a.id), right = store.forGraph(p.id, b.id)
  const file = new ProjectEvidence(left, root).publish(p.id, Buffer.from('private graph A proof'), { description: 'A proof' })
  assert.throws(() => right.addFact(p.id, 'B', { doc: { artifactId: file.id, description: 'A doc' } }), /Cross-Graph artifact/)
  const fact = right.addFact(p.id, 'B proof'), finding = right.addFinding(p.id, { title: 'B finding', description: 'B fixture', type: 'fixture', severity: 'low', factIds: [fact.id] })
  const step = right.nodes<Step>(p.id, ['step'])[0], run = right.claim(p.id, 'execute', worker, step.id)
  const tools = graphTools({ store: right, run, worker, config, signal: new AbortController().signal }, () => {})
  await assert.rejects(tools.find(t => t.name === 'project_evidence_read')!.execute('foreign', { artifact_id: file.id }), /not in this Graph/)
  assert.equal(right.node<Finding>(p.id, finding.id).report, undefined)
})

test('runtime prompt preserves ARTEX report sections and adapts only the data interfaces', () => {
  const original = readFileSync(new URL('../prompts/upstream/artex-reporter.md', import.meta.url), 'utf8'), runtime = legionMission('reporter')
  for (const heading of ['## 概述','## 影响与危害','## 受影响范围','## 复现步骤','## 证据','## PoC','## 根因分析','## 修复建议','### 步骤 1：准备环境']) assert.ok(original.includes(heading) && runtime.includes(heading))
  assert.ok(runtime.includes(original.slice(original.indexOf('━━ 纪律'), original.lastIndexOf('\n'))))
  assert.match(runtime, /project_evidence_read/); assert.match(runtime, /read_execution/); assert.match(runtime, /expectedVersion/)
  assert.match(legionMission('soldier'), /latest incremental fact/)
  const markup = readFileSync(new URL('../../../static/index.html', import.meta.url), 'utf8')
  assert.ok(markup.includes('<p class="mt-1 text-slate-600 whitespace-pre-wrap break-words" x-text="fact.description">'))
  assert.ok(markup.includes("reporter: 'Reporter'"))
})

test('REST accepts Markdown Doc before any Run, keeps legacy clients and exposes only titles by default', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-layers-api-')), engine = await serveEngine({ root, port: 0, autoStart: false })
  const base = 'http://127.0.0.1:'+(engine.server.address() as any).port
  const call = async (route: string, body?: unknown) => {
    const response = await fetch(base+route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {})
    const value = await response.json() as any; assert.ok(response.ok, JSON.stringify(value)); return value
  }
  try {
    const created = await call('/v2/projects', { mode: 'general', title: 'REST fixture', origin: 'authorized fixture only', goal: 'verify' }), prefix = '/v2/projects/'+created.project.id
    const fact = await call(prefix+'/facts', { title: 'Verified response', description: 'Original summary', doc: '# Real fixture execution\nLiteral stdout: proof', evidence: [{ description: 'fixture stdout: proof' }] })
    assert.ok(fact.doc.artifactId)
    const legacy = await call(prefix+'/facts', { description: 'Historical client summary。Unchanged body', evidence: [] })
    assert.equal(legacy.title, 'Historical client summary'); assert.equal(legacy.description, 'Historical client summary。Unchanged body')
    const finding = await call(prefix+'/findings', { title: 'Legacy finding', description: 'Original description', factIds: [fact.id], details: { body: 'original detail' } })
    const graph = await call(prefix+'/graph')
    assert.ok(graph.facts.every((f: any) => !('description' in f) && !('doc' in f)))
    assert.ok(!('description' in graph.findings[0])); assert.equal(graph.nodes.find((n: any) => n.id === fact.id).folded, true)
    const summary = await call(prefix+'/nodes/'+finding.id)
    assert.equal(summary.facts[0].description, 'Original summary'); assert.equal(summary.facts[0].evidence, undefined)
    const doc = await call(prefix+'/nodes/'+fact.id+'?detail=doc')
    assert.match((await call(prefix+'/evidence/'+doc.doc.artifactId)).content, /Literal stdout: proof/)
    assert.equal(engine.store.nodes<Step>(created.project.id, ['step']).length, 0)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})

test('FGS canvas folds supporting Facts, expands referenced Fact and preserves split UTF-8 Artifact pages', async () => {
  const context = { window: {} as any, TextDecoder, TextEncoder, atob }
  vm.runInNewContext(readFileSync(new URL('../../../static/fgs-view.js', import.meta.url), 'utf8'), context)
  const app = context.window.redtraceFgsView
  app.fgs = { nodes: [{ id: 'f001', nodeType: 'fact', label: 'hidden support', folded: true }, { id: 'f002', nodeType: 'fact', label: 'independent active dependency' }, { id: 'finding_001', nodeType: 'finding', label: 'Combined', factCount: 2 }], edges: [] }
  app.factDisplayId = (id: string) => id
  assert.deepEqual(Array.from(app.fgsBuildElements().nodes, (n: any) => n.data.id), ['f002', 'finding_001'])
  app.fgsShownFacts.push('f001')
  assert.equal(app.fgsBuildElements().nodes.length, 3)
  const text = '证据与复现\n'.repeat(2000), bytes = Buffer.from(text), parts = []
  for (let offset = 0; offset < bytes.length; offset += 7600) { const chunk = bytes.subarray(offset, offset+7600); parts.push({ content: chunk.toString(isUtf8(chunk) ? 'utf8' : 'base64'), ...(isUtf8(chunk) ? {} : { encoding: 'base64' }) }) }
  app.fgsArtifactPreview = { parts }; assert.equal(app.fgsArtifactText(), text)
  let resolve!: (value: unknown) => void
  app.fgsShownFacts = []; app.selectedProjectId = 'A'; app.selectedGraphId = 'graph-A'; app.replay = { active: false }; app.updateGraph = () => {}
  app.api = () => new Promise(r => { resolve = r })
  const pending = app.selectNativeFgsNode('fact', 'f001')
  app.selectedProjectId = 'B'; app.selectedGraphId = 'graph-B'
  resolve({ id: 'f001', description: 'A private summary' }); await pending
  assert.equal(app.fgsNodeDetail, null, 'late A response must not appear in B')
})
