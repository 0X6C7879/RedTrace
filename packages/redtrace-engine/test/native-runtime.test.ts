import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { domainTools, rewriteToolNames, actionParameters } from '../../redtrace-dsh/src/tool-domains.ts'
import { providerProfiles } from '../src/models.ts'
import { Store } from '../src/store.ts'
import { graphUpdate } from '../src/runner.ts'

const native = createRequire(import.meta.url)('../src/native/redtrace_native.node') as {
  NativeGraphNotice: new (cursor: number, step: string | null, critical: boolean, stopped: boolean, version: number, bound: number, hasStep: boolean, seq: number) => {ingest(events: unknown[]): number; finish(cursor?: number): string}
}

test('domain schemas keep mutable branches and original action references isolated across registrations', async () => {
  const calls: unknown[] = []
  const source = (name: string, parameters: any) => ({name, description: name, parameters, execute: (...args: unknown[]) => calls.push(args)})
  const list = {type:'object', properties:{kind:{type:'string'}}, required:['kind']}
  const register = {type:'object', properties:{kind:{type:'integer'}, name:{type:'string'}}, required:['kind','name']}
  const tools = [source('resource_list', list), source('resource_register', register)]
  const first = domainTools(tools)[0], second = domainTools(tools)[0]
  assert.equal(first.parameters.properties.kind.anyOf[0], list.properties.kind)
  first.parameters.properties.action.enum.push('injected')
  first.parameters.anyOf[0].properties.action.const = 'injected'
  first.parameters.required.push('injected')
  assert.deepEqual(second.parameters.properties.action.enum, ['list','register'])
  assert.equal(second.parameters.anyOf[0].properties.action.const, 'list')
  assert.deepEqual(second.parameters.required, ['action','kind'])
  assert.deepEqual(actionParameters(second.parameters, {}).anyOf, second.parameters.anyOf)
  const params = actionParameters(second.parameters, {action:'register'})
  assert.equal(params.properties.kind.type, 'integer')
  assert.deepEqual(params.required, ['action','kind','name'])
  await second.execute('call', {action:'list',kind:'fixture'})
  assert.deepEqual(calls, [['call',{kind:'fixture'}]])
  const third = domainTools(tools, name => name !== 'resource_register')[0]
  assert.deepEqual(third.parameters.properties.action.enum, ['list'])
  assert(!third.parameters.properties.name)
})

test('schema property keys, required names and opaque JSON strings keep lone UTF-16 surrogates', async () => {
  const key = 'k\ud800', raw = {type:'string',description:'description\udfff',enum:['value\ud800'],default:'default\udfff'}
  const calls: unknown[] = []
  const tools = domainTools([
    {name:'resource_list',description:'read',parameters:{type:'object',properties:{[key]:raw},required:[key]},execute:(value: unknown) => calls.push(value)},
    {name:'resource_register',description:'write',parameters:{type:'object',properties:{other:{type:'integer'}},required:['other']},execute:()=>{}},
  ])
  const parameters = tools[0].parameters
  assert.equal(parameters.properties[key], raw)
  const branch = actionParameters(parameters, {action:'list'})
  assert.deepEqual(branch.required, ['action',key])
  assert.equal(branch.properties[key].description, 'description\udfff')
  assert.deepEqual(branch.properties[key].enum, ['value\ud800'])
  await tools[0].execute({action:'list',[key]:'value\ud800'})
  assert.deepEqual(calls,[{[key]:'value\ud800'}])
})

test('tool rewriting retains JavaScript word boundaries and lone UTF-16 surrogates', () => {
  assert.equal(rewriteToolNames('中submit_fact({x:1}) xsubmit_fact submit_fact_x 😀submit_fact\ud800'), '中fgs_publish({action:"fact",x:1}) xsubmit_fact submit_fact_x 😀fgs_publish (action=fact)\ud800')
})

test('DSH provider projection keeps missing/null efforts and protocol replay contracts', () => {
  const config: any = {providers:{fixture:{api:'openai-completions',baseUrl:'https://fixture///',apiKey:'secret\ud800',models:[{id:'m\udfff',thinkingFormat:'none'},{id:'effort',contextWindow:123,maxTokens:45,reasoningEfforts:{high:'h'}}]}}}
  const result: any = providerProfiles(config)
  assert.equal(result.providers.fixture.baseURL,'https://fixture//')
  assert.equal(result.env.REDTRACE_DSH_KEY_66697874757265,'secret\ud800')
  assert.equal(result.providers.fixture.models[0].id,'m\udfff')
  assert.equal(result.providers.fixture.models[0].reasoningEfforts,false)
  assert.equal(result.providers.fixture.models[0].contextWindow,undefined)
  assert.deepEqual(result.providers.fixture.models[1].reasoningEfforts,{high:'h'})
  assert.deepEqual(result.providers.fixture.models[1].compat,{supportsDeveloperRole:false})
})

test('native graph notices retain page cursors, stopped state and bounded insertion-ordered node IDs', () => {
  const notice = new native.NativeGraphNotice(0,null,true,false,1,1,false,7)
  for(let page=0;page<2;page++) notice.ingest(Array.from({length:10},(_,i)=>({id:page*10+i+1,eventType:'fact.added',nodeId:'f'+(page*10+i),evidenceSeq:page*10+i+1,hintSeq:0})))
  notice.ingest([{id:21,eventType:'planning.critical',nodeId:'',evidenceSeq:0,hintSeq:0}])
  const output=JSON.parse(notice.finish(24))
  assert.equal(output.cursor,24);assert.equal(output.evidenceSeq,20);assert.equal(output.criticalSeq,7)
  assert.equal(output.counts['fact.added'],20);assert.equal(output.nodeIds.length,16);assert.equal(output.omitted,true)
  const stopped=new native.NativeGraphNotice(0,'step',true,true,2,1,true,0)
  stopped.ingest([{id:1,eventType:'step.revised',nodeId:'step',evidenceSeq:0,hintSeq:0}])
  assert.equal(JSON.parse(stopped.finish()).planChanged,false)
  assert.equal(JSON.parse(stopped.finish()).relevant,false)
})

test('graph notice node IDs inherit SQLite text conversion without parsing opaque payload strings', () => {
  const store = new Store(':memory:')
  try {
    const project = store.createProject({title:'unicode',origin:'local fixture',goal:'retain SQLite behavior'}).project
    const after = Number(store.db.prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?').get(project.id)!.id)
    const payload = JSON.stringify({evidenceSeq:11,description:'opaque\udfff'})
    store.db.prepare('INSERT INTO events(project_id,revision,type,node_id,data,created_at) VALUES(?,?,?,?,?,?)').run(project.id,1,'fact.added','node\ud800',payload,'2000-01-01T00:00:00Z')
    const expected = store.events(project.id,after)[0]
    assert.equal((expected.payload as any).description,'opaque\udfff')
    assert.equal(expected.nodeId,'node�')
    const update = graphUpdate(store,project.id,after,null)
    assert.deepEqual(update.nodeIds,[expected.nodeId])
    assert.equal(update.evidenceSeq,11)
    assert.equal(update.counts['fact.added'],1)
  } finally { store.close() }
})

test('configuration and domain catalogs import before the native build, including launcher help', () => {
  const script = `import Module from 'node:module'; const original=Module._load; Module._load=function(request,...args){if(String(request).endsWith('.node'))throw new Error('native addon loaded before build');return original.call(this,request,...args)};await import(${JSON.stringify(new URL('../src/config.ts',import.meta.url).href)});await import(${JSON.stringify(new URL('../../redtrace-dsh/src/tool-domains.ts',import.meta.url).href)});process.argv=['node','--help'];await import(${JSON.stringify(new URL('../../../scripts/run-redtrace-node.mjs',import.meta.url).href)})`
  const output=execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8'})
  assert.match(output,/RedTrace Node: --root DIR/)
})
