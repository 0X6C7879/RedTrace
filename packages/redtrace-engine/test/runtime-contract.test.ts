import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { Store } from '../src/store.ts'
import { graphTools, launchContext } from '../src/runner.ts'
import { serveEngine } from '../src/index.ts'
import { executionResult } from '../src/execution-result.ts'
import { resourceTools, verbTask, channelsFor } from '../src/capability-verbs.ts'
import { HttpError } from '../src/types.ts'
import type { EngineConfig, Worker } from '../src/types.ts'
const { executionEvidenceReadGuard } = await import(new URL('../compat/cordis.mjs', import.meta.url).href)
const worker: Worker = {name:'fixture',backend:'mock',provider:'mock',model:'',enabled:true,reason:true,explore:true,bootstrap:false,maxRunning:4,priority:0}

test('capacity and acknowledgement boundaries are explicit; Fact-less completion is still rejected', async () => {
 const store = new Store(':memory:')
 try {
  const project = store.createProject({title:'fixture',origin:'scope',goal:'check',bootstrap:false}).project
  const run = store.claim(project.id,'decide',worker), config={maxSteps:2} as EngineConfig
  let ceiling=2
  const tools=graphTools({store,run,worker,config,currentMaxSteps:()=>ceiling,signal:new AbortController().signal},()=>{}),by=(name:string)=>tools.find(t=>t.name===name)!
  assert.deepEqual(launchContext(store,run.id,[],2).planningCapacity,{maxSteps:2,activeSteps:0,remainingSteps:2})
  await by('add_step').execute('one',{description:'one',sourceIds:['origin']})
  await by('add_step').execute('two',{description:'two',sourceIds:['origin']})
  const read:any=await by('read_graph').execute('state',{})
  assert.equal(read.details.planningCapacity.remainingSteps,0)
  ceiling=4
  assert.deepEqual((await by('read_graph').execute('reloaded',{}) as any).details.planningCapacity,{maxSteps:4,activeSteps:2,remainingSteps:2})
  ceiling=2
  const rejected:any=await by('add_step').execute('full',{description:'three',sourceIds:['origin']})
  assert.equal(rejected.isError,true);assert.equal(rejected.details.context.code,'STEP_LIMIT_REACHED')
  assert.equal(rejected.details.context.planningCapacity.activeSteps,2)
  const delta:any=await by('read_graph_delta').execute('delta',{})
  assert.equal(delta.details.acknowledgementBoundary.throughEvidenceSeq,store.run(run.id).deliveredEvidenceSeq)
  assert.throws(()=>store.acknowledgeEvidence(run.id,999), (error:any)=>{ assert.ok(error instanceof HttpError); assert.deepEqual(error.details,{acknowledgementBoundary:delta.details.acknowledgementBoundary,minimum:0}); return true })
  assert.throws(()=>store.acknowledgeHint(run.id,999),(error:any)=>{ assert.ok(error instanceof HttpError); assert.deepEqual(error.details,{acknowledgementBoundary:delta.details.acknowledgementBoundary,minimum:0}); return true })
  const step=store.nodes(project.id,['step'])[0], execute=store.claim(project.id,'execute',worker,step.id)
  const execTools=graphTools({store,run:execute,worker,config,signal:new AbortController().signal},()=>{})
  await assert.rejects(execTools.find(t=>t.name==='finish_step')!.execute('finish',{summary:'no Fact'}),/must submit at least one Fact/)
  await execTools.find(t=>t.name==='submit_fact')!.execute('fact',{description:'Local fixture verified the expected state',evidence:[{description:'literal fixture output'}]})
  await execTools.find(t=>t.name==='finish_step')!.execute('finish',{summary:'verified'})
  assert.equal(store.finishRun(execute.id,'succeeded').status,'succeeded')
  const another=store.nodes(project.id,['step'])[1],empty=store.claim(project.id,'execute',worker,another.id)
  assert.equal(store.finishRun(empty.id,'succeeded').status,'failed')
 } finally {store.close()}
})

test('Execute recovery guard and evidence_read retain real-path containment and producer integrity', async () => {
 const root=mkdtempSync(path.join(tmpdir(),'redtrace-read-contract-')),store=new Store(':memory:')
 try {
  const project=store.createProject({title:'fixture',origin:'scope',goal:'check',bootstrap:false}).project
  const foreign=store.createProject({title:'foreign',origin:'scope',goal:'check',bootstrap:false}).project
  const producerStep=store.addStep(project.id,{description:'produce',sourceIds:['origin']}),producer=store.claim(project.id,'execute',worker,producerStep.id)
  const foreignStep=store.addStep(foreign.id,{description:'foreign',sourceIds:['origin']}),foreignRun=store.claim(foreign.id,'execute',worker,foreignStep.id)
  const run=store.claim(project.id,'decide',worker),cwd=path.join(root,project.id);run.workspaceRoot=cwd;mkdirSync(cwd)
  const output=Buffer.from('{"fixture":"verified"}'),sha=createHash('sha256').update(output).digest('hex'),id='ev-'+sha
  const evidence=path.join(cwd,'.redtrace-output','evidence',producer.id);mkdirSync(evidence,{recursive:true});writeFileSync(path.join(evidence,id+'.json'),output)
  const guard=executionEvidenceReadGuard(path.join(root,'missing-spill'),cwd),read=(file:string)=>guard({name:'read',arguments:{file_path:file}})
  assert.equal(read(path.join(evidence,id+'.json')),undefined)
  mkdirSync(path.join(cwd,'.redtrace-secrets'));writeFileSync(path.join(cwd,'.redtrace-secrets','secret'),'private')
  assert.ok(read(path.join(cwd,'.redtrace-secrets','secret')))
  const outside=path.join(root,'foreign.txt');writeFileSync(outside,'foreign');symlinkSync(outside,path.join(cwd,'escape.txt'))
  assert.ok(read(outside));assert.ok(read(path.join(cwd,'escape.txt')))
  const tools=graphTools({store,run,worker,config:{workspaceRoot:root,maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{}),tool=tools.find(t=>t.name==='evidence_read')!
  const result:any=await tool.execute('read',{run_id:producer.id,id})
  assert.match(result.content[0].text,/verified/)
  await assert.rejects(tool.execute('foreign',{run_id:foreignRun.id,id}),/another Project/)
  writeFileSync(path.join(evidence,id+'.json'),'tampered')
  await assert.rejects(tool.execute('tamper',{run_id:producer.id,id}),/hash mismatch/)
  rmSync(path.join(evidence,id+'.json'));writeFileSync(outside,output);symlinkSync(outside,path.join(evidence,id+'.json'))
  await assert.rejects(tool.execute('escape',{run_id:producer.id,id}),/escapes producer/)
 } finally {store.close();rmSync(root,{recursive:true,force:true})}
})

test('Resource APIs, task polling and routing stay Project-scoped; accepted large results remain complete', async () => {
 const root=mkdtempSync(path.join(tmpdir(),'redtrace-scope-contract-')),engine=await serveEngine({root,port:0,autoStart:false})
 try {
  const a=engine.store.createProject({title:'a',origin:'scope',goal:'check',bootstrap:false}).project,b=engine.store.createProject({title:'b',origin:'scope',goal:'check',bootstrap:false}).project
  const shell=(pid:string|null)=>engine.operations.create(pid,{kind:'webshell',name:'fixture',target:'http://127.0.0.1:9',metadata:{},secret:{},actor_type:'human',actor:'fixture'}).resource
  const own=shell(a.id),foreign=shell(b.id),global=shell(null)
  const task=engine.operations.createTask(a.id,own.id,{action:'command',actor_type:'human',actor:'fixture',arguments:{command:'not-executed'}})
  const output='X'.repeat(2*1024*1024+100)+'END'
  engine.operations.finish(task.id,executionResult(output,0))
  const result:any=engine.store.db.prepare('SELECT * FROM operation_results WHERE task_id=?').get(task.id)
  assert.equal(result.content,output);assert.equal(result.size_bytes,Buffer.byteLength(output));assert.equal(result.sha256,createHash('sha256').update(output).digest('hex'))
  const file=path.join(engine.operations.outputRoot,'webshell','results',`${task.id}-${result.id}.txt`)
  assert.equal(readFileSync(file,'utf8'),output)
  assert.throws(()=>engine.operations.createTask(a.id,foreign.id,{action:'command',arguments:{command:'never'},actor_type:'worker',actor:'fixture'}),/not found in this Project/)
  assert.throws(()=>engine.operations.createTask(a.id,global.id,{action:'command',arguments:{command:'never'},actor_type:'worker',actor:'fixture'}),/not found in this Project/)
  await assert.rejects(verbTask({operations:engine.operations},task.id,b.id),/not found in this Project/)
  assert.deepEqual(channelsFor({operations:engine.operations},[],8,a.id).map(r=>r.id),[own.id])
  const run=engine.store.claim(a.id,'decide',worker),list=resourceTools({store:engine.store,run,worker,config:{} as EngineConfig,signal:new AbortController().signal},{operations:engine.operations})
  assert.equal((await list.find(t=>t.name==='resource_list')!.execute('list',{}) as any).details.resources.length,1)
  await assert.rejects(list.find(t=>t.name==='resource_get')!.execute('foreign',{resource_id:foreign.id}),/not found in this Project/)
  const url=`http://127.0.0.1:${(engine.server.address() as {port:number}).port}`
  for(const route of [`/projects/${b.id}/resources/${own.id}`,`/projects/${b.id}/operations/tasks/${task.id}`,`/projects/${b.id}/operations/results/${result.id}`]) assert.equal((await fetch(url+route)).status,404)
  assert.equal((await fetch(url+'/projects/_global/resources',{headers:{'x-redtrace-worker':'fixture'}})).status,403)
  const inventory:any=await (await fetch(url+'/projects/_global/resources')).json();assert.equal(inventory.resources.length,3)
  const scoped:any=await (await fetch(url+`/projects/${a.id}/resources`)).json();assert.equal(scoped.resources.length,1)
  const events:any=await (await fetch(url+`/projects/${b.id}/operations/audit`)).json();assert.ok(events.events.every((e:any)=>e.project_id===b.id))
 } finally {await engine.close();rmSync(root,{recursive:true,force:true})}
})
