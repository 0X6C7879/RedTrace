import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {legionTools} from '../src/legion-tools.ts'
import {graphTools} from '../src/runner.ts'
import {Scheduler} from '../src/scheduler.ts'
import {legionMission} from '../src/legion-missions.ts'
import type {Step,Goal} from '../src/types.ts'
const worker={name:'fixture',backend:'mock' as const,enabled:true,roles:['scout','soldier','general'] as any,maxRunning:4,priority:0,provider:'mock',model:'mock'}
const config={workers:[worker],providers:{},maxProjectWorkers:4,maxRunningProjects:1,maxSteps:null,workspaceRoot:'/tmp/benchmark-resident-fixture'} as any
function fixture(t:any){const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'local',origin:'authorized fixture',goal:'verify'}).project,legion=new LegionStore(store,p.id);t.after(()=>store.close());return{store,p,legion}}

test('legacy tactical STATE is retained in storage but excluded from Benchmark Commander reads',async t=>{
 const{store,p,legion}=fixture(t),old=legion.campaign();legion.saveCampaign({...old,state:'LEGACY_TACTICAL_BODY',nativeCompactionSummary:'LEGACY_TACTICAL_SUMMARY'})
 legion.claimCommand();const state=legionTools(store,'commander',p.id,null,()=>{},config).find(t=>t.name==='legion_state')!
 assert(!JSON.stringify((await state.execute('',{})).details).includes('LEGACY_TACTICAL'))
 assert.equal(legion.campaign().state,'LEGACY_TACTICAL_BODY','inspection does not destroy historical STATE')
 await state.execute('',{summary:'Keep current owners; next action: inspect resource availability'})
 assert.match(JSON.stringify((await state.execute('',{})).details),/Keep current owners/)
 assert.equal(legion.campaign().nativeCompactionSummary,undefined,'an old native summary cannot reintroduce tactics after the next activation')
})

test('Benchmark registers compact global tools directly, with no FGS or redundant Project parameters',async t=>{
 const{store,p,legion}=fixture(t);legion.claimCommand();const tools=legionTools(store,'commander',p.id,null,()=>{},config)
 const forbidden=['legion_graph','legion_hint','legion_read_node','legion_goal','legion_update_goal','legion_update_step','legion_manage_evidence','legion_accept','legion_classify','legion_confirm_transfer','legion_experience_capture','legion_finish','TodoWrite','legion_todos','submit_fact','submit_finding','legion_instance','legion_platform_hint','legion_read_run','legion_evidence_read']
 for(const name of forbidden)assert(!tools.some(t=>t.name===name),name)
 assert.equal(tools.length,16)
 for(const tool of tools){const schema=JSON.parse(JSON.stringify(tool.parameters));assert.equal(schema.additionalProperties,false);assert(!schema.properties.projectId);assert(!schema.properties.graphId)}
 assert(Buffer.byteLength(JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))))<10500)
 assert(Buffer.byteLength(legionMission('commander','benchmark'))<5000)
 await assert.rejects(tools.find(t=>t.name==='legion_spawn')!.execute('',{projectId:p.id,role:'scout' as never,taskKey:'T',mission:'classify'}),/Invalid tool arguments/)
 const spawn=await tools.find(t=>t.name==='legion_spawn')!.execute('',{role:'soldier',taskKey:'T',mission:'solve'})
 const step=spawn.details as any,graph=store.projectGraphs(p.id)[0];assert.equal(step.graphId,graph.id);assert.deepEqual(step.sourceIds,[graph.originId])
})

test('Commander changes contain scheduling metadata, not FGS nodes, Docs or historical bodies',async t=>{
 const{store,p,legion}=fixture(t);legion.claimCommand();const g=store.createGraph(p.id,{taskKey:'T',title:'local',origin:'local',goal:'verify'})
 store.forGraph(p.id,g.id).addFact(p.id,'PRIVATE_FGS_BODY',{title:'private title',evidence:[{description:'PRIVATE_EVIDENCE_BODY'}]})
 store.graph=()=>{throw Error('Full FGS read forbidden')};store.graphDelta=()=>{throw Error('FGS body projection forbidden')}
 const changes=legionTools(store,'commander',p.id,null,()=>{},config).find(t=>t.name==='legion_read_changes')!
 let cursor=0,hasMore=true,total=0;while(hasMore){const page=(await changes.execute('',{after:cursor,limit:1})).details as any;assert(!JSON.stringify(page).includes('PRIVATE_'));assert(!('nodes' in page));cursor=page.cursor;hasMore=page.hasMore;total+=page.events.length}
 assert(total>0);let finished=false;const wait=legionTools(store,'commander',p.id,null,()=>{finished=true},config).find(t=>t.name==='legion_wait')!;await assert.rejects(wait.execute('',{}),/Invalid tool arguments/);assert(!finished);await wait.execute('',{through:cursor});assert(finished);assert.equal(legion.campaign().cursors[p.id].acknowledged,cursor)
 assert.equal(((await changes.execute('',{})).details as {hasMore:boolean}).hasMore,false)
})

test('Commander resolution deltas name the exact Run and task while another Unknown remains reserved',()=>{
 const store=new Store(':memory:');try{
  const p=store.createProject({mode:'benchmark',title:'resolution attribution',origin:'fixture',goal:'verify'}).project,l=new LegionStore(store,p.id),runs=['A','B'].map(taskKey=>{const g=store.createGraph(p.id,{taskKey,title:taskKey,origin:'fixture',goal:'verify'}),s=store.forGraph(p.id,g.id).addStep(p.id,{description:'observe',role:'soldier',taskKey,sourceIds:[g.originId]}),r=store.claim(p.id,'execute',worker,s.id);store.finishRun(r.id,'unknown');return r})
  store.resolveUnknown(runs[0].id,'confirmed cancellation')
  const event=l.readCommandChanges(p.id).events.find(e=>e.type==='execute.resolved') as any
  assert.equal(event.runId,runs[0].id);assert.equal(event.taskKey,'A');assert.equal(store.run(runs[1].id).status,'unknown')
 }finally{store.close()}
})

test('a first patrol can explicitly acknowledge zero without claiming undelivered events',t=>{
 const{p,legion}=fixture(t);legion.claimCommand()
 assert.throws(()=>legion.finishCommand({[p.id]:1},undefined,false),/Acknowledgement/)
 legion.finishCommand({[p.id]:0},undefined,false)
 assert.deepEqual(legion.campaign().cursors[p.id],{delivered:0,acknowledged:0})
})

test('Workers can message the current sleeping Graph Planner without messaging stopped executions or another Graph',()=>{
 const store=new Store(':memory:');try{
  const p=store.createProject({mode:'benchmark',title:'sleeping Planner',origin:'fixture',goal:'verify'}).project,l=new LegionStore(store,p.id),g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'fixture',goal:'verify'}),scoped=store.forGraph(p.id,g.id)
  const planner=store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]}),prun=scoped.claim(p.id,'plan',worker)
  store.completePlanning(prun.id,0,'waiting for evidence');store.finishRun(prun.id,'succeeded')
  const step=scoped.addStep(p.id,{role:'soldier',taskKey:'T',description:'collect evidence',sourceIds:[g.originId]}),run=store.claim(p.id,'execute',worker,step.id)
  const message=l.message(p.id,run.id,prun.id,'REPORT','verified result needs task acceptance')
  assert.equal(l.messages(p.id,prun.id)[0].id,message.id);assert(Number.isFinite(store.plannerWakeAt(store.projectGraph(p.id,g.id).planner!)))
  assert(store.plannerEvents(store.projectGraph(p.id,g.id).planner!).events.some(e=>e.type==='legion.message'&&e.payload.messageId===message.id))
  assert.throws(()=>l.message(p.id,prun.id,run.id,'MESSAGE','stopped sender'),/stopped/)
  const other=store.createGraph(p.id,{taskKey:'OTHER',title:'OTHER',origin:'fixture',goal:'verify'}),foreign=store.forGraph(p.id,other.id).addStep(p.id,{role:'soldier',taskKey:'OTHER',description:'other',sourceIds:[other.originId]}),foreignRun=store.claim(p.id,'execute',worker,foreign.id)
  assert.throws(()=>l.message(p.id,foreignRun.id,prun.id,'REPORT','foreign'),/another Graph/)
  store.savePlanner({...planner,status:'cancelled'});assert.throws(()=>l.message(p.id,run.id,prun.id,'REPORT','retired Planner'),/stopped/)
 }finally{store.close()}
})

test('Benchmark dispatch is immediate without classification or Scout',async t=>{
 const{store,p,legion}=fixture(t);legion.claimCommand()
 const command=legionTools(store,'commander',p.id,null,()=>{},config),spawn=command.find(t=>t.name==='legion_spawn')!
 const soldier=(await spawn.execute('',{taskKey:'T',role:'soldier',mission:'solve directly'})).details as import('../src/types.ts').Step
 assert.equal(soldier.role,'soldier');assert(!legion.tactics(p.id)[0].classification)
 await assert.rejects(spawn.execute('',{taskKey:'retired',role:'scout' as never,mission:'classify'}),/Invalid tool arguments/)
 const unknown=(await spawn.execute('',{taskKey:'unknown',role:'general',mission:'metadata unknown'})).details as import('../src/types.ts').Step
 assert.equal(unknown.role,'soldier')
})

test('General/Soldier owns scoped FGS planning and task acceptance; all task outcomes end Benchmark',async t=>{
 const{store,p,legion}=fixture(t),graphs=['A','B'].map(taskKey=>store.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
 assert.equal(legion.completeBenchmark(p.id),false)
 for(const [i,g] of graphs.entries()){
  const scoped=store.forGraph(p.id,g.id),step=i?store.addPlanner(p.id,g.id,{description:'solve task',sourceIds:[g.originId]}):scoped.addStep(p.id,{role:'soldier',taskKey:g.taskKey!,description:'solve task',sourceIds:[g.originId]}),run=i?scoped.claim(p.id,'plan',worker):store.claim(p.id,'execute',worker,step.id),producer=i?store.claim(p.id,'execute',worker,scoped.addStep(p.id,{description:'collect proof',sourceIds:[g.originId]}).id):run,fact=scoped.addFact(p.id,'verified result',{runId:producer.id,evidence:[{description:'local actual evidence',runId:producer.id,toolCallId:'fixture-proof'}]})
  store.audit({id:producer.id,project_id:p.id,graph_id:g.id},[{kind:'tool.completed',call_id:'fixture-proof',content:'literal local evidence'}])
  let finished=false;const tools=legionTools(scoped,run.id,p.id,null,()=>{finished=true},config),goal=tools.find(t=>t.name==='legion_goal')!,accept=tools.find(t=>t.name==='legion_accept')!
  await assert.rejects(goal.execute('',{description:'cross',parentId:graphs[1-i].goalId}));assert(!tools.some(t=>t.name==='legion_manage_evidence'));const stage=(await goal.execute('',{description:'verify stage'})).details as any;await tools.find(t=>t.name==='legion_update_goal')!.execute('',{id:stage.id,expectedVersion:stage.version,status:'achieved',evidenceIds:[fact.id]});assert.equal((store.node(p.id,stage.id,'goal') as import('../src/types.ts').Goal).status,'achieved')
  await assert.rejects(accept.execute('',{expectedVersion:1,evidenceIds:[g.originId]}));await accept.execute('',{expectedVersion:1,evidenceIds:[fact.id]});assert(finished)
  assert.equal(store.projectGraph(p.id,g.id).status,'completed');store.finishRun(run.id,'cancelled')
  assert.equal(legion.completeBenchmark(p.id),i===1)
 }
 assert.equal(store.project(p.id).status,'completed');assert.equal(legion.campaign().endgame,'all tasks completed')
})

test('platform-confirmed task status is distinct from internal proof; empty campaigns are not accepted',t=>{
 const{store,p,legion}=fixture(t);assert(!legion.completeBenchmark(p.id));const g=store.createGraph(p.id,{taskKey:'T',title:'local',origin:'local',goal:'verify'}),scoped=store.forGraph(p.id,g.id),fact=scoped.addFact(p.id,'internal proof',{evidence:[{description:'local proof'}]})
 scoped.updateGoal(p.id,g.goalId,{status:'achieved',expectedVersion:1,evidenceIds:[fact.id]});store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T',JSON.stringify({platformCompleted:false}));assert(!legion.completeBenchmark(p.id));store.db.prepare('UPDATE legion_tasks SET data=? WHERE project_id=?').run(JSON.stringify({platformCompleted:true}),p.id);assert(legion.completeBenchmark(p.id))
})


for(const [name,fixture,marker] of [
 ['native Benchmark dispatch, task FGS acceptance and deterministic campaign completion','benchmark-autonomy.fixture.mjs','BENCHMARK_AUTONOMY=true'],
 ['native Benchmark compaction restores full STATE into a fresh resident Session','benchmark-resident-context.fixture.mjs','BENCHMARK_RESIDENT_RELAY=true'],
])test(name,{timeout:90000},async()=>{const{execFile}=await import('node:child_process'),{promisify}=await import('node:util');const result=await promisify(execFile)(process.execPath,[new URL('./'+fixture,import.meta.url).pathname],{maxBuffer:2*1024*1024});assert(result.stdout.includes(marker),result.stdout)})


test('native Benchmark multi-flag metadata routes directly to General and General accepts its own task',{timeout:90000},async()=>{const{execFile}=await import('node:child_process'),{promisify}=await import('node:util');const result=await promisify(execFile)(process.execPath,[new URL('./benchmark-autonomy.fixture.mjs',import.meta.url).pathname,'hard'],{maxBuffer:2*1024*1024});assert.match(result.stdout,/BENCHMARK_AUTONOMY=true/);assert.match(result.stdout,/GENERAL/)})


test('native Commander and Worker argument errors identify bad fields without disabling validation',{timeout:90000},async()=>{const{execFile}=await import('node:child_process'),{promisify}=await import('node:util');const r=await promisify(execFile)(process.execPath,[new URL('./benchmark-autonomy.fixture.mjs',import.meta.url).pathname],{env:{...process.env,REDTRACE_INVALID_ACTION_PROBE:'1'},maxBuffer:2*1024*1024});assert.match(r.stdout,/NATIVE_ACTION_DIAGNOSTICS=true/);assert.match(r.stdout,/BENCHMARK_AUTONOMY=true/)})

test('root Goal update uses acceptance and ends its owner normally without cancelling the current tool',async t=>{
 const{store,p}=fixture(t),g=store.createGraph(p.id,{taskKey:'T',title:'fixture',origin:'local',goal:'verify'}),s=store.forGraph(p.id,g.id)
 const step=s.addStep(p.id,{role:'soldier',taskKey:'T',description:'verify',sourceIds:[g.originId]}),run=s.claim(p.id,'execute',worker,step.id)
 store.audit({id:run.id,project_id:p.id,graph_id:g.id},[{kind:'tool.completed',call_id:'proof',content:'local evidence'}])
 const fact=s.addFact(p.id,'confirmed',{runId:run.id,evidence:[{description:'local evidence',runId:run.id,toolCallId:'proof'}]})
 let finished=false
 const update=legionTools(s,run.id,p.id,null,()=>{finished=true},config).find(t=>t.name==='legion_update_goal')!
 await assert.rejects(update.execute('invalid',{id:g.goalId,status:'achieved',description:'changed contract',expectedVersion:1,evidenceIds:[fact.id]}),/immutable/)
 const result=await update.execute('accept',{id:g.goalId,status:'achieved',expectedVersion:1,evidenceIds:[fact.id]})
 assert.equal(result.terminate,true);assert.equal(finished,true);assert.equal(s.node<Step>(p.id,step.id,'step').status,'done');assert.equal(s.node<Goal>(p.id,g.goalId,'goal').status,'achieved')
})

test('root acceptance closes its completed managed instance; General still requires Worker cleanup',async t=>{
 const{mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync}=await import('node:fs'),{tmpdir}=await import('node:os'),{join}=await import('node:path')
 const root=mkdtempSync(join(tmpdir(),'root-accept-cleanup-')),script=join(root,'skills/tsecbench-api/scripts/tsecbench.py')
 t.after(()=>rmSync(root,{recursive:true,force:true}));mkdirSync(join(root,'skills/tsecbench-api/scripts'),{recursive:true})
 writeFileSync(script,'import json,sys\nfrom pathlib import Path\nif sys.argv[1]=="list": print(json.dumps({"challenges":[{"unique_code":"T","is_completed":True,"container_status":"available","container_addr":["fixture.invalid:9000"]}]}))\nelif sys.argv[1:]==["close","T"]:\n Path("closed").write_text("T")\n print(json.dumps({"closed":True}))\nelse: raise ValueError(sys.argv)\n')
 for(const role of ['general','soldier'] as const){
  const store=new Store(':memory:');try{
   const p=store.createProject({mode:'benchmark',title:'fixture',origin:'TSecBench local test',goal:'verify'}).project,l=new LegionStore(store,p.id),g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),s=store.forGraph(p.id,g.id)
   const owner=role==='general'?store.addPlanner(p.id,g.id,{description:'verify',sourceIds:[g.originId]}):s.addStep(p.id,{role,taskKey:'T',description:'verify',sourceIds:[g.originId]}),run=s.claim(p.id,role==='general'?'plan':'execute',worker,role==='soldier'?owner.id:undefined)
   const producer=role==='general'?s.claim(p.id,'execute',worker,s.addStep(p.id,{role:'soldier',taskKey:'T',description:'collect evidence',sourceIds:[g.originId]}).id):run
   store.audit({id:producer.id,project_id:p.id,graph_id:g.id},[{kind:'tool.completed',call_id:'proof',content:'local evidence'}])
   const fact=s.addFact(p.id,'confirmed',{runId:producer.id,evidence:[{description:'local evidence',runId:producer.id,toolCallId:'proof'}]})
   if(role==='general')store.finishRun(producer.id,'succeeded')
   let finished=false
   const update=legionTools(s,run.id,p.id,null,()=>{finished=true},{...config,workspaceRoot:join(root,'workspaces')}).find(t=>t.name==='legion_update_goal')!,args={id:g.goalId,status:'achieved',expectedVersion:1,evidenceIds:[fact.id]}
   if(role==='general'){
    await assert.rejects(update.execute('accept',args),/General cannot operate/);assert.equal(s.node<Goal>(p.id,g.goalId,'goal').status,'open');assert.equal(finished,false)
   }else{
    assert.equal((await update.execute('accept',args)).terminate,true);assert.equal(finished,true);assert.equal(s.node<Step>(p.id,owner.id,'step').status,'done');assert.equal(readFileSync(join(root,'skills/tsecbench-api/scripts/closed'),'utf8'),'T')
    assert.equal(JSON.parse(String(store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(p.id,'T')!.data)).platformInstance.status,'stopped')
   }
  }finally{store.close()}
 }
})
