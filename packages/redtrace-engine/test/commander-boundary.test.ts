import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {legionTools} from '../src/legion-tools.ts'
import {graphTools} from '../src/runner.ts'
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
  assert.throws(()=>l.spawn(p.id,{role:'scout',taskKey:'T',description:'repeat solved task',sourceIds:[g.originId]}),/platform-completed/)
 }finally{store.close()}
})

test('General can delegate completed-instance cleanup before acceptance, while Commander cannot redispatch solved work',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'completed-instance-cleanup-')),store=new Store(':memory:')
 try{
  const dir=path.join(root,'skills/tsecbench-api');mkdirSync(dir+'/scripts',{recursive:true});writeFileSync(dir+'/SKILL.md','fixture');writeFileSync(dir+'/scripts/tsecbench.py','import json,sys\nassert sys.argv[1:] == ["close","T"]\nprint(json.dumps({"closed":True,"unique_code":"T"}))\n')
  const p=store.createProject({mode:'benchmark',title:'cleanup',origin:'TSecBench authorized fixture',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),scoped=store.forGraph(p.id,g.id),l=new LegionStore(store,p.id),config={workspaceRoot:root+'/workspaces',maxSteps:3} as EngineConfig
  const planner=store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]}),prun=scoped.claim(p.id,'plan',worker),proofStep=scoped.addStep(p.id,{description:'proof',role:'soldier',taskKey:'T',sourceIds:[g.originId]}),proofRun=store.claim(p.id,'execute',worker,proofStep.id)
  store.audit({id:proofRun.id,project_id:p.id,graph_id:g.id},[{kind:'tool.completed',call_id:'proof',content:'local verified proof'}]);const fact=scoped.addFact(p.id,'verified proof',{runId:proofRun.id,evidence:[{description:'tool stdout',runId:proofRun.id,toolCallId:'proof'}]});store.finishRun(proofRun.id,'succeeded')
  store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T',JSON.stringify({platformCompleted:true}));store.setBenchmarkHosts(p.id,'T',['127.0.0.1:9001'])
  const tools=legionTools(scoped,prun.id,p.id,3,()=>{},config),accept=tools.find(t=>t.name==='legion_accept')!
  await assert.rejects(accept.execute('',{expectedVersion:1,evidenceIds:[fact.id]}),/Assign an execution Worker/)
  assert.throws(()=>l.spawn(p.id,{role:'scout',taskKey:'T',description:'redo solved task',sourceIds:[g.originId]}),/platform-completed/)
  const cleanup=(await tools.find(t=>t.name==='legion_step')!.execute('',{description:'close only this completed instance and retain confirmation',sourceIds:[fact.id]})).details as Step
  assert.equal(cleanup.plannerId,planner.id)
  store.completePlanning(prun.id,0,'cleanup delegated');store.finishRun(prun.id,'succeeded')
  const run=store.claim(p.id,'execute',worker,cleanup.id),task=domainTools(graphTools({store:scoped,run,worker,config,signal:new AbortController().signal},()=>{})).find(t=>t.name==='tsecbench_task')!
  await task.execute('',{action:'close'});assert.equal(store.project(p.id).benchmarkHosts?.T,undefined);store.finishRun(run.id,'succeeded')
  await new Promise(resolve=>setTimeout(resolve,820));scoped.claim(p.id,'plan',worker)
  await accept.execute('',{expectedVersion:1,evidenceIds:[fact.id]});assert.equal(scoped.node<Goal>(p.id,g.goalId,'goal').status,'achieved')
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('Commander cannot bypass completed Scout evidence, manipulate task platforms or redispatch completed work',async()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({mode:'benchmark',title:'boundary',origin:'local fixture',goal:'verify'}).project,l=new LegionStore(store,p.id),g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'})
 l.claimCommand();const tools=domainTools(legionTools(store,'commander',p.id,1,()=>{}))
 assert(!tools.some(t=>['legion_instance','legion_evidence_read','tsecbench_task','tsecbench_submit','legion_experience'].includes(t.name)))
 assert.deepEqual(JSON.parse(JSON.stringify(tools.find(t=>t.name==='legion_platform')!.parameters)).properties.action.enum,['list'])
 assert(!JSON.parse(JSON.stringify(tools.find(t=>t.name==='legion_inspect')!.parameters)).properties.action.enum.includes('run'))
 for(const role of ['soldier','general'] as const)assert.throws(()=>l.spawn(p.id,{role,taskKey:'T',description:'skip recon',sourceIds:[g.originId]}),/Scout/)
 const scout=l.spawn(p.id,{role:'scout',taskKey:'T',description:'recon',sourceIds:[g.originId]}) as Step,run=store.claim(p.id,'execute',worker,scout.id)
 const fact=store.forGraph(p.id,g.id).addFact(p.id,'observed product and entry point',{runId:run.id,evidence:[{description:'fixture probe stdout'}]})
 assert.throws(()=>l.classify(p.id,'T','hard',[fact.id]),/completed Scout/)
 store.finishRun(run.id,'succeeded');l.classify(p.id,'T','hard',[fact.id]);const planner=l.spawn(p.id,{role:'general',taskKey:'T',description:'plan complex task',sourceIds:[fact.id]});assert.equal(planner.role,'general');assert.equal(store.planningCapacity(p.id,1,g.id).activeSteps,0)
 store.db.prepare("UPDATE legion_tasks SET data=json_set(data,'$.platformCompleted',json('true')) WHERE project_id=? AND task_key=?").run(p.id,'T')
 assert.throws(()=>l.spawn(p.id,{role:'scout',taskKey:'T',description:'redo solved task',sourceIds:[fact.id]}),/already platform-completed/)
 assert.match(l.boardSummary('T').lines.join('\n'),/platform-completed/)
 }finally{store.close()}
})

test('assigned execution Worker platform actions retain scope, evidence and close/Hint safety boundaries',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'platform-actions-')),store=new Store(':memory:')
 try{
 const dir=path.join(root,'skills/tsecbench-api');mkdirSync(dir+'/scripts',{recursive:true});writeFileSync(dir+'/SKILL.md','fixture')
 writeFileSync(dir+'/scripts/tsecbench.py',`import json,sys\na=sys.argv[1]\nr={'list':{'challenges':[{'unique_code':'T','is_completed':False},{'unique_code':'OTHER'}]},'start':{'unique_code':'T','container_addr':['127.0.0.1:9001']},'close':{'closed':True},'submit':{'correct':True,'correct_flag_count':1,'total_flag_count':1},'hint':{'hint':'fixture hint'}}\nprint(json.dumps(r[a]))\n`)
 const p=store.createProject({mode:'benchmark',title:'platform',origin:'TSecBench authorized fixture',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),scope=store.forGraph(p.id,g.id)
 const invoke=(role:'scout'|'soldier')=>{const step=scope.addStep(p.id,{role,taskKey:'T',description:role,sourceIds:[g.originId]}),run=scope.claim(p.id,'execute',worker,step.id),tools=domainTools(graphTools({store:scope,run,worker,config:{workspaceRoot:root+'/workspaces',maxSteps:3} as EngineConfig,signal:new AbortController().signal},()=>{}));return{step,run,tool:tools.find(t=>t.name==='tsecbench_task')!}}
 const scout=invoke('scout');assert.deepEqual(JSON.parse(JSON.stringify(scout.tool.parameters)).properties.action.enum,['list','start']);assert.equal(JSON.parse(JSON.stringify((await scout.tool.execute('',{action:'list'})).details)).unique_code,'T');await scout.tool.execute('',{action:'start'});assert.deepEqual(store.project(p.id).benchmarkHosts?.T,['127.0.0.1:9001']);assert.throws(()=>scout.tool.execute('',{action:'submit',unique_code:'T',flag:'fixture'}),/disabled or unavailable/);store.finishRun(scout.run.id,'cancelled')
 const soldier=invoke('soldier');await assert.rejects(soldier.tool.execute('',{action:'submit',unique_code:'OTHER',flag:'fixture'}),/assigned task/);await assert.rejects(soldier.tool.execute('',{action:'hint',confirmScorePenalty:false}),/must be equal to constant|Invalid tool arguments/)
 assert.equal((await soldier.tool.execute('',{action:'hint',confirmScorePenalty:true})).details,'fixture hint')
 const peer=invoke('scout');await assert.rejects(soldier.tool.execute('',{action:'close'}),/every task execution/);store.finishRun(peer.run.id,'cancelled')
 await soldier.tool.execute('',{action:'submit',unique_code:'T',flag:'fixture'});assert.equal(new LegionStore(store,p.id).board().projects[0].platform.T.confirmed,true);assert.equal(scope.nodeCount(p.id,'fact'),1,'platform status is not forged Fact evidence')
 assert.equal(JSON.parse(JSON.stringify((await soldier.tool.execute('',{action:'close'})).details)).closed,true);assert.equal(store.project(p.id).benchmarkHosts?.T,undefined)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})
