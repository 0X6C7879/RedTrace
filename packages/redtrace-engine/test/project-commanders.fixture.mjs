import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Configuration} from '../src/config.ts'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {providerProfiles} from '../src/models.ts'
import {load} from '../../redtrace-dsh/lib/loader.js'
import {createCommanderController} from '../compat/legion.mjs'
const work=mkdtempSync(path.join(os.tmpdir(),'redtrace-project-commanders-')),configuration=new Configuration(work);configuration.initialize()
const store=new Store(work+'/engine.db'),legion=new LegionStore(store)
const projects=['A','B'].map(title=>store.createProject({mode:'general',title,origin:'authorized local protocol fixture',goal:'save own state'}).project)
const requests=new Map(),first=new Set(),responses=new Set();let release;const both=new Promise(r=>release=r);let overlap=false,ctx,controller
const model=createServer(async(req,res)=>{
 responses.add(res);res.on('close',()=>responses.delete(res))
 try{let text='';for await(const b of req)text+=b;const input=JSON.parse(text),all=JSON.stringify(input.messages),projectId=all.match(/Assigned Project=(proj_\d+)/)?.[1];assert(projectId)
 requests.set(projectId,(requests.get(projectId)??0)+1)
 const boundary=input.messages.findLastIndex(m=>(m.tool_calls??[]).some(c=>c.function.name==='legion_finish'))
 const calls=input.messages.slice(boundary+1).flatMap(m=>m.tool_calls??[]).map(c=>c.function.name)
 if(!first.has(projectId)){first.add(projectId);if(first.size===2){overlap=true;release()}await both}
 let name,args
 if(!calls.includes('legion_read_changes')){name='legion_read_changes';args={projectId}}
 else{const output=JSON.parse(input.messages.filter(m=>m.role==='tool').at(-1).content);assert(output.events.every(e=>e.projectId===projectId));name='legion_finish';args={processed:{[projectId]:output.cursor},state:'STATE only '+projectId}}
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-'+projectId+'-'+requests.get(projectId),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
 }catch(error){res.writeHead(500);res.end(String(error))}
})
try{
 await new Promise(r=>model.listen(0,'127.0.0.1',r))
 configuration.commit(configuration.read().revision,raw=>{raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+model.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:30000,max_tokens:1000,reasoning:'off',reasoning_efforts:false}]}};raw.workers=[{name:'commander',roles:['commander'],provider:'fixture',model:'fixture',max_running:2}];raw.runtime={max_workers:2,max_project_workers:2,max_running_projects:2};raw.tasks={commander:{timeout:15,conclude_timeout:2}}})
 const{Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js');ctx=new Context()
 for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']){const module=await load(file);await ctx.plugin(module.default??module).await()}
 const persist=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js');await ctx.plugin(persist,{root:work+'/sessions'}).await()
 const llm=await import('../compat/llm.mjs');await ctx.plugin(llm,{providers:providerProfiles(configuration.resolvedSnapshot().config).providers,credentialSource:{root:work,filename:configuration.filename,revision:configuration.read().revision}}).await()
 controller=createCommanderController(ctx,{store,legion,configuration,scheduler:{maintenance:false,wake(){}}});controller.start()
 const until=async predicate=>{const deadline=Date.now()+12000;while(!predicate()){if(Date.now()>deadline)throw Error('Concurrent Commander fixture did not settle '+JSON.stringify(legion.campaigns()));await new Promise(r=>setTimeout(r,10))}}
 await until(()=>legion.campaigns().every(c=>c.status==='idle'&&c.state.includes(c.projectId)))
 assert(overlap);assert.notEqual(legion.campaign(projects[0].id).sessionId,legion.campaign(projects[1].id).sessionId)
 const before=requests.get(projects[1].id);store.addInput(projects[0].id,'hint','A-only event')
 await until(()=>legion.campaign(projects[0].id).cursors[projects[0].id]?.acknowledged===Number(store.db.prepare('SELECT MAX(id) AS n FROM events WHERE project_id=?').get(projects[0].id).n))
 assert.equal(requests.get(projects[1].id),before,'A event must not wake B')
 console.log('PROJECT_COMMANDERS_CONCURRENT=true; distinct_native_sessions=true; own_STATE=true; A_event_does_not_wake_B=true; global_slots=2; model=local-protocol-fixture')
}finally{await controller?.close();await ctx?.fiber.dispose();store.close();for(const res of responses)res.destroy();await new Promise(r=>model.close(r));rmSync(work,{recursive:true,force:true})}
