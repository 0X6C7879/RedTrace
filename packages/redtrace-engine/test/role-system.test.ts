import type {Json} from '../src/types.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Configuration } from '../src/config.ts'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { legionMission } from '../src/legion-missions.ts'
import { legionTools } from '../src/legion-tools.ts'
import { Scheduler } from '../src/scheduler.ts'
import { MODE_ROLES, executorRole, executionRole, type FixedRole } from '../../redtrace-dsh/src/roles.ts'
import { toolStatistics } from '../src/tool-stats.ts'
import { serveEngine } from '../src/index.ts'
import type { EngineConfig, Worker, Step } from '../src/types.ts'

const worker: Worker = { name:'shared',roles:['commander','general','soldier'],provider:'mock',model:'mock',enabled:true,maxRunning:4,priority:0,backend:'mock' }

test('legacy Worker/config migration preserves Benchmark and adds only mapped General qualifications once',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'role-migration-'))
  try {
    mkdirSync(root+'/.redtrace');writeFileSync(root+'/.redtrace/redtrace.yaml',`workers:\n  - name: shared\n    provider: mock\n    roles: [commander, general, soldier]\n  - name: unqualified\n    provider: mock\n    roles: []\ntasks:\n  soldier: {timeout: 77, conclude_timeout: 9}\ntool_settings:\n  fixture: {enabled: true, workers: [shared]}\n`)
    const config=new Configuration(root),first=config.read()
    assert.deepEqual(first.raw.workers[0].roles,MODE_ROLES.benchmark)
    assert.deepEqual(first.raw.workers[1].roles,[])
    assert.deepEqual(first.raw.tool_settings?.fixture.roles,worker.roles)
    assert.equal(first.raw.tool_settings?.fixture.workers,undefined)
    assert.equal(config.resolve(first.raw).taskLimits?.soldier.timeout,77)
    config.commit(first.revision,()=>{})
    assert.deepEqual(config.read().raw.workers[0].roles,worker.roles)
    config.commit(config.read().revision,raw=>{raw.workers[0].roles=['commander','soldier']})
    assert.deepEqual(config.resolvedSnapshot().config.workers[0].roles,['commander','soldier'],'explicit new qualifications do not cross-expand')
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('General is sole Planner; Soldier and custom Executor inherit execution identity without planning tools',async()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({mode:'general',title:'roles',origin:'local',goal:'verify'}).project,l=new LegionStore(store,p.id)
 assert.deepEqual(MODE_ROLES.general,['general','soldier']);assert.equal(store.nodeCount(p.id,'step'),0)
 for(const role of ['general','worker','planner','commander','scout','leader','operator'])assert.throws(()=>store.addStep(p.id,{role:role as any,taskKey:role,description:role,sourceIds:['origin']}),/Invalid general role/)
 l.claimCommand();const tools=legionTools(store,'commander',p.id,null,()=>{},undefined,l.planningTodos(p.id))
 assert(tools.some(t=>t.name==='TodoWrite'));assert(tools.some(t=>t.name==='legion_experience_search'));assert(tools.some(t=>t.name==='legion_experience_capture'))
 const create=tools.find(t=>t.name==='legion_step')!,specialist={name:'CodeAudit',responsibilities:'audit',capabilities:['local code'],scope:'local'}
 for(const custom of [false,true]){
 const step=(await create.execute('create',{projectId:p.id,description:custom?'custom audit':'local work',sourceIds:['origin'],...(custom?{specialist}:{})})).details as Step
 assert.equal(step.role,'soldier');assert.deepEqual(step.specialist,custom?specialist:undefined)
 const run=store.claim(p.id,'execute',worker,step.id),names=legionTools(store,run.id,p.id,null,()=>{}).map(t=>t.name)
 for(const name of ['TodoWrite','legion_todos','legion_goal','legion_accept','legion_spawn','legion_step','legion_roster','legion_experience_search','legion_experience_capture'])assert(!names.includes(name),name)
 assert.match(legionMission('general','general'),/不执行任务/);assert.match(legionMission('soldier','general',false),/你是 SOLDIER/)
 store.finishRun(run.id,'cancelled')
 }
 }finally{store.close()}
})

test('one Worker schedules the correct identity concurrently across both Project modes', async()=>{
  const store=new Store(':memory:'),root=mkdtempSync(path.join(os.tmpdir(),'role-schedule-'))
  let release!:()=>void;const pending=new Promise<void>(r=>release=r)
  const config={workers:[{...worker,roles:['soldier'] as FixedRole[]}],maxProjectWorkers:2,maxRunningProjects:2,workspaceRoot:root,maxSteps:null} as EngineConfig
  const scheduler=new Scheduler(store,config,async()=>pending)
  try {
    for(const mode of ['general','benchmark'] as const){const p=store.createProject({mode,title:mode,origin:'fixture',goal:'verify'}).project,g=mode==='benchmark'?store.createGraph(p.id,{taskKey:'one',title:'one',origin:'fixture',goal:'verify'}):store.projectGraphs(p.id)[0];store.forGraph(p.id,g.id).addStep(p.id,{role:executorRole(mode),taskKey:'one',description:'work',sourceIds:[g.originId]})}
    scheduler.start();for(let i=0;i<30&&scheduler.activeRuns.length<2;i++)await new Promise(r=>setImmediate(r))
    assert.equal(scheduler.activeRuns.length,2);assert(scheduler.activeRuns.every(r=>r.worker==='shared'))
    assert.deepEqual(scheduler.activeRuns.map(r=>store.node<Step>(r.projectId,r.stepId!,'step').role).sort(),['soldier','soldier'])
  } finally {release();await scheduler.close();store.close();rmSync(root,{recursive:true,force:true})}
})

test('tool audit pairs Run+Call, counts all filtered data before history pagination, and preserves unfinished state',async()=>{
  const store=new Store(':memory:')
  try {
    const projects=['general','benchmark'].map(mode=>store.createProject({mode:mode as 'general'|'benchmark',title:mode,origin:'fixture',goal:'verify'}).project)
    for(const [i,p] of projects.entries()){
      const graph=store.projectGraphs(p.id)[0]??store.createGraph(p.id,{taskKey:'one',title:'one',origin:'fixture',goal:'verify'})
      const events=[]
      for(let n=0;n<251;n++){
        const call_id='call-'+n,timestamp='2026-11-16T00:00:00.000Z'
        events.push({event_uid:`${i}-${n}-start`,kind:'tool.started',title:'bash',call_id,timestamp,arguments:{command:'printf fixture'}})
        if(n<250)events.push({event_uid:`${i}-${n}-end`,kind:'tool.completed',title:'bash',call_id,timestamp:'2026-11-16T00:00:01.000Z',error:n%2===0,content:n%2===0?'fixture error':'fixture output'})
      }
      store.audit({id:'run-'+i,project_id:p.id,graph_id:graph.id,task_type:i?'soldier':'soldier',worker:'shared'},events)
      // Native duplicates are deduped by event UID; even a repeated start with another UID is still the same call.
      store.audit({id:'run-'+i,project_id:p.id,graph_id:graph.id,task_type:i?'soldier':'soldier',worker:'shared'},[{kind:'tool.started',title:'bash',call_id:'call-0',timestamp:'2026-11-16T00:00:00.000Z'}])
    }
    const query=(suffix='')=>toolStatistics(store,new URL('http://fixture/stats?'+suffix),['bash','skill'])
    assert.deepEqual(query().stats,{calls:502,usedTools:1,succeeded:250,failed:250,unfinished:2,commandFailed:0})
    const first=query('mode=general&role=soldier&tool=bash&limit=100'),last=query('mode=general&role=soldier&tool=bash&limit=100&offset=200')
    assert.equal(first.history.length,100);assert.equal(last.history.length,51);assert.equal(last.total,251)
    assert.equal(first.stats.calls,last.stats.calls);assert.equal(first.tools[0].share,1)
    assert.equal(first.history[0].duration_ms,1000);assert.match(String(first.history[0].arguments_summary),/printf fixture/)
    assert.equal(query('mode=benchmark&role=general').stats.calls,0)
    assert.equal(query('projectId='+projects[1].id).stats.calls,251)
    assert.equal(query('from=2026-11-17T00:00:00.000Z').stats.calls,0)
    assert.equal(query('to=2026-11-15T00:00:00.000Z').stats.calls,0)
  } finally {store.close()}
})

test('tool statistics use supplied catalog names without inspecting the live catalog',async()=>{
  let catalogReads=0
  const root=mkdtempSync(path.join(os.tmpdir(),'tool-stat-api-')),engine=await serveEngine({root,autoStart:false,port:0,runtimeCatalog:()=>{
    catalogReads++
    return {tools:[{name:'bash',source:'DSH',scope:'catalog',status:'available',role:'soldier'}],mcp:[]}
  }})
  try {
    const p=engine.store.createProject({title:'fixture',origin:'fixture',goal:'verify'}).project
    engine.store.audit({id:'run',project_id:p.id,task_type:'soldier'},[{kind:'tool.started',title:'bash',call_id:'one',timestamp:'2026-11-16T00:00:00Z'},{kind:'tool.completed',title:'bash',call_id:'one',error:false,timestamp:'2026-11-16T00:00:01Z'},{kind:'tool.started',title:'retired-tool',call_id:'two'}])
    const base='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
    const catalog=await(await fetch(base+'/console/tools')).json() as any
    assert.equal(catalog.stats,undefined);assert.equal(catalog.tools.length,1)
    const stats=await(await fetch(base+'/console/tool-stats?tool=bash&names=bash&to=2026-11-16T00:00:00Z')).json() as any
    assert.equal(stats.stats.calls,1);assert.equal(stats.history[0].role,'soldier');assert.equal(stats.history[0].duration_ms,1000)
    assert.equal(catalogReads,1)
    const legacy=await(await fetch(base+'/console/tool-stats')).json() as any
    assert.equal(legacy.stats.calls,1)
    assert.equal(catalogReads,2)
    assert.equal(stats.projects[0].id,p.id)
  } finally {await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('conversation model catalogs honor Project mode without copying Workers or mixing coordinator qualifications',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'role-model-catalog-')),engine=await serveEngine({root,autoStart:false,port:0})
 try{
  engine.configuration.commit(engine.configuration.read().revision,raw=>{
   raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:1/v1',models:[{id:'model',context_window:10000,max_tokens:1000},{id:'unassigned',context_window:10000,max_tokens:1000}]}}
   raw.workers=[{name:'benchmark-only',provider:'fixture',model:'model',roles:['commander']},{name:'general-only',provider:'fixture',model:'model',roles:['general']}]
  })
  const base='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
  for(const [mode,name] of [['benchmark','benchmark-only'],['general','general-only']]){
   const response=await fetch(base+'/v2/chats/models?mode='+mode),models=await response.json() as any[]
   assert.equal(response.status,200);assert(models.length===2);assert(models.every(m=>m.worker===name))
  }
  assert.equal((await fetch(base+'/v2/chats/models?mode=leader')).status,422)
 }finally{await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('command exit failures are indexed separately from tool errors and survive migration and reopen',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'command-outcomes-'));let store=new Store(path.join(root,'db'))
 try{
 const p=store.createProject({title:'shell',origin:'local',goal:'verify'}).project
 const cases=[{content:'ok',error:false},{content:'failed\n[exit code: 2]',error:false},{content:'stopped\n[killed by signal: SIGTERM]',error:false},{content:'spawn failed',error:true},{content:'job started',error:false,background:true},{content:'partial\n[still running after 1000ms; moved to background job abc]',error:false}]
 store.audit({id:'shell',project_id:p.id,task_type:'soldier'},cases.flatMap((v,i): Record<string,Json>[]=>[{kind:'tool.started',title:'bash',call_id:String(i),arguments:{command:'fixture',run_in_background:v.background??false}},{kind:'tool.completed',title:'bash',call_id:String(i),content:v.content,error:v.error,arguments:{run_in_background:v.background??false}}]))
 const query=()=>toolStatistics(store,new URL('http://fixture/stats?tool=bash'),['bash'])
 assert.equal(query().stats.succeeded,5);assert.equal(query().stats.failed,1);assert.equal(query().stats.commandFailed,2)
 assert.equal(query().history.find(c=>c.call_id==='1')!.command_exit_code,2);assert.equal(query().history.find(c=>c.call_id==='2')!.command_signal,'SIGTERM');assert.equal(query().history.find(c=>c.call_id==='4')!.command_exit_code,null);assert.equal(query().history.find(c=>c.call_id==='5')!.command_exit_code,null)
 // Exercise the upgrade from the existing compact call index on the same stored events.
 store.db.exec("DELETE FROM metadata WHERE key='tool-command-outcomes'; ALTER TABLE tool_calls DROP COLUMN command_exit_code; ALTER TABLE tool_calls DROP COLUMN command_signal;")
 store.close();store=new Store(path.join(root,'db'))
 assert.equal(query().stats.commandFailed,2);assert.equal(query().history.find(c=>c.call_id==='4')!.command_exit_code,null)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('native JSON-text arguments retain Action counts and background acknowledgements through migration',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'native-args-'));let store=new Store(path.join(root,'db'))
 try{
 const p=store.createProject({title:'args',origin:'local',goal:'verify'}).project
 store.audit({id:'args',project_id:p.id},[{kind:'tool.started',title:'legion_plan',call_id:'action',arguments:'{"action":"accept","expectedVersion":1,"evidenceIds":["f1"]}'},{kind:'tool.completed',title:'legion_plan',call_id:'action',error:false},{kind:'tool.started',title:'bash',call_id:'job',arguments:'{"command":"fixture","run_in_background":true}'},{kind:'tool.completed',title:'bash',call_id:'job',content:'background job started',error:false}])
 const query=()=>toolStatistics(store,new URL('http://fixture/stats?tool=bash'),['bash','legion_plan'])
 assert.deepEqual(query().actions.find(c=>c.name==='legion_plan'),{name:'legion_plan',action:'accept',calls:1});assert.equal(query().history[0].command_exit_code,null)
 store.db.exec("UPDATE tool_calls SET action=NULL,command_exit_code=0; UPDATE metadata SET value='1' WHERE key='tool-command-outcomes'")
 store.close();store=new Store(path.join(root,'db'))
 assert.equal(query().actions.find(c=>c.name==='legion_plan')!.action,'accept');assert.equal(query().history[0].command_exit_code,null)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
