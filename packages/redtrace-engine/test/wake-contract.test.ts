import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import type { EngineConfig, Project, RunStatus, Worker } from '../src/types.ts'

const worker: Worker = { name: 'contract', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: true, explore: false, bootstrap: false, maxRunning: 8, priority: 0 }
const config = (maxSteps: number | null = null): EngineConfig => ({ workers: [worker], providers: {}, maxWorkers: 8, maxProjectWorkers: 8,
  maxRunningProjects: 8, maxSteps, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: os.tmpdir() })
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean, turns = 200) { for (let i = 0; i < turns; i++) { if (predicate()) return; await turn() } assert.fail('Condition did not settle') }
async function quiet() { for (let i = 0; i < 12; i++) await turn() }
const create = (store: Store) => store.createProject({ title: 'Squares', origin: 'Positive integers', goal: 'Record verified squares' }).project.id
function ready(store: Store) { const id = create(store), run = store.claim(id, 'decide', worker); store.finishRun(run.id, 'succeeded'); return id }
function execution(store: Store, projectId: string, input: number) {
  const step = store.addStep(projectId, { description: `Square ${input}`, sourceIds: ['origin'] })
  return { step, run: store.claim(projectId, 'execute', worker, step.id), input }
}
function fact(store: Store, item: ReturnType<typeof execution>) { return store.addFact(item.step.projectId, `${item.input}² = ${item.input ** 2}`, { runId: item.run.id }) }
function finish(store: Store, item: ReturnType<typeof execution>, status: RunStatus) { store.finishRun(item.run.id, status) }
function saveProject(store: Store, project: Project) { store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(project), project.id) }
function counter(store: Store, maxSteps: number | null = null, task?: (store: Store, projectId: string, decision: number) => Promise<void> | void) {
  let decisions = 0
  const scheduler = new Scheduler(store, config(maxSteps), async ({ store, run }) => { if (run.activity === 'decide') { decisions++; await task?.(store, run.projectId, decisions) } })
  return { scheduler, decisions: () => decisions }
}

test('1: first launch plans once; reactivation alone does not plan again', async () => {
  const store = new Store(':memory:'), id = create(store), seen = counter(store)
  try {
    seen.scheduler.start(); await until(() => seen.decisions() === 1); await quiet()
    store.setStatus(id, 'stopped'); store.setStatus(id, 'active'); await quiet()
    assert.equal(seen.decisions(), 1)
  } finally { await seen.scheduler.close(); store.close() }
})

test('2: many Facts from one Step coalesce until an ending arrives', async () => {
  const store = new Store(':memory:'), id = ready(store), seen = counter(store)
  try {
    seen.scheduler.start(); await quiet(); const item = execution(store, id, 2)
    for (let i = 0; i < 5; i++) fact(store, item)
    await quiet(); assert.equal(seen.decisions(), 0)
    finish(store, item, 'succeeded'); await until(() => seen.decisions() === 1); await quiet(); assert.equal(seen.decisions(), 1)
  } finally { await seen.scheduler.close(); store.close() }
})

test('3: ending a Step without a new Fact cannot wake Decide', async () => {
  const store = new Store(':memory:'), id = ready(store), item = execution(store, id, 2), seen = counter(store)
  try { finish(store, item, 'succeeded'); seen.scheduler.start(); await quiet(); assert.equal(seen.decisions(), 0) }
  finally { await seen.scheduler.close(); store.close() }
})

for (const [number, order] of [[4, 'fact-first'], [5, 'end-first']] as const) test(`${number}: different Steps pair in ${order} order`, async () => {
  const store = new Store(':memory:'), id = ready(store), seen = counter(store)
  try {
    seen.scheduler.start(); await quiet(); const a = execution(store, id, 2), b = execution(store, id, 3)
    if (order === 'fact-first') { fact(store, a); finish(store, b, 'succeeded') }
    else { finish(store, b, 'failed'); fact(store, a) }
    await until(() => seen.decisions() === 1); await quiet(); assert.equal(seen.decisions(), 1)
    fact(store, a); await quiet(); assert.equal(seen.decisions(), 1, 'an acknowledged ending cannot pair again')
  } finally { await seen.scheduler.close(); store.close() }
})

test('6: events from different projects never pair', async () => {
  const store = new Store(':memory:'), a = ready(store), b = ready(store), seen = counter(store)
  try { seen.scheduler.start(); await quiet(); const x = execution(store, a, 2), y = execution(store, b, 3); fact(store, x); finish(store, y, 'succeeded'); await quiet(); assert.equal(seen.decisions(), 0) }
  finally { await seen.scheduler.close(); store.close() }
})

test('7: full capacity preserves a pending pair until a slot opens', async () => {
  const store = new Store(':memory:'), id = ready(store), seen = counter(store, 3)
  try {
    seen.scheduler.start(); await quiet(); const a = execution(store, id, 2), b = execution(store, id, 3)
    fact(store, a); finish(store, b, 'succeeded')
    const c = store.addStep(id, { description: 'Square 4', sourceIds: ['origin'] }), d = store.addStep(id, { description: 'Square 5', sourceIds: ['origin'] })
    await quiet(); assert.equal(seen.decisions(), 0)
    store.updateStep(id, d.id, { status: 'cancelled' }); await until(() => seen.decisions() === 1)
    assert.equal(store.node(id, c.id).kind, 'step')
  } finally { await seen.scheduler.close(); store.close() }
})

for (const [number, status, expected] of [[8, 'succeeded', 1], [9, 'failed', 1], [10, 'paused', 0], [11, 'cancelled', 0]] as const) test(`${number}: Execute ${status} ${expected ? 'does' : 'does not'} provide an ending event`, async () => {
  const store = new Store(':memory:'), id = ready(store), item = execution(store, id, 2), seen = counter(store)
  try { fact(store, item); finish(store, item, status); seen.scheduler.start(); expected ? await until(() => seen.decisions() === 1) : await quiet(); assert.equal(seen.decisions(), expected) }
  finally { await seen.scheduler.close(); store.close() }
})

test('12: spare capacity and elapsed time cannot wake on a Fact alone', async () => {
  const store = new Store(':memory:'), id = ready(store), seen = counter(store, 3)
  try { seen.scheduler.start(); await quiet(); const item = execution(store, id, 2); fact(store, item); await quiet(); assert.equal(seen.decisions(), 0); finish(store, item, 'succeeded'); await until(() => seen.decisions() === 1) }
  finally { await seen.scheduler.close(); store.close() }
})

test('13: successful planning acknowledges its start boundary and preserves later events', async () => {
  const store = new Store(':memory:'), id = ready(store)
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), seen = counter(store, null, async (_store, _id, decision) => { if (decision === 1) await gate })
  try {
    seen.scheduler.start(); await quiet(); const a = execution(store, id, 2), b = execution(store, id, 3)
    fact(store, a); finish(store, a, 'succeeded'); const firstPairRevision = store.project(id).revision; await until(() => seen.decisions() === 1)
    fact(store, b); finish(store, b, 'failed'); release(); await until(() => seen.decisions() === 2); await quiet()
    assert.equal(seen.decisions(), 2)
    const firstSuccess = store.events(id).find(event => event.type === 'decide.succeeded' && event.revision > firstPairRevision)!
    const before = store.graphAt(id, firstPairRevision), acknowledged = store.graphAt(id, firstSuccess.revision)
    assert.deepEqual([before.project.factSeq, before.project.endedSeq, before.project.acknowledgedFactSeq, before.project.acknowledgedEndedSeq], [1, 1, 0, 0])
    assert.deepEqual([acknowledged.project.factSeq, acknowledged.project.endedSeq, acknowledged.project.acknowledgedFactSeq, acknowledged.project.acknowledgedEndedSeq], [2, 2, 1, 1])
  } finally { release(); await seen.scheduler.close(); store.close() }
})

test('14: failed planning retains its boundary and obeys retryAfter', async () => {
  const store = new Store(':memory:'), id = ready(store), item = execution(store, id, 2)
  fact(store, item); finish(store, item, 'succeeded')
  const failed = store.claim(id, 'decide', worker); store.finishRun(failed.id, 'failed', 'retry')
  const project = store.project(id)
  assert.equal(project.acknowledgedFactSeq, 0); assert.equal(project.acknowledgedEndedSeq, 0); assert.equal(project.planningRetryPending, true)
  assert.ok(project.retryAfter >= Date.now() + 4_000)
  project.retryAfter = Date.now() + 30; saveProject(store, project)
  const seen = counter(store)
  try { seen.scheduler.start(); await quiet(); assert.equal(seen.decisions(), 0); await new Promise(resolve => setTimeout(resolve, 40)); await until(() => seen.decisions() === 1) }
  finally { await seen.scheduler.close(); store.close() }
})

test('15: failed first planning remains eligible for retry', async () => {
  const store = new Store(':memory:'), id = create(store), failed = store.claim(id, 'decide', worker)
  store.finishRun(failed.id, 'failed', 'retry')
  const project = store.project(id); assert.equal(project.initialPlanningPending, true); assert.equal(project.planningRetryPending, true)
  project.retryAfter = 0; saveProject(store, project)
  const seen = counter(store)
  try { seen.scheduler.start(); await until(() => seen.decisions() === 1) }
  finally { await seen.scheduler.close(); store.close() }
})

test('critical verified events wake Decide at capacity, deduplicate, and do not relax Step limits', async () => {
  const store = new Store(':memory:'), id = create(store), criticalWorker: Worker = { ...worker, name: 'critical', explore: true, maxRunning: 2 }
  const cfg = { ...config(1), workers: [criticalWorker], maxWorkers: 2, maxProjectWorkers: 2 }
  let decisions = 0, release!: () => void, executeStarted!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), executing = new Promise<void>(resolve => { executeStarted = resolve })
  const scheduler = new Scheduler(store, cfg, async ({ run }) => {
    if (run.activity === 'decide') decisions++
    else { executeStarted(); await gate }
  })
  try {
    scheduler.start(); await until(() => decisions === 1 && scheduler.activeRuns.length === 0)
    store.addStep(id, { description: 'Long-running exploration', sourceIds: ['origin'] })
    await executing
    assert.equal(store.recordCriticalSignal(id, 'platform-flag:one', { source: 'platform-confirmed-flag' }), true)
    assert.equal(store.recordCriticalSignal(id, 'platform-flag:one', { source: 'platform-confirmed-flag' }), false)
    await until(() => decisions === 2)
    await quiet()
    assert.equal(scheduler.activeRuns.filter(run => run.activity === 'decide').length, 0)
    assert.equal(store.project(id).acknowledgedCriticalSeq, 1)
    assert.throws(() => store.addStep(id, { description: 'Over capacity', sourceIds: ['origin'] }, 1), /Active Step limit/)
  } finally { release(); await scheduler.close(); store.close() }
})

test('16: disk recovery retains pending boundaries and retries interrupted planning', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-wake-')), filename = path.join(root, 'engine.db')
  try {
    let store = new Store(filename)
    const id = ready(store), item = execution(store, id, 2); fact(store, item); finish(store, item, 'succeeded'); store.claim(id, 'decide', worker); store.close()
    store = new Store(filename); store.recover()
    const project = store.project(id)
    assert.equal(project.acknowledgedFactSeq, 0); assert.equal(project.acknowledgedEndedSeq, 0); assert.equal(project.planningRetryPending, true)
    assert.equal(store.runs(id).at(-1)?.status, 'unknown'); store.close()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('17: stopped and completed projects preserve pending boundaries without planning', async () => {
  const store = new Store(':memory:'), stopped = ready(store), a = execution(store, stopped, 2)
  fact(store, a); finish(store, a, 'succeeded'); store.setStatus(stopped, 'stopped')
  const completed = ready(store), b = execution(store, completed, 3), proof = fact(store, b); finish(store, b, 'succeeded'); store.updateGoal(completed, 'goal', { status: 'achieved', evidenceIds: [proof.id] })
  const seen = counter(store)
  try {
    seen.scheduler.start(); await quiet(); assert.equal(seen.decisions(), 0)
    store.setStatus(stopped, 'active'); await until(() => seen.decisions() === 1)
    assert.equal(store.project(completed).factSeq > store.project(completed).acknowledgedFactSeq, true)
  } finally { await seen.scheduler.close(); store.close() }
})

test('18: deterministic planner fills free capacity with finite nonduplicate work', async () => {
  const store = new Store(':memory:'), id = create(store), candidates = [2, 2, 3, 4, 5]
  const seen = counter(store, 3, (s, projectId) => {
    for (const input of new Set(candidates)) {
      const occupied = s.nodes(projectId, ['step']).filter((node: any) => ['pending', 'running', 'paused'].includes(node.status)).length
      if (occupied >= 3) break
      if (!s.nodes(projectId, ['step']).some((node: any) => node.description === `Square ${input}`)) s.addStep(projectId, { description: `Square ${input}`, sourceIds: ['origin'] }, 3)
    }
  })
  try {
    seen.scheduler.start(); await until(() => seen.decisions() === 1); await quiet()
    let steps = store.nodes<any>(id, ['step']); assert.equal(steps.length, 3); assert.equal(new Set(steps.map(step => step.description)).size, 3)
    const first = steps[0], run = store.claim(id, 'execute', worker, first.id); store.addFact(id, 'verified square', { runId: run.id }); store.finishRun(run.id, 'succeeded')
    await until(() => seen.decisions() === 2); steps = store.nodes<any>(id, ['step']); assert.equal(steps.length, 4)
  } finally { await seen.scheduler.close(); store.close() }
})

test('19: no useful candidates permits an unsaturated plan without spinning', async () => {
  const store = new Store(':memory:'), id = create(store), seen = counter(store, 3)
  try { seen.scheduler.start(); await until(() => seen.decisions() === 1); await quiet(); assert.equal(seen.decisions(), 1); assert.equal(store.nodes(id, ['step']).length, 0) }
  finally { await seen.scheduler.close(); store.close() }
})

test('critical-event plugin gate restores ordinary wake semantics without discarding signals',async()=>{
 const store=new Store(':memory:'),id=ready(store)
 let enabled=false,decisions=0
 const scheduler=new Scheduler(store,config(),async({run})=>{if(run.activity==='decide')decisions++},undefined,()=>enabled)
 try {
  scheduler.start();store.recordCriticalSignal(id,'verified-new',{kind:'route.verified'});await quiet();assert.equal(decisions,0)
  enabled=true;scheduler.wake();await until(()=>decisions===1);assert.equal(store.project(id).acknowledgedCriticalSeq,1)
 } finally {await scheduler.close();store.close()}
})
