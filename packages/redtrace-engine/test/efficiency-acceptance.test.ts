import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { criticalNotice, graphUpdate } from '../src/runner.ts'
import { extractOutput } from '../src/result-summary.ts'
import type { Worker } from '../src/types.ts'
const worker: Worker = {name:'fixture',backend:'mock',provider:'mock',model:'',enabled:true,reason:false,explore:true,bootstrap:false,maxRunning:1,priority:0}
function fixture() {
 const store = new Store(':memory:'), project = store.createProject({title:'Fixture',origin:'http://127.0.0.1:8080',goal:'Verify local efficiency'}).project
 const step = store.addStep(project.id,{description:'Inspect',sourceIds:['origin']}), run=store.claim(project.id,'execute',worker,step.id)
 return {store,project,step,run}
}
test('attempt ledger preserves parameter encoding/order, identity and challenge, reminds once without blocking',()=>{
 const {store,project,run}=fixture()
 try {
  const data={name:'http_batch',arguments:{challenge:'q1',identity:'alice',url:'http://127.0.0.1:8080/?a=1&b=%2f'}}
  assert.equal(store.attempt(run.id,'a',data),undefined)
  assert.equal(store.attempt(run.id,'b',data),undefined)
  assert.match(store.attempt(run.id,'c',data)!,/3 次相同/)
  assert.equal(store.attempt(run.id,'d',data),undefined)
  assert.equal(store.attempt(run.id,'env-change',data,'new-auth-version'),undefined)
  for (const change of [{url:'http://127.0.0.1:8080/?b=%2f&a=1'},{url:'http://127.0.0.1:8080/?a=1&b=/'},{identity:'bob'},{challenge:'q2'}]) assert.equal(store.attempt(run.id,'other',{...data,arguments:{...data.arguments,...change}}),undefined)
  store.addFact(project.id,'Authentication expired',{stepId:run.stepId!})
  assert.equal(store.attempt(run.id,'fresh',data),undefined)
 } finally {store.close()}
})
test('historical native and DSH audit traces rebuild in pages, redact and enforce project isolation',()=>{
 const {store,project,run}=fixture()
 try {
  for(let i=0;i<510;i++)store.runEvent(run.id,'tool.started',{name:'historymarker',arguments:{index:i,token:'secret'}})
  const metadata=JSON.parse(String(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id)!.data))
  store.audit(metadata,[{kind:'tool.completed',title:'dshmarker',event_uid:'dsh-unique',content:'fixture evidence'}])
  store.db.exec('DELETE FROM trace_fts; DELETE FROM trace_cursors')
  const hits=store.traceSearch(project.id,'dshmarker')
  assert.equal(hits.length,1);assert.equal(hits[0]!.source,'audit')
  assert.match(JSON.stringify(store.traceEvent(project.id,run.id,hits[0]!.eventId,'audit')),/fixture evidence/)
  const native=store.traceSearch(project.id,'historymarker');assert.equal(native.length,5)
  assert.doesNotMatch(JSON.stringify(store.traceEvent(project.id,run.id,native[0]!.eventId)),/secret/)
  store.traceSearch(project.id,'historymarker');assert.equal(Number(store.db.prepare('SELECT COUNT(*) AS count FROM trace_fts').get()!.count),510)
  const other=store.createProject({title:'Other',origin:'other',goal:'other'}).project
  assert.throws(()=>store.traceEvent(other.id,run.id,hits[0]!.eventId,'audit'),/not found/)
  for(let i=0;i<510;i++)store.addFact(project.id,`fixture ${i}`,{})
  const update=graphUpdate(store,project.id,0,'different');assert.ok(update.relevant)
  assert.equal(update.cursor,Number(store.db.prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?').get(project.id)!.id))
 } finally {store.close()}
})
test('runtime capability gain/loss and dependency invalidation are verified, not ordinary Facts',async()=>{
 const {store,project}=fixture(), ops=new Operations(store,process.cwd())
 try {
  const parent=ops.create(project.id,{kind:'proxy',name:'parent',status:'available',metadata:{provider:'chisel'}}).resource
  const child=ops.create(project.id,{kind:'proxy',name:'child',status:'available',metadata:{dependencies:[parent.id]}}).resource
  const initial=store.project(project.id).criticalSeq??0
  store.addFact(project.id,'Model claims a breakthrough',{});assert.equal(store.project(project.id).criticalSeq??0,initial)
  ops.verifiedResource(parent.id,{metadata_json:JSON.stringify({verified_capabilities:['pivot.socks']})},'route.verified')
  ops.verifiedResource(child.id,{metadata_json:JSON.stringify({verified_capabilities:['pivot.socks'],dependencies:[parent.id]})},'route.verified')
  assert.equal(store.project(project.id).criticalSeq,initial+2)
  ops.verifiedResource(parent.id,{metadata_json:ops.resource(parent.id).metadata_json},'route.verified');assert.equal(store.project(project.id).criticalSeq,initial+2)
  ops.updateResource(parent.id,{status:'offline'})
  assert.equal(ops.resource(child.id).status,'degraded')
  assert.equal(JSON.parse(ops.resource(child.id).metadata_json).runtime_verified,false)
  assert.equal(store.project(project.id).criticalSeq,initial+4)
 } finally {await ops.close();store.close()}
})
test('cost buckets are disjoint tokens and timing residual never subtracts overlapping intervals twice',()=>{
 const {store,run}=fixture()
 try {
  const current=store.run(run.id);Object.assign(current,{inputTokens:11,outputTokens:7,cacheReadTokens:3,cacheWriteTokens:2});store.saveRun(current)
  store.metricStart(run.id,'m','model');store.metricEnd(run.id,'m');store.metricStart(run.id,'tool','tool');store.metricEnd(run.id,'tool')
  const costs=store.runCosts(run.id);assert.equal(costs.totalTokens,23);assert.equal(costs.tokens.cacheRead,3);assert.ok(costs.waitOrUninstrumentedMs>=0)
  assert.deepEqual(extractOutput('[1,2]'),{format:'json',type:'array',count:2,keys:['0','1'],parseError:null})
  assert.match(extractOutput('{broken','application/json').parseError!,/SyntaxError/)
  assert.deepEqual(extractOutput('80/tcp open http\nERROR failed').ports,[{port:80,protocol:'tcp',state:'open',service:'http'}])
 } finally {store.close()}
})
test('critical planning acknowledges its start boundary only; failure, pause and new arrivals retain signals',()=>{
 const {store,project}=fixture()
 try {
  const planner={...worker,name:'reason',reason:true}
  store.recordCriticalSignal(project.id,'verified-one',{kind:'route.verified'})
  const run=store.claim(project.id,'decide',planner)
  assert.equal(criticalNotice(store.project(project.id),run,false),undefined)
  store.recordCriticalSignal(project.id,'verified-two',{kind:'capability.lost'})
  assert.match(criticalNotice(store.project(project.id),run,false)!,/关键状态/)
  assert.equal(criticalNotice(store.project(project.id),run,true),undefined)
  assert.equal(criticalNotice(store.project(project.id),run,false,false),undefined)
  store.finishRun(run.id,'succeeded')
  assert.equal(store.project(project.id).acknowledgedCriticalSeq,1)
  assert.equal(store.project(project.id).criticalSeq,2)
  const failed=store.claim(project.id,'decide',planner);store.finishRun(failed.id,'failed','fixture failure')
  assert.equal(store.project(project.id).acknowledgedCriticalSeq,1)
  const paused=store.claim(project.id,'decide',planner);store.finishRun(paused.id,'paused')
  assert.equal(store.project(project.id).acknowledgedCriticalSeq,1)
  const before=store.project(project.id).criticalSeq!
  for(let i=0;i<300;i++)store.recordCriticalSignal(project.id,`new-${i}`,{kind:'route.verified'})
  assert.equal(store.recordCriticalSignal(project.id,'verified-one',{kind:'route.verified'}),false)
  assert.equal(store.project(project.id).criticalSeq,before+300)
 } finally {store.close()}
})

import { graphTools } from '../src/runner.ts'
import type {EngineConfig} from '../src/types.ts'
test('large graph SQL pages and active Run query do not load full graph or historical checkpoints',async()=>{
 const {store,project,run}=fixture()
 try {
  for(let i=0;i<600;i++)store.addFact(project.id,`item ${i}`,{})
  for(let i=0;i<1000;i++){const old={...run,id:`historical-${i}`,status:'succeeded' as const,checkpoint:{payload:'unused history'}};store.saveRun(old)}
  store.graph=()=>{throw new Error('full graph loading forbidden')}
  store.runs=()=>{throw new Error('full historical Run loading forbidden')}
  assert.deepEqual(store.runsByStatus('running').map(row=>row.id),[run.id])
  const tools=graphTools({store,run,worker,config:{} as EngineConfig,signal:new AbortController().signal},()=>{})
  const result=await tools.find(tool=>tool.name==='read_graph')!.execute('read',{kinds:['fact'],offset:500,limit:10,full:true}) as any
  assert.equal(result.details.facts.length,10);assert.equal(result.details.nextOffsets.fact,510)
  assert.deepEqual(result.details.steps,[])
 } finally {store.close()}
})
