import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import { graphTools, graphUpdate, launchContext } from '../src/runner.ts'
import type { EngineConfig, Step, Worker } from '../src/types.ts'

const cordisPath = '../compat/cordis.mjs'
const { notifyExplore, pruneExploreNotices, filterExploreNotices } = await import(cordisPath)
const worker: Worker = { name: 'fixture', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: true, explore: true, bootstrap: false, maxRunning: 4, priority: 0 }
const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 4, maxProjectWorkers: 4, maxRunningProjects: 2, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: '/tmp' }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(check: () => boolean) { for (let i = 0; i < 200; i++) { if (check()) return; await turn() } assert.fail('Did not settle') }
function fixture() {
  const store = new Store(':memory:')
  const project = store.createProject({ title: 'Notify', origin: 'Local fixture', goal: 'Check' }).project
  const step = store.addStep(project.id, { description: 'Follower', sourceIds: ['origin'] })
  const target = store.claim(project.id, 'execute', worker, step.id), run = store.claim(project.id, 'decide', worker)
  const inbox = { nextStep: [] as any[], remove(id: string) { const i = this.nextStep.findIndex(m => m.id === id); if (i < 0) return false; this.nextStep.splice(i, 1); return true } }
  const agent: any = { id: target.id, status: 'running', inbox, injected: 0, inject(message: any) { this.injected++; inbox.nextStep.push(message) }, steer() { assert.fail('Notification woke driver') }, followup() { assert.fail('Notification created turn') }, cancel() { assert.fail('Notification cancelled execution') } }
  const task: any = { type: 'explore', projectId: project.id, intentId: step.id, runId: target.id, sessionId: target.id, notificationEpoch: 'first', handle: { agent }, committed: false }
  const shared = { tasks: new Map([[target.id, task]]) }, controller = new AbortController()
  const context = { store, run, worker, config, signal: controller.signal }
  let serial = 0
  const message = (text: string) => ({ id: `notice-${++serial}`, content: [{ type: 'text', text }] })
  const send = (text = 'Useful verified path', sourceIds: string[] = []) => notifyExplore(context, shared, { stepId: step.id, message: text, sourceIds }, message)
  return { store, project, step, target, run, agent, task, shared, context, controller, message, send }
}

test('Reason-only tool, precise non-waking delivery, bounded queue and durable activation-scoped dedup', async () => {
  const f = fixture(), { store, send, agent, task, context, target, step, project } = f
  try {
    const evidence = store.addFact(project.id, 'Confirmed path')
    const before = store.project(project.id), version = store.node<Step>(project.id, step.id).planVersion
    assert.equal(send('Use this path', [evidence.id]).status, 'queued')
    assert.equal(send('Use this path', [evidence.id]).status, 'duplicate'); assert.equal(agent.injected, 1)
    agent.inbox.nextStep.length = 0
    assert.equal(send('Use this path', [evidence.id]).status, 'duplicate', 'consumed notice was re-delivered')
    assert.equal(store.project(project.id).revision, before.revision)
    assert.equal(store.project(project.id).evidenceSeq, before.evidenceSeq)
    assert.equal(store.node<Step>(project.id, step.id).planVersion, version)
    assert.equal(store.run(target.id).boundStepVersion, target.boundStepVersion)
    for (let i = 0; i < 8; i++) assert.equal(send(`Distinct ${i}`).status, 'queued')
    assert.equal(send('Overflow').reason, 'queue_full'); assert.equal(agent.inbox.nextStep.length, 8)
    pruneExploreNotices(store, target, agent, 'paused'); assert.equal(agent.inbox.nextStep.length, 0)
    task.notificationEpoch = 'resume'
    assert.equal(send('Use this path', [evidence.id]).status, 'queued', 'fresh activation may re-evaluate and send')
    const tools = graphTools({ ...context, notifyExplore: (args: any) => notifyExplore(context, f.shared, args, f.message) }, () => {})
    assert.ok(tools.some(t => t.name === 'notify_explore'))
    assert.ok(!graphTools({ ...context, run: target }, () => {}).some(t => t.name === 'notify_explore'))
    const unavailable = graphTools(context, () => {}).find(t => t.name === 'notify_explore')!
    const result = await unavailable.execute('id', { stepId: step.id, message: 'test' })
    assert.equal((result.details as any).reason, 'transport_unavailable')
    assert.equal(notifyExplore({ ...context, run: target }, f.shared, { stepId: step.id, message: 'bad caller' }, f.message).reason, 'reason_not_running')
  } finally { store.close() }
})

test('invalid, foreign, unready, closing, failed and completed targets report actual outcomes', () => {
  const f = fixture(), { store, project, task, agent, step, target, context, shared, message, send } = f
  try {
    assert.equal(send('  ').reason, 'invalid_message_or_sources')
    assert.equal(send('x'.repeat(2001)).reason, 'invalid_message_or_sources')
    assert.equal(send('Info', ['origin', 'origin']).reason, 'invalid_message_or_sources')
    const hint = store.addInput(project.id, 'hint', 'Unverified')
    assert.equal(send('Info', [hint.id]).reason, 'invalid_source')
    assert.equal(send('Info', ['missing']).reason, 'target_or_source_missing')
    const archived = store.addFact(project.id, 'Unused')
    store.manageEvidence(project.id, { operation: 'archive', id: archived.id, expectedVersion: archived.version!, reason: 'Unused' })
    assert.equal(send('Info', [archived.id]).reason, 'invalid_source')
    const foreign = store.createProject({ title: 'Foreign', origin: 'Different scope', goal: 'Check' }).project
    task.projectId = foreign.id; assert.equal(send().reason, 'session_not_ready_or_closing'); task.projectId = project.id
    task.sessionId = 'foreign-session'; assert.equal(send().reason, 'session_not_ready_or_closing'); task.sessionId = target.id
    task.handle = undefined; assert.equal(send().reason, 'session_not_ready_or_idle'); task.handle = { agent }
    agent.status = 'idle'; assert.equal(send().reason, 'session_not_ready_or_idle'); agent.status = 'running'
    for (const flag of ['committed', 'cancelled', 'concludeOnly']) { task[flag] = true; assert.equal(send().reason, 'session_not_ready_or_closing'); task[flag] = false }
    const inject = agent.inject; agent.inject = () => { throw new Error('native injection failed') }
    assert.equal(send().status, 'failed'); assert.equal(agent.inbox.nextStep.length, 0); agent.inject = inject
    assert.equal(notifyExplore(context, shared, { stepId: 'missing', message: 'Info' }, message).reason, 'target_or_source_missing')
    store.setStatus(project.id, 'stopped'); assert.equal(send().reason, 'project_inactive'); store.setStatus(project.id, 'active')
    store.finishRun(target.id, 'succeeded'); assert.equal(send().reason, 'step_not_running')
    assert.equal(agent.injected, 0)
  } finally { store.close() }
})

test('notifications never cross concurrent Steps and obsolete pending or claimed notices are discarded', () => {
  const f = fixture(), { store, project, shared, agent, target, step, send, context, message } = f
  try {
    const second = store.addStep(project.id, { description: 'Independent', sourceIds: ['origin'] })
    const other = store.claim(project.id, 'execute', worker, second.id)
    const inbox: any = { nextStep: [], remove() { return false } }
    const otherAgent: any = { id: other.id, status: 'running', inbox, inject(m: any) { inbox.nextStep.push(m) } }
    shared.tasks.set(other.id, { ...f.task, intentId: second.id, runId: other.id, sessionId: other.id, handle: { agent: otherAgent } })
    assert.equal(send().status, 'queued'); assert.equal(inbox.nextStep.length, 0)
    assert.equal(notifyExplore(context, shared, { stepId: second.id, message: 'Only second' }, message).status, 'queued')
    assert.equal(inbox.nextStep.length, 1); assert.equal(agent.inbox.nextStep.length, 1)
    const claimed = [...agent.inbox.nextStep]; agent.inbox.nextStep.length = 0
    store.updateStep(project.id, step.id, { description: 'New mandatory contract', mode: 'amend', expectedVersion: store.node(project.id, step.id).version })
    assert.deepEqual(filterExploreNotices(store, target, claimed), [])
    assert.equal(send('Latest').status, 'queued')
    store.updateStep(project.id, step.id, { description: 'Replacement', mode: 'replace', expectedVersion: store.node(project.id, step.id).version })
    pruneExploreNotices(store, target, agent); assert.equal(agent.inbox.nextStep.length, 0)
    assert.equal(send().reason, 'step_not_running')
    assert.ok(store.db.prepare("SELECT 1 FROM audit_events WHERE json_extract(data,'$.kind')='explore.notification.discarded'").get())
  } finally { store.close() }
})

test('Hint wakes Reason, preserves busy continuous boundaries and is never Explore launch or broadcast input', async () => {
  const store = new Store(':memory:'), id = store.createProject({ title: 'Hint', origin: 'Local', goal: 'Check' }).project.id
  const step = store.addStep(id, { description: 'Follower', sourceIds: ['origin'] }), target = store.claim(id, 'execute', worker, step.id)
  const first = store.claim(id, 'decide', worker); store.finishRun(first.id, 'succeeded')
  let release: () => void = () => {}, seen = 0, active: any
  const scheduler = new Scheduler(store, { ...config, workers: [{ ...worker, explore: false }] }, async ({ run }) => { seen++; active = run; await new Promise<void>(resolve => { release = resolve }) })
  try {
    scheduler.start(); await turn(); assert.equal(seen, 0)
    const a = store.addInput(id, 'hint', 'First global input', 'human', step.id)
    await until(() => seen === 1)
    store.addInput(id, 'hint', 'Second while busy'); store.deleteInput(id, a.id)
    assert.equal(store.project(id).evidenceSeq, 0); assert.equal(store.project(id).hintSeq, 3)
    assert.equal(graphUpdate(store, id, target.deliveredGraphCursor!, step.id, target.id).relevant, false)
    assert.equal(launchContext(store, target.id).hints, undefined)
    assert.ok(launchContext(store, active.id).hints!.items.some(h => h.content === 'Second while busy'))
    assert.throws(() => store.acknowledgeHint(active.id, 3), /delivered Hint/)
    const latest = store.events(id).at(-1)!.id
    store.graphDelta(id, latest - 1, 1, active.id)
    assert.throws(() => store.acknowledgeHint(active.id, 3), /delivered Hint/, 'skip-ahead read acknowledged a gap')
    let page = store.graphDelta(id, active.deliveredGraphCursor!, 1, active.id)
    while (page.hasMore) page = store.graphDelta(id, page.cursor, 1, active.id)
    store.acknowledgeHint(active.id, 3); release()
    await until(() => scheduler.activeRuns.length === 1)
    for (let i = 0; i < 12; i++) await turn()
    assert.equal(seen, 1); assert.equal(store.project(id).acknowledgedHintSeq, 3)
    assert.equal(store.graphAt(id, store.project(id).revision).project.hintSeq, 3)
    store.addInput(id, 'hint', 'Next input'); await until(() => seen === 2)
    store.addInput(id, 'hint', 'Must survive omitted acknowledgement'); release()
    await until(() => seen === 3)
    assert.ok(store.project(id).hintSeq! > store.project(id).acknowledgedHintSeq!)
  } finally { release(); await scheduler.close(); store.close() }
})


test('all Fact/Finding lifecycle events, including own produced evidence, stay in FGS without Explore broadcast', () => {
  const f = fixture(), { store, project, step, target, run } = f
  let cursor = store.events(project.id).at(-1)!.id
  const scan = () => { const update = graphUpdate(store, project.id, cursor, step.id, target.id); cursor = update.cursor; return update }
  const noBroadcast = () => { const update = scan(); assert.equal(update.relevant, false); assert.equal(update.planChanged, false); assert.deepEqual(update.counts, {}) }
  try {
    const one = store.addFact(project.id, 'External verified evidence'); noBroadcast()
    const two = store.addFact(project.id, 'Own verified evidence', { runId: target.id }); noBroadcast()
    const a = store.addFinding(project.id, { title: 'External result', description: 'Proof', factIds: [one.id] }); noBroadcast()
    const b = store.addFinding(project.id, { title: 'Own result', description: 'Proof', factIds: [two.id], runId: target.id }); noBroadcast()
    assert.equal(store.project(project.id).evidenceSeq, 4)
    assert.ok(store.project(project.id).evidenceSeq! > store.project(project.id).acknowledgedEvidenceSeq!)
    assert.equal(graphUpdate(store, project.id, run.deliveredGraphCursor!, null, run.id).evidenceSeq, 4)
    store.manageEvidence(project.id, { operation: 'merge', id: one.id, expectedVersion: one.version!, sourceIds: [two.id], sourceVersions: { [two.id]: two.version! }, reason: 'Same verified result' }); noBroadcast()
    assert.deepEqual(store.node<Step>(project.id, step.id).factIds, [one.id])
    assert.equal(store.node<Step>(project.id, step.id).planVersion, 1, 'output evidence bookkeeping is not an execution contract')
    store.manageEvidence(project.id, { operation: 'merge', id: a.id, expectedVersion: store.node(project.id, a.id).version!, sourceIds: [b.id], sourceVersions: { [b.id]: store.node(project.id, b.id).version! }, reason: 'Same verified deliverable' }); noBroadcast()
    const unusedFact = store.addFact(project.id, 'Unreferenced evidence'); noBroadcast()
    const unusedFinding = store.addFinding(project.id, { title: 'Unreferenced result', description: 'Proof', factIds: [one.id] }); noBroadcast()
    for (const node of [unusedFact, unusedFinding]) {
      store.manageEvidence(project.id, { operation: 'archive', id: node.id, expectedVersion: store.node(project.id, node.id).version!, reason: 'Unused' }); noBroadcast()
      store.manageEvidence(project.id, { operation: 'restore', id: node.id, expectedVersion: store.node(project.id, node.id).version!, reason: 'Reuse' }); noBroadcast()
    }
    const events = store.events(project.id).map(e => e.type)
    for (const kind of ['fact', 'finding']) for (const action of ['added', 'updated', 'merged', 'archived', 'restored']) assert.ok(events.includes(`${kind}.${action}`), `${kind}.${action} not exercised`)
    assert.equal(store.project(project.id).evidenceSeq, 6)
    assert.equal(store.graph(project.id).facts.some(node => node.id === unusedFact.id), true)
    assert.equal(store.graph(project.id).findings.some(node => node.id === unusedFinding.id), true)
  } finally { store.close() }
})

test('canonical source reference rewrites preserve real contract sync, not evidence broadcast', () => {
  const f = fixture(), { store, project, step, target } = f
  try {
    const one = store.addFact(project.id, 'Canonical'), two = store.addFact(project.id, 'Equivalent')
    store.updateStep(project.id, step.id, { sourceIds: [two.id], mode: 'amend', expectedVersion: store.node(project.id, step.id).version })
    store.syncStep(target.id, 2)
    const cursor = store.events(project.id).at(-1)!.id
    store.manageEvidence(project.id, { operation: 'merge', id: one.id, expectedVersion: one.version!, sourceIds: [two.id], sourceVersions: { [two.id]: two.version! }, reason: 'Same confirmed dependency' })
    const update = graphUpdate(store, project.id, cursor, step.id, target.id)
    assert.equal(update.planChanged, true); assert.equal(update.planVersion, 3)
    assert.deepEqual(update.counts, { 'step.updated': 1 })
    assert.equal(update.evidenceSeq, 0)
  } finally { store.close() }
})
