import{LegionStore}from'../src/legion-store.ts'
import{legionTools}from'../src/legion-tools.ts'
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

test('destructive evidence and Step APIs are absent; corrections preserve history and references', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), a = produced(s, id, 'Initial observation')
    const step = s.addStep(id, { description: 'Dependent', sourceIds: [a.fact.id] })
    const corrected = s.addFact(id, 'Correction to '+a.fact.id+': independently verified result', { evidence: [{ description: 'New literal proof' }] })
    for (const name of ['manageEvidence', 'releaseFact', 'deleteStep', 'deleteInput']) assert.equal(name in s, false)
    s.updateStep(id, step.id, { status: 'cancelled' })
    assert.equal(s.node(id, a.fact.id).id, a.fact.id)
    assert.deepEqual(s.node<Step>(id, step.id).sourceIds, [a.fact.id])
    assert.equal(s.nodeCount(id, 'fact'), 3)
    assert.equal(s.node(id, corrected.id).id, corrected.id)
    assert.deepEqual(projectFgs(s.graph(id)).missingReferences, [])
  } finally { s.close() }
})

test('live amendment preserves Run, requires sync and rejects old tool call trees after acknowledgement', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), step = s.addStep(id, { description: 'Original', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    const guard = createPlanGuard(s, run.id); guard.beginTurn()
    assert.equal(guard.check({ name: 'bash', rootCallId: 'old' }), undefined)
    const current = s.node<Step>(id, step.id), amended = s.updateStep(id, step.id, { description: 'Corrected strategy', expectedVersion: current.version, mode: 'amend' })
    assert.equal(s.run(run.id).status, 'running')
    assert.match(guard.check({ name: 'bash', rootCallId: 'old' })!, /Plan changed/)
    assert.equal(guard.check({ name: 'sync_step', rootCallId: 'old' }), undefined)
    const synced = s.syncStep(run.id, amended.planVersion!)
    assert.equal(synced.step.description, 'Corrected strategy')
    assert.match(guard.check({ name: 'bash', rootCallId: 'old' })!, /Old call trees/)
    guard.beginTurn(); assert.equal(guard.check({ name: 'bash', rootCallId: 'new' }), undefined)
    assert.equal(s.updateStep(id, step.id, { requires: ['remote.command'], expectedVersion: s.node(id, step.id).version, mode: 'amend' }).planVersion, amended.planVersion)
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

test('Commander incremental pages cannot acknowledge unseen gaps',()=>{const s=new Store(':memory:');try{const id=project(s),legion=new LegionStore(s);legion.claimCommand();const first=legion.readChanges(id);s.addFact(id,'First');s.addFact(id,'Second');assert.throws(()=>legion.finishCommand({[id]:first.cursor+2},'state'),/exceeds/);let page=legion.readChanges(id,first.cursor,1);while(page.hasMore)page=legion.readChanges(id,page.cursor,1);assert.equal(legion.campaign().cursors[id].acknowledged,0);legion.finishCommand({[id]:page.cursor},'processed');assert.equal(legion.campaign().cursors[id].acknowledged,page.cursor)}finally{s.close()}})

test('Finding and maintenance events reach Commander with bounded graph scans',()=>{const s=new Store(':memory:');try{const id=project(s),a=produced(s,id,'A'),legion=new LegionStore(s);legion.claimCommand();const first=legion.readChanges(id);s.addFinding(id,{title:'Finding',description:'New deliverable',factIds:[a.fact.id]});s.graph=()=>{throw Error('Full graph read forbidden')};let page=legion.readChanges(id,first.cursor,1),seen=false;do{seen ||= page.events.some(e=>e.type==='finding.added');if(!page.hasMore)break;page=legion.readChanges(id,page.cursor,1)}while(true);assert.ok(seen);assert.ok(s.db.prepare("EXPLAIN QUERY PLAN SELECT data FROM nodes WHERE project_id=? AND kind='fact' AND COALESCE(json_extract(data,'$.deleted'),0)=0 LIMIT 1").all(id).some(r=>String(r.detail).includes('nodes_active')))}finally{s.close()}})

test('Commander and task owners can update plans but never delete or merge evidence',()=>{const s=new Store(':memory:');try{const id=project(s);new LegionStore(s).claimCommand();const tools=legionTools(s,'commander',id,null,()=>{});const step=s.addStep(id,{description:'execute',sourceIds:['origin']}),run=s.claim(id,'execute',worker,step.id),exec=graphTools({store:s,run,worker,config,signal:new AbortController().signal},()=>{});assert.ok(exec.some(t=>t.name==='sync_step'));for(const set of [tools,exec])assert.ok(!set.some(t=>t.name==='legion_manage_evidence'));assert.ok(tools.some(t=>t.name==='legion_goal'));assert.ok(tools.some(t=>t.name==='legion_update_step'))}finally{s.close()}})

test('role scheduling honors total and Worker concurrency without an independent Reason slot',async()=>{const s=new Store(':memory:'),id=project(s);for(let i=0;i<4;i++)s.addStep(id,{description:'work '+i,sourceIds:['origin']});let release!:()=>void;const wait=new Promise<void>(r=>release=r),scheduler=new Scheduler(s,{...config,maxWorkers:2,workers:[{...worker,roles:['soldier'],maxRunning:2}]},async()=>wait);try{scheduler.start();await until(()=>scheduler.activeRuns.length===2);assert.equal(s.runs(id).length,2);assert.ok(s.runs(id).every(r=>r.activity==='execute'))}finally{release();await scheduler.close();s.close()}})

test('disabled role routes do not prevent another eligible Project from dispatching',async()=>{const s=new Store(':memory:'),a=project(s),b=project(s);s.addStep(a,{description:'General unavailable',sourceIds:['origin'],role:'general',taskKey:'unavailable'});s.addStep(b,{description:'Soldier available',sourceIds:['origin'],role:'soldier',taskKey:'available'});let release!:()=>void;const wait=new Promise<void>(r=>release=r),scheduler=new Scheduler(s,{...config,workers:[{...worker,roles:['soldier']}]},async()=>wait);try{scheduler.start();await until(()=>scheduler.activeRuns.length===1);assert.equal(scheduler.activeRuns[0].projectId,b)}finally{release();await scheduler.close();s.close()}})


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

test('new Explore deltas start at claim; producing Steps and Facts remain', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s)
    for (let i = 0; i < 501; i++) s.addInput(id, 'observation', `old noise ${i}`)
    const step = s.addStep(id, { description: 'Fresh Explore', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    const page = s.graphDelta(id, run.deliveredGraphCursor, 100, run.id)
    assert.equal(page.events.length, 1); assert.equal(page.events[0].type, 'execute.started'); assert.equal(page.hasMore, false)
    const fact = s.addFact(id, 'Retained evidence fixture', { runId: run.id }); s.finishRun(run.id, 'succeeded')
    assert.equal(s.graph(id).steps.length, 1)
    assert.deepEqual(s.graph(id).steps[0].factIds, [fact.id])
    assert.equal(s.node(id, fact.id).id, fact.id)
  } finally { s.close() }
})

test('stopped contracts never ask to sync; unrelated evidence maintenance does not notify Explore', () => {
 const s=new Store(':memory:'), id=project(s)
 try {
  const unrelated=s.addFact(id,'Unrelated evidence')
  const step=s.addStep(id,{description:'Current',sourceIds:['origin']}),run=s.claim(id,'execute',worker,step.id)
  let cursor=run.deliveredGraphCursor!
  s.addFact(id,'Correction to '+unrelated.id+': new observed evidence')
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
