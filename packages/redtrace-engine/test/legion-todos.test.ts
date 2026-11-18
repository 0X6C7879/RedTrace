import {scoutedSpawn} from './scout-fixture.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { CommanderTodos } from '../src/legion-todos.ts'
import { legionTools } from '../src/legion-tools.ts'
import { graphTools, launchContext } from '../src/runner.ts'
import { legionMission } from '../src/legion-missions.ts'
import type { EngineConfig } from '../src/types.ts'

const plan = [{content:'verify entry',status:'in_progress' as const},{content:'get credentials',status:'pending' as const}]
const worker = {name:'fixture',backend:'mock' as const}
function fixture(t: any) {
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'A',origin:'local fixture',goal:'verify'}).project
  const graphs=['A','B'].map(taskKey=>store.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
  const legion=new LegionStore(store);t.after(()=>store.close())
  const tools=(graph=graphs[0],role:'soldier'|'general'|'scout'='general')=>{
    const step=role==='general'?store.addPlanner(p.id,graph.id,{description:'general fixture',sourceIds:[graph.originId]}):store.forGraph(p.id,graph.id).addStep(p.id,{role,taskKey:graph.taskKey!,description:role+' fixture',sourceIds:[graph.originId],goalId:graph.goalId})
    const run=role==='general'?store.forGraph(p.id,graph.id).claim(p.id,'plan',worker):store.claim(p.id,'execute',worker,step.id)
    return legionTools(store,run.id,p.id,null,()=>{})
  }
  return {store,p,graphs,legion,tools}
}

test('Benchmark Generals own separate durable task Graph TodoLists',async t=>{
  const {store,p,graphs,legion,tools}=fixture(t)
  const generalA=tools(),write=generalA.find(t=>t.name==='TodoWrite')!,read=generalA.find(t=>t.name==='legion_todos')!
  assert.deepEqual((await read.execute('empty',{})).details,[{content:'verify',status:'pending'}])
  const before=JSON.stringify(store.forGraph(p.id,graphs[0].id).graph(p.id))
  await write.execute('first',{todos:plan})
  assert.equal(JSON.stringify(store.forGraph(p.id,graphs[0].id).graph(p.id)),before,'TodoWrite never writes FGS or queues Steps')
  assert.deepEqual((await read.execute('read',{})).details,plan)
  assert.deepEqual(legion.planningTodos(p.id).list(graphs[1].id),[])
  const general=tools(graphs[1],'general')
  await general.find(t=>t.name==='TodoWrite')!.execute('graph-B',{todos:[{content:'B only',status:'pending'}]})
  assert.deepEqual(legion.planningTodos(p.id).list(graphs[0].id),plan)
  assert.deepEqual(legion.planningTodos(p.id).list(graphs[1].id),[{content:'B only',status:'pending'}])
  const other=store.createProject({mode:'general',title:'other',origin:'local',goal:'verify'}).project
  assert.deepEqual(legion.planningTodos(other.id).list(graphs[0].id),[])
  assert.deepEqual(new LegionStore(store).planningTodos(p.id).list(graphs[0].id),plan)
  await write.execute('replace',{todos:[{content:'new route',status:'pending'}]})
  assert.deepEqual(legion.planningTodos(p.id).list(graphs[0].id),[{content:'new route',status:'pending'}])
  await write.execute('clear',{todos:[]})
  assert.deepEqual(legion.planningTodos(p.id).list(graphs[0].id),[])
})

test('TodoStore owns snapshots rather than caller arrays',()=>{
  const todos=new CommanderTodos(),input=structuredClone(plan)
  todos.replace('graph',input);input[0].content='mutated input'
  const snapshot=todos.list('graph');snapshot[0].content='mutated output';snapshot.pop()
  assert.deepEqual(todos.list('graph'),plan)
})

test('Benchmark TodoWrite accepts only items and binds writes to the assigned Graph',async t=>{
  const {store,p,graphs,legion,tools}=fixture(t),write=tools().find(t=>t.name==='TodoWrite')!
  const q=store.createProject({mode:'general',title:'foreign',origin:'local',goal:'verify'}).project
  for(const input of [
    {todos:[{content:'bad',status:'failed'}]},
    {todos:[{content:'bad',status:'pending',depends_on:['a']}]},
    {todos:[{status:'pending'}]},
    {projectId:p.id,graphId:graphs[1].id,todos:plan},
    {projectId:q.id,graphId:store.projectGraphs(q.id)[0].id,todos:plan},
  ]) await assert.rejects(write.execute('invalid',input))
  assert.deepEqual(legion.planningTodos(p.id).list(graphs[0].id),[{content:'verify',status:'pending'}])
  assert.deepEqual(legion.planningTodos(p.id).list(graphs[1].id),[])
})

test('Benchmark Commander and Scout have no TodoList tools; Soldier planner and General Commander own their lists',t=>{
  const {store,p,tools}=fixture(t)
  assert(!legionTools(store,'commander',p.id,null,()=>{},undefined,new LegionStore(store).planningTodos(p.id)).some(t=>['TodoWrite','legion_todos'].includes(t.name)))
  for(const role of ['scout'] as const)assert(!tools(undefined,role).some(t=>['TodoWrite','legion_todos'].includes(t.name)))
  const q=store.createProject({mode:'general',title:'roles',origin:'local',goal:'verify'}).project,l=new LegionStore(store,q.id)
  l.claimCommand(q.id)
  assert(legionTools(store,'commander',q.id,null,()=>{},undefined,l.planningTodos(q.id)).some(t=>t.name==='TodoWrite'))
  for(const role of ['worker'] as const){
    const step=l.spawn(q.id,{taskKey:role,role,description:'fixture',sourceIds:['origin']}),run=store.claim(q.id,'execute',worker,step.id)
    assert(!legionTools(store,run.id,q.id,null,()=>{}).some(t=>t.name==='TodoWrite'))
    assert(!graphTools({store,run,worker:worker as any,config:{maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{}).some(t=>t.name==='TodoWrite'))
  }
})

test('Benchmark General owns task subgoals while Commander keeps global allocation',async t=>{
  const {store,p,graphs,tools}=fixture(t)
  const command=legionTools(store,'commander',p.id,null,()=>{})
  assert(!command.some(t=>['legion_goal','legion_update_goal','TodoWrite'].includes(t.name)))
  const general=tools(),create=general.find(t=>t.name==='legion_goal')!
  const goal=(await create.execute('stage',{description:'verify stage'})).details as {id:string}
  assert.equal(store.node(p.id,goal.id,'goal').graphId,graphs[0].id)
  assert(general.some(t=>t.name==='legion_update_goal'))
  const soldier=tools(graphs[1],'soldier');assert(soldier.some(t=>t.name==='legion_goal'));assert(soldier.some(t=>t.name==='TodoWrite'))
})

test('Only Benchmark General prompt owns task planning while General mode Commander remains unchanged',()=>{
  const command=legionMission('commander','benchmark')
  assert(!command.includes('legion_todo'))
  assert(command.includes('You never modify FGS'))
  const prompt=legionMission('general','benchmark');assert(prompt.includes('legion_todo({action:"write",todos})'));assert(prompt.includes('verified FGS Facts'))
  assert(legionMission('soldier','benchmark').includes('legion_todo'));assert(!legionMission('scout','benchmark').includes('legion_todo'))
  const general=legionMission('planner','general')
  for(const text of ['legion_todo','full route once','actual prerequisite Fact IDs','Independent directions'])assert(general.includes(text),text)
  for(const role of ['worker'] as const)assert(!legionMission(role,'general').includes('legion_todo'))
})

test('native DSH wake-ups retain TodoLists, wait for Facts after failure, and dispatch only the next serial stage',{timeout:90000},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[new URL('./legion-todos.fixture.mjs',import.meta.url).pathname],{timeout:80000,maxBuffer:2*1024*1024})
  assert.match(stdout,/TODOS_NATIVE_DSH=true/)
  assert.match(stdout,/fresh_session_memory=true/)
  assert.match(stdout,/failure_does_not_advance=true/)
  assert.match(stdout,/independent_parallel=true/)
  console.log(stdout.trim())
})


test('project-detail HTTP snapshot reads current task Graph TodoList without changing FGS',{timeout:30000},async()=>{
  const {mkdtempSync,rmSync}=await import('node:fs'),{default:os}=await import('node:os'),{default:path}=await import('node:path')
  const {serveEngine}=await import('../src/index.ts')
  const work=mkdtempSync(path.join(os.tmpdir(),'redtrace-todo-http-')),engine=await serveEngine({root:work,port:0,autoStart:false})
  const url='http://127.0.0.1:'+(engine.server.address() as any).port
  const request=async(p:string)=>{const r=await fetch(url+p);return {status:r.status,body:await r.json() as any}}
  try{
    const p=engine.store.createProject({mode:'benchmark',title:'A',origin:'local fixture',goal:'verify'}).project
    const graphs=['A','B'].map(taskKey=>engine.store.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
    const q=engine.store.createProject({mode:'general',title:'other',origin:'local',goal:'verify'}).project
    const base='/v2/projects/'+p.id+'/graph?graphId='
    const a=base+graphs[0].id,b=base+graphs[1].id
    assert.deepEqual((await request(a)).body.planningTodos,[])
    const step=engine.store.addPlanner(p.id,graphs[0].id,{description:'plan',sourceIds:[graphs[0].originId]})
    const run=engine.store.forGraph(p.id,graphs[0].id).claim(p.id,'plan',worker)
    const write=legionTools(engine.store,run.id,p.id,null,()=>{}).find(t=>t.name==='TodoWrite')!
    const before=JSON.stringify(engine.store.forGraph(p.id,graphs[0].id).graph(p.id))
    await write.execute('first',{todos:plan})
    assert.deepEqual((await request(a)).body.planningTodos,plan)
    assert.deepEqual((await request(b)).body.planningTodos,[])
    assert.deepEqual((await request('/v2/projects/'+q.id+'/graph')).body.planningTodos,[])
    const next=[{content:'replacement only',status:'in_progress'}]
    await write.execute('next',{todos:next})
    assert.deepEqual((await request(a)).body.planningTodos,next)
    assert.equal((await request('/v2/projects/'+q.id+'/graph?graphId='+graphs[0].id)).status,404)
    assert.equal(JSON.stringify(engine.store.forGraph(p.id,graphs[0].id).graph(p.id)),before)
    assert(!('planningTodos' in engine.store.forGraph(p.id,graphs[0].id).graph(p.id)))
    assert(!('planningTodos' in (await request('/v2/projects/'+p.id+'/graph/delta?graphId='+graphs[0].id)).body))
  }finally{await engine.close();rmSync(work,{recursive:true,force:true})}
})


test('Benchmark launch and General reinforcement inherit only their assigned task planning memory',async t=>{
 const {store,p,graphs,legion}=fixture(t);legion.planningTodos(p.id).replace(graphs[0].id,plan);
 const spawn=(graph:any,role:'soldier'|'general'|'scout',description:string)=>{const step=scoutedSpawn(legion,p.id,{graphId:graph.id,taskKey:graph.taskKey,role,description,sourceIds:[graph.originId]});return role==='general'?store.forGraph(p.id,graph.id).claim(p.id,'plan',worker):store.claim(p.id,'execute',worker,step.id)};
 const first=spawn(graphs[0],'soldier','initial task planner');assert.deepEqual(launchContext(store,first.id).planningTodos,plan);
 const other=spawn(graphs[1],'soldier','another task planner');assert.deepEqual(launchContext(store,other.id).planningTodos,[{content:'verify',status:'pending'}]);
 const reinforcement=spawn(graphs[0],'general','new strategy reinforcement');assert.deepEqual(launchContext(store,reinforcement.id).planningTodos,plan);assert(!('planningTodos' in launchContext(store,first.id)));
 const scout=spawn(graphs[0],'scout','recon only');assert(!('planningTodos' in launchContext(store,scout.id)));
 const general=legionMission('general','benchmark');for(const rule of ['planningTodos','never duplicate covered work','independent directions remain parallel','one item per real stage'])assert(general.includes(rule));
});
