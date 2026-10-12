import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import { graphTools, graphUpdate } from '../src/runner.ts'
import { createPlanGuard } from '../src/plan-guard.ts'
import { projectFgs } from '../src/fgs.ts'
import type { EngineConfig, Fact, Finding, Goal, Step, Worker } from '../src/types.ts'

const worker: Worker = { name: 'fixture', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: true, explore: true, bootstrap: true, maxRunning: 8, priority: 0 }
const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 4, maxProjectWorkers: 4, maxRunningProjects: 2, maxSteps: 1, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: '/tmp' }
const turn = () => new Promise<void>(r => setImmediate(r))
async function until(check: () => boolean) { for (let i = 0; i < 100; i++) { if (check()) return; await turn() } assert.fail('Did not settle') }
function project(s: Store) { return s.createProject({ title: 'Maintenance', origin: 'Local fixture', goal: 'Verified result' }).project.id }
function produced(s: Store, id: string, description: string) {
  const step = s.addStep(id, { description, sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
  const fact = s.addFact(id, description, { runId: run.id, evidence: [{ description, runId: run.id }] })
  s.finishRun(run.id, 'succeeded'); return { step, run, fact }
}

test('merge is atomic, versioned, evidence-preserving and reference-complete', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), a = produced(s, id, 'proof A'), b = produced(s, id, 'proof B')
    const finding = s.addFinding(id, { title: 'Deliverable', description: 'Proof', factIds: [a.fact.id, b.fact.id] })
    const goal = s.addGoal(id, 'Completed subgoal'); s.updateGoal(id, goal.id, { status: 'achieved', evidenceIds: [b.fact.id] })
    const next = s.addStep(id, { description: 'Follow latest', sourceIds: [a.fact.id, b.fact.id] })
    const before = s.project(id), change = { operation: 'merge' as const, id: a.fact.id, expectedVersion: a.fact.version!, sourceIds: [b.fact.id], sourceVersions: { [b.fact.id]: 999 }, reason: 'Confirmed equivalent in this fixture' }
    assert.throws(() => s.manageEvidence(id, change), (e: any) => e.status === 409 && e.details.current.id === b.fact.id)
    assert.equal(s.project(id).revision, before.revision)
    const merged = s.manageEvidence(id, { ...change, sourceVersions: { [b.fact.id]: b.fact.version! }, description: 'Consolidated proof' }) as Fact
    assert.equal(merged.description, 'Consolidated proof')
    assert.equal(merged.evidence.length, 2)
    assert.deepEqual(new Set(merged.producerStepIds), new Set([a.step.id, b.step.id]))
    assert.deepEqual(s.node<Step>(id, next.id).sourceIds, [a.fact.id])
    assert.deepEqual(s.node<Finding>(id, finding.id).factIds, [a.fact.id])
    assert.deepEqual(s.node<Goal>(id, goal.id).evidenceIds, [a.fact.id])
    assert.deepEqual(s.node<Step>(id, b.step.id).factIds, [a.fact.id])
    assert.throws(() => s.node(id, b.fact.id), (e: any) => e.status === 404)
    assert.equal(s.graph(id).facts.length, 2)
    assert.equal(s.db.prepare('SELECT COUNT(*) AS count FROM nodes WHERE project_id=? AND kind=?').get(id, 'fact')!.count, 2)
    assert.equal(s.project(id).evidenceSeq, before.evidenceSeq)
    assert.equal(projectFgs(s.graph(id)).missingReferences.length, 0)
    assert.throws(() => s.manageEvidence(id, { ...change, id: b.fact.id }), /not found/)
    assert.throws(() => s.manageEvidence(id, { ...change, sourceIds: [a.fact.id], expectedVersion: merged.version! }), /sources/)
    assert.throws(() => s.manageEvidence(id, { ...change, sourceIds: [finding.id], sourceVersions: { [finding.id]: finding.version! }, expectedVersion: merged.version! }), /same kind/)
  } finally { s.close() }
})

test('Finding merge preserves producing actions, evidence, details and completed-goal references', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), a = produced(s, id, 'A'), b = produced(s, id, 'B')
    const one = s.addFinding(id, { title: 'Same result', description: 'A', factIds: [a.fact.id], details: { source: 'A' } })
    const two = s.addFinding(id, { title: 'Same result', description: 'B', factIds: [b.fact.id], details: { source: 'B' } })
    const goal = s.addGoal(id, 'Subgoal'); s.updateGoal(id, goal.id, { status: 'achieved', evidenceIds: [two.id] })
    const merged = s.manageEvidence(id, { operation: 'merge', id: one.id, expectedVersion: one.version!, sourceIds: [two.id], sourceVersions: { [two.id]: two.version! }, reason: 'Same deliverable', title: 'Unified result', description: 'Final proof', details: { proof: 'AB' } }) as Finding
    assert.deepEqual(new Set(merged.factIds), new Set([a.fact.id, b.fact.id]))
    assert.throws(() => s.node(id, two.id), /not found/)
    assert.equal(merged.title, 'Unified result'); assert.equal(merged.description, 'Final proof')
    assert.deepEqual(merged.details, { proof: 'AB' })
    assert.ok(!('sourceDetails' in merged))
    assert.deepEqual(s.node<Goal>(id, goal.id).evidenceIds, [one.id])
  } finally { s.close() }
})

test('delete refuses active references atomically, clears concluded references and retains producer Runs', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), a = produced(s, id, 'A'), step = s.addStep(id, { description: 'Dependent', sourceIds: [a.fact.id] })
    const change = { operation: 'delete' as const, id: a.fact.id, expectedVersion: a.fact.version!, reason: 'No longer useful' }, revision = s.project(id).revision
    assert.throws(() => s.manageEvidence(id, change), (e: any) => e.details.blockers.some((n: any) => n.id === step.id))
    assert.equal(s.project(id).revision, revision)
    s.updateStep(id, step.id, { status: 'cancelled' })
    assert.deepEqual(s.manageEvidence(id, change), { id: a.fact.id, deleted: true })
    assert.equal(s.nodeCount(id, 'fact'), 1)
    assert.deepEqual(s.node<Step>(id, step.id).sourceIds, [])
    assert.deepEqual(s.node<Step>(id, a.step.id).factIds, [])
    assert.equal(s.run(a.run.id).status, 'succeeded')
    assert.throws(() => s.node(id, a.fact.id), (e: any) => e.status === 404)
    assert.equal(projectFgs(s.graph(id)).missingReferences.length, 0)
    assert.throws(() => s.addStep(id, { description: 'Invalid', sourceIds: [a.fact.id] }), /not found/)
    assert.throws(() => s.manageEvidence(id, { ...change, id: 'origin', expectedVersion: 1 }), /Scope/)
    assert.throws(() => s.updateGoal(id, 'goal', { description: 'Different authorization' }), /immutable/)
  } finally { s.close() }
})

test('live amendment preserves Run, requires sync and rejects old PTC descendants after acknowledgement', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), step = s.addStep(id, { description: 'Original', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    const guard = createPlanGuard(s, run.id); guard.beginTurn()
    assert.equal(guard.check({ name: 'run_code', rootCallId: 'old' }), undefined)
    const current = s.node<Step>(id, step.id), amended = s.updateStep(id, step.id, { description: 'Corrected strategy', expectedVersion: current.version, mode: 'amend' })
    assert.equal(s.run(run.id).status, 'running')
    assert.match(guard.check({ name: 'bash', rootCallId: 'old' })!, /Plan changed/)
    assert.equal(guard.check({ name: 'sync_step', rootCallId: 'old' }), undefined)
    const synced = s.syncStep(run.id, amended.planVersion!)
    assert.equal(synced.step.description, 'Corrected strategy')
    assert.match(guard.check({ name: 'bash', rootCallId: 'old' })!, /Old call trees/)
    guard.beginTurn(); assert.equal(guard.check({ name: 'bash', rootCallId: 'new' }), undefined)
    assert.throws(() => s.updateStep(id, step.id, { requires: ['remote.command'], expectedVersion: s.node(id, step.id).version, mode: 'amend' }), /require replace/)
    const version = s.node<Step>(id, step.id).planVersion
    s.addFact(id, 'Already-issued command evidence', { runId: run.id })
    assert.equal(s.node<Step>(id, step.id).planVersion, version, 'evidence arrival is not a plan revision')
  } finally { s.close() }
})

test('replacement waits for stop confirmation, retains results and blocks unknown side effects', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), step = s.addStep(id, { description: 'Old objective', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    const fact = s.addFact(id, 'Committed result', { runId: run.id })
    const next = s.updateStep(id, step.id, { description: 'New objective', expectedVersion: s.node(id, step.id).version, mode: 'replace' })
    assert.equal(next.status, 'blocked'); assert.equal(next.replaces, step.id)
    assert.throws(() => s.claim(id, 'execute', worker, next.id), /claimable/)
    assert.throws(() => s.addFact(id, 'Late write', { runId: run.id }), /no longer running/)
    s.finishRun(run.id, 'unknown', 'Unconfirmed command')
    assert.equal(s.node<Step>(id, next.id).replacementPending, true)
    assert.throws(() => s.updateStep(id, next.id, { status: 'pending' }), /stop confirmation/)
    s.resolveUnknown(run.id, 'Inspected result; command completed without a remaining operation')
    assert.equal(s.node<Step>(id, next.id).status, 'pending')
    assert.equal(s.node<Fact>(id, fact.id).description, 'Committed result')
    assert.equal(s.claim(id, 'execute', worker, next.id).stepId, next.id)
  } finally { s.close() }
})

test('Subgoal amendments invalidate all unfinished descendant contracts without changing Root Goal', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), parent = s.addGoal(id, 'Subgoal'), child = s.addGoal(id, 'Child', parent.id)
    const step = s.addStep(id, { description: 'Act', sourceIds: ['origin'], goalId: child.id }), run = s.claim(id, 'execute', worker, step.id)
    assert.throws(() => s.updateGoal(id, parent.id, { description: 'Corrected' }), /mode/)
    s.updateGoal(id, parent.id, { description: 'Corrected', expectedVersion: parent.version, mode: 'amend' })
    assert.equal(s.node<Step>(id, step.id).planVersion, 2)
    assert.equal(s.run(run.id).boundStepVersion, 1)
    assert.equal(s.syncStep(run.id, 2).goals[1].description, 'Corrected')
    assert.equal(s.node<Goal>(id, 'goal').description, 'Verified result')
  } finally { s.close() }
})

test('incremental pages cannot acknowledge unseen gaps; successful explicit acknowledgement avoids redundant planning', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), run = s.claim(id, 'decide', worker), cursor = run.deliveredGraphCursor!
    s.addFact(id, 'First'); s.addFact(id, 'Second')
    const before = s.project(id).acknowledgedEvidenceSeq
    s.graphDelta(id, cursor + 2, 100, run.id)
    assert.throws(() => s.acknowledgeEvidence(run.id, 2), /delivered/)
    let page = s.graphDelta(id, cursor, 1, run.id)
    while (page.hasMore) page = s.graphDelta(id, page.cursor, 1, run.id)
    assert.equal(s.project(id).acknowledgedEvidenceSeq, before)
    s.acknowledgeEvidence(run.id, 2); s.finishRun(run.id, 'succeeded')
    assert.equal(s.project(id).acknowledgedEvidenceSeq, 2)
  } finally { s.close() }
})

test('Finding-only wakes Reason; self-maintenance does not recursively wake and graph scans stay bounded', async () => {
  const s = new Store(':memory:'), id = project(s), a = produced(s, id, 'A')
  const first = s.claim(id, 'decide', worker); s.finishRun(first.id, 'succeeded')
  let decisions = 0
  const scheduler = new Scheduler(s, { ...config, workers: [{ ...worker, explore: false }] }, async ({ run }) => { if (run.activity === 'decide') decisions++ })
  try {
    scheduler.start(); s.addFinding(id, { title: 'Finding', description: 'New deliverable', factIds: [a.fact.id] })
    await until(() => decisions === 1 && scheduler.activeRuns.length === 0)
    const unused = s.addFact(id, 'Unused')
    await until(() => decisions === 2 && scheduler.activeRuns.length === 0)
    s.manageEvidence(id, { operation: 'delete', id: unused.id, expectedVersion: unused.version!, reason: 'Unused' })
    for (let i = 0; i < 10; i++) await turn()
    assert.equal(decisions, 2)
    s.graph = () => { throw new Error('Full graph read forbidden') }
    assert.equal(graphUpdate(s, id, 0, a.step.id).relevant, false)
    assert.ok(s.graphDelta(id, 0, 1).hasMore)
    assert.ok(s.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM nodes WHERE project_id=? AND kind='fact' AND COALESCE(json_extract(data,'$.deleted'),0)=0 LIMIT 1").all(id).some(r => String(r.detail).includes('nodes_active')))
  } finally { await scheduler.close(); s.close() }
})

test('Reason owns maintenance tools, Explore only syncs its own contract and explicit delta reads do not imply processing', async () => {
  const s = new Store(':memory:'), id = project(s), run = s.claim(id, 'decide', worker)
  try {
    const tools = graphTools({ store: s, run, worker, config, signal: new AbortController().signal }, () => {})
    assert.ok(tools.some(t => t.name === 'manage_evidence')); assert.ok(!tools.some(t => t.name === 'sync_step'))
    const fact = s.addFact(id, 'Evidence'), maintain = tools.find(t => t.name === 'manage_evidence')!
    const conflict = await maintain.execute('fixture', { operation: 'delete', id: fact.id, expectedVersion: 999, reason: 'Fixture' })
    assert.ok('isError' in conflict && conflict.isError); assert.match(JSON.stringify(conflict), /current/)
    const step = s.addStep(id, { description: 'Execute', sourceIds: ['origin'] }), execute = s.claim(id, 'execute', worker, step.id)
    const executeTools = graphTools({ store: s, run: execute, worker, config, signal: new AbortController().signal }, () => {})
    assert.ok(executeTools.some(t => t.name === 'sync_step')); assert.ok(!executeTools.some(t => t.name === 'manage_evidence'))
  } finally { s.close() }
})

test('Reason has no reserved slot, waits at total/Worker capacity and wins the next available slot', async () => {
  const s = new Store(':memory:'), id = project(s)
  const initial = s.claim(id, 'decide', worker); s.finishRun(initial.id, 'succeeded')
  let release!: () => void, started = false, decisions = 0
  const gate = new Promise<void>(r => { release = r })
  const scheduler = new Scheduler(s, { ...config, maxWorkers: 1, maxProjectWorkers: 1, workers: [{ ...worker, maxRunning: 1 }] }, async ({ run }) => {
    if (run.activity === 'decide') decisions++
    else { started = true; await gate }
  })
  try {
    const step = s.addStep(id, { description: 'Full slot', sourceIds: ['origin'] })
    scheduler.start(); await until(() => started)
    const run = s.latestRun(id, step.id)!
    s.addFact(id, 'Immediate pending evidence', { runId: run.id })
    for (let i = 0; i < 10; i++) await turn()
    assert.equal(decisions, 0); assert.equal(scheduler.activeRuns.length, 1)
    assert.ok(s.project(id).evidenceSeq! > s.project(id).acknowledgedEvidenceSeq!)
    release(); await until(() => decisions === 1)
    assert.ok(scheduler.activeRuns.length <= 1)
  } finally { release(); await scheduler.close(); s.close() }
})

test('pending Reason in another project precedes an earlier project Explore', async () => {
  const s = new Store(':memory:'), a = project(s), b = project(s), order: string[] = []
  for (const id of [a, b]) { const run = s.claim(id, 'decide', worker); s.finishRun(run.id, 'succeeded') }
  s.addStep(a, { description: 'Earlier project Explore', sourceIds: ['origin'] }); s.addFact(b, 'Later project evidence')
  const scheduler = new Scheduler(s, { ...config, maxWorkers: 1, workers: [{ ...worker, maxRunning: 1 }] }, async ({ run }) => { order.push(`${run.projectId}:${run.activity}`) })
  try { scheduler.start(); await until(() => order.length === 2); assert.deepEqual(order, [`${b}:decide`, `${a}:execute`]) }
  finally { await scheduler.close(); s.close() }
})

test('a paused session is already quiescent and can be replaced without leaving an orphan paused lease', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), step = s.addStep(id, { description: 'Old', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    s.finishRun(run.id, 'paused')
    const replacement = s.updateStep(id, step.id, { description: 'New', mode: 'replace', expectedVersion: s.node(id, step.id).version })
    assert.equal(s.run(run.id).status, 'cancelled'); assert.equal(replacement.status, 'pending')
    assert.equal(s.runsByStatus('paused').length, 0)
  } finally { s.close() }
})

test('new Explore deltas start at claim, not at historical events; legacy deletion retains producing Steps', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s)
    for (let i = 0; i < 501; i++) s.addInput(id, 'observation', `old noise ${i}`)
    const step = s.addStep(id, { description: 'Fresh Explore', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    const page = s.graphDelta(id, run.deliveredGraphCursor, 100, run.id)
    assert.equal(page.events.length, 1); assert.equal(page.events[0].type, 'execute.started'); assert.equal(page.hasMore, false)
    const fact = s.addFact(id, 'Legacy deletion fixture', { runId: run.id }); s.finishRun(run.id, 'succeeded'); s.releaseFact(id, fact.id)
    assert.equal(s.graph(id).steps.length, 1)
    assert.deepEqual(s.graph(id).steps[0].factIds, [])
    assert.throws(() => s.node(id, fact.id), /not found/)
  } finally { s.close() }
})

test('stopped contracts never ask to sync; unrelated evidence maintenance does not notify Explore', () => {
 const s=new Store(':memory:'), id=project(s)
 try {
  const unrelated=s.addFact(id,'Unrelated evidence')
  const step=s.addStep(id,{description:'Current',sourceIds:['origin']}),run=s.claim(id,'execute',worker,step.id)
  let cursor=run.deliveredGraphCursor!
  s.manageEvidence(id,{operation:'delete',id:unrelated.id,expectedVersion:unrelated.version!,reason:'Unreferenced'})
  const update=graphUpdate(s,id,cursor,step.id,run.id)
  assert.equal(update.relevant,false);cursor=update.cursor
  s.updateStep(id,step.id,{description:'Replacement',mode:'replace',expectedVersion:s.node(id,step.id).version})
  const replaced=graphUpdate(s,id,cursor,step.id,run.id)
  assert.equal(replaced.stopped,true);assert.equal(replaced.planChanged,false);assert.equal(replaced.relevant,false)
  const goal=s.addGoal(id,'Temporary subgoal')
  const other=s.addStep(id,{description:'Goal closure',sourceIds:['origin'],goalId:goal.id})
  const next=s.claim(id,'execute',worker,other.id)
  s.updateGoal(id,goal.id,{status:'cancelled'})
  const closed=graphUpdate(s,id,next.deliveredGraphCursor!,other.id,next.id)
  assert.equal(closed.stopped,true);assert.equal(closed.planChanged,false);assert.equal(closed.relevant,false)
 } finally {s.close()}
})
