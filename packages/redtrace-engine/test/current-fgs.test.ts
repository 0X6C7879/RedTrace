import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { graphTools } from '../src/runner.ts'
import { projectFgs, liveSteps } from '../src/fgs.ts'
import { serveEngine } from '../src/index.ts'
import type { EngineConfig, Step } from '../src/types.ts'

const worker = { name: 'fixture', backend: 'mock' as const, provider: 'mock', model: '', enabled: true, maxRunning: 4, priority: 0 }

test('graph projection counts only active nondeleted Steps per Goal and emits each live edge once', () => {
  const store = new Store(':memory:')
  try {
    const id = store.createProject({title:'Counts',origin:'Local fixture',goal:'Render'}).project.id
    const step = store.addStep(id,{description:'Fixture',sourceIds:['origin']})
    const graph = store.graph(id), goal = graph.goals[0]
    graph.goals.push({...goal,id:'second',parentId:goal.id})
    graph.steps = ['pending','running','paused','blocked','done','cancelled'].map((status,index)=>({...step,id:'step-'+index,status:status as Step['status'],sourceIds:['origin','origin'],goalId:index===3?'second':goal.id}))
    graph.steps.push({...step,id:'deleted',deleted:true})
    const view = projectFgs(graph), live = liveSteps(graph)
    assert.equal(view.nodes.find(node=>node.id===goal.id)!.activeSteps,3)
    assert.equal(view.nodes.find(node=>node.id==='second')!.activeSteps,1)
    assert.equal(live.nodes.length,4)
    assert.equal(live.edges.length,8)
    assert.equal(new Set(live.edges.map(edge=>JSON.stringify([edge.source,edge.target]))).size,8)
  } finally {store.close()}
})

test('corrections retain original bytes, producer and multi-stage dependencies while indexes stay compact', async () => {
  const s = new Store(':memory:')
  try {
    const id = s.createProject({title:'History',origin:'Authorized fixture',goal:'Verified result'}).project.id
    const producer = s.addStep(id,{description:'Verify first stage',sourceIds:['origin']})
    const run = s.claim(id,'execute',worker,producer.id)
    const original = s.addFact(id,'Observed HTTP 403; token=fixture; exact Payload retained', {title:'First response',runId:run.id,evidence:[{description:'HTTP/1.1 403; X-Clue: fixture',toolCallId:'original'}]})
    s.finishRun(run.id,'succeeded')
    const consumer = s.addStep(id,{description:'Stage two',sourceIds:[original.id]})
    const snapshot = s.node(id,original.id), cursor = s.events(id).at(-1)!.id
    const correction = s.addFact(id,'Correction to '+original.id+': valid session returns 200', {title:'Session verified',evidence:[{description:'Literal HTTP/1.1 200'}]})
    assert.deepEqual(s.node(id,original.id),snapshot)
    assert.deepEqual(s.node<Step>(id,consumer.id).sourceIds,[original.id])
    const current = s.node<Step>(id,consumer.id)
    s.updateStep(id,consumer.id,{sourceIds:[correction.id],mode:'amend',expectedVersion:current.version})
    assert.deepEqual(s.node<Step>(id,consumer.id).sourceIds,[correction.id])
    const next = s.claim(id,'execute',worker,consumer.id)
    const tools = graphTools({store:s,run:next,worker,config:{workspaceRoot:os.tmpdir()} as EngineConfig,signal:new AbortController().signal},()=>{})
    const index = (await tools.find(t=>t.name==='read_graph')!.execute('index',{})).details as any
    assert.ok(index.facts.some((f:any)=>f.id===original.id));assert.ok(!JSON.stringify(index).includes('exact Payload retained'))
    const detail = (await tools.find(t=>t.name==='read_graph')!.execute('proof',{id:original.id,detail:'doc'})).details
    assert.match(JSON.stringify(detail),/exact Payload retained/)
    const delta = s.graphDelta(id,cursor)
    assert.ok(delta.nodes.some(n=>n.id===correction.id));assert.ok(!JSON.stringify(delta).includes(original.description))
    s.updateStep(id,consumer.id,{status:'cancelled'})
    assert.equal(s.node(id,original.id).id,original.id)
    assert.deepEqual(projectFgs(s.graph(id)).missingReferences,[])
  } finally {s.close()}
})

test('opening historical databases never erases legacy nodes, details or event bodies', () => {
  const root = mkdtempSync(path.join(os.tmpdir(),'redtrace-append-only-')), file = path.join(root,'engine.db')
  let s = new Store(file)
  try {
    const id=s.createProject({title:'History',origin:'Scope',goal:'Verify'}).project.id
    const a=s.addFact(id,'Canonical'), b=s.addFact(id,'LEGACY_BODY', {evidence:[{description:'Literal old proof'}]})
    s.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify({...b,lifecycle:'merged',mergedInto:a.id,sourceDetails:{raw:'Retain'}}),id,b.id)
    const first=s.events(id)[0]
    s.db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({nodeSnapshot:b,description:'ORIGINAL_EVENT_BODY'}),first.id)
    s.db.prepare('DELETE FROM metadata WHERE key=?').run('fgs-current-only')
    const nodes=s.db.prepare('SELECT * FROM nodes ORDER BY id').all(),events=s.db.prepare('SELECT * FROM events ORDER BY id').all()
    s.close();s=new Store(file)
    assert.deepEqual(s.db.prepare('SELECT * FROM nodes ORDER BY id').all(),nodes)
    assert.deepEqual(s.db.prepare('SELECT * FROM events ORDER BY id').all(),events)
    assert.equal(s.node<import('../src/types.ts').Fact>(id,b.id).description,'LEGACY_BODY')
    assert.ok(!JSON.stringify(s.graphDelta(id,0)).includes('ORIGINAL_EVENT_BODY'))
    assert.match(JSON.stringify(s.events(id)),/ORIGINAL_EVENT_BODY/)
  } finally {s.close();rmSync(root,{recursive:true,force:true})}
})

test('HTTP deletes and merges are absent in both modes; cancellation and Goal updates retain nodes', async () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'redtrace-append-api-')), engine=await serveEngine({root,port:0,autoStart:false})
  const url='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
  const call=async(route:string,method='GET',body?:unknown)=>{const response=await fetch(url+route,{method,...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{})});return{status:response.status,data:await response.json() as any}}
  try {
    for(const mode of ['general','benchmark'] as const){
      const p=engine.store.createProject({mode,title:mode,origin:'Fixture',goal:'Verified'}).project
      const graph=mode==='benchmark'?engine.store.createGraph(p.id,{taskKey:'fixture',title:'fixture',origin:'Task scope',goal:'Task proof'}):engine.store.projectGraphs(p.id)[0]
      const scoped=engine.store.forGraph(p.id,graph.id),base='/v2/projects/'+p.id,query='?graphId='+graph.id
      const a=scoped.addFact(p.id,'Original'),b=scoped.addFact(p.id,'Correction to '+a.id+': verified'),finding=scoped.addFinding(p.id,{title:'Result',description:'Verified',factIds:[b.id]})
      const hint=scoped.addInput(p.id,'hint','Unverified instruction'),step=scoped.addStep(p.id,{description:'Next',sourceIds:[b.id],goalId:graph.goalId})
      for(const operation of ['delete','merge','archive','restore'])assert.ok([404,405].includes((await call(base+'/evidence/manage'+query,'POST',{operation,id:a.id,expectedVersion:a.version,sourceIds:[b.id],reason:'fixture'})).status))
      for(const [kind,id]of [['facts',a.id],['findings',finding.id],['goals',graph.goalId],['steps',step.id],['hints',hint.id]])assert.ok([404,405].includes((await call(base+'/'+kind+'/'+id+query,'DELETE')).status))
      assert.ok([404,405].includes((await call('/projects/'+p.id+'/intents/'+step.id+query,'DELETE')).status))
      assert.equal((await call(base+'/steps/'+step.id+query,'PATCH',{status:'cancelled',expectedVersion:step.version})).status,200)
      assert.equal((await call(base+'/goals/'+graph.goalId+query,'PATCH',{status:'achieved',evidenceIds:[finding.id]})).status,200)
      const current=await call(base+'/graph'+query)
      assert.equal(current.status,200);assert.ok(current.data.facts.some((n:any)=>n.id===a.id));assert.ok(current.data.facts.some((n:any)=>n.id===b.id))
      assert.equal(scoped.node<Step>(p.id,step.id).status,'cancelled');assert.deepEqual(scoped.node<Step>(p.id,step.id).sourceIds,[b.id])
      assert.equal((await call(base+'/nodes/'+a.id+query)).data.description,'Original')
      assert.match((await fetch(url+'/projects/'+p.id+'/export?format=yaml&graphId='+graph.id)).status.toString(),/200/)
    }
  } finally {await engine.close();rmSync(root,{recursive:true,force:true})}
})
