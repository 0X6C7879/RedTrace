import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync,readFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {serveEngine} from '../src/index.ts'
const {load,mount}=await import(new URL('../../redtrace-dsh/lib/loader.js',import.meta.url).href)
const {mountExecutionTools}=await import(new URL('../../redtrace-dsh/lib/execution-tools.js',import.meta.url).href)
const {mountToolSettings,mountSystemLogs}=await import(new URL('../compat/console.mjs',import.meta.url).href)

test('Commander/Planner native documents work; editable DSH settings hot-load Schema and dispatch without changing native definitions',{timeout:30000},async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'coordinator-io-')),engine=await serveEngine({root,autoStart:false,port:0})
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),ctx=new Context()
 try{
  for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','vendor/deepseek-harness/packages/subprocess/subprocess-local/lib/index.js','packages/redtrace-dsh/lib/core.js'])await mount(ctx,file)
  mountToolSettings(ctx,engine)
  const {createScope}=await load('vendor/deepseek-harness/packages/core/scope/lib/index.js'),{SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
  let call=0
  for(const [mode,role] of [['benchmark','commander'],['general','planner']] as const){
   const p=engine.store.createProject({mode,title:role,origin:'local fixture',goal:'verify'}).project,c=engine.legion.campaign(p.id),cwd=path.join(root,p.id);mkdirSync(cwd)
   const carrier=ctx.plugin({inject:['tools','systemPrompt'],apply(){}});await carrier.await()
   const agent:any={options:{},session:ctx.sessions.create(SessionId(c.sessionId),{meta:{cwd}}),model:{current:()=>({provider:'fixture',model:'fixture'})}},scope=createScope(carrier.ctx,agent);agent.ctx=scope.ctx
   await mountExecutionTools(scope.ctx,{task:{type:role,projectId:p.id,worker:'fixture',committed:false},cwd,sessionRoot:root,skillsDir:path.join(root,'skills'),available:(id:string)=>['redtrace-fs-search','redtrace-jobs'].includes(id)})
   scope.ctx.tools.restrict({allow:[]})
   const resolve=()=>ctx.tools.resolve({agent,modelSelection:agent.model.current(),signal:new AbortController().signal})
   const names=async()=>{const s=await resolve();try{return ctx.tools.schemas(agent,s).map((t:any)=>t.name)}finally{s.dispose()}}
   const invoke=async(name:string,args:any,set?:any)=>{const own=!set,selected=set??await resolve();try{return(await ctx.tools.execute({agent,signal:new AbortController().signal,toolSet:selected,calls:[{type:'tool-call',name,id:'native-'+ ++call,arguments:JSON.stringify(args)}]})).results[0].result}finally{if(own)selected.dispose()}}
   const tools=await names();for(const name of ['read','write','edit','glob','grep'])assert(tools.includes(name),role+' '+name)
   assert.equal(tools.includes('bash'),role==='planner');assert(!tools.some((n:string)=>n.startsWith('mcp__rea__')))
   assert.equal((await invoke('write',{file_path:'handoff.md',content:role+' evidence=verified\n'})).isError,false)
   assert.equal((await invoke('read',{file_path:'handoff.md'})).isError,false)
   assert.equal((await invoke('edit',{file_path:'handoff.md',old_string:'verified',new_string:'retained'})).isError,false)
   assert.equal(readFileSync(path.join(cwd,'handoff.md'),'utf8'),role+' evidence=retained\n')
   let ready=false,release!:()=>void,started!:()=>void
   const entered=new Promise<void>(r=>started=r),held=new Promise<void>(r=>release=r)
   const conditional={name:'native_condition_fixture',description:'Native activation and in-flight fixture',parameters:{type:'object',properties:{}},output:{schema:{type:'object'},render:()=>[{type:'text',text:'settled'}]},execute:async()=>{started();await held;return{settled:true}}}
   scope.ctx.tools.register(conditional,{when:()=>ready})
   assert(!(await names()).includes(conditional.name),'native activation conditions remain authoritative')
   ready=true;assert((await names()).includes(conditional.name))
   const active=invoke(conditional.name,{})
   await entered
   engine.configuration.commit(engine.configuration.read().revision,raw=>{raw.tool_settings={[conditional.name]:{enabled:false}}})
   release();assert.equal((await active).isError,false,'a started native call settles after a settings change')
   assert(!(await names()).includes(conditional.name))
   engine.configuration.commit(engine.configuration.read().revision,raw=>{delete raw.tool_settings})
   const definition=ctx.tools.get('read',agent)
   const schema=JSON.stringify(ctx.tools.get('read',agent).parameters),stale=await resolve()
   engine.configuration.commit(engine.configuration.read().revision,raw=>{raw.tool_settings={read:{enabled:true,roles:[role==='commander'?'planner':'commander']}}})
   assert(!(await names()).includes('read'));assert.equal((await invoke('read',{file_path:'handoff.md'},stale)).isError,true)
   stale.dispose()
   engine.configuration.commit(engine.configuration.read().revision,raw=>{raw.tool_settings={read:{enabled:false}}})
   assert(!(await names()).includes('read'))
   engine.configuration.commit(engine.configuration.read().revision,raw=>{delete raw.tool_settings})
   assert((await names()).includes('read'));assert.equal((await invoke('read',{file_path:'handoff.md'})).isError,false)
   assert.equal(JSON.stringify(ctx.tools.get('read',agent).parameters),schema);assert.equal(ctx.tools.get('read',agent),definition)
   await scope.dispose();await carrier.dispose()
  }
 }finally{await ctx.fiber.dispose();await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('system logs forward real Project/Worker/FGS events once, retain warnings and omit raw evidence bodies',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'lifecycle-logs-')),engine=await serveEngine({root,autoStart:false,port:0})
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),ctx=new Context()
 try{
  await mountSystemLogs(ctx,engine)
  const p=engine.store.createProject({title:'logs',origin:'private fixture body',goal:'verify'}).project
  const step=engine.store.addStep(p.id,{description:'do not log this secret body',sourceIds:['origin']}),run=engine.store.claim(p.id,'execute',{name:'pool',backend:'mock'},step.id)
  engine.store.addFact(p.id,'private evidence',{runId:run.id,evidence:[{description:'raw private proof'}]});engine.store.finishRun(run.id,'failed','private error details')
  await new Promise(r=>setImmediate(r))
  const url='http://127.0.0.1:'+(engine.server.address() as any).port+'/console/logs',first=await(await fetch(url)).json() as any[]
  for(const type of ['project.created','step.added','execute.started','fact.added','execute.failed'])assert(first.some(e=>e.message.includes(type)),type)
  assert.equal(first.filter(e=>e.message.includes('execute.started')).length,1)
  assert.equal(first.find(e=>e.message.includes('execute.failed')).level,'warn')
  assert(!JSON.stringify(first).includes('raw private proof'));assert(!JSON.stringify(first).includes('private error details'))
  engine.store.changes.emit('change',p.id);assert.equal((await(await fetch(url)).json() as any[]).length,first.length)
  console.log('REAL_LIFECYCLE_LOGS='+first.length+'; no_duplicate_events=true; no_model_or_evidence_bodies=true')
 }finally{await ctx.fiber.dispose();await engine.close();rmSync(root,{recursive:true,force:true})}
})


test('existing native Web session reloads common-env keys; an in-flight search keeps its original configuration',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'coordinator-web-'))
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),ctx=new Context()
 const names=['TINYFISH_API_KEY','ANYSEARCH_API_KEY','EXA_API_KEY','TAVILY_API_KEY','FIRECRAWL_API_KEY','BRAVE_API_KEY','SERPAPI_API_KEY','JINA_API_KEY'],saved=Object.fromEntries(names.map(n=>[n,process.env[n]])),originalFetch=globalThis.fetch
 let refresh!:()=>Promise<void>,search:any,release!:()=>void,entered!:()=>void
 const started=new Promise<void>(r=>entered=r),held=new Promise<void>(r=>release=r),keys:string[]=[]
 try{
  for(const name of names)delete process.env[name]
  process.env.EXA_API_KEY='fixture-before'
  globalThis.fetch=async(input,init)=>{
   assert.equal(String(input),'https://api.exa.ai/search')
   keys.push(new Headers(init?.headers).get('x-api-key')!)
   if(keys.length===1){entered();await held;assert.equal(init?.signal?.aborted,false)}
   return new Response(JSON.stringify({results:[]}))
  }
  for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','vendor/deepseek-harness/packages/subprocess/subprocess-local/lib/index.js','packages/redtrace-dsh/lib/core.js'])await mount(ctx,file)
  const carrier=ctx.plugin({inject:['tools','systemPrompt'],apply(){}});await carrier.await()
  const {createScope}=await load('vendor/deepseek-harness/packages/core/scope/lib/index.js'),scope=createScope(carrier.ctx,{})
  await mountExecutionTools(scope.ctx,{task:{type:'planner',projectId:'fixture',worker:'fixture',committed:false},cwd:root,sessionRoot:root,skillsDir:root,available:(id:string)=>id==='redtrace-web',onRefresh:(fn:()=>Promise<void>)=>refresh=fn,onSchemas:(_plugin:string,tools:any[])=>{search=tools.find(t=>t.name==='web_search')??search}})
  const pending=search.execute({queries:['local fixture']},{signal:new AbortController().signal})
  await started;process.env.EXA_API_KEY='fixture-after';await refresh();release();await pending
  await search.execute({queries:['local fixture']},{signal:new AbortController().signal})
  assert.deepEqual(keys,['fixture-before','fixture-after'])
  delete process.env.EXA_API_KEY;await refresh()
  await assert.rejects(search.execute({queries:['local fixture']},{signal:new AbortController().signal}))
  await scope.dispose();await carrier.dispose()
  console.log('WEB_CONFIG_HOTLOAD=true; in_flight_search_preserved=true; removed_key_not_reused=true')
 }finally{release?.();globalThis.fetch=originalFetch;for(const [name,value]of Object.entries(saved)){if(value===undefined)delete process.env[name];else process.env[name]=value}await ctx.fiber.dispose();rmSync(root,{recursive:true,force:true})}
})
