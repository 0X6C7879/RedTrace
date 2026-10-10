import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { boundToolOutput } from '../src/runner.ts'
test('8 KiB budget covers content and JSON escaping, retains images and exact evidence', async () => {
 const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-output-'))
 try {
  const text = '"\\\n'.repeat(10000), input = { content: [{ type: 'text' as const, text }, { type: 'image' as const, data: 'eA==', mimeType: 'image/png' }], details: { exitCode: 7 } }
  const output = await boundToolOutput(input, root, 'run')
  assert.ok(Buffer.byteLength((output.content[0] as {text:string}).text) <= 8192)
  assert.equal(output.content[1]?.type, 'image')
  const details = output.details as {evidenceId:string;exitCode:number}
  const raw = JSON.parse(readFileSync(path.join(root, 'run', details.evidenceId + '.json'), 'utf8'))
  assert.equal(raw.content[0].text, text)
  assert.equal(raw.details.exitCode, 7)
  assert.equal(details.exitCode, 7)
 } finally { rmSync(root, {recursive:true,force:true}) }
})

import { Store } from '../src/store.ts'
import { graphTools, efficiencyToolAvailable } from '../src/runner.ts'
import type { EngineConfig, Worker } from '../src/types.ts'
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
