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
  const target=graphs.at(-1)!,step=store.forGraph(p.id,target.id).addStep(p.id,{role:'scout',taskKey:target.taskKey!,description:'classify',sourceIds:[target.originId],goalId:target.goalId})
  const run=store.claim(p.id,'execute',{name:'fixture',backend:'mock'},step.id)
  legion.message(p.id,run.id,'commander','HELP','Need a concrete next move')
  const board=new LegionStore(store,p.id).boardSummary()
  assert.ok(board.lines.length<=100)
  assert.match(board.lines[1],/^HELP /)
  assert.match(board.lines[2],/T109/)
  assert.ok(board.lines.at(-1)?.startsWith('omitted='))
  assert.ok(!JSON.stringify(board).includes('Need a concrete next move and full FGS'))
})

test('Watchdog escalates only after confirmed evidence stops advancing', t => {
  const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'fixture',origin:'local fixture',goal:'verify'}).project
  const legion=new LegionStore(store);t.after(()=>store.close())
  const graph=store.createGraph(p.id,{taskKey:'T1',title:'fixture',origin:'local',goal:'verify'})
  store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T1',JSON.stringify({difficulty:'medium'}))
  const step=store.forGraph(p.id,graph.id).addStep(p.id,{role:'soldier',taskKey:'T1',description:'work',sourceIds:[graph.originId],goalId:graph.goalId})
  const run=store.claim(p.id,'execute',{name:'fixture',backend:'mock'},step.id)
  run.startedAt=new Date(Date.now()-25*60000).toISOString();store.saveRun(run)
  assert.equal(legion.tactics(p.id)[0].recommendation,'general')
  legion.watchdog(p.id);legion.watchdog(p.id)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='legion.watchdog'").get()!.n,1)
  store.setStatus(p.id,'stopped');store.setStatus(p.id,'active')
  assert.equal(legion.tactics(p.id)[0].recommendation,'working','paused project time must not count as evidence stagnation')
  store.forGraph(p.id,graph.id).addFact(p.id,'new evidence',{evidence:[{description:'verified fixture'}]})
  assert.equal(legion.tactics(p.id)[0].recommendation,'working')
  legion.watchdog(p.id)
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='legion.watchdog'").get()!.n,1)
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

test('TPCTF adapter discovers scored tasks through its existing CLI without taking instance ownership', async () => {
  const work=mkdtempSync(path.join(os.tmpdir(),'redtrace-tpctf-adapter-'))
  const script=path.join(work,'.redtrace/skills/tpctf-api/scripts/tpctf.py')
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
    assert.equal((new LegionStore(store,p.id).board().projects[0] as any).platform['challenge-1'].confirmed,false)
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
