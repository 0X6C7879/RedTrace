import {scoutedSpawn} from './scout-fixture.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { CommanderTodos, taskTodoOwner } from '../src/legion-todos.ts'
import { graphTools, launchContext } from '../src/runner.ts'
import { ProjectEvidence } from '../src/project-evidence.ts'
import { legionTools } from '../src/legion-tools.ts'
import { Scheduler } from '../src/scheduler.ts'
import type { EngineConfig, Fact, Goal, Step, Run, TaskAssignment, GraphPlanner } from '../src/types.ts'

const worker = {name:'fixture',backend:'mock' as const,provider:'fixture',model:'fixture',enabled:true,roles:['general','soldier'] as ('general'|'soldier')[],priority:0,maxRunning:8}
const settle = async () => { for(let i=0;i<15;i++) await new Promise<void>(r=>setImmediate(r)) }
function fixture(t:any) {
  const root=mkdtempSync(path.join(os.tmpdir(),'artex-planner-')),store=new Store(root+'/engine.db'),legion=new LegionStore(store)
  const p=store.createProject({mode:'benchmark',title:'Planner',origin:'authorized fixture',goal:'verify'}).project
  const graph=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local fixture',goal:'verified objective'})
  mkdirSync(root+'/'+p.id,{recursive:true})
  const scoped=store.forGraph(p.id,graph.id),config={workers:[worker],providers:{},maxWorkers:8,maxProjectWorkers:8,maxRunningProjects:1,maxSteps:null,workspaceRoot:root} as EngineConfig
  const add=(role:'general'|'soldier'='general')=>scoutedSpawn(legion,p.id,{role,taskKey:'A',graphId:graph.id,description:role,sourceIds:[graph.originId]})
  const context=(step:TaskAssignment)=>{const run=step.role==='general'?scoped.claim(p.id,'plan',worker):store.claim(p.id,'execute',worker,step.id);return{store:scoped,run,worker,config,signal:new AbortController().signal}}
  const evidence=new ProjectEvidence(scoped,root)
  const fact=(runId?:string)=>{const artifact=evidence.publish(p.id,Buffer.from('literal local stdout: verified'),{description:'local evidence',...(runId?{runId}:{})});return scoped.addFact(p.id,'verified local result',{...(runId?{runId}:{}),evidence:[{description:'literal stdout',artifactId:artifact.id}]})}
  t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
  return{root,store,legion,p,graph,scoped,config,add,context,evidence,fact}
}

test('Planner owns durable Todo acceptance; unsupported completion and forged/cross-task Facts are rejected',async t=>{
  const f=fixture(t),general=f.add(),ctx=f.context(general),tools=graphTools(ctx,()=>{}),write=tools.find(t=>t.name==='TodoWrite')!
  const plan=[{content:'entry',status:'in_progress',acceptance:'literal proof of entry',stepIds:[]},{content:'objective',status:'pending',acceptance:'objective proof'}]
  await write.execute('plan',{todos:plan})
  for(const invalid of [
    [{content:'entry',status:'completed'}],
    [{content:'entry',status:'completed',acceptance:'proof',factIds:[f.graph.originId]}],
  ])await assert.rejects(write.execute('claim',{todos:invalid}))
  const claimed=f.scoped.addFact(f.p.id,'Worker said done',{evidence:[{description:'unverified text'}]})
  await assert.rejects(write.execute('claim',{todos:[{...plan[0],status:'completed',factIds:[claimed.id]}]}),/real tool result/)
  const child=(await tools.find(t=>t.name==='legion_step')!.execute('dispatch',{description:'collect entry proof',sourceIds:[f.graph.originId]})).details as Step
  const childCtx=f.context(child),childTools=graphTools(childCtx,()=>{})
  assert(!childTools.some(t=>['TodoWrite','legion_todos','legion_step','legion_steps','legion_goal','legion_accept'].includes(t.name)))
  const proof=f.fact(childCtx.run.id);f.store.finishRun(childCtx.run.id,'succeeded')
  assert.equal(f.legion.planningTodos(f.p.id).list(f.graph.id)[0].status,'in_progress','Worker termination cannot check Todo')
  const accepted=[{...plan[0],status:'completed',stepIds:[child.id],factIds:[proof.id]},plan[1]]
  await write.execute('accept',{todos:accepted});assert.deepEqual(f.legion.planningTodos(f.p.id).list(f.graph.id),accepted)
  const foreign=f.store.createGraph(f.p.id,{taskKey:'B',title:'B',origin:'local',goal:'B'}),bad=f.store.forGraph(f.p.id,foreign.id).addFact(f.p.id,'foreign fact',{evidence:[{description:'foreign'}]})
  await assert.rejects(write.execute('cross',{todos:[{...accepted[0],factIds:[bad.id]}]}),/not found|Graph/)
  const artifact=f.evidence.artifact(f.p.id,proof.evidence[0].artifactId!)
  writeFileSync(path.join(f.root,f.p.id,artifact.path),'tampered')
  await assert.rejects(write.execute('tampered',{todos:accepted}),/hash|integrity|mismatch/i)
  f.store.finishRun(ctx.run.id,'succeeded');assert.equal(f.store.projectGraph(f.p.id,f.graph.id).planner!.status,'pending')
  const reopened=new Store(f.root+'/engine.db')
  try{assert.deepEqual(new CommanderTodos(reopened,f.p.id).list(f.graph.id),accepted)}finally{reopened.close()}
})

test('upgrade preserves FGS, evidence, TodoList, runs and one planning owner; duplicate direct creation is rejected',async t=>{
  const f=fixture(t),soldier=f.add('soldier'),ctx=f.context(soldier),oldTools=graphTools(ctx,()=>{}),proof=f.fact(ctx.run.id)
  const finding=f.scoped.addFinding(f.p.id,{title:'local evidence finding',description:'fixture',factIds:[proof.id],runId:ctx.run.id})
  const plan=[{content:'entry',status:'completed',acceptance:'entry proof',stepIds:[soldier.id],factIds:[proof.id]},{content:'next stage',status:'pending'}]
  await oldTools.find(t=>t.name==='TodoWrite')!.execute('save',{todos:plan})
  const before=f.scoped.graph(f.p.id),general=f.add(),planner=f.context(general),snapshot=launchContext(f.scoped,planner.run.id)
  assert.deepEqual(snapshot.planningTodos,plan);assert.deepEqual(f.scoped.graph(f.p.id).facts,before.facts);assert.deepEqual(f.scoped.graph(f.p.id).findings,before.findings)
  assert.equal(f.store.run(ctx.run.id).status,'running');assert.equal(f.store.node<Fact>(f.p.id,proof.id).id,proof.id);assert.equal(f.store.node(f.p.id,finding.id).id,finding.id)
  assert(taskTodoOwner(general,f.store));assert(!taskTodoOwner(soldier,f.store))
  await assert.rejects(oldTools.find(t=>t.name==='TodoWrite')!.execute('stale',{todos:[]}),/ownership transferred/)
  assert.throws(()=>f.scoped.addStep(f.p.id,{role:'general',taskKey:'A',description:'duplicate',sourceIds:[f.graph.originId]}),/Invalid benchmark role/)
  assert(!graphTools(planner,()=>{}).some(t=>/^(submit_|http_|knowledge_|resource_|bash|shell|browser|mcp__)/.test(t.name)))
  assert('plannerRound' in snapshot)
})

test('Max Step counts claimed executions, never Planner or Pending; batches queue atomically',async t=>{
  const f=fixture(t),general=f.add(),ctx=f.context(general);f.store.stepLimit=()=>3
  const tools=legionTools(f.scoped,ctx.run.id,f.p.id,3,()=>{},f.config),batch=tools.find(t=>t.name==='legion_steps')!
  const children=(await batch.execute('queue',{steps:Array.from({length:10},(_,i)=>({description:'angle '+i,sourceIds:[f.graph.originId]}))})).details as Step[]
  assert.equal(f.scoped.nodeCount(f.p.id,'step'),10);assert.equal(f.scoped.planningCapacity(f.p.id).activeSteps,0)
  for(const step of children.slice(0,3))f.context(step)
  assert.equal(f.scoped.planningCapacity(f.p.id).activeSteps,3);assert.throws(()=>f.context(children[3]),/Step limit/)
  await assert.rejects(batch.execute('invalid',{steps:[{description:'valid',sourceIds:[f.graph.originId]},{description:'invalid',sourceIds:['missing']}]}));assert.equal(f.scoped.nodeCount(f.p.id,'step'),10)
  const first=f.store.latestRun(f.p.id,children[0].id)!;f.fact(first.id);f.store.finishRun(first.id,'succeeded');f.context(children[3]);assert.equal(f.scoped.planningCapacity(f.p.id).activeSteps,3)
})

test('Planner and three Workers overlap, event processing commits only on success and quiet heartbeat never wakes LLM',async t=>{
 const f=fixture(t),general=f.add();f.config.maxSteps=3
 const launched:Run[]=[],held=new Map<string,()=>void>()
 const scheduler=new Scheduler(f.store,f.config,async ctx=>{launched.push(ctx.run);if(ctx.run.activity==='plan'){const payload=launchContext(ctx.store,ctx.run.id) as any;const tools=graphTools(ctx,()=>{});if(!ctx.store.nodeCount(f.p.id,'step'))await tools.find(t=>t.name==='legion_steps')!.execute('dispatch',{steps:['A','B','C','D'].map(description=>({description,sourceIds:[f.graph.originId]}))});await tools.find(t=>t.name==='legion_plan_done')!.execute('done',{state:'queued four independent directions',through:payload.plannerRound.triggers.cursor})}else await new Promise<void>(r=>{held.set(ctx.run.id,r);ctx.signal.addEventListener('abort',()=>r(),{once:true})})})
 try{scheduler.start();await settle();assert.equal(launched.filter(r=>r.activity==='execute').length,3);assert.equal(f.scoped.planningCapacity(f.p.id).activeSteps,3);assert.equal(f.scoped.nodeCount(f.p.id,'step'),4)
 await new Promise(r=>setTimeout(r,950));await settle();const rounds=launched.filter(r=>r.activity==='plan').length
 await new Promise(r=>setTimeout(r,950));await settle();assert.equal(launched.filter(r=>r.activity==='plan').length,rounds,'quiet Planner stays asleep')
 const running=launched.find(r=>r.activity==='execute')!;f.fact(running.id);held.get(running.id)!();await settle();assert.equal(launched.filter(r=>r.activity==='execute').length,4,'release automatically dispatches queue')
 await new Promise(r=>setTimeout(r,950));await settle();assert(launched.filter(r=>r.activity==='plan').length>rounds)
 }finally{await scheduler.close()}
})

test('failed Worker retains literal Trace/Output and partial progress for the next Planner round',async t=>{
  const f=fixture(t),general=f.add(),planner=f.context(general),tools=graphTools(planner,()=>{})
  const child=(await tools.find(t=>t.name==='legion_step')!.execute('dispatch',{description:'inspect local service',sourceIds:[f.graph.originId]})).details as Step
  const ctx=f.context(child),proof=f.fact(ctx.run.id),run=f.store.run(ctx.run.id);run.failureCode='TRANSPORT';f.store.saveRun(run)
  f.store.audit({id:run.id,project_id:f.p.id,graph_id:f.graph.id},[{kind:'tool.completed',call_id:'probe',content:'literal stdout: partial progress'},{kind:'error',content:'transport interrupted'}])
  f.store.finishRun(run.id,'failed','transport interrupted')
  const result=(await tools.find(t=>t.name==='legion_read_run')!.execute('read',{runId:run.id})).details as any
  assert.equal(result.run.status,'failed');assert.equal(result.run.failureCode,'TRANSPORT');assert(result.events.some((e:any)=>e.summary==='literal stdout: partial progress'));const event=result.events.find((e:any)=>e.summary==='literal stdout: partial progress');const detail=(await tools.find(t=>t.name==='legion_read_run')!.execute('detail',{runId:run.id,eventId:event.id})).details as any;assert.equal(detail.event.content,'literal stdout: partial progress')
  assert.deepEqual(f.store.node<Step>(f.p.id,child.id).factIds,[proof.id]);assert.equal(f.legion.planningTodos(f.p.id).list(f.graph.id)[0].status,'pending')
  const snapshot=launchContext(f.scoped,planner.run.id) as any
  const saved=f.store.projectGraph(f.p.id,f.graph.id).planner!;saved.retryAfter=Date.now()+2000;f.store.savePlanner(saved)
  f.store.finishRun(planner.run.id,'paused');assert(f.store.plannerWakeAt(f.store.projectGraph(f.p.id,f.graph.id).planner!)>Date.now(),'General recovery observes backoff too')
  assert(snapshot.plannerRound.workers.some((w:any)=>w.id===run.id&&w.error==='transport interrupted'));assert(!JSON.stringify(snapshot).includes('literal stdout: partial progress'),'raw traces stay on demand')
})

test('shipped DSH host registers planning-only General and executing Specialists, then accepts real retained Fact evidence',{timeout:60000},async()=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
  const result=await promisify(execFile)(process.execPath,[new URL('./artex-planner-native.fixture.mjs',import.meta.url).pathname],{timeout:50000,maxBuffer:2*1024*1024})
  assert.match(result.stdout,/ARTEX_NATIVE=true/);assert.match(result.stdout,/planner_no_attack_tools=true/);assert.match(result.stdout,/worker_trace_read=true/)
})


test('exhausted Planner task stops honestly and remains visibly exhausted, never achieved',async t=>{
  const f=fixture(t),general=f.add(),ctx=f.context(general),tools=graphTools(ctx,()=>{})
  f.store.stepLimit=()=>1
  const stop=await tools.find(t=>t.name==='legion_task_stop')!.execute('exhausted',{reason:'Max Step leaves no executable allowance and there is no target proof',state:'Preserve pending objective and all evidence'})
  assert.equal((stop.details as any).status,'cancelled');assert.equal(f.scoped.node<Goal>(f.p.id,f.graph.goalId,'goal').status,'cancelled')
  assert.equal(f.legion.tactics(f.p.id)[0].recommendation,'exhausted');assert(f.legion.boardSummary().lines.some(line=>line.includes('exhausted')))
  assert.equal(f.legion.planningTodos(f.p.id).list(f.graph.id)[0].status,'pending');assert.equal(f.store.project(f.p.id).status,'active')
})


test('Finding report queues even when execution slots are full',t=>{
 const f=fixture(t),soldier=f.add('soldier'),ctx=f.context(soldier),proof=f.fact(ctx.run.id);f.store.stepLimit=()=>1
 const finding=f.scoped.addFinding(f.p.id,{title:'local verified finding',description:'fixture',type:'fixture',severity:'low',factIds:[proof.id],runId:ctx.run.id})
 assert.equal(f.scoped.nodeCount(f.p.id,'step'),2);const report=f.scoped.requestFindingReport(f.p.id,finding.id);assert.equal(report.sourceIds[0],finding.id);assert.throws(()=>f.context(report),/Step limit/)
})

test('legacy completed Todos without Fact acceptance are durably reopened for review without losing the attack chain',t=>{
  const f=fixture(t),general=f.add(),ctx=f.context(general),proof=f.fact()
  const legacy=[{content:'old untraceable completion',status:'completed',stepIds:[general.id]},{content:'verified phase',status:'completed',acceptance:'literal proof',factIds:[proof.id]},{content:'next phase',status:'pending'}]
  f.store.db.prepare('UPDATE commander_todos SET data=? WHERE project_id=? AND graph_id=?').run(JSON.stringify(legacy),f.p.id,f.graph.id)
  f.store.db.prepare("DELETE FROM metadata WHERE key='todo-fact-acceptance'").run()
  const reopened=new Store(f.root+'/engine.db')
  try{
    const actual=new CommanderTodos(reopened,f.p.id).list(f.graph.id)
    assert.deepEqual(actual,[{...legacy[0],status:'in_progress'},legacy[1],legacy[2]])
    const row=reopened.db.prepare('SELECT data FROM commander_todos WHERE project_id=? AND graph_id=?').get(f.p.id,f.graph.id)!
    assert.deepEqual(JSON.parse(String(row.data)),actual);assert.equal(reopened.node(f.p.id,proof.id,'fact').id,proof.id)
  }finally{reopened.close()}
})
