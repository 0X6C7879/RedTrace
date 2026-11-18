import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {legionTools} from '../src/legion-tools.ts'
import {graphTools} from '../src/runner.ts'
import {benchmarkInstance} from '../src/benchmark.ts'
import {domainTools} from '../../redtrace-dsh/src/tool-domains.ts'
import type {EngineConfig,Step,Goal} from '../src/types.ts'
const worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,priority:0,maxRunning:10}

test('completed-task recovery wakes only its existing Planner and never requeues parked attacks',()=>{
 const store=new Store(':memory:');try{
  const p=store.createProject({mode:'benchmark',title:'cleanup recovery',origin:'fixture',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'fixture',goal:'verify'}),scoped=store.forGraph(p.id,g.id),l=new LegionStore(store,p.id)
  store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]});const run=scoped.claim(p.id,'plan',worker);store.completePlanning(run.id,0,'waiting');store.finishRun(run.id,'succeeded')
  const attack=scoped.addStep(p.id,{description:'old attack',role:'soldier',taskKey:'T',sourceIds:[g.originId]});store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T',JSON.stringify({platformCompleted:true}))
  l.park(p.id,'T','cleanup blocked','executor repaired');l.reactivate(p.id,'T','executor repaired')
  assert.equal(store.projectGraph(p.id,g.id).planner!.status,'pending');assert.equal(store.node<Step>(p.id,attack.id,'step').status,'cancelled');assert.equal(store.node<Goal>(p.id,g.goalId,'goal').status,'open')
  assert.throws(()=>l.spawn(p.id,{role:'soldier',taskKey:'T',description:'repeat solved task',sourceIds:[g.originId]}),/platform-completed/)
 }finally{store.close()}
})

test('General acceptance waits for internal instance cleanup, while Commander cannot redispatch solved work',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'completed-instance-cleanup-')),store=new Store(':memory:')
 try{
  const dir=path.join(root,'skills/tsecbench-api');mkdirSync(dir+'/scripts',{recursive:true});writeFileSync(dir+'/SKILL.md','fixture');writeFileSync(dir+'/scripts/tsecbench.py',`import json,sys,pathlib
marker=pathlib.Path(__file__).with_suffix('.closed')
if sys.argv[1:] == ['list']:
 print(json.dumps({'challenges':[{'unique_code':'T','is_completed':True,'container_status':'stopped' if marker.exists() else 'available','container_addr':[]}]}))
else:
 assert sys.argv[1:] == ['close','T']
 marker.touch()
 print(json.dumps({'closed':True,'unique_code':'T'}))
`)
  const p=store.createProject({mode:'benchmark',title:'cleanup',origin:'TSecBench authorized fixture',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),scoped=store.forGraph(p.id,g.id),l=new LegionStore(store,p.id),config={workspaceRoot:root+'/workspaces',maxSteps:3} as EngineConfig
  const planner=store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]}),prun=scoped.claim(p.id,'plan',worker),proofStep=scoped.addStep(p.id,{description:'proof',role:'soldier',taskKey:'T',sourceIds:[g.originId]}),proofRun=store.claim(p.id,'execute',worker,proofStep.id)
  store.audit({id:proofRun.id,project_id:p.id,graph_id:g.id},[{kind:'tool.completed',call_id:'proof',content:'local verified proof'}]);const fact=scoped.addFact(p.id,'verified proof',{runId:proofRun.id,evidence:[{description:'tool stdout',runId:proofRun.id,toolCallId:'proof'}]});store.finishRun(proofRun.id,'succeeded')
  store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T',JSON.stringify({platformCompleted:true}));store.setBenchmarkHosts(p.id,'T',['127.0.0.1:9001'])
  const tools=legionTools(scoped,prun.id,p.id,3,()=>{},config),accept=tools.find(t=>t.name==='legion_accept')!
  await assert.rejects(accept.execute('',{expectedVersion:1,evidenceIds:[fact.id]}),/Confirm managed instance cleanup/)
  assert.throws(()=>l.spawn(p.id,{role:'soldier',taskKey:'T',description:'redo solved task',sourceIds:[g.originId]}),/platform-completed/)
  const cleanup=(await tools.find(t=>t.name==='legion_step')!.execute('',{description:'close only this completed instance and retain confirmation',sourceIds:[fact.id]})).details as Step
  assert.equal(cleanup.plannerId,planner.id)
  store.completePlanning(prun.id,0,'cleanup delegated');store.finishRun(prun.id,'succeeded')
  const run=store.claim(p.id,'execute',worker,cleanup.id)
  assert(!graphTools({store:scoped,run,worker,config,signal:new AbortController().signal},()=>{}).some(tool=>tool.name.startsWith('tsecbench_')))
  await benchmarkInstance(store,config,p.id,'T','close',undefined,run.id)
  assert.equal(store.project(p.id).benchmarkHosts?.T,undefined);store.finishRun(run.id,'succeeded')
  await new Promise(resolve=>setTimeout(resolve,820));scoped.claim(p.id,'plan',worker)
  await accept.execute('',{expectedVersion:1,evidenceIds:[fact.id]});assert.equal(scoped.node<Goal>(p.id,g.goalId,'goal').status,'achieved')
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('Commander dispatches without classification but cannot manipulate task platforms',async()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({mode:'benchmark',title:'boundary',origin:'local fixture',goal:'verify'}).project,l=new LegionStore(store,p.id),g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'})
 l.claimCommand();const tools=domainTools(legionTools(store,'commander',p.id,1,()=>{}))
 assert(!tools.some(t=>['legion_instance','legion_evidence_read','tsecbench_task','tsecbench_submit','legion_experience'].includes(t.name)))
 assert.deepEqual(JSON.parse(JSON.stringify(tools.find(t=>t.name==='legion_platform')!.parameters)).properties.action.enum,['list'])
 assert(!JSON.parse(JSON.stringify(tools.find(t=>t.name==='legion_inspect')!.parameters)).properties.action.enum.includes('run'))
 assert.equal(l.spawn(p.id,{role:'soldier',taskKey:'T',description:'direct dispatch',sourceIds:[g.originId]}).role,'soldier')
 assert.throws(()=>l.spawn(p.id,{role:'scout' as never,taskKey:'T',description:'retired role',sourceIds:[g.originId]}),/Scout is retired/)
 }finally{store.close()}
})

test('internal TSecBench cleanup still blocks on unsettled peers', async () => {
 const root=mkdtempSync(path.join(os.tmpdir(),'platform-cleanup-')),store=new Store(':memory:')
 try {
  const dir=path.join(root,'skills/tsecbench-api');mkdirSync(dir+'/scripts',{recursive:true})
  writeFileSync(dir+'/scripts/tsecbench.py','import json,sys\nassert sys.argv[1:] == ["close","T"]\nprint(json.dumps({"closed":True}))\n')
  const p=store.createProject({mode:'benchmark',title:'platform fixture',origin:'TSecBench local fixture',goal:'verify'}).project
  const g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}), scope=store.forGraph(p.id,g.id)
  const step=scope.addStep(p.id,{role:'soldier',taskKey:'T',description:'fixture',sourceIds:[g.originId]})
  const run=scope.claim(p.id,'execute',worker,step.id), config={workspaceRoot:root+'/workspaces'} as EngineConfig
  store.setBenchmarkHosts(p.id,'T',['127.0.0.1:9001'])
  await assert.rejects(benchmarkInstance(store,config,p.id,'T','close'),/every task execution/)
  assert.deepEqual(store.project(p.id).benchmarkHosts?.T,['127.0.0.1:9001'])
  store.finishRun(run.id,'cancelled')
  assert.deepEqual(await benchmarkInstance(store,config,p.id,'T','close'),{closed:true})
  assert.equal(store.project(p.id).benchmarkHosts?.T,undefined)
 } finally {store.close();rmSync(root,{recursive:true,force:true})}
})

for(const closed of [true,false])test('CLI-started completed instance is settled before Soldier acceptance; closed='+closed,async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'cli-instance-accept-')),store=new Store(':memory:'),dir=path.join(root,'skills/tsecbench-api/scripts')
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})});mkdirSync(dir,{recursive:true})
 writeFileSync(dir+'/tsecbench.py',`import json,sys,pathlib
p=pathlib.Path(__file__).with_suffix('.calls')
with p.open('a') as f: f.write(' '.join(sys.argv[1:])+'\\n')
if sys.argv[1:] == ['list']:
 print(json.dumps({'ok':True,'challenges':[{'unique_code':'T','is_completed':True,'container_status':'available','container_addr':['127.0.0.1:9001']}]}))
else:
 assert sys.argv[1:] == ['close','T']
 print(json.dumps({'closed':${closed?'True':'False'}}))
`)
 const p=store.createProject({mode:'benchmark',title:'CLI lifecycle',origin:'TSecBench fixture',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),scoped=store.forGraph(p.id,g.id)
 new LegionStore(store);const step=scoped.addStep(p.id,{role:'soldier',taskKey:'T',description:'own task',sourceIds:[g.originId]}),run=scoped.claim(p.id,'execute',worker,step.id)
 store.audit({id:run.id,project_id:p.id,graph_id:g.id},[{kind:'tool.completed',call_id:'proof',content:'platform submission accepted'}])
 const fact=scoped.addFact(p.id,'confirmed proof',{runId:run.id,evidence:[{description:'retained result',runId:run.id,toolCallId:'proof'}]})
 assert.equal(store.project(p.id).benchmarkHosts,undefined,'CLI start is not tracked by legacy managed hosts')
 let finished=false;const accept=legionTools(scoped,run.id,p.id,null,()=>{finished=true},{workspaceRoot:root+'/workspaces'} as EngineConfig).find(t=>t.name==='legion_accept')!
 const action=()=>accept.execute('accept',{expectedVersion:1,evidenceIds:[fact.id]})
 if(closed)await action();else await assert.rejects(action(),/close is unconfirmed/)
 assert.equal(finished,closed);assert.equal(scoped.node<Goal>(p.id,g.goalId,'goal').status,closed?'achieved':'open')
 const observed=JSON.parse(String(store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(p.id,'T')!.data)).platformInstance
 assert.equal(observed.status,closed?'stopped':'available','confirmed close must update Board immediately, not wait for Commander polling')
 assert.equal(readFileSync(dir+'/tsecbench.calls','utf8'),'list\nclose T\n')
})
