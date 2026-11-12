import { createHash } from 'node:crypto'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs'
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


function sessionServices(root: string, projectId: string, entries: { id: string; events: unknown[]; cwd?: string }[] = [], objects = new Map<string, Uint8Array>()) {
  const closed: string[] = []
  const read = (ref: any) => { const bytes = objects.get(ref.attachmentId); if (!bytes) throw new Error('Attachment object is missing'); return bytes }
  return { closed, objects, entries, sessionPersistence: {
    async list() { return entries.map(entry => ({ header: { id: entry.id, cwd: entry.cwd ?? path.join(root, projectId) }, revision: 'fixture-1' })) },
    async stat() { return { revision: 'fixture-1' } },
    async open(id: string, access: 'read') { assert.equal(access, 'read'); return { async read() { return { events: entries.find(entry => entry.id === id)!.events } }, async close() { closed.push(id) } } },
  }, attachments: { async readImage(ref: any) { return { data: read(ref) } }, async *readFileStream(ref: any) { yield read(ref) } } }
}
function attachment(bytes: string, image = false) {
  const data = Buffer.from(bytes), attachmentId = 'sha256:' + createHash('sha256').update(data).digest('hex')
  return { data, ref: { attachmentId, bytes: data.length, name: 'fixture.bin', ...(image ? { mediaType: 'image/png', width: 1, height: 1 } : {}) } }
}

test('reset preflight retains nested Finding files, tools and Session attachments after fixture deletion', async t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  writeFileSync(path.join(root, project.id, 'proof.txt'), 'finding proof')
  const fact = store.addFact(project.id, 'proof', { runId: run.id, evidence: [{ path: 'proof.txt', runId: run.id, description: 'fact file' }] })
  store.runEvent(run.id, 'tool_execution_end', { toolName: 'fixture', toolCallId: 'finding-call', result: { content: [{ type: 'text', text: 'tool proof' }] } })
  const file = attachment('session file'), image = attachment('image bytes', true)
  const finding = store.addFinding(project.id, { title: 'result', description: 'retained', factIds: [fact.id], runId: run.id, details: { nested: [{ path: 'proof.txt' }, { runId: run.id, toolCallId: 'finding-call' }], image: image.ref, text: 'unchanged result' } })
  const services = sessionServices(root, project.id, [{ id: run.id, events: [{ content: [{ type: 'file', attachment: file.ref }, { type: 'image', attachment: image.ref }] }] }], new Map([[file.ref.attachmentId, file.data], [image.ref.attachmentId, image.data]]))
  store.finishRun(run.id, 'succeeded'); store.setStatus(project.id, 'stopped')
  const report = await evidence.preflightReset(project.id, services)
  assert.equal(report.dataReady, true, JSON.stringify(report.blockers)); assert.equal(report.cleanupAllowed, false)
  assert.equal(report.preservation.references.length, 5)
  assert.deepEqual(services.closed, [run.id])
  const details = store.node<any>(project.id, finding.id).details
  assert.equal(details.text, 'unchanged result'); assert.equal(details.nested[0].path, undefined)
  const refs = evidence.retainedReferences(project.id), hashes = refs.map(ref => evidence.read(project.id, ref.artifactId).sha256)
  // Destructive operations exist ONLY in this temporary fixture, not in the preflight implementation.
  store.transaction(() => {
    for (const item of report.detachments) store.saveNode(item.after)
    store.db.prepare('DELETE FROM runs WHERE project_id=?').run(project.id)
    store.db.prepare('DELETE FROM audit_runs WHERE project_id=?').run(project.id)
    store.db.prepare("DELETE FROM nodes WHERE project_id=? AND kind='step'").run(project.id)
  })
  services.entries.splice(0); services.objects.clear(); rmSync(path.join(root, project.id, 'proof.txt'))
  assert.deepEqual(refs.map(ref => evidence.read(project.id, ref.artifactId).sha256), hashes)
  assert.equal((await evidence.preflightReset(project.id, services)).dataReady, true)
  for (const node of store.nodes<any>(project.id, ['fact', 'finding', 'hint', 'observation'])) {
    assert.equal(node.stepId, null); assert.equal(node.producerStepIds?.length ?? 0, 0)
  }
  assert.ok(store.node(project.id, finding.id)); assert.ok(store.node(project.id, 'goal'))
  const reopened = new Store(path.join(root, 'engine.db'))
  try { assert.deepEqual(new ProjectEvidence(reopened, root).retainedReferences(project.id), evidence.retainedReferences(project.id)) }
  finally { reopened.close() }
})

test('preflight reports running, paused, unknown and pending tools without stopping or deleting anything', async t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const services = sessionServices(root, project.id)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  for (const status of ['running', 'paused', 'unknown', 'succeeded'] as const) {
    run.status = status; run.pendingTools = status === 'succeeded' ? ['uncertain'] : []; store.saveRun(run)
    const report = await evidence.preflightReset(project.id, services)
    assert.equal(report.dataReady, false); assert.ok(report.blockers.some(b => b.owner === run.id))
    assert.equal(store.run(run.id).status, status); assert.equal(store.runs(project.id).length, 1)
  }
  assert.equal(store.project(project.id).status, 'active')
})

test('missing or corrupt Finding/Session evidence stays explicit and never produces cleanup readiness', async t => {
  const { store, project, root, evidence } = fixture(t)
  const fact = store.addFact(project.id, 'retained')
  const bad = attachment('missing'), corrupt = attachment('expected')
  const finding = store.addFinding(project.id, { title: 'incomplete', description: 'needs recovery', factIds: [fact.id], details: { file: { path: 'missing.txt' }, attachment: bad.ref, prose: 'file:///missing-proof', wrong: corrupt.ref } })
  const services = sessionServices(root, project.id, [{ id: 'orphan-session', events: [{ attachment: bad.ref }, { attachment: corrupt.ref }] }], new Map([[corrupt.ref.attachmentId, Buffer.from('wrong')]]))
  store.setStatus(project.id, 'stopped')
  const report = await evidence.preflightReset(project.id, services)
  assert.equal(report.dataReady, false); assert.equal(report.preservation.unresolved.length, 6)
  assert.ok(report.blockers.some(b => b.reason.includes('hash')))
  assert.deepEqual(store.node<any>(project.id, finding.id).details.attachment, bad.ref)
  assert.equal(evidence.retainedReferences(project.id).length, 0)
})

test('Session inventory failures, missing sessions, foreign workspace and concurrent changes block preflight', async t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', { ...worker, backend: 'dsh' }, step.id)
  store.finishRun(run.id, 'succeeded'); store.setStatus(project.id, 'stopped')
  const services = sessionServices(root, project.id)
  assert.ok((await evidence.preflightReset(project.id, services)).blockers.some(b => /Session is missing/.test(b.reason)))
  services.entries.push({ id: run.id, cwd: root, events: [] })
  assert.ok((await evidence.preflightReset(project.id, services)).blockers.some(b => /another Project/.test(b.reason)))
  services.entries[0].cwd = path.join(root, project.id)
  services.sessionPersistence.stat = async () => ({ revision: 'changed' })
  assert.ok((await evidence.preflightReset(project.id, services)).blockers.some(b => /changed during/.test(b.reason)))
  services.sessionPersistence.list = async () => { throw new Error('Unreadable session inventory') }
  assert.ok((await evidence.preflightReset(project.id, services)).blockers.some(b => /Unreadable/.test(b.reason)))
})

test('repeat promotion verifies spill children and detects loss even with an intact tool manifest', t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  const bytes = Buffer.from('spill evidence'), hash = createHash('sha256').update(bytes).digest('hex'), id = 'ev-' + hash
  const directory = path.join(root, project.id, '.redtrace-output/evidence', run.id)
  mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, id + '.json'), bytes)
  store.runEvent(run.id, 'tool_execution_end', { toolName: 'fixture', toolCallId: 'spill', result: { content: [{ type: 'text', text: id }] } })
  store.addFact(project.id, 'spill proof', { runId: run.id, evidence: [{ runId: run.id, toolCallId: 'spill', description: 'result' }] })
  assert.equal(evidence.promoteFacts(project.id).factsReady, true)
  rmSync(path.join(root, project.id, '.redtrace-output/project-evidence', hash))
  assert.equal(evidence.promoteFacts(project.id).factsReady, false)
})


test('Finding attachments cannot import a foreign Session object through the shared DSH attachment store', async t => {
  const { store, project, root, evidence } = fixture(t)
  const file = attachment('foreign private bytes'), fact = store.addFact(project.id, 'retained')
  store.addFinding(project.id, { title: 'wrong scope', description: 'must not import', factIds: [fact.id], details: { attachment: file.ref } })
  const services = sessionServices(root, project.id, [{ id: 'foreign', cwd: root, events: [{ attachment: file.ref }] }], new Map([[file.ref.attachmentId, file.data]]))
  store.setStatus(project.id, 'stopped')
  const report = await evidence.preflightReset(project.id, services)
  assert.equal(report.dataReady, false); assert.ok(report.blockers.some(b => /no preserved Session reference/.test(b.reason)))
  assert.equal(evidence.retainedReferences(project.id).length, 0); assert.equal(services.closed.length, 0)
})

test('preflight detects concurrent retained graph edits instead of certifying a stale scan', async t => {
  const { store, project, root, evidence } = fixture(t)
  const services = sessionServices(root, project.id)
  store.setStatus(project.id, 'stopped')
  services.sessionPersistence.list = async () => { store.rename(project.id, 'changed during scan'); return [] }
  const report = await evidence.preflightReset(project.id, services)
  assert.equal(report.dataReady, false); assert.ok(report.blockers.some(b => /Project changed/.test(b.reason)))
})

test('preflight rejects dangling retained graph edges and running Commander', async t => {
  const { store, legion, project, root, evidence } = fixture(t)
  const fact = store.addFact(project.id, 'proof')
  const finding = store.addFinding(project.id, { title: 'result', description: 'result', factIds: [fact.id] })
  store.db.prepare('DELETE FROM nodes WHERE project_id=? AND id=?').run(project.id, fact.id)
  legion.claimCommand(); store.setStatus(project.id, 'stopped')
  const report = await evidence.preflightReset(project.id, sessionServices(root, project.id))
  assert.equal(report.dataReady, false)
  assert.ok(report.blockers.some(b => b.owner === finding.id && /dependency is missing/.test(b.reason)))
  assert.ok(report.blockers.some(b => b.owner === 'commander'))
})


test('preflight keeps HTTP/credential resources and blocks queued operations and live global-resource leases', async t => {
  const { store, legion, project, root, evidence } = fixture(t)
  store.db.exec(readFileSync(new URL('../src/operations.sql', import.meta.url), 'utf8'))
  const step = legion.spawn(project.id, mission), run = store.claim(project.id, 'execute', worker, step.id)
  store.finishRun(run.id, 'succeeded'); store.setStatus(project.id, 'stopped')
  for (const kind of ['http_session', 'credential_ref']) store.db.prepare('INSERT INTO shared_resources(id,project_id,kind,name,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(kind, kind === 'credential_ref' ? null : project.id, kind, 'fixture', 'fixture', 'fixture', 'fixture')
  store.db.prepare('INSERT INTO operation_tasks(id,project_id,resource_id,action,actor_type,actor,created_at) VALUES (?,?,?,?,?,?,?)').run('op', project.id, 'http_session', 'fixture', 'human', 'fixture', 'fixture')
  store.db.prepare('INSERT INTO resource_leases VALUES (?,?,?,?,?,?,?,?)').run('fixture', 'credential_ref', 'worker', 'fixture', run.id, 1, '2999-01-01T00:00:00.000Z', 'fixture')
  const services = sessionServices(root, project.id), report = await evidence.preflightReset(project.id, services)
  assert.equal(report.dataReady, false)
  assert.ok(report.blockers.some(b => b.owner === 'op')); assert.ok(report.blockers.some(b => b.owner === run.id && /lease/.test(b.reason)))
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM shared_resources').get()!.n, 2)
  store.db.prepare("UPDATE operation_tasks SET status='succeeded' WHERE id='op'").run()
  store.db.prepare("UPDATE resource_leases SET expires_at='2000-01-01T00:00:00.000Z'").run()
  assert.equal((await evidence.preflightReset(project.id, services)).dataReady, true)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM shared_resources').get()!.n, 2)
})


test('binary evidence pages round-trip exact attachment bytes rather than lossy UTF-8', t => {
  const { evidence, project } = fixture(t)
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff])
  const artifact = evidence.publish(project.id, bytes, { description: 'binary fixture' })
  const page = evidence.read(project.id, artifact.id)
  assert.equal(page.encoding, 'base64')
  assert.deepEqual(Buffer.from(page.content, page.encoding), bytes)
  const tail = evidence.read(project.id, artifact.id, 4, 2)
  assert.deepEqual(Buffer.from(tail.content, tail.encoding ?? 'utf8'), bytes.subarray(4))
})


test('raw published evidence with tool provenance is not mistaken for a tool-result envelope', t => {
  const { store, project, evidence } = fixture(t)
  const artifact = evidence.publish(project.id, Buffer.from('raw evidence'), { runId: 'retired-run', toolCallId: 'retired-call', description: 'already preserved' })
  store.addFact(project.id, 'raw evidence', { evidence: [{ artifactId: artifact.id, description: 'raw evidence' }] })
  assert.equal(evidence.promoteFacts(project.id).factsReady, true)
})
