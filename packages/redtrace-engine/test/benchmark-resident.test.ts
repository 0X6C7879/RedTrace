import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {legionTools} from '../src/legion-tools.ts'
import {graphTools} from '../src/runner.ts'
import {Scheduler} from '../src/scheduler.ts'
import {legionMission} from '../src/legion-missions.ts'
const worker={name:'fixture',backend:'mock' as const,enabled:true,roles:['scout','soldier','general'] as any,maxRunning:4,priority:0,provider:'mock',model:'mock'}
const config={workers:[worker],providers:{},maxWorkers:4,maxProjectWorkers:4,maxRunningProjects:1,maxSteps:null,workspaceRoot:'/tmp/benchmark-resident-fixture'} as any
function fixture(t:any){const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'local',origin:'authorized fixture',goal:'verify'}).project,legion=new LegionStore(store,p.id);t.after(()=>store.close());return{store,p,legion}}

test('Benchmark registers compact global tools directly, with no FGS or redundant Project parameters',async t=>{
 const{store,p,legion}=fixture(t);legion.claimCommand();const tools=legionTools(store,'commander',p.id,null,()=>{},config)
 const forbidden=['legion_graph','legion_hint','legion_read_node','legion_goal','legion_update_goal','legion_update_step','legion_manage_evidence','legion_accept','legion_classify','legion_confirm_transfer','legion_evidence_read','legion_experience_capture','legion_finish','TodoWrite','legion_todos','submit_fact','submit_finding']
 for(const name of forbidden)assert(!tools.some(t=>t.name===name),name)
 assert.equal(tools.length,18)
 for(const tool of tools){const schema=JSON.parse(JSON.stringify(tool.parameters));assert.equal(schema.additionalProperties,false);assert(!schema.properties.projectId);assert(!schema.properties.graphId)}
 assert(Buffer.byteLength(JSON.stringify(tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))))<10500)
 assert(Buffer.byteLength(legionMission('commander','benchmark'))<4000)
 await assert.rejects(tools.find(t=>t.name==='legion_spawn')!.execute('',{projectId:p.id,role:'scout',taskKey:'T',mission:'classify'}),/Invalid tool arguments/)
 const spawn=await tools.find(t=>t.name==='legion_spawn')!.execute('',{role:'scout',taskKey:'T',mission:'classify'})
 const step=spawn.details as any,graph=store.projectGraphs(p.id)[0];assert.equal(step.graphId,graph.id);assert.deepEqual(step.sourceIds,[graph.originId])
})

test('Commander changes contain scheduling metadata, not FGS nodes, Docs or historical bodies',async t=>{
 const{store,p,legion}=fixture(t);legion.claimCommand();const g=store.createGraph(p.id,{taskKey:'T',title:'local',origin:'local',goal:'verify'})
 store.forGraph(p.id,g.id).addFact(p.id,'PRIVATE_FGS_BODY',{title:'private title',evidence:[{description:'PRIVATE_EVIDENCE_BODY'}]})
 store.graph=()=>{throw Error('Full FGS read forbidden')};store.graphDelta=()=>{throw Error('FGS body projection forbidden')}
 const changes=legionTools(store,'commander',p.id,null,()=>{},config).find(t=>t.name==='legion_read_changes')!
 let cursor=0,hasMore=true,total=0;while(hasMore){const page=(await changes.execute('',{after:cursor,limit:1})).details as any;assert(!JSON.stringify(page).includes('PRIVATE_'));assert(!('nodes' in page));cursor=page.cursor;hasMore=page.hasMore;total+=page.events.length}
 assert(total>0);let finished=false;await legionTools(store,'commander',p.id,null,()=>{finished=true},config).find(t=>t.name==='legion_wait')!.execute('',{through:cursor});assert(finished);assert.equal(legion.campaign().cursors[p.id].acknowledged,cursor)
 assert.equal(((await changes.execute('',{})).details as {hasMore:boolean}).hasMore,false)
})

test('Scout classification publishes after successful completion, without Commander evidence operations',async t=>{
 const{store,p,legion}=fixture(t);const g=store.createGraph(p.id,{taskKey:'T',title:'local',origin:'local',goal:'verify'});legion.spawn(p.id,{role:'scout',taskKey:'T',description:'classify',sourceIds:[g.originId]})
 const scheduler=new Scheduler(store,config,async context=>{
   const tools=graphTools(context,()=>{});assert(!tools.some(t=>t.name==='legion_accept'));await tools.find(t=>t.name==='submit_fact')!.execute('',{title:'product verified',description:'local product/version',evidence:[{description:'local fixture'}]})
   const finish=tools.find(t=>t.name==='finish_step')!;await assert.rejects(finish.execute('',{summary:'missing verdict'}),/Invalid tool arguments/)
   await finish.execute('',{summary:'classification evidence complete',difficulty:'hard',family:'generic-product'})
 })
 try{scheduler.start();for(let i=0;i<50&&!legion.tactics(p.id)[0]?.classification;i++)await new Promise(r=>setImmediate(r));assert.equal(legion.tactics(p.id)[0].classification.difficulty,'hard');assert.equal(legion.tactics(p.id)[0].classification.family,'generic-product');assert.equal(legion.tactics(p.id)[0].recommendation,'general')}finally{await scheduler.close()}
 legion.claimCommand();const command=legionTools(store,'commander',p.id,null,()=>{},config);const general=(await command.find(t=>t.name==='legion_spawn')!.execute('',{taskKey:'T',role:'general',mission:'solve the chain'})).details as any;assert.equal(general.role,'general')
 const reuse=(await command.find(t=>t.name==='legion_spawn')!.execute('',{taskKey:'unrelated-platform-name',role:'general',mission:'verify sibling differences',reuseTaskKey:'T'})).details as any;assert.equal(reuse.role,'general');assert.equal(legion.tactics(p.id).find(t=>t.taskKey==='unrelated-platform-name')!.classification.sourceTaskKey,'T')
})

test('General/Soldier owns scoped FGS planning and task acceptance; all task outcomes end Benchmark',async t=>{
 const{store,p,legion}=fixture(t),graphs=['A','B'].map(taskKey=>store.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
 assert.equal(legion.completeBenchmark(p.id),false)
 for(const [i,g] of graphs.entries()){
  const scoped=store.forGraph(p.id,g.id),step=scoped.addStep(p.id,{role:i?'general':'soldier',taskKey:g.taskKey!,description:'solve task',sourceIds:[g.originId]}),run=store.claim(p.id,'execute',worker,step.id),fact=scoped.addFact(p.id,'verified result',{runId:run.id,evidence:[{description:'local actual evidence'}]})
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


test('native Benchmark hard verdict routes directly to General and General accepts its own task',{timeout:90000},async()=>{const{execFile}=await import('node:child_process'),{promisify}=await import('node:util');const result=await promisify(execFile)(process.execPath,[new URL('./benchmark-autonomy.fixture.mjs',import.meta.url).pathname,'hard'],{maxBuffer:2*1024*1024});assert.match(result.stdout,/BENCHMARK_AUTONOMY=true/);assert.match(result.stdout,/GENERAL/)})
