import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { serveEngine } from '../src/index.ts'

test('LLM polling API persists settings, validates members and tracks provider edits without changing secrets', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-polling-config-'))
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  engine.configuration.commit(engine.configuration.read().revision, raw => {
    raw.providers = Object.fromEntries(['a','b'].map(name => [name, { api: 'openai-completions' as const, base_url: 'http://127.0.0.1:1/v1', api_key: name+'-secret', models: [{ id: 'shared', context_window: 20000, max_tokens: 1000 }] }]))
  })
  const url = 'http://127.0.0.1:'+(engine.server.address() as any).port
  const call = async (route: string, method = 'GET', body?: unknown) => { const res = await fetch(url+route, { method, ...(body ? { headers: {'content-type':'application/json'}, body: JSON.stringify(body) } : {}) }); return { status: res.status, data: await res.json() as any } }
  try {
    let snapshot = (await call('/worker-config')).data
    assert.deepEqual(snapshot.llm_polling, {enabled:true,models:{}})
    const payload = { expected_revision: snapshot.revision, enabled: false, models: { shared: ['b','a'] } }
    let result = await call('/worker-config/llm-polling','PUT',payload)
    assert.equal(result.status,200); snapshot=result.data
    assert.deepEqual(engine.configuration.resolvedSnapshot().config.llmPolling,{enabled:false,models:{shared:['b','a']}})
    assert.deepEqual((await call('/worker-config')).data.llm_polling,snapshot.llm_polling)
    assert.match(readFileSync(engine.configuration.filename,'utf8'),/llm_polling:/)
    assert.deepEqual(Object.values(engine.configuration.resolve(engine.configuration.read().raw).providers).map(p=>p.apiKey),['a-secret','b-secret'])
    assert.equal((await call('/worker-config/llm-polling','PUT',payload)).status,409)
    for (const models of [{shared:['a','a']},{shared:['missing']},{shared:['toString']},{other:['a']}]) {
      assert.equal((await call('/worker-config/llm-polling','PUT',{...payload,expected_revision:snapshot.revision,models})).status,422)
      assert.equal(engine.configuration.read().revision,snapshot.revision)
    }
    result=await call('/worker-config/providers/b','PUT',{expected_revision:snapshot.revision,name:'renamed',api:'openai-completions',base_url:'http://127.0.0.1:1/v1',models:[{id:'shared'}]})
    assert.equal(result.status,200);snapshot=result.data
    assert.deepEqual(snapshot.llm_polling.models.shared,['renamed','a'])
    result=await call('/worker-config/providers/renamed','PUT',{expected_revision:snapshot.revision,name:'renamed',api:'openai-completions',base_url:'http://127.0.0.1:1/v1',models:[{id:'other'}]})
    assert.equal(result.status,200);snapshot=result.data
    assert.deepEqual(snapshot.llm_polling.models.shared,['a'])
    result=await call('/worker-config/providers/a?expected_revision='+snapshot.revision,'DELETE')
    assert.equal(result.status,200);assert.deepEqual(result.data.llm_polling.models.shared,[])
    result=await call('/worker-config/llm-polling','PUT',{expected_revision:result.data.revision,enabled:true,models:{}})
    assert.equal(result.status,200);assert.equal(result.data.llm_polling.enabled,true)
  } finally { await engine.close();rmSync(root,{recursive:true,force:true}) }
})
