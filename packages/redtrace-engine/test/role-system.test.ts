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

const worker: Worker = { name:'shared',roles:['commander','general','soldier','scout','planner','worker'],provider:'mock',model:'mock',enabled:true,maxRunning:4,priority:0,backend:'mock' }

test('legacy Worker/config migration preserves Benchmark and adds only mapped General qualifications once',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'role-migration-'))
  try {
    mkdirSync(root+'/.redtrace');writeFileSync(root+'/.redtrace/redtrace.yaml',`workers:\n  - name: shared\n    provider: mock\n    roles: [commander, general, soldier, scout]\n  - name: recon\n    provider: mock\n    roles: [scout]\ntasks:\n  soldier: {timeout: 77, conclude_timeout: 9}\ntool_settings:\n  fixture: {enabled: true, workers: [shared]}\n`)
    const config=new Configuration(root),first=config.read()
    assert.deepEqual(first.raw.workers[0].roles,[...MODE_ROLES.benchmark,...MODE_ROLES.general])
    assert.deepEqual(first.raw.workers[1].roles,['scout'])
    assert.deepEqual(first.raw.tool_settings?.fixture.roles,worker.roles)
    assert.equal(first.raw.tool_settings?.fixture.workers,undefined)
    assert.equal(config.resolve(first.raw).taskLimits?.worker.timeout,77)
    config.commit(first.revision,()=>{})
    assert.deepEqual(config.read().raw.workers[0].roles,worker.roles)
    config.commit(config.read().revision,raw=>{raw.workers[0].roles=['commander','worker']})
    assert.deepEqual(config.resolvedSnapshot().config.workers[0].roles,['commander','worker'],'explicit new qualifications do not cross-expand')
  } finally {rmSync(root,{recursive:true,force:true})}
})

test('General uses only Planner/Worker; only Planner owns FGS/TodoList and neither can create squads', async()=>{
  const store=new Store(':memory:')
  try {
    const p=store.createProject({mode:'general',title:'roles',origin:'fixture',goal:'verify',bootstrap:true}).project,legion=new LegionStore(store,p.id)
    assert.deepEqual(MODE_ROLES.general,['planner','worker'])
    assert.equal(store.nodes<Step>(p.id,['step']).length,0,'Planner creates the first Step, not bootstrap')
    for(const role of ['commander','general','soldier','scout','reporter','leader','operator']) {
      assert.throws(()=>store.addStep(p.id,{role:role as any,taskKey:role,description:role,sourceIds:['origin']}),/Invalid general role/)
      if(role!=='reporter')assert.throws(()=>legionMission(role as any,'general'),/Invalid general role/)
    }
    for(const role of MODE_ROLES.general)assert.match(legionMission(role,'general'),new RegExp('You are '+role.toUpperCase()))
    legion.claimCommand(p.id)
    const coordinator=legionTools(store,'commander',p.id,null,()=>{},undefined,legion.planningTodos(p.id))
    assert(coordinator.some(t=>t.name==='TodoWrite'));assert(coordinator.some(t=>t.name==='legion_accept'))
    assert(!coordinator.some(t=>/^(submit_|resource_|mcp__|legion_experience|legion_transfer|legion_spawn|legion_reassign)/.test(t.name)))
    const create=coordinator.find(t=>t.name==='legion_step')!
    const step=(await create.execute('step',{projectId:p.id,description:'strings',sourceIds:['origin']})).details as Step
    assert.equal(step.role,'worker');assert(!step.specialist);assert(!step.parentStepId)
    await assert.rejects(create.execute('dynamic',{projectId:p.id,description:'strings',sourceIds:['origin'],specialist:{name:'expert'}}))
    const run=store.claim(p.id,'execute',worker,step.id),tools=legionTools(store,run.id,p.id,null,()=>{})
    assert(!tools.some(t=>['TodoWrite','legion_todos','legion_goal','legion_accept','legion_spawn','legion_step','legion_roster','legion_experience_search','legion_experience_capture'].includes(t.name)))
    assert.throws(()=>legion.spawn(p.id,{role:'worker',taskKey:'dynamic',description:'x',sourceIds:['origin'],specialist:{name:'expert',responsibilities:'x',capabilities:[],scope:'x'}}),/not specialist squads/)
    assert.throws(()=>legion.spawn(p.id,{role:'worker',taskKey:'dynamic',description:'x',sourceIds:['origin'],parentRunId:run.id}),/not specialist squads/)
  } finally {store.close()}
})

test('one Worker schedules the correct identity concurrently across both Project modes', async()=>{
  const store=new Store(':memory:'),root=mkdtempSync(path.join(os.tmpdir(),'role-schedule-'))
  let release!:()=>void;const pending=new Promise<void>(r=>release=r)
  const config={workers:[{...worker,roles:['soldier','worker'] as FixedRole[]}],maxWorkers:2,maxProjectWorkers:2,maxRunningProjects:2,workspaceRoot:root,maxSteps:null} as EngineConfig
  const scheduler=new Scheduler(store,config,async()=>pending)
  try {
    for(const mode of ['general','benchmark'] as const){const p=store.createProject({mode,title:mode,origin:'fixture',goal:'verify'}).project,g=mode==='benchmark'?store.createGraph(p.id,{taskKey:'one',title:'one',origin:'fixture',goal:'verify'}):store.projectGraphs(p.id)[0];store.forGraph(p.id,g.id).addStep(p.id,{role:executorRole(mode),taskKey:'one',description:'work',sourceIds:[g.originId]})}
    scheduler.start();for(let i=0;i<30&&scheduler.activeRuns.length<2;i++)await new Promise(r=>setImmediate(r))
    assert.equal(scheduler.activeRuns.length,2);assert(scheduler.activeRuns.every(r=>r.worker==='shared'))
    assert.deepEqual(scheduler.activeRuns.map(r=>store.node<Step>(r.projectId,r.stepId!,'step').role).sort(),['soldier','worker'])
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
      store.audit({id:'run-'+i,project_id:p.id,graph_id:graph.id,task_type:i?'soldier':'worker',worker:'shared'},events)
      // Native duplicates are deduped by event UID; even a repeated start with another UID is still the same call.
      store.audit({id:'run-'+i,project_id:p.id,graph_id:graph.id,task_type:i?'soldier':'worker',worker:'shared'},[{kind:'tool.started',title:'bash',call_id:'call-0',timestamp:'2026-11-16T00:00:00.000Z'}])
    }
    const query=(suffix='')=>toolStatistics(store,new URL('http://fixture/stats?'+suffix),['bash','skill'])
    assert.deepEqual(query().stats,{calls:502,usedTools:1,succeeded:250,failed:250,unfinished:2})
    const first=query('mode=general&role=worker&tool=bash&limit=100'),last=query('mode=general&role=worker&tool=bash&limit=100&offset=200')
    assert.equal(first.history.length,100);assert.equal(last.history.length,51);assert.equal(last.total,251)
    assert.equal(first.stats.calls,last.stats.calls);assert.equal(first.tools[0].share,1)
    assert.equal(first.history[0].duration_ms,1000);assert.match(String(first.history[0].arguments_summary),/printf fixture/)
    assert.equal(query('mode=benchmark&role=worker').stats.calls,0)
    assert.equal(query('projectId='+projects[1].id).stats.calls,251)
    assert.equal(query('from=2026-11-17T00:00:00.000Z').stats.calls,0)
    assert.equal(query('to=2026-11-15T00:00:00.000Z').stats.calls,0)
  } finally {store.close()}
})

test('tool statistics endpoint is lazy, registry-only and independent of catalog loading',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'tool-stat-api-')),engine=await serveEngine({root,autoStart:false,port:0,runtimeCatalog:()=>({tools:[{name:'bash',source:'DSH',scope:'catalog',status:'available',role:'worker'}],mcp:[]})})
  try {
    const p=engine.store.createProject({title:'fixture',origin:'fixture',goal:'verify'}).project
    engine.store.audit({id:'run',project_id:p.id,task_type:'worker'},[{kind:'tool.started',title:'bash',call_id:'one',timestamp:'2026-11-16T00:00:00Z'},{kind:'tool.completed',title:'bash',call_id:'one',error:false,timestamp:'2026-11-16T00:00:01Z'},{kind:'tool.started',title:'retired-tool',call_id:'two'}])
    const base='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
    const catalog=await(await fetch(base+'/console/tools')).json() as any
    assert.equal(catalog.stats,undefined);assert.equal(catalog.tools.length,1)
    const stats=await(await fetch(base+'/console/tool-stats?tool=bash')).json() as any
    assert.equal(stats.stats.calls,1);assert.equal(stats.history[0].role,'worker');assert.equal(stats.history[0].duration_ms,1000)
    assert.equal(stats.projects[0].id,p.id)
  } finally {await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('conversation model catalogs honor Project mode without copying Workers or mixing coordinator qualifications',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'role-model-catalog-')),engine=await serveEngine({root,autoStart:false,port:0})
 try{
  engine.configuration.commit(engine.configuration.read().revision,raw=>{
   raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:1/v1',models:[{id:'model',context_window:10000,max_tokens:1000},{id:'unassigned',context_window:10000,max_tokens:1000}]}}
   raw.workers=[{name:'benchmark-only',provider:'fixture',model:'model',roles:['commander']},{name:'general-only',provider:'fixture',model:'model',roles:['planner']}]
  })
  const base='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
  for(const [mode,name] of [['benchmark','benchmark-only'],['general','general-only']]){
   const response=await fetch(base+'/v2/chats/models?mode='+mode),models=await response.json() as any[]
   assert.equal(response.status,200);assert(models.length===2);assert(models.every(m=>m.worker===name))
  }
  assert.equal((await fetch(base+'/v2/chats/models?mode=leader')).status,422)
 }finally{await engine.close();rmSync(root,{recursive:true,force:true})}
})
