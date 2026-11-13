import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { CommanderTodos } from '../src/legion-todos.ts'
import { legionTools } from '../src/legion-tools.ts'
import { graphTools } from '../src/runner.ts'
import { legionMission } from '../src/legion-missions.ts'
import type { EngineConfig } from '../src/types.ts'

const plan = [{content:'verify entry',status:'in_progress' as const},{content:'get credentials',status:'pending' as const}]
const worker = {name:'fixture',backend:'mock' as const}
function fixture(t: any) {
  const store=new Store(':memory:'), p=store.createProject({mode:'benchmark',title:'A',origin:'local fixture',goal:'verify'}).project
  const graphs=['A','B'].map(taskKey=>store.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
  const legion=new LegionStore(store), todos=legion.planningTodos(p.id)
  legion.claimCommand(p.id);t.after(()=>store.close())
  const tools=()=>legionTools(store,'commander',p.id,null,()=>{},undefined,legion.planningTodos(p.id))
  return {store,p,graphs,legion,todos,tools}
}

test('Commander reuses Graph memory across activations, isolated by Graph and Project; restart is empty',async t=>{
  const {store,p,graphs,legion,todos,tools}=fixture(t)
  assert.deepEqual(todos.list(graphs[0].id),[])
  const write=tools().find(t=>t.name==='TodoWrite')!
  const before=JSON.stringify(store.forGraph(p.id,graphs[0].id).graph(p.id))
  await write.execute('first',{projectId:p.id,graphId:graphs[0].id,todos:plan})
  assert.equal(legion.planningTodos(p.id),todos)
  assert.deepEqual(todos.list(graphs[0].id),plan)
  assert.deepEqual(todos.list(graphs[1].id),[])
  await write.execute('graph-B',{projectId:p.id,graphId:graphs[1].id,todos:[{content:'B only',status:'pending'}]})
  assert.deepEqual(todos.list(graphs[0].id),plan)
  const other=store.createProject({mode:'general',title:'B',origin:'local',goal:'verify'}).project
  assert.deepEqual(legion.planningTodos(other.id).list(graphs[0].id),[])
  legion.claimCommand(other.id)
  await legionTools(store,'commander',other.id,null,()=>{},undefined,legion.planningTodos(other.id)).find(t=>t.name==='TodoWrite')!.execute('project-B',{projectId:other.id,graphId:store.projectGraphs(other.id)[0].id,todos:[{content:'other Project only',status:'completed'}]})
  assert.deepEqual(todos.list(graphs[0].id),plan)
  assert.deepEqual(todos.list(graphs[1].id),[{content:'B only',status:'pending'}])
  assert.deepEqual(new LegionStore(store).planningTodos(p.id).list(graphs[0].id),[])
  const updated=[{content:'new route',status:'pending'}]
  await tools().find(t=>t.name==='TodoWrite')!.execute('replace',{projectId:p.id,graphId:graphs[0].id,todos:updated})
  assert.deepEqual(todos.list(graphs[0].id),updated)
  assert.equal(JSON.stringify(store.forGraph(p.id,graphs[0].id).graph(p.id)),before,'TodoWrite never writes FGS or queues Steps')
  await write.execute('clear',{projectId:p.id,graphId:graphs[0].id,todos:[]})
  assert.deepEqual(todos.list(graphs[0].id),[])
})

test('TodoStore owns snapshots rather than caller arrays',()=>{
  const todos=new CommanderTodos(),input=structuredClone(plan)
  todos.replace('graph',input);input[0].content='mutated input'
  const snapshot=todos.list('graph');snapshot[0].content='mutated output';snapshot.pop()
  assert.deepEqual(todos.list('graph'),plan)
})

test('TodoWrite validates only the simple schema and existing Project/Graph boundary',async t=>{
  const {store,p,graphs,todos,tools}=fixture(t),write=tools().find(t=>t.name==='TodoWrite')!
  const q=store.createProject({mode:'general',title:'foreign',origin:'local',goal:'verify'}).project
  for(const input of [
    {projectId:p.id,graphId:graphs[0].id,todos:[{content:'bad',status:'failed'}]},
    {projectId:p.id,graphId:graphs[0].id,todos:[{content:'bad',status:'pending',depends_on:['a']}]},
    {projectId:p.id,graphId:graphs[0].id,todos:[{status:'pending'}]},
    {projectId:p.id,todos:plan},
    {projectId:q.id,graphId:store.projectGraphs(q.id)[0].id,todos:plan},
    {projectId:p.id,graphId:store.projectGraphs(q.id)[0].id,todos:plan},
  ]) await assert.rejects(write.execute('invalid',input))
  assert.deepEqual(todos.list(graphs[0].id),[])
})

test('Scout, General, Soldier and ordinary execution tools never register TodoWrite even if given a Store',t=>{
  const {store,p,graphs,todos}=fixture(t)
  // General-mode Missions do not require Benchmark Scout classification.
  const q=store.createProject({mode:'general',title:'roles',origin:'local',goal:'verify'}).project,l=new LegionStore(store,q.id)
  for(const role of ['scout','general','soldier'] as const){
    const step=l.spawn(q.id,{taskKey:role,role,description:'fixture',sourceIds:['origin']}),run=store.claim(q.id,'execute',worker,step.id)
    assert(!legionTools(store,run.id,q.id,null,()=>{},undefined,todos).some(t=>t.name==='TodoWrite'))
    assert(!graphTools({store,run,worker:worker as any,config:{maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{}).some(t=>t.name==='TodoWrite'))
  }
  const step=store.forGraph(p.id,graphs[0].id).addStep(p.id,{description:'ordinary execution',sourceIds:[graphs[0].originId]}),run=store.claim(p.id,'execute',worker,step.id)
  assert(!graphTools({store,run,worker:worker as any,config:{maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{}).some(t=>t.name==='TodoWrite'))
})

test('both Commander modes get serial-chain doctrine without changing Worker missions',()=>{
  for(const mode of ['general','benchmark'] as const){
    const prompt=legionMission('commander',mode)
    for(const text of ['TodoWrite','full route once','actual prerequisite Fact IDs','Independent directions']) {
      assert(prompt.includes(text),text)
    }
    assert(prompt.includes('failure without required Facts does not complete a Todo'))
    for(const role of ['scout','general','soldier'] as const)assert(!legionMission(role,mode).includes('TodoWrite'))
  }
})

test('native DSH wake-ups retain TodoLists, wait for Facts after failure, and dispatch only the next serial stage',{timeout:90000},async()=>{
  const {stdout}=await promisify(execFile)(process.execPath,[new URL('./legion-todos.fixture.mjs',import.meta.url).pathname],{timeout:80000,maxBuffer:2*1024*1024})
  assert.match(stdout,/TODOS_NATIVE_DSH=true/)
  assert.match(stdout,/fresh_session_memory=true/)
  assert.match(stdout,/failure_does_not_advance=true/)
  assert.match(stdout,/independent_parallel=true/)
  console.log(stdout.trim())
})


test('project-detail HTTP snapshot reads current Graph TodoList from the Commander runtime without changing FGS',{timeout:30000},async()=>{
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
    const before=JSON.stringify(engine.store.forGraph(p.id,graphs[0].id).graph(p.id))
    engine.legion.claimCommand(p.id)
    const write=legionTools(engine.store,'commander',p.id,null,()=>{},undefined,engine.legion.planningTodos(p.id)).find(t=>t.name==='TodoWrite')!
    await write.execute('first',{projectId:p.id,graphId:graphs[0].id,todos:plan})
    assert.deepEqual((await request(a)).body.planningTodos,plan)
    assert.deepEqual((await request(b)).body.planningTodos,[])
    assert.deepEqual((await request('/v2/projects/'+q.id+'/graph')).body.planningTodos,[])
    const next=[{content:'replacement only',status:'completed'}]
    await write.execute('next',{projectId:p.id,graphId:graphs[0].id,todos:next})
    assert.deepEqual((await request(a)).body.planningTodos,next)
    assert.equal((await request('/v2/projects/'+q.id+'/graph?graphId='+graphs[0].id)).status,404)
    assert.equal(JSON.stringify(engine.store.forGraph(p.id,graphs[0].id).graph(p.id)),before)
    assert(!('planningTodos' in engine.store.forGraph(p.id,graphs[0].id).graph(p.id)))
    assert(!('planningTodos' in (await request('/v2/projects/'+p.id+'/graph/delta?graphId='+graphs[0].id)).body))
  }finally{await engine.close();rmSync(work,{recursive:true,force:true})}
})
