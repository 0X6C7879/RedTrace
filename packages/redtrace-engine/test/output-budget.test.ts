import { test } from 'node:test'
import assert from 'node:assert/strict'

import { Store, redactSensitive } from '../src/store.ts'
import { graphTools, efficiencyToolAvailable } from '../src/runner.ts'
import type { EngineConfig, Worker } from '../src/types.ts'
test('result and audit redaction preserve output text while protecting structured credentials', () => {
 const original = { content: [{ type: 'text', text: '{"token":"test-secret","responseBody":"private","output":"hello"}' }], arguments: '{"password":"test-password"}' }
 const safe = redactSensitive(original) as typeof original
 assert.equal(JSON.parse(safe.content[0].text).token, '[REDACTED]')
 assert.equal(JSON.parse(safe.content[0].text).responseBody, '[REDACTED]')
 assert.equal(JSON.parse(safe.content[0].text).output, 'hello')
 assert.equal(JSON.parse(safe.arguments).password, '[REDACTED]')
 assert.equal(original.content[0].text.includes('test-secret'), true)
 assert.equal((redactSensitive({ text: 'native output\n' }) as { text: string }).text, 'native output\n')
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
