import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Store } from '../src/store.ts'
import { graphTools, efficiencyToolAvailable } from '../src/runner.ts'
import type { EngineConfig, Worker } from '../src/types.ts'
test('model and audit retain credentials, flags, bodies and URL parameters verbatim', async () => {
 const store = new Store(':memory:')
 const worker: Worker = { name:'fixture', backend:'mock', provider:'mock', model:'', enabled:true, reason:true, explore:true, bootstrap:false, maxRunning:1, priority:0 }
 try {
  const project = store.createProject({title:'Raw evidence',origin:'fixture',goal:'fixture',bootstrap:false}).project
  const run = store.claim(project.id,'execute',worker,store.addStep(project.id,{description:'Legion read-only fixture',sourceIds:['origin'],role:'worker',taskKey:'fixture'}).id)
  const original = {token:'fixture-token',flag:'flag{fixture}',cookie:'session=fixture',responseBody:'raw-body',url:'https://fixture.invalid/?token=fixture'}
  const fact = store.addFact(project.id,JSON.stringify(original),{creator:'human'})
  const tools = graphTools({store,run,worker,config:{maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{})
  const result = await tools.find(tool=>tool.name==='read_graph')!.execute('read',{id:fact.id})
  assert.ok(JSON.stringify(result.content).includes('fixture-token')); assert.ok(!JSON.stringify(result.content).includes('[REDACTED]'))
  store.runEvent(run.id,'fixture',original)
  assert.deepEqual(JSON.parse(String(store.db.prepare("SELECT data FROM run_events WHERE run_id=? AND type='fixture'").get(run.id)!.data)),original)
  store.audit({id:run.id,project_id:project.id},[{kind:'tool.completed',content:JSON.stringify(original),arguments:JSON.stringify(original)}])
  const event=JSON.parse(String(store.db.prepare('SELECT data FROM audit_events WHERE run_id=? ORDER BY id DESC LIMIT 1').get(run.id)!.data))
  assert.deepEqual(JSON.parse(event.content),original); assert.deepEqual(JSON.parse(event.arguments),original)
 } finally { store.close() }
})
test('Explore receives knowledge tools and plugin disabling blocks previously exposed tools', async () => {
 const store = new Store(':memory:')
 const worker: Worker = { name:'fixture', backend:'mock', provider:'mock', model:'', enabled:true, reason:false, explore:true, bootstrap:false, maxRunning:1, priority:0 }
 const project = store.createProject({title:'Fixture',origin:'http://127.0.0.1:8080',goal:'Inspect authorized HTTP'}).project
 const step = store.addStep(project.id,{description:'Inspect HTTP',sourceIds:['origin']}), run = store.claim(project.id,'execute',worker,step.id)
 let enabled = true
 const context = {store,run,worker,config:{} as EngineConfig,signal:new AbortController().signal, featureAvailable:()=>enabled}
 try {
  const tools = graphTools(context,()=>{})
  assert.ok(tools.some(tool=>tool.name==='knowledge_search'))
  assert.ok(tools.some(tool=>tool.name==='http_batch'))
  enabled=false
  assert.equal(efficiencyToolAvailable(context,'knowledge_search'),false)
  assert.equal(efficiencyToolAvailable(context,'evidence_read'),true)
  await assert.rejects(tools.find(tool=>tool.name==='knowledge_search')!.execute('search',{query:'csrf'}),/plugin is disabled/)
 } finally { store.close() }
})
