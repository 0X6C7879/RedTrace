import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {serveEngine} from '../src/index.ts'
import {configuredConversationModels,conversationWorker} from '../src/chat.ts'
import {providerProfiles} from '../src/models.ts'
import {load} from '../../redtrace-dsh/lib/loader.js'
const root=path.resolve(import.meta.dirname,'../../..'),html=readFileSync(root+'/static/index.html','utf8')

test('provider models without Worker bindings are selectable without changing capacity, roles or tool identity',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'model-choices-')),e=await serveEngine({root:dir,autoStart:false,port:0}),base='http://127.0.0.1:'+(e.server.address() as any).port
 try {
 e.configuration.commit(e.configuration.read().revision,raw=>{raw.providers={fixture:{api:'anthropic-messages',base_url:'http://fixture.invalid',models:[{id:'custom-a',context_window:30000,max_tokens:8192},{id:'custom-b',context_window:30000,max_tokens:8192,reasoning_efforts:{minimal:'minimal',low:'low',medium:'medium',high:'high'}},{id:'disabled-thinking',context_window:30000,max_tokens:8192,reasoning_efforts:false}]}};raw.workers=[{name:'commander',provider:'fixture',model:'custom-a',roles:['commander'],max_running:1},{name:'disabled',provider:'fixture',model:'custom-a',roles:['commander'],enabled:false}]})
 const config=e.configuration.resolvedSnapshot().config,choices=configuredConversationModels(config),choice=choices.find(m=>m.model==='custom-b')!
 assert.deepEqual(choices.map(m=>m.model),['custom-a','custom-b','disabled-thinking']);assert.deepEqual(choice.reasoningEfforts,['minimal','low','medium','high']);assert.equal(choices[2].reasoningEfforts.length,0);assert.deepEqual(choices[0].reasoningEfforts,[]);assert(!Object.hasOwn((providerProfiles(config).providers as any).fixture.models[0],'reasoningEfforts'))
 const worker=conversationWorker(config,choice.name)!;assert.equal(worker.name,'commander');assert.equal(worker.model,'custom-b');assert.equal(worker.maxRunning,1);assert.deepEqual(worker.roles,['commander']);assert.equal(conversationWorker(config,'disabled'),undefined)
 assert.deepEqual((providerProfiles(config).providers as any).fixture.models[1].reasoningEfforts,{minimal:'minimal',low:'low',medium:'medium',high:'high'})
 const project=e.store.createProject({mode:'benchmark',title:'model selection',origin:'fixture',goal:'test'}).project
 const response=await fetch(base+'/v2/legion/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:project.id,receiver:'commander',type:'MESSAGE',content:'next cycle',worker:choice.name,reasoning:'high'})});assert.equal(response.status,200);assert.equal(e.legion.campaign(project.id).nextWorker,choice.name);assert.equal(e.legion.campaign(project.id).reasoning,'high')
 e.configuration.commit(e.configuration.read().revision,raw=>{raw.providers!.fixture.models.splice(1,1)});assert.equal(conversationWorker(e.configuration.resolvedSnapshot().config,choice.name),undefined)
 }finally{await e.close();rmSync(dir,{recursive:true,force:true})}
})

test('both composers use immediate native capsule sliders, reset effort on model change, and remove redundant labels',()=>{
 const c=vm.createContext({window:{}});vm.runInContext(readFileSync(root+'/static/workbench.js','utf8'),c);const a=c.window.redtraceWorkbench;a.chatId='global';a.conversationModels=[{name:'route',reasoningEfforts:['off','low','high','max']}]
 assert.equal(a.reasoningPosition('global'),0);a.chooseReasoning('global','high');assert.equal(a.reasoningPosition('global'),2);assert.deepEqual(Array.from(a.reasoningOptions('global')),['','low','high','max']);assert.equal(a.modelSelections.global,'route');a.changeComposerModel('global');assert.equal(a.reasoningPosition('global'),0)
 assert.equal((html.match(/class="wb-reasoning-slider"/g)||[]).length,2);assert.equal((html.match(/aria-valuetext="reasoningLabel/g)||[]).length,2);assert(!html.includes('wb-reasoning-capsules'));assert(!html.includes('Shift+Enter 换行'));assert(!html.includes('恢复项目'));assert(!html.includes('停止项目'));assert(!html.includes('>Snapshot<'));assert(html.includes("'停止' : '恢复'"))
 const logs=html.slice(html.indexOf('<section x-show="appPage === \'logs\'"'),html.indexOf('<section x-show="appPage === \'skills\'"'));assert(logs.includes('systemLogsPage()'));assert(!logs.includes('auditPage()'));assert(!logs.includes('Commander'));assert(!logs.includes('工作区文件'))
})

test('system log endpoint reads existing native logger buffer, formats errors, redacts credentials and never reads model sessions',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'system-logs-')),e=await serveEngine({root:dir,autoStart:false,port:0}),base='http://127.0.0.1:'+(e.server.address() as any).port
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),ctx=new Context(),{mountSystemLogs}=await import(new URL('../compat/console.mjs',import.meta.url).href)
 try {
 e.configuration.commit(e.configuration.read().revision,raw=>{raw.providers={fixture:{api:'openai-completions',base_url:'http://fixture.invalid',api_key:'fixture-secret',models:[{id:'fixture',context_window:30000,max_tokens:8192}]}};raw.common_env={TEST_TOKEN:'common-secret'}})
 await mountSystemLogs(ctx,e);ctx.logger('scheduler').info('ready %s','worker');ctx.logger('plugins').warn('failed key=fixture-secret Bearer other-secret https://example.test?token=query-secret common-secret');ctx.logger('engine').error(new Error('fixture error'))
 const response=await fetch(base+'/console/logs'),entries=await response.json() as any[];assert.equal(response.status,200);assert.equal(entries[0].source,'scheduler');assert.equal(entries[0].message,'ready worker');assert.equal(entries[1].level,'warn');assert(!JSON.stringify(entries).includes('fixture-secret'));assert(!JSON.stringify(entries).includes('other-secret'));assert(!JSON.stringify(entries).includes('query-secret'));assert(!JSON.stringify(entries).includes('common-secret'));assert(entries[2].message.includes('Error: fixture error'));assert(entries.every(v=>!('sessionId' in v)));assert.equal(e.store.db.prepare('SELECT count(*) AS n FROM audit_events').get()!.n,0)
 }finally{await ctx.fiber.dispose();await e.close();rmSync(dir,{recursive:true,force:true})}
})

test('system log view searches, filters, refreshes only while visible and preserves history reading position',async()=>{
 let tick:()=>void=()=>{},cleared=0;const c=vm.createContext({window:{},setInterval:(fn:()=>void)=>{tick=fn;return 1},clearInterval:()=>cleared++});vm.runInContext(readFileSync(root+'/static/console.js','utf8'),c)
 let calls=0;c.capabilityRequest=async()=>{calls++;return [{id:1,level:'warn',source:'scheduler',message:'capacity'},{id:2,level:'info',source:'plugins',message:'ready'}]};const a=c.window.systemLogsPage(),scroller={scrollHeight:500,scrollTop:100,clientHeight:100};a.$refs={logList:scroller};a.$nextTick=(fn:()=>void)=>fn()
 await a.setActive(true);assert.equal(calls,1);assert.equal(scroller.scrollTop,100);a.level='warn';assert.equal(a.filtered.length,1);a.query='plugins';assert.equal(a.filtered.length,0);a.level='';assert.equal(a.filtered.length,1);a.autoFollow=false;tick();assert.equal(calls,1);await a.setActive(false);assert(cleared>=2)
 c.capabilityRequest=async()=>{throw new Error('unavailable')};await a.load();assert.equal(a.error,'unavailable');assert.equal(a.entries.length,2)
})

test('removed or unsupported saved efforts reset to default; supplier choices are per-model and never offer off',async()=>{
 const c=vm.createContext({window:{}});vm.runInContext(readFileSync(root+'/static/workbench.js','utf8'),c);const a=c.window.redtraceWorkbench;a.chatId='one';a.modelSelections={one:'route',two:'route',three:'route'};a.reasoningSelections={one:'off',two:'xhigh',three:'high'};a.api=async()=>[{name:'route',reasoningEfforts:['minimal','low','medium','high']}]
 await a.loadConversationModels();assert.equal(a.reasoningSelections.one,'');assert.equal(a.reasoningSelections.two,'');assert.equal(a.reasoningSelections.three,'high');assert(!a.reasoningOptions('global').includes('off'))
 const match=html.match(/providerReasoningOptions\(model\) \{([\s\S]*?)\n    \},/);assert(match);const options=new Function('model',match[1]),ui={conversationModels:[{provider:'p',model:'known',reasoningEfforts:['off','low','high']}],providerForm:{name:'p'}}
 assert.deepEqual(options.call(ui,{id:'known',reasoning_capability:'catalog'}),['low','high']);assert.deepEqual(options.call(ui,{id:'unknown',reasoning_capability:'catalog'}),[]);assert.deepEqual(options.call(ui,{reasoning_capability:'custom',reasoning_levels:['off','minimal','high']}),['minimal','high']);assert.deepEqual(options.call(ui,{reasoning_capability:'none'}),[]);assert(!html.includes('<option value="off">关闭</option>'))
})

test('four declared Anthropic budget levels produce four distinct native requests; aliases are not offered',async()=>{
 const {createServer}=await import('node:http'),{mount}=await import(new URL('../../redtrace-dsh/lib/loader.js',import.meta.url).href),{resolveReasoningEffort}=await import(new URL('../../redtrace-dsh/lib/agent.js',import.meta.url).href),{Configuration}=await import('../src/config.ts')
 const dir=mkdtempSync(path.join(os.tmpdir(),'native-effort-levels-')),c=new Configuration(dir);c.initialize();const requests:any[]=[]
 const server=createServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;requests.push(JSON.parse(raw));res.writeHead(200,{'Content-Type':'text/event-stream'});const event=(type:string,data:any)=>res.write('event: '+type+'\ndata: '+JSON.stringify(data)+'\n\n');event('message_start',{type:'message_start',message:{id:'m',type:'message',role:'assistant',model:'fixture',content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}});event('content_block_start',{type:'content_block_start',index:0,content_block:{type:'text',text:''}});event('content_block_delta',{type:'content_block_delta',index:0,delta:{type:'text_delta',text:'OK'}});event('content_block_stop',{type:'content_block_stop',index:0});event('message_delta',{type:'message_delta',delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:1}});event('message_stop',{type:'message_stop'});res.end()});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r))
 c.commit(c.read().revision,raw=>{raw.providers={fixture:{api:'anthropic-messages',base_url:'http://127.0.0.1:'+(server.address() as any).port,api_key:'fixture',models:[{id:'fixture',context_window:100000,max_tokens:128000,reasoning_efforts:{minimal:'minimal',low:'low',medium:'medium',high:'high'}}]}}})
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),ctx=new Context()
 try{
 await mount(ctx,'vendor/deepseek-harness/packages/llm/llm/lib/index.js');await mount(ctx,'packages/redtrace-engine/compat/llm.mjs',{providers:providerProfiles(c.resolvedSnapshot().config).providers,credentialSource:{root:dir,filename:c.filename,revision:c.read().revision}})
 const llm=ctx.get('llm'),info=await llm.resolveModelInfo('fixture','fixture');assert.deepEqual(info.reasoning.efforts.map((e:any)=>e.id),['minimal','low','medium','high'])
 for(const effort of ['minimal','low','medium','high']){let finish;for await(const part of llm.stream({provider:'fixture',model:'fixture',reasoningEffort:effort,messages:[{role:'user',content:[{type:'text',text:'Reply with OK only.'}]}],maxTokens:256,signal:AbortSignal.timeout(5000)}))if(part.type==='finish')finish=part.reason.kind;assert.equal(finish,'stop')}
 assert.deepEqual(requests.map(r=>r.thinking.budget_tokens),[256,1280,7424,15616]);assert.equal(new Set(requests.map(r=>JSON.stringify(r.thinking))).size,4)
 for(const effort of ['xhigh','max'])await assert.rejects(resolveReasoningEffort(llm,{provider:'fixture',model:'fixture',reasoning:effort}),/does not support/);assert.equal(await resolveReasoningEffort(llm,{provider:'fixture',model:'fixture',reasoning:'auto_max'}),'high');assert.equal(requests.length,4)
 }finally{await ctx.fiber.dispose();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));rmSync(dir,{recursive:true,force:true})}
})
