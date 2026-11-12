import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { ProjectEvidence } from '../src/project-evidence.ts'
import { Scheduler } from '../src/scheduler.ts'
import { graphTools } from '../src/runner.ts'
import { serveEngine } from '../src/index.ts'
import { legacyIntent } from '../src/legacy.ts'
import type { EngineConfig, Step, Fact } from '../src/types.ts'

function fixture(t: any) {
  const root = mkdtempSync(path.join(tmpdir(), 'redtrace-legion-'))
  const store = new Store(path.join(root, 'engine.db')), legion = new LegionStore(store)
  const project = store.createProject({ title: 'local fixture', origin: 'authorized local fixtures only', goal: 'prove fixture result' }).project
  mkdirSync(path.join(root, project.id))
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, legion, project, evidence: new ProjectEvidence(store, root) }
}
const mission = { role: 'general' as const, taskKey: 'challenge-a', description: 'fixture task', sourceIds: ['origin'] }
const worker = { name: 'fixture', backend: 'mock' as const, provider: 'mock', model: 'mock', enabled: true, reason: false, explore: true, bootstrap: true, maxRunning: 4, priority: 0 }
const config = (root: string): EngineConfig => ({ workers: [worker], providers: {}, maxWorkers: 4, maxProjectWorkers: 4, maxRunningProjects: 2, maxSteps: null, decideTimeout: 5, executeTimeout: 5, concludeTimeout: 1, bootstrapTimeout: 5, bootstrapConcludeTimeout: 1, workspaceRoot: root })

test('Campaign is a singleton control record, not a Project; acknowledgements cannot skip delivery', t => {
  const { store, legion, project } = fixture(t)
  const campaign = legion.campaign()
  assert.equal(legion.campaign().sessionId, campaign.sessionId)
  assert.equal(store.projects().length, 1)
  legion.claimCommand(); assert.throws(() => legion.claimCommand(), /not idle/)
  assert.throws(() => legion.readChanges(project.id, 100), /undelivered/)
  const first = legion.readChanges(project.id, undefined, 1)
  assert.throws(() => legion.finishCommand({ [project.id]: first.cursor + 1 }, 'state'), /exceeds/)
  assert.equal(legion.campaign().status, 'running')
  legion.finishCommand({ [project.id]: first.cursor }, 'allocation checkpoint')
  assert.equal(legion.campaign().cursors[project.id].acknowledged, first.cursor)
  assert.equal(legion.campaign().state, 'allocation checkpoint')
})

test('role metadata persists; General may create exactly two same-task squads in its delegated Goal', t => {
  const { store, legion, project } = fixture(t)
  const goal = store.addGoal(project.id, 'delegated goal')
  const parent = legion.spawn(project.id, { ...mission, goalId: goal.id })
  const run = store.claim(project.id, 'execute', worker, parent.id)
  const chore = { ...mission, parentRunId: run.id, role: 'scout' as const }
  assert.equal(legion.spawn(project.id, chore).parentStepId, parent.id)
  assert.throws(() => legion.spawn(project.id, { ...chore, taskKey: 'other' }), /same-task/)
  assert.throws(() => legion.spawn(project.id, { ...chore, goalId: 'goal' }), /escapes/)
  assert.throws(() => legion.spawn(project.id, { ...chore, role: 'general' }), /same-task/)
  const second = legion.spawn(project.id, { ...chore, role: 'soldier' })
  assert.equal(second.role, 'soldier')
  assert.throws(() => legion.spawn(project.id, chore), /two active squads/)
  assert.throws(() => store.addStep(project.id, { ...mission, role: 'invalid' as any }), /Invalid Legion role/)
  assert.throws(() => store.addStep(project.id, { ...mission, taskKey: '' }), /taskKey/)
})

test('Park survives Run completion, prevents claim/spawn, and requires confirmed stop for reactivation', t => {
  const { store, legion, project } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  legion.park(project.id, mission.taskKey, 'blocked', 'new evidence')
  assert.equal(legacyIntent(store.node(project.id, step.id)).state, 'parked')
  assert.throws(() => legion.reactivate(project.id, mission.taskKey, 'new evidence'), /Confirm old/)
  assert.throws(() => legion.spawn(project.id, mission), /parked/)
  assert.throws(() => store.claim(project.id, 'execute', worker, step.id), /not claimable/)
  store.finishRun(run.id, 'cancelled')
  assert.equal(store.node<Step>(project.id, step.id).status, 'parked')
  legion.reactivate(project.id, mission.taskKey, 'confirmed alternative')
  assert.equal(store.node<Step>(project.id, step.id).status, 'pending')
})

test('Scheduler wake does not claim a parked Step', async t => {
  const { store, legion, project, root } = fixture(t)
  const step = legion.spawn(project.id, mission)
  legion.park(project.id, mission.taskKey, 'blocked', 'new evidence')
  const scheduler = new Scheduler(store, config(root), async () => { assert.fail('Parked Step was dispatched') })
  scheduler.start(); scheduler.wake(); scheduler.wake()
  await new Promise(resolve => setTimeout(resolve, 20))
  await scheduler.close()
  assert.equal(store.runs(project.id).length, 0)
  assert.equal(store.node<Step>(project.id, step.id).status, 'parked')
})

test('handoff waits for old execution and creates a new Run on the same Step; resume is not handoff', t => {
  const { store, legion, project } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  legion.requestHandoff(run.id, 'confirmed state and next action')
  assert.throws(() => legion.completeHandoff(project.id, step.id), /not confirmed stopped/)
  store.finishRun(run.id, 'cancelled')
  legion.completeHandoff(project.id, step.id)
  const next = store.claim(project.id, 'execute', worker, step.id)
  assert.notEqual(next.id, run.id)
  assert.equal(next.predecessorRunId, run.id)
  assert.equal(next.handoff, 'confirmed state and next action')
  assert.equal(store.run(run.id).status, 'cancelled')
})

test('unknown or pending tool results prevent automatic handoff/reactivation', t => {
  const { store, legion, project } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  run.pendingTools = ['unconfirmed-call']; store.saveRun(run)
  assert.throws(() => legion.requestHandoff(run.id, 'summary'), /Unconfirmed/)
  run.pendingTools = []; store.saveRun(run)
  legion.requestHandoff(run.id, 'summary')
  store.finishRun(run.id, 'unknown', 'uncertain')
  assert.throws(() => legion.completeHandoff(project.id, step.id), /not confirmed stopped/)
  assert.throws(() => legion.reactivate(project.id, mission.taskKey, 'hint'), /Confirm old/)
})

test('HELP/REPORT remain durable messages, not confirmed Facts; foreign and closed actors are rejected', t => {
  const { store, legion, project } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  const before = store.graph(project.id).facts.length
  legion.message(project.id, run.id, 'commander', 'HELP', 'need tactical decision')
  assert.equal(legion.messages(project.id, 'commander').length, 1)
  assert.equal(store.graph(project.id).facts.length, before)
  const other = store.createProject({ title: 'other', origin: 'fixture', goal: 'fixture' }).project
  assert.throws(() => legion.message(other.id, 'commander', run.id, 'REPORT', 'foreign'), /another Project/)
  store.finishRun(run.id, 'cancelled')
  assert.throws(() => legion.message(project.id, 'commander', run.id, 'MESSAGE', 'stopped'), /stopped/)
})

test('project evidence is readable with unchanged hash after producer Run/audit deletion', t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  const filename = path.join(root, project.id, 'proof.txt'); writeFileSync(filename, 'fixture proof')
  const artifact = evidence.promoteFile(project.id, { path: 'proof.txt', runId: run.id, toolCallId: 'call-1', description: 'observed proof' })
  const fact = store.addFact(project.id, 'verified fixture', { runId: run.id, evidence: [{ artifactId: artifact.id, description: 'fixture proof' }] })
  store.finishRun(run.id, 'succeeded')
  store.db.prepare('DELETE FROM runs WHERE id=?').run(run.id)
  store.db.prepare('DELETE FROM audit_runs WHERE id=?').run(run.id)
  rmSync(filename)
  assert.equal(evidence.read(project.id, artifact.id).content, 'fixture proof')
  assert.equal(evidence.read(project.id, artifact.id).sha256, artifact.sha256)
  assert.equal(store.node<Fact>(project.id, fact.id).evidence[0].artifactId, artifact.id)
  const other = store.createProject({ title: 'other', origin: 'fixture', goal: 'fixture' }).project
  assert.throws(() => evidence.read(other.id, artifact.id), /not found/)
})

test('project evidence bounds reads, detects tampering, and rejects filesystem/credential escapes', t => {
  const { project, root, evidence } = fixture(t)
  const artifact = evidence.publish(project.id, Buffer.from('0123456789'), { description: 'proof' })
  assert.deepEqual(evidence.read(project.id, artifact.id, 2, 3), { id: artifact.id, sha256: artifact.sha256, offset: 2, bytes: 3, totalBytes: 10, nextOffset: 5, content: '234' })
  assert.throws(() => evidence.read(project.id, artifact.id, 11), /outside/)
  assert.throws(() => evidence.read(project.id, artifact.id, 0, 7601), /exceeds/)
  writeFileSync(path.join(root, project.id, '.env'), 'private')
  assert.throws(() => evidence.promoteFile(project.id, { path: '.env', description: 'forbidden' }), /Private/)
  writeFileSync(path.join(root, 'foreign.txt'), 'foreign')
  symlinkSync(path.join(root, 'foreign.txt'), path.join(root, project.id, 'escape.txt'))
  assert.throws(() => evidence.promoteFile(project.id, { path: 'escape.txt', description: 'forbidden' }), /escapes/)
  writeFileSync(path.join(root, project.id, artifact.path), 'tampered')
  assert.throws(() => evidence.read(project.id, artifact.id), /hash mismatch/)
})

test('project evidence directory symlink cannot publish outside Project', t => {
  const { project, root, evidence } = fixture(t)
  const outside = path.join(root, 'outside'); mkdirSync(outside)
  symlinkSync(outside, path.join(root, project.id, '.redtrace-output'))
  assert.throws(() => evidence.publish(project.id, Buffer.from('proof'), { description: 'proof' }), /escapes/)
})

test('native project_evidence_read reads published evidence without producer lookup', async t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  const artifact = evidence.publish(project.id, Buffer.from('native proof'), { description: 'proof' })
  const tools = graphTools({ store, run, worker, config: config(root), signal: new AbortController().signal }, () => {})
  const tool = tools.find(t => t.name === 'project_evidence_read')!
  const result = await tool.execute('read', { artifact_id: artifact.id })
  assert.equal((result.details as any).content, 'native proof')
})


test('evidence promotion is repeatable and reports missing sources without inventing proof', t => {
  const { store, project, root, evidence } = fixture(t)
  writeFileSync(path.join(root, project.id, 'proof.txt'), 'retained proof')
  const good = store.addFact(project.id, 'retained finding', { evidence: [{ path: 'proof.txt', description: 'real file' }] })
  const missing = store.addFact(project.id, 'unreadable legacy reference', { evidence: [{ path: 'missing.txt', description: 'missing file' }] })
  const first = evidence.promoteFacts(project.id)
  assert.equal(first.factsReady, false)
  assert.equal(first.unresolved.length, 1)
  assert.equal(first.unresolved[0].factId, missing.id)
  const preserved = store.node<Fact>(project.id, good.id)
  const artifactId = preserved.evidence[0].artifactId!
  rmSync(path.join(root, project.id, 'proof.txt'))
  const second = evidence.promoteFacts(project.id)
  assert.equal(second.unresolved.length, 1)
  assert.equal(store.node<Fact>(project.id, good.id).version, preserved.version)
  assert.equal(evidence.read(project.id, artifactId).content, 'retained proof')
})

test('explicit tool result and referenced spill bytes survive promotion independently of Run audit', t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  const bytes = Buffer.from('full raw tool output')
  const hash = createHash('sha256').update(bytes).digest('hex')
  const id = 'ev-' + hash, directory = path.join(root, project.id, '.redtrace-output', 'evidence', run.id)
  mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, id + '.json'), bytes)
  store.runEvent(run.id, 'tool_execution_end', { toolName: 'fixture', toolCallId: 'call-proof', result: { content: [{ type: 'text', text: id }] } })
  const fact = store.addFact(project.id, 'verified output', { runId: run.id, evidence: [{ runId: run.id, toolCallId: 'call-proof', description: 'actual tool result' }] })
  const promoted = evidence.promoteFacts(project.id)
  assert.equal(promoted.factsReady, true)
  const artifactId = store.node<Fact>(project.id, fact.id).evidence[0].artifactId!
  const manifest = JSON.parse(evidence.read(project.id, artifactId).content)
  assert.equal(manifest.attachments[0].id, id)
  store.finishRun(run.id, 'succeeded')
  store.db.prepare('DELETE FROM runs WHERE id=?').run(run.id)
  store.db.prepare('DELETE FROM audit_runs WHERE id=?').run(run.id)
  rmSync(directory, { recursive: true })
  assert.equal(evidence.read(project.id, manifest.attachments[0].artifactId).content, 'full raw tool output')
})

test('Campaign cursor, STATE and pending messages survive Store reopen', t => {
  const { store, legion, project, root } = fixture(t)
  legion.claimCommand()
  const page = legion.readChanges(project.id)
  legion.finishCommand({ [project.id]: page.cursor }, 'durable state')
  const sessionId = legion.campaign().sessionId
  legion.message(project.id, 'commander', 'commander', 'REPORT', 'durable report')
  const reopened = new Store(path.join(root, 'engine.db'))
  try {
    const restored = new LegionStore(reopened)
    assert.equal(restored.campaign().sessionId, sessionId)
    assert.equal(restored.campaign().state, 'durable state')
    assert.equal(restored.campaign().cursors[project.id].acknowledged, page.cursor)
    assert.equal(restored.messages(project.id, 'commander')[0].content, 'durable report')
  } finally { reopened.close() }
})


test('HTTP Step schema persists roles and Project artifact endpoint enforces bounded scoped reads', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'redtrace-legion-http-'))
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  t.after(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }) })
  const address = engine.server.address() as import('node:net').AddressInfo
  const base = 'http://127.0.0.1:' + address.port
  const created = await fetch(base + '/v2/projects', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'fixture', origin: 'local fixture', goal: 'proof' }) })
  assert.equal(created.status, 201)
  const project = (await created.json()).project
  const stepResponse = await fetch(base + '/v2/projects/' + project.id + '/steps', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(mission) })
  assert.equal(stepResponse.status, 201)
  assert.equal((await stepResponse.json()).role, 'general')
  mkdirSync(path.join(engine.configuration.workspaceRoot, project.id), { recursive: true })
  const artifact = engine.evidence.publish(project.id, Buffer.from('http proof'), { description: 'fixture' })
  const response = await fetch(base + '/v2/projects/' + project.id + '/evidence/' + artifact.id + '?length=4')
  assert.equal(response.status, 200)
  assert.equal((await response.json()).content, 'http')
  const bad = await fetch(base + '/v2/projects/' + project.id + '/evidence/' + artifact.id + '?length=7601')
  assert.equal(bad.status, 422)
  const missing = await fetch(base + '/v2/projects/missing/evidence/' + artifact.id)
  assert.equal(missing.status, 404)
})
