import {spawnTask} from './task-fixture.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { benchmarkAdapter, discoverBenchmarkTasks, benchmarkInstance } from '../src/benchmark.ts'
import { serveEngine } from '../src/index.ts'

test('War Board is at most 100 lines and puts HELP ahead of other tasks', t => {
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'fixture',origin:'local fixture',goal:'verify'}).project
  const legion=new LegionStore(store);t.after(()=>store.close())
  const graphs=Array.from({length:110},(_,i)=>store.createGraph(p.id,{taskKey:'T'+String(i).padStart(3,'0'),title:'fixture',origin:'local',goal:'verify'}))
  const target=graphs.at(-1)!,step=store.forGraph(p.id,target.id).addStep(p.id,{role:'soldier',taskKey:target.taskKey!,description:'slot fixture',sourceIds:[target.originId],goalId:target.goalId})
  const run=store.claim(p.id,'execute',{name:'fixture',backend:'mock'},step.id)
  legion.message(p.id,run.id,'commander','HELP','Need a concrete next move')
  const board=new LegionStore(store,p.id).boardSummary()
  assert.ok(board.lines.length<=100)
  assert.match(board.lines[1],/^HELP /)
  assert(board.lines.some(line=>line.startsWith('T109 ')))
  assert(board.lines.some(line=>line.startsWith('待分配：')&&line.includes('T000')))
  assert.ok(!JSON.stringify(board).includes('Need a concrete next move and full FGS'))
})

test('Watchdog escalates only after confirmed evidence stops advancing', t => {
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'fixture',origin:'local fixture',goal:'verify'}).project
  const legion=new LegionStore(store);t.after(()=>store.close())
  const graph=store.createGraph(p.id,{taskKey:'T1',title:'fixture',origin:'local',goal:'verify'})
  store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T1',JSON.stringify({difficulty:'medium'}))
  const step=store.forGraph(p.id,graph.id).addStep(p.id,{role:'soldier',taskKey:'T1',description:'work',sourceIds:[graph.originId],goalId:graph.goalId})
  const run=store.claim(p.id,'execute',{name:'fixture',backend:'mock'},step.id)
  run.startedAt=new Date(Date.now()-25*60000).toISOString();store.saveRun(run);store.db.prepare("UPDATE events SET created_at=? WHERE type='execute.started' AND json_extract(data,'$.runId')=?").run(run.startedAt,run.id)
  assert.equal(legion.tactics(p.id)[0].recommendation,'general')
  assert.equal(typeof (legion as any).watchdog,'undefined','Watchdog must not own strategy')
  store.setStatus(p.id,'stopped');store.setStatus(p.id,'active')
  assert.equal(legion.tactics(p.id)[0].recommendation,'general','changing Project state is not new evidence and must not erase active stagnation')
  store.forGraph(p.id,graph.id).addFact(p.id,'new evidence',{evidence:[{description:'verified fixture'}]})
  assert.equal(legion.tactics(p.id)[0].recommendation,'working')

})

test('Manual Benchmark adapter needs neither instance nor submission API', async t => {
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'local',origin:'local fixture',goal:'verify'}).project
  new LegionStore(store);t.after(()=>store.close())
  store.createGraph(p.id,{taskKey:'local-1',title:'local task',origin:'local',goal:'verify'})
  assert.deepEqual(benchmarkAdapter(store,p.id),{kind:'manual',instanceApi:false,submissionApi:false})
  const config={workspaceRoot:'/unused'} as any
  assert.equal((await discoverBenchmarkTasks(store,config,p.id)).challenges[0].unique_code,'local-1')
  assert.deepEqual(await benchmarkInstance(store,config,p.id,'local-1','start'),{supported:false,adapter:'manual',action:'start',taskKey:'local-1'})
})

test('observed TSecBench transposition discovers tasks instead of silently selecting manual mode',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'platform-name-')),script=path.join(root,'skills/tsecbench-api/scripts/tsecbench.py')
 mkdirSync(path.dirname(script),{recursive:true});writeFileSync(script,'import json,sys\nassert sys.argv[1:] == ["list"]\nprint(json.dumps({"ok":True,"challenges":[{"unique_code":"T1","is_completed":False},{"unique_code":"T2","is_completed":True}]}))\n')
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'tsec',origin:'在tscebench上完成测评',goal:'解决所有题目'}).project
 new LegionStore(store,p.id).claimCommand();t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 const {legionTools}=await import('../src/legion-tools.ts'),tool=legionTools(store,'commander',p.id,null,()=>{},{workspaceRoot:root+'/workspaces'} as any).find(t=>t.name==='legion_platform_list')!
 const result=await tool.execute('list',{}),board=result.details as any
 assert.equal(benchmarkAdapter(store,p.id).kind,'tsecbench');assert.equal(board.adapter.kind,'tsecbench')
 assert.equal(store.projectGraphs(p.id).length,1);assert.equal(store.projectGraphs(p.id)[0].taskKey,'T1')
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM legion_tasks WHERE project_id=?').get(p.id)!.n,2)
})

test('malformed platform lists fail explicitly rather than reporting zero tasks',async t=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'platform-shape-')),script=path.join(root,'skills/tsecbench-api/scripts/tsecbench.py')
 mkdirSync(path.dirname(script),{recursive:true});writeFileSync(script,'import json\nprint(json.dumps({"ok":True,"unexpected":[]}))\n')
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'shape',origin:'TSecBench',goal:'verify'}).project
 new LegionStore(store);t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 await assert.rejects(discoverBenchmarkTasks(store,{workspaceRoot:root+'/workspaces'} as any,p.id),/TSecBench task list is missing challenges/)
 assert.equal(store.projectGraphs(p.id).length,0)
 writeFileSync(script,'import json\nprint(json.dumps({"ok":True,"challenges":[]}))\n')
 assert.deepEqual((await discoverBenchmarkTasks(store,{workspaceRoot:root+'/workspaces'} as any,p.id)).challenges,[])
})

test('platform refresh exposes real instance holders, including completed tasks, without closing anything',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'platform-instance-refresh-')),script=path.join(root,'skills/tsecbench-api/scripts/tsecbench.py')
 mkdirSync(path.dirname(script),{recursive:true});writeFileSync(script,'import json,sys\nassert sys.argv[1:] == ["list"]\nprint(json.dumps({"challenges":[{"unique_code":"done","is_completed":True,"container_status":"available","container_addr":["127.0.0.1:9001"]},{"unique_code":"live","is_completed":False,"container_status":"available","container_addr":["127.0.0.1:9002"]}]}))\n')
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'status',origin:'TSecBench authorized fixture',goal:'verify'}).project,l=new LegionStore(store,p.id)
 try{await discoverBenchmarkTasks(store,{workspaceRoot:root+'/workspaces'} as any,p.id);const lines=l.boardSummary().lines.join('\n');assert.match(lines,/done=available\(completed\)/);assert.match(lines,/live=available/);const events=store.events(p.id).filter(e=>e.type==='legion.instance_updated');assert.equal(events.length,2);await discoverBenchmarkTasks(store,{workspaceRoot:root+'/workspaces'} as any,p.id);assert.equal(store.events(p.id).filter(e=>e.type==='legion.instance_updated').length,2,'unchanged refresh does not manufacture events');assert.equal(store.project(p.id).benchmarkHosts,undefined,'read-only discovery does not start or close instances')}
 finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('TPCTF adapter discovers scored tasks through its existing CLI without taking instance ownership', async () => {
  const work=mkdtempSync(path.join(os.tmpdir(),'redtrace-tpctf-adapter-'))
  const script=path.join(work,'skills/tpctf-api/scripts/tpctf.py')
  mkdirSync(path.dirname(script),{recursive:true})
  writeFileSync(script,'import json\nprint(json.dumps({"items":[{"id":"challenge-1","title":"Fixture","scoring":"scored","my_team_fully_solved":False}]}))\n')
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'fixture',origin:'TPCTF authorized fixture',goal:'verify'}).project
  new LegionStore(store)
  try {
    const config={workspaceRoot:work+'/workspaces'} as any
    assert.equal(benchmarkAdapter(store,p.id).kind,'tpctf')
    const result=await discoverBenchmarkTasks(store,config,p.id)
    assert.equal(result.items[0].id,'challenge-1')
    assert.equal(store.projectGraphs(p.id).find(g=>g.taskKey==='challenge-1')?.title,'Fixture')
    assert.deepEqual(new LegionStore(store,p.id).board().projects[0].platform['challenge-1'],{title:'Fixture',flag_count:null,correct_flag_count:null,difficulty:null,total_score:null,is_completed:false,submitted:false,accepted:false})
    assert.equal((await benchmarkInstance(store,config,p.id,'challenge-1','start') as any).supported,false)
  } finally {store.close();rmSync(work,{recursive:true,force:true})}
})

test('TodoList survives database reopen and static UI follows source code, not data root', async () => {
  const work=mkdtempSync(path.join(os.tmpdir(),'redtrace-benchmark-fix-'))
  try {
    const store=new Store(work+'/engine.db'),p=store.createProject({mode:'benchmark',title:'fixture',origin:'local',goal:'verify'}).project
    const graph=store.createGraph(p.id,{taskKey:'T1',title:'fixture',origin:'local',goal:'verify'})
    new LegionStore(store).planningTodos(p.id).replace(graph.id,[{content:'next',status:'pending'}]);store.close()
    const reopened=new Store(work+'/engine.db')
    assert.deepEqual(new LegionStore(reopened).planningTodos(p.id).list(graph.id),[{content:'next',status:'pending'}]);reopened.close()
    const engine=await serveEngine({root:work,port:0,autoStart:false})
    try { const response=await fetch('http://127.0.0.1:'+(engine.server.address() as any).port+'/');assert.equal(response.status,200);assert.match(await response.text(),/内部目标达成/) }
    finally { await engine.close() }
  } finally { rmSync(work,{recursive:true,force:true}) }
})


test('escalation uses evidence age, gives a General mid-chain time, and never duplicates a second angle', t => {
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'ladder',origin:'local',goal:'verify'}).project,legion=new LegionStore(store,p.id)
  t.after(()=>store.close())
  const graph=store.createGraph(p.id,{taskKey:'T',title:'fixture',origin:'local',goal:'verify'})
  store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T',JSON.stringify({difficulty:'medium'}))
  const mission={role:'soldier' as const,taskKey:'T',description:'first angle',sourceIds:[graph.originId]},first=spawnTask(legion,p.id,mission),run=store.claim(p.id,'execute',{name:'fixture',backend:'mock'},first.id),at=Date.now()
  const age=(minutes:number)=>{run.startedAt=new Date(at-minutes*60000).toISOString();store.saveRun(run);store.db.prepare("UPDATE events SET created_at=? WHERE type='execute.started' AND json_extract(data,'$.runId')=?").run(run.startedAt,run.id)}
  for(const [minutes,recommendation] of [[6,'tactical'],[10,'second-angle'],[19,'second-angle'],[20,'general'],[29,'general']] as const){age(minutes);assert.equal(legion.tactics(p.id,at)[0].recommendation,recommendation)}
  age(15);spawnTask(legion,p.id,{...mission,description:'second angle'})
  assert.equal(spawnTask(legion,p.id,{...mission,description:'third angle'}).role,'soldier','distinct specialist angles are bounded by configured capacity, not a new hard cap')
  age(30);const general=spawnTask(legion,p.id,{...mission,role:'general',description:'upgrade'}),g=store.forGraph(p.id,graph.id).claim(p.id,'plan',{name:'fixture',backend:'mock'})
  g.startedAt=new Date(at-10*60000).toISOString();store.saveRun(g);store.db.prepare("UPDATE events SET created_at=? WHERE type='execute.started' AND json_extract(data,'$.runId')=?").run(g.startedAt,g.id)
  assert.equal(legion.tactics(p.id,at)[0].recommendation,'working','a newly upgraded General is not parked at minute 30')
  age(45);assert.equal(legion.tactics(p.id,at)[0].recommendation,'park')
  store.forGraph(p.id,graph.id).addFact(p.id,'confirmed chain progress',{runId:run.id})
  assert.equal(legion.tactics(p.id,at)[0].recommendation,'working')
  legion.park(p.id,'T','blocked chain','new confirmed intel');store.finishRun(run.id,'cancelled');store.finishRun(g.id,'cancelled')
  assert.equal(legion.reactivate(p.id,'T','new confirmed intel').length,3)
})

test('historical classification stays readable but neither sibling hints nor Scout are prerequisites', t => {
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'family',origin:'local',goal:'verify'}).project,legion=new LegionStore(store,p.id)
 t.after(()=>store.close())
 const a=store.createGraph(p.id,{taskKey:'source',title:'source',origin:'local',goal:'verify'}),b=store.createGraph(p.id,{taskKey:'target',title:'target',origin:'local',goal:'verify'})
 store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'target',JSON.stringify({difficulty:'hard',classifiedAt:'legacy',factIds:[],sourceTaskKey:'source'}))
 store.forGraph(p.id,b.id).addInput(p.id,'hint','UNVERIFIED sibling product; verify in target')
 const soldier=legion.spawn(p.id,{role:'soldier',taskKey:'target',description:'verify target',sourceIds:[b.originId]})
 assert.equal(soldier.role,'soldier');assert.equal(legion.tactics(p.id).find(t=>t.taskKey==='target')!.classification.classifiedAt,'legacy')
 assert.equal(store.forGraph(p.id,b.id).nodes(p.id,['fact']).length,1)
 assert.throws(()=>legion.spawn(p.id,{role:'scout' as never,taskKey:'source',description:'retired',sourceIds:[a.originId]}),/Scout is retired/)
})

test('80% context and major decisions checkpoint full STATE without recursive growth', async t => {
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'STATE',origin:'local',goal:'verify'}).project,legion=new LegionStore(store,p.id)
  t.after(()=>store.close());legion.claimCommand();legion.saveState(p.id,'commander','allocation; parked blocker; intel; queue; exact next move')
  const graph=store.createGraph(p.id,{taskKey:'T',title:'fixture',origin:'local',goal:'verify'}),{legionTools}=await import('../src/legion-tools.ts')
  const tool=legionTools(store,'commander',p.id,null,()=>{}).find(t=>t.name==='legion_spawn')!
  await tool.execute('spawn',{role:'soldier',taskKey:'T',mission:'solve'})
  assert.equal(JSON.parse(legion.campaign().state).reason,'legion_spawn')
  const {mountLegionContext}=await import(new URL('../compat/legion-context.mjs',import.meta.url).href),listeners=new Map<string,any[]>(),messages:string[]=[]
  const scoped={on(name:string,fn:any){listeners.set(name,[...(listeners.get(name)??[]),fn])}},ctx={get(name:string){return name==='tokenMeter'?{measure(){return{totalTokens:80}}}:{resolveModelInfo(){return{context:{contextWindow:100}}}}}}
  mountLegionContext(scoped,ctx,{store:store.forProject(p.id),legion,message:(s:string)=>s})
  await listeners.get('agent/request')![0]({agent:{status:'running',inject:(m:string)=>messages.push(m)}},()=>{})
  for(const f of listeners.get('session/event')!)await f({}, {type:'request/header',data:{header:{config:{}}}})
  const state=JSON.parse(legion.campaign().state);assert.equal(state.reason,'context-80-percent');assert.match(state.notes,/exact next move/);assert.equal(state.board,'legion_inspect(action=board)');assert(!('tasks' in state));assert.equal(messages.length,1)
  legion.checkpointState(p.id,'repeat');assert.equal(JSON.parse(legion.campaign().state).notes,state.notes)
  const waiting=await legionTools(store,'commander',p.id,null,()=>{}).find(t=>t.name==='legion_wait')!.execute('wait',{through:0})
  assert.equal((waiting.details as any).sleepSeconds,60)
})

test('Benchmark Worker mailbox still wakes immediately',async t=>{
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'mailbox',origin:'local',goal:'verify'}).project,legion=new LegionStore(store,p.id)
  t.after(()=>store.close());const{attachLegionMailbox}=await import(new URL('../compat/legion.mjs',import.meta.url).href)
  let steers=0;const ctx={on(){return()=>{}}},agent={status:'idle',steer(){steers++},inject(){steers++}},message=(text:string,source:any)=>({text,source})
  const g=store.createGraph(p.id,{taskKey:'T',title:'soldier',origin:'local',goal:'verify'}),step=store.forGraph(p.id,g.id).addStep(p.id,{role:'soldier',taskKey:'T',description:'work',sourceIds:[g.originId]}),run=store.claim(p.id,'execute',{name:'fixture',backend:'mock'},step.id)
  const worker=attachLegionMailbox(ctx,legion,{projectId:p.id,actor:run.id,sessionId:run.id,agent,message});legion.message(p.id,'commander',run.id,'MESSAGE','act now');assert.equal(steers,1);worker()
})

test('Scheduler Watchdog continues settled model recovery beyond three attempts and never replays unknown outcomes',async t=>{
  const{Scheduler}=await import('../src/scheduler.ts'),store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'recovery',origin:'local',goal:'verify'}).project
  t.after(()=>store.close());new LegionStore(store)
  const g=store.createGraph(p.id,{taskKey:'T',title:'fixture',origin:'local',goal:'verify'}),step=store.forGraph(p.id,g.id).addStep(p.id,{role:'soldier',taskKey:'T',description:'native work',sourceIds:[g.originId]})
  let attempts=0;const ids:string[]=[]
  const scheduler=new Scheduler(store,{workers:[{name:'fixture',backend:'mock',enabled:true,roles:['soldier'],maxRunning:1,priority:0}],maxWorkers:1,maxProjectWorkers:1,maxRunningProjects:1,workspaceRoot:'/unused'} as any,async({run})=>{attempts++;ids.push(run.id);const saved=store.run(run.id);saved.failureCode='TRANSPORT';saved.checkpoint={sessionId:run.id};store.saveRun(saved);throw Error('native transport died')})
  const settle=async()=>{for(let i=0;i<10;i++)await new Promise(r=>setImmediate(r))}
  try{scheduler.start();await settle();assert.equal(attempts,1)
    for(let i=0;i<4;i++){scheduler.watchdog();const next=store.node(p.id,step.id,'step') as any;if(next.status==='paused'&&next.retryAfter){assert(next.retryAfter>Date.now());next.retryAfter=Date.now()-1;store.saveNode(next);scheduler.wake()}await settle()}
    assert.equal(attempts,5);assert.equal(new Set(ids).size,1);assert.equal((store.node(p.id,step.id,'step') as any).failureCount,4)
    for(const code of ['CONTEXT_WINDOW_EXCEEDED','ABORTED','PARTIAL_RESPONSE']){const r=store.run(ids[0]);const s=store.node(p.id,step.id,'step') as any;s.failureCount=0;store.saveNode(s);r.failureCode=code;store.saveRun(r);scheduler.watchdog();await settle();assert.equal(attempts,5)}
    const r=store.run(ids[0]);r.failureCode='TRANSPORT';r.pendingTools=['unknown-side-effect'];store.saveRun(r);scheduler.watchdog();await settle();assert.equal(attempts,5);assert.equal((store.node(p.id,step.id,'step') as any).status,'blocked')
  }finally{await scheduler.close()}
})


test('native Commander patrol clock, per-Project concurrency, General events and 15-second bounded recovery', {timeout:90000},async()=>{
  const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
  const result=await promisify(execFile)(process.execPath,[new URL('./benchmark-controller.fixture.mjs',import.meta.url).pathname],{maxBuffer:2*1024*1024})
  assert.match(result.stdout,/BENCHMARK_PATROL=true/);assert.match(result.stdout,/waiting_capacity_released=true/);assert.match(result.stdout,/native_recovery_continues=true/)
})

test('native pause excludes offline time but retains prior active stagnation for escalation',t=>{
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'clock',origin:'local fixture',goal:'verify'}).project,legion=new LegionStore(store,p.id)
 t.after(()=>store.close());const graph=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),scoped=store.forGraph(p.id,graph.id),step=scoped.addStep(p.id,{role:'soldier',taskKey:'T',description:'work',sourceIds:[graph.originId]}),worker={name:'fixture',backend:'mock' as const},run=scoped.claim(p.id,'execute',worker,step.id),at=Date.now()
 store.finishRun(run.id,'paused');store.setStatus(p.id,'stopped');store.setStatus(p.id,'active');scoped.claim(p.id,'execute',worker,step.id)
 const events=store.db.prepare("SELECT id,type FROM events WHERE project_id=? AND type IN ('execute.started','execute.paused','project.stopped','project.active') ORDER BY id").all(p.id)
 const stamps=[at-30*60000,at-20*60000,at-20*60000,at-60000,at-60000]
 assert.equal(events.length,5)
 events.forEach((event,index)=>store.db.prepare('UPDATE events SET created_at=? WHERE id=?').run(new Date(stamps[index]).toISOString(),Number(event.id)))
 const tactic=legion.tactics(p.id,at)[0]
 assert.equal(tactic.elapsedMs,11*60000,'10 active minutes before pause plus 1 after resume, excluding 19 offline minutes')
 assert.equal(tactic.stalledMinutes,11,'pause is not new evidence and must not erase prior stagnation')
 assert.equal(tactic.recommendation,'second-angle')
})
