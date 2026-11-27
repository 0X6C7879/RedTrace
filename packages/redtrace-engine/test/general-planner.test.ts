import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync,mkdirSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {Configuration} from '../src/config.ts'
import {legionTools} from '../src/legion-tools.ts'
import {graphTools,launchContext} from '../src/runner.ts'
import {Scheduler} from '../src/scheduler.ts'
import {chatTools} from '../src/chat.ts'
import type {Step,Goal,Fact,EngineConfig,Worker} from '../src/types.ts'

const worker:Worker={name:'pool',roles:['soldier'],provider:'mock',model:'mock',backend:'mock',enabled:true,maxRunning:3,priority:0}

test('General Frontier gates dependencies at atomic claim; independent Steps still run concurrently',async()=>{
 const store=new Store(':memory:'),root=mkdtempSync(path.join(os.tmpdir(),'general-frontier-'))
 let release!:()=>void;const held=new Promise<void>(r=>release=r)
 const config={workers:[worker],workspaceRoot:root,maxProjectWorkers:3,maxRunningProjects:1,maxSteps:null} as EngineConfig
 const scheduler=new Scheduler(store,config,async()=>held)
 try{
  const p=store.createProject({title:'serial',origin:'fixture',goal:'verify'}).project
  const a=store.addStep(p.id,{description:'first',sourceIds:['origin']}),b=store.addStep(p.id,{description:'second',sourceIds:['origin'],dependsOn:[a.id]}),c=store.addStep(p.id,{description:'independent',sourceIds:['origin']})
  assert.throws(()=>store.claim(p.id,'execute',worker,b.id),/not claimable/)
  scheduler.start();for(let i=0;i<20&&scheduler.activeRuns.length<2;i++)await new Promise(r=>setImmediate(r))
  assert.deepEqual(scheduler.activeRuns.map(r=>r.stepId).sort(),[a.id,c.id].sort())
  assert.equal(store.node<Step>(p.id,b.id).status,'pending')
  const first=scheduler.activeRuns.find(r=>r.stepId===a.id)!
  assert.throws(()=>store.claim(p.id,'execute',worker,a.id),/not claimable/,'one atomic claimant per Step')
  store.finishRun(first.id,'failed','fixture failure');assert(!store.stepReady(b),'failed prerequisites do not unlock downstream work')
  store.updateStep(p.id,a.id,{status:'pending'})
  const retry=store.claim(p.id,'execute',worker,a.id)
  store.addFact(p.id,'first stage verified',{runId:retry.id,evidence:[{description:'fixture evidence'}]});store.finishRun(retry.id,'succeeded')
  const run=store.claim(p.id,'execute',worker,b.id);assert.equal(run.stepId,b.id)
 }finally{release();await scheduler.close();store.close();rmSync(root,{recursive:true,force:true})}
})

test('Planner TodoList survives Store reopen without FGS writes; Worker cannot read or maintain the plan',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'general-plan-')),file=path.join(root,'engine.db');let store=new Store(file)
 try{
  const p=store.createProject({title:'plan',origin:'fixture',goal:'verify'}).project,g=store.projectGraphs(p.id)[0],l=new LegionStore(store,p.id);l.claimCommand()
  const tools=legionTools(store,'commander',p.id,null,()=>{},undefined,l.planningTodos(p.id)),write=tools.find(t=>t.name==='TodoWrite')!
  const todos=[{content:'1 verify entry; Goal goal',status:'in_progress'},{content:'2 use credentials after 1',status:'pending'}]
  const before=JSON.stringify(store.graph(p.id))
  await write.execute('save',{projectId:p.id,graphId:g.id,todos})
  assert.equal(JSON.stringify(store.graph(p.id)),before,'planning notes never create FGS or dispatch work')
  store.close();store=new Store(file)
  const next=new LegionStore(store,p.id);assert.deepEqual(next.planningTodos(p.id).list(g.id),todos)
  const s=store.addStep(p.id,{description:'execute entry',sourceIds:['origin']}),run=store.claim(p.id,'execute',worker,s.id)
  const context={store,run,worker,config:{workspaceRoot:root,maxSteps:null} as EngineConfig,signal:new AbortController().signal}
  const names=graphTools(context,()=>{}).map(t=>t.name)
  for(const name of ['TodoWrite','legion_todos','legion_spawn','legion_step','legion_update_step','legion_goal','legion_accept','legion_experience_search'])assert(!names.includes(name),name)
  const launch=launchContext(store,run.id);assert(!('planningTodos' in launch));assert(!('planningCapacity' in launch));assert(!('step' in launch));assert.equal(launch.dependencies?.length,0)
  const query=chatTools(store).find(t=>t.name==='project_query')!
  await assert.rejects(query.execute('read-plan',{projectId:p.id,kind:'plan'}),/only by Planner/)
  store.audit({id:'planner-session',project_id:p.id,graph_id:g.id,task_type:'general'},[{kind:'tool.started',title:'TodoWrite',call_id:'plan',arguments:{todos}}])
  const read=graphTools(context,()=>{}).find(t=>t.name==='read_execution')!
  const history=await read.execute('runs',{});assert(!(history.details as any).runs.some((r:any)=>r.id==='planner-session'))
  await assert.rejects(read.execute('plan-history',{run_id:'planner-session'}),/not in this Graph/)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('v2 qualifications/tool bindings collapse Leader/Operator once and preserve Benchmark routes',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'general-v3-'))
 try{
  mkdirSync(path.join(root,'.redtrace'));writeFileSync(path.join(root,'.redtrace/redtrace.yaml'),'role_version: 2\nworkers:\n - {name: shared, provider: mock, roles: [commander, general, soldier, planner, leader, operator]}\ntasks:\n operator: {timeout: 77, conclude_timeout: 9}\ntool_settings:\n fixture: {enabled: true, roles: [soldier, leader, operator]}\n')
  const c=new Configuration(root),first=c.read()
  assert.deepEqual(first.raw.workers[0].roles,['commander','general','soldier'])
  assert.deepEqual(first.raw.tool_settings?.fixture.roles,['soldier']);assert.equal(first.raw.tasks?.soldier.timeout,77)
  c.commit(first.revision,()=>{});assert.equal(c.read().raw.role_version,4);assert.equal(c.read().raw.tasks?.operator,undefined)
  assert.deepEqual(c.read().raw.workers[0].roles,first.raw.workers[0].roles)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('General Findings trigger planning without automatically creating report Steps',()=>{
 const store=new Store(':memory:')
 try{
  const p=store.createProject({title:'finding',origin:'fixture',goal:'verify'}).project,fact=store.addFact(p.id,'verified',{evidence:[{description:'fixture'}]})
  const finding=store.addFinding(p.id,{title:'verified fixture',description:'fixture',type:'fixture',severity:'low',factIds:[fact.id]})
  assert.equal(store.nodes(p.id,['step']).length,0)
  assert(store.events(p.id).some(e=>e.type==='finding.added'&&e.nodeId===finding.id))
 }finally{store.close()}
})

test('native Planner debounces FGS/Worker/Finding events and permits zero-Step cycles without spinning',{timeout:30000},async()=>{
 const {promisify}=await import('node:util'),{execFile}=await import('node:child_process')
 const {stdout}=await promisify(execFile)(process.execPath,[new URL('./planner-events.fixture.mjs',import.meta.url).pathname],{timeout:25000,maxBuffer:1024*1024})
 assert.match(stdout,/PLANNER_EVENTS=true/);assert.match(stdout,/burst_rounds=1/);assert.match(stdout,/fact_completion_finding_triggers=true/)
 console.log(stdout.trim())
})

test('stored v2 General Steps migrate to Soldier, preserving custom definitions and audit evidence',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'general-step-v3-')),file=path.join(root,'engine.db');let store=new Store(file)
 try{
  const p=store.createProject({title:'migration',origin:'fixture',goal:'verify'}).project
  const step=store.addStep(p.id,{description:'original Mission',sourceIds:['origin']})
  store.db.prepare("UPDATE nodes SET data=json_set(data,'$.role','leader','$.specialist',json(?),'$.parentStepId','old-parent') WHERE project_id=? AND id=?").run(JSON.stringify({name:'expert',scope:'fixture',responsibilities:'verify',capabilities:['analysis']}),p.id,step.id)
  store.audit({id:'historical',project_id:p.id,task_type:'leader'},[{kind:'tool.started',title:'bash',call_id:'old',arguments:{command:'literal original command'}}])
  const audit=JSON.stringify(store.db.prepare('SELECT data FROM audit_events').all())
  store.close();store=new Store(file)
  const migrated=store.node<Step>(p.id,step.id)
  assert.equal(migrated.role,'soldier');assert.equal(migrated.specialist?.name,'expert');assert.equal(migrated.parentStepId,undefined)
  assert.equal(migrated.description,'original Mission');assert.equal(JSON.stringify(store.db.prepare('SELECT data FROM audit_events').all()),audit)
  const count=store.events(p.id).filter(e=>e.type==='legion.role_migrated').length
  store.close();store=new Store(file);assert.equal(store.events(p.id).filter(e=>e.type==='legion.role_migrated').length,count)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})


test('General stops exhausted work without accepting Goal; negative Facts survive and unfinished work blocks stop',async()=>{
 const store=new Store(':memory:')
 try{
  const p=store.createProject({title:'negative',origin:'local fixture',goal:'verify'}).project,l=new LegionStore(store,p.id)
  l.claimCommand();let finished=false
  const tools=legionTools(store,'commander',p.id,null,()=>{finished=true}),stop=tools.find(t=>t.name==='legion_stop')!
  assert(!tools.some(t=>t.name==='legion_board'))
  const step=store.addStep(p.id,{description:'test one payload on /fixture',sourceIds:['origin']}),run=store.claim(p.id,'execute',worker,step.id)
  await assert.rejects(stop.execute('',{reason:'exhausted',state:'keep state'}),/Unsettled/)
  const fact=store.addFact(p.id,'GET /fixture with payload X returned literal X, not execution; only this endpoint and payload tested',{title:'Payload X did not execute',runId:run.id,evidence:[{description:'fixture stdout: literal X'}]})
  store.finishRun(run.id,'succeeded')
  const changes=l.readChanges(p.id);assert(JSON.stringify(changes).includes(fact.id))
  await stop.execute('',{reason:'tested direction exhausted',state:'Negative Fact '+fact.id+'; no further direction in scope'})
  assert(finished);assert.equal(store.project(p.id).status,'stopped');assert.equal(store.node<Goal>(p.id,'goal','goal').status,'open')
  assert.equal(l.campaign().endgame,'tested direction exhausted');assert(l.campaign().state.includes(fact.id))
  assert.equal(store.node<Fact>(p.id,fact.id,'fact').description,fact.description)
  store.setStatus(p.id,'active');assert.equal(store.project(p.id).status,'active')
 }finally{store.close()}
})

test('Worker system fault with unresolved tool outcome settles unknown without fabricated Fact',async()=>{
 const store=new Store(':memory:'),root=mkdtempSync(path.join(os.tmpdir(),'worker-fault-'))
 const scheduler=new Scheduler(store,{workers:[worker],workspaceRoot:root,maxProjectWorkers:2,maxRunningProjects:1,maxSteps:null} as EngineConfig,async({run})=>{
  store.toolStarted(run.id,'uncertain-call',{name:'fixture',arguments:{}})
  throw Error('fixture transport lost')
 })
 try{
  const p=store.createProject({title:'fault',origin:'fixture',goal:'verify'}).project,s=store.addStep(p.id,{description:'execute',sourceIds:['origin']})
  scheduler.start();for(let i=0;i<30&&!store.runsByStatus('unknown').length;i++)await new Promise(r=>setImmediate(r))
  const [run]=store.runsByStatus('unknown');assert(run);assert.equal(run.stepId,s.id);assert.deepEqual(run.pendingTools,['uncertain-call'])
  assert.equal(store.node<Step>(p.id,s.id).factIds.length,0);scheduler.watchdog();assert.equal(store.runsByStatus('running').length,0)
  assert(store.events(p.id).some(e=>e.type==='execute.unknown'))
 }finally{await scheduler.close();store.close();rmSync(root,{recursive:true,force:true})}
})
