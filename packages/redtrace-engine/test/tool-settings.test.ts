import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'
import {serveEngine} from '../src/index.ts'
const {load,mount}=await import(new URL('../../redtrace-dsh/lib/loader.js',import.meta.url).href)
const {mountToolSettings}=await import(new URL('../compat/console.mjs',import.meta.url).href)

test('tool settings persist global and Worker bindings, including Commander; restore retains the native schema',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'tool-settings-'))
 const schema={type:'object',properties:{text:{type:'string',description:'Native text',default:'hello'}},required:['text']}
 const engine=await serveEngine({root,autoStart:false,port:0,runtimeCatalog:()=>({tools:[{name:'fixture',description:'Native description',parameters:schema,source:'RedTrace',scope:'global',status:'registered'}],mcp:[]})})
 try{
  engine.configuration.commit(engine.configuration.read().revision,raw=>{raw.workers=['commander','soldier'].map(name=>({name,provider:'mock',roles:[name as 'commander'|'soldier']}))})
  const api='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
  const get=async()=>await(await fetch(api+'/console/tools')).json() as any
  const save=async(revision:string,enabled:boolean,workers:string[])=>fetch(api+'/console/tools/fixture/settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({expected_revision:revision,enabled,workers})})
  let data=await get();const revision=data.revision
  assert.deepEqual(data.workers.map((w:any)=>w.name),['commander','soldier']);assert.deepEqual(data.tools[0].parameters,schema)
  assert.equal((await save(revision,false,['commander'])).status,200)
  data=await get();assert.equal(data.tools[0].enabled,false);assert.deepEqual(data.tools[0].workerBindings,['commander'])
  assert.equal((await save(revision,true,['commander'])).status,409)
  assert.equal((await save(data.revision,true,['missing'])).status,400)
  assert.equal((await save(data.revision,true,['commander'])).status,200)
  assert.deepEqual(engine.configuration.read().raw.tool_settings,{fixture:{enabled:true,workers:['commander']}})
  data=await get();assert.equal((await save(data.revision,true,['commander','soldier'])).status,200)
  assert.equal(engine.configuration.read().raw.tool_settings,undefined);assert.deepEqual((await get()).tools[0].parameters,schema)
 }finally{await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('native dispatch honors global and scoped Worker switches for Commander, Worker and program subcalls',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'tool-native-switch-')),engine=await serveEngine({root,autoStart:false,port:0})
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),ctx=new Context()
 try{
  for(const module of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','vendor/deepseek-harness/packages/subprocess/subprocess-local/lib/index.js','packages/redtrace-dsh/lib/core.js'])await mount(ctx,module)
  await ctx.fiber.await();mountToolSettings(ctx,engine)
  const p=engine.store.createProject({title:'Switch fixture',origin:'local',goal:'verify'}).project
  const step=engine.store.addStep(p.id,{description:'fixture',sourceIds:['origin']}),run=engine.store.claim(p.id,'execute',{name:'soldier',backend:'mock'},step.id)
  const campaign=engine.legion.campaign(p.id);engine.legion.saveCampaign({...campaign,workerName:'commander'})
  const {createScope}=await load('vendor/deepseek-harness/packages/core/scope/lib/index.js')
  const {SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
  const agents:any[]=[];let bodies=0,callId=0
  for(const id of [campaign.sessionId,run.id]){
   const carrier=ctx.plugin({inject:['tools','systemPrompt'],apply(){}});await carrier.await()
   const agent:any={options:{},session:ctx.sessions.create(SessionId(id),{meta:{cwd:root}})}
   const scope=createScope(carrier.ctx,agent);agent.ctx=scope.ctx
   agent.ctx.tools.register({name:'fixture',description:'Real native dispatch',parameters:{type:'object',properties:{}},output:{schema:{type:'object',additionalProperties:true},render:()=>[{type:'text',text:'ran'}]},execute:()=>{bodies++;return{ran:true}}})
   agents.push(agent)
  }
  const set=(enabled:boolean,workers?:string[])=>engine.configuration.commit(engine.configuration.read().revision,raw=>{raw.tool_settings={fixture:{enabled,...(workers?{workers}:{})}}})
  const invoke=async(agent:any)=>{const batch=await ctx.get('tools').execute({calls:[{type:'tool-call',name:'fixture',arguments:'{}',id:'switch-'+ ++callId}],agent,signal:new AbortController().signal});return batch.results[0].result}
  assert.equal((await invoke(agents[0])).isError,false);assert.equal((await invoke(agents[1])).isError,false);assert.equal(bodies,2)
  set(false);assert.equal((await invoke(agents[0])).isError,true);assert.equal((await invoke(agents[1])).isError,true);assert.equal(bodies,2)
  set(true,['commander']);assert.equal((await invoke(agents[0])).isError,false);assert.equal((await invoke(agents[1])).isError,true);assert.equal(bodies,3)
  const {ToolExecutionPipeline}=await load('vendor/deepseek-harness/packages/core/tools/lib/pipeline.js'),pipeline=new ToolExecutionPipeline(ctx)
  const nested=await pipeline.prepare({name:'fixture',callId:'nested',rootCallId:'root',arguments:{},agent:agents[1],parent:{} as any,signal:new AbortController().signal})
  assert.equal(nested.kind,'post-result');assert.match(nested.result.error.message,/未绑定/);assert.equal(bodies,3)
  set(true);assert.equal((await invoke(agents[1])).isError,false);assert.equal(bodies,4)
 }finally{await ctx.fiber.dispose();await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('tool dialog opens schema details and persists the selected global and Worker controls',async()=>{
 const source=path.resolve(import.meta.dirname,'../../..'),calls:any[]=[],ctx=vm.createContext({window:{},capabilityRequest:async(method:string,url:string,body:any)=>{calls.push({method,url,body});return method==='GET'?{revision:'next',workers:[{name:'commander'}],tools:[tool],calls:[],stats:{}}:{}}})
 const tool={name:'fixture',source:'RedTrace',enabled:true,workerBindings:['commander'],parameters:{type:'object',properties:{text:{type:'string',description:'Text',default:'hello'}},required:['text']}}
 vm.runInContext(readFileSync(source+'/static/console.js','utf8'),ctx)
 const page=ctx.window.toolsPage();let opened=false;page.$refs={toolDialog:{showModal(){opened=true}}};page.data={revision:'initial',workers:[{name:'commander'}],tools:[tool]};page.open(tool)
 assert(opened);assert.equal(page.parameters[0].required,true);assert.equal(page.parameters[0].default,'hello')
 page.draft.enabled=false;await page.save();assert.equal(calls[0].body.enabled,false);assert.deepEqual(Array.from(calls[0].body.workers),['commander']);assert.equal(calls[0].url,'/console/tools/fixture/settings');assert.match(page.saved,/已保存/)
 const html=readFileSync(source+'/static/index.html','utf8');assert.match(html,/@click="open\(tool\)"/);assert.match(html,/role="switch" aria-label="启用"/)
})

test('switch on/off colors override the shared important input styles without changing palette tokens',()=>{
 const source=path.resolve(import.meta.dirname,'../../..'),css=readFileSync(source+'/static/console.css','utf8')
 assert.match(css,/\.tool-global input\[role=switch\]\{[^}]*background-color:var\(--rt-surface-active\)!important;[^}]*border-color:var\(--rt-border\)!important/)
 assert.match(css,/\.tool-global input\[role=switch\]:checked\{background-color:var\(--rt-coral\)!important;border-color:var\(--rt-coral\)!important/)
})
