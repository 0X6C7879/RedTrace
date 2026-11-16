import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import os from 'node:os'
import {deflateSync} from 'node:zlib'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {ChatStore,chatRoutes} from '../src/chat.ts'
import {Router} from '../src/http.ts'
import {Configuration} from '../src/config.ts'
import {providerProfiles} from '../src/models.ts'
import {load} from '../../redtrace-dsh/lib/loader.js'
import {mountGlobalChat} from '../compat/chat.mjs'
const work=mkdtempSync(os.tmpdir()+'/global-chat-native-'),store=new Store(work+'/engine.db'),legion=new LegionStore(store),chats=new ChatStore(store),configuration=new Configuration(work);configuration.initialize()
const p=store.createProject({mode:'general',title:'query fixture',origin:'local fixture',goal:'verify conversation isolation'}).project,graph=store.projectGraphs(p.id)[0]
let ctx,closeChat,http,requests=0,fileUpload,imageUpload;const outputs=new Set()
const model=createServer(async(req,res)=>{
 outputs.add(res);res.on('close',()=>outputs.delete(res))
 try{let raw='';for await(const b of req)raw+=b;const input=JSON.parse(raw),messages=JSON.stringify(input.messages),a=messages.includes('CHAT_A'),b=messages.includes('CHAT_B'),chief=messages.includes('CHIEF_TASK');assert.equal(Number(a)+Number(b)+Number(chief),1,'independent histories cannot mix');assert(!messages.includes('Assigned Project='),'no Commander context');requests++
 assert.equal(input.model,messages.includes('UNASSIGNED_MODEL')?'fixture-c':chief||messages.includes('RESUME_A')?'fixture-b':'fixture');if(chief||messages.includes('RESUME_A'))assert.equal(input.reasoning_effort,messages.includes('UNASSIGNED_MODEL')?'low':'high','selected native reasoning reached provider')
 const names=input.tools.map(t=>t.function.name);assert.deepEqual(names.sort(),['attachment_read','commander_message','project_hint','project_query','projects']);const calls=input.messages.flatMap(m=>m.tool_calls??[]).map(c=>c.function.name)
 let name,args
 if(chief){assert(JSON.stringify(input.messages).includes('PROJECT CHIEF'));assert(input.messages.some(m=>Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url')),'native vision bytes reached provider');if(!calls.includes('attachment_read')){name='attachment_read';args={id:fileUpload.id}}else if(!calls.includes('commander_message')){assert(messages.includes('user-uploaded fixture text'));name='commander_message';args={projectId:p.id,content:'human upload instruction',attachmentIds:[fileUpload.id,imageUpload.id]}}}
 else if(!calls.includes('projects')){name='projects';args={query:'query',limit:1}}
 else if(!calls.includes('project_hint')){name='project_hint';args={projectId:p.id,graphId:graph.id,content:a?'fixture Hint A':'fixture Hint B'}}
 const delta=name?{role:'assistant',tool_calls:[{index:0,id:'chat-call-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]}:{role:'assistant',content:chief?'Chief reply':('Global reply '+(a?'A':'B')+(messages.includes('RESUME_A')?' resumed':''))}
 if(messages.includes('RESUME_A'))assert(messages.includes('Global reply A'),'native history resumed')
 if(chief&&!name){res.writeHead(200,{'Content-Type':'text/event-stream'});for(const text of ['Chief ','reply']){res.write('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:text},finish_reason:null}]})+'\n\n');await new Promise(r=>setTimeout(r,40))}res.end('data: '+JSON.stringify({choices:[{index:0,delta:{},finish_reason:'stop'}]})+'\n\ndata: [DONE]\n\n');return}
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:name?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')
 }catch(e){console.error(e);res.writeHead(500);res.end(String(e))}
})
try{
 await new Promise(r=>model.listen(0,'127.0.0.1',r))
 configuration.commit(configuration.read().revision,raw=>{raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+model.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:30000,max_tokens:1000,reasoning:'off',reasoning_efforts:false},{id:'fixture-b',context_window:30000,max_tokens:1000,reasoning:'low',reasoning_efforts:{low:'low',high:'high'}},{id:'fixture-c',context_window:30000,max_tokens:1000,reasoning:'low',reasoning_efforts:{low:'low',high:'high'}}]}};raw.workers=[{name:'commander',roles:['commander','planner'],provider:'fixture',model:'fixture',max_running:3},{name:'commander-b',roles:['commander','planner'],provider:'fixture',model:'fixture-b',max_running:3}];raw.runtime={max_workers:3,max_project_workers:3,max_running_projects:2};raw.tasks={commander:{timeout:15,conclude_timeout:2}}})
 const{Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js');ctx=new Context()
 for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']){const m=await load(file);await ctx.plugin(m.default??m).await()}
 const persist=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js');await ctx.plugin(persist,{root:work+'/sessions'}).await()
 const attachment=await load('vendor/deepseek-harness/packages/attachment/attachment-local/lib/index.js');await ctx.plugin(attachment.default,{dshHome:work+'/dsh'}).await()
 const llm=await import('../compat/llm.mjs');await ctx.plugin(llm,{providers:providerProfiles(configuration.resolvedSnapshot().config).providers,credentialSource:{root:work,filename:configuration.filename,revision:configuration.read().revision}}).await()
 closeChat=mountGlobalChat(ctx,{chats,store,legion,configuration,scheduler:{wake(){}}},async()=>{})
 const a=chats.create('global A'),b=chats.create('global B');await Promise.all([chats.runtime(a,'CHAT_A query and add fixture Hint'),chats.runtime(b,'CHAT_B query and add fixture Hint')])
 assert.equal(store.nodes(p.id,['step']).length,0);assert.equal(store.nodes(p.id,['hint']).length,2);assert.notEqual(a.sessionId,legion.campaign(p.id).sessionId)
 await assert.rejects(chats.runtime(chats.get(a.id),'invalid route',[],'missing'),/enabled DSH Commander/);await assert.rejects(chats.runtime(chats.get(a.id),'invalid effort',[],'commander-b','ultra'),/does not support/);
 await chats.runtime(chats.get(a.id),'RESUME_A continue this independent conversation',[],'commander-b','high');assert.equal(chats.get(a.id).selectedWorker,'commander-b');assert.equal(chats.get(a.id).reasoning,'high')
 const pa=await chats.events(chats.get(a.id),0,500,new AbortController().signal),pb=await chats.events(chats.get(b.id),0,500,new AbortController().signal)
 assert(JSON.stringify(pa).includes('Global reply A resumed'));assert(!JSON.stringify(pb).includes('CHAT_A'));assert(!JSON.stringify(pa).includes('CHAT_B'))
 const router=new Router();chatRoutes(router,chats,()=>configuration.resolvedSnapshot().config);http=createServer((req,res)=>{void router.handle(req,res)});await new Promise(r=>http.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+http.address().port,chief=chats.chief(p.id),upload=async(bytes,type,name)=>{const response=await fetch(base+'/v2/chats/'+chief.id+'/attachments',{method:'POST',headers:{'content-type':type,'x-filename':encodeURIComponent(name)},body:bytes});assert.equal(response.status,200);return response.json()}
 fileUpload=await upload(Buffer.from('user-uploaded fixture text'),'text/plain','任务.txt')
 const chunk=(type,data)=>{const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const b of body){crc^=b;for(let i=0;i<8;i++)crc=crc&1?(crc>>>1)^0xedb88320:crc>>>1}const out=Buffer.alloc(body.length+8);out.writeUInt32BE(data.length);body.copy(out,4);out.writeUInt32BE((crc^0xffffffff)>>>0,out.length-4);return out},header=Buffer.alloc(13);header.writeUInt32BE(2);header.writeUInt32BE(2,4);header[8]=8;header[9]=2
 imageUpload=await upload(Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,0,170,136,0,170,136,0,0,170,136,0,170,136]))),chunk('IEND',Buffer.alloc(0))]),'image/png','pixel.png')
 assert.equal((await chats.readUpload(fileUpload)).content,'user-uploaded fixture text')
 assert.throws(()=>chats.owned(a.id,[fileUpload.id]),/does not belong/)
 const download=await fetch(base+'/v2/chats/'+chief.id+'/attachments/'+fileUpload.id);assert.equal(await download.text(),'user-uploaded fixture text');assert.match(download.headers.get('content-disposition'),/attachment/);const picture=await fetch(base+'/v2/chats/'+chief.id+'/attachments/'+imageUpload.id);assert.equal(picture.headers.get('content-type'),'image/png');assert.equal((await picture.arrayBuffer()).byteLength,imageUpload.attachment.bytes);assert.equal((await fetch(base+'/v2/chats/'+a.id+'/attachments/'+fileUpload.id)).status,404)
 const choices=await (await fetch(base+'/v2/chats/models')).json();assert.deepEqual(choices.find(m=>m.name==='commander-b').reasoningEfforts,['low','high']);assert(!JSON.stringify(choices).includes('api_key'));
 const unassigned=choices.find(m=>m.model==='fixture-c');assert(unassigned);await chats.runtime(chats.get(a.id),'UNASSIGNED_MODEL continue',[],unassigned.name,'low');assert.equal(chats.get(a.id).workerName,'commander');assert.equal(chats.get(a.id).selectedWorker,unassigned.name)
 const submitted=await fetch(base+'/v2/chats/'+chief.id+'/messages',{method:'POST',headers:{'content-type':'application/json',accept:'application/x-ndjson'},body:JSON.stringify({content:'CHIEF_TASK read my file and pass it with the image to Commander',worker:'commander-b',reasoning:'high',attachmentIds:[fileUpload.id,imageUpload.id]})});assert.equal(submitted.status,200)
 const reader=submitted.body.getReader(),decoder=new TextDecoder();let wire='',sawPartial=false
 for(;;){const {done,value}=await reader.read();if(done)break;wire+=decoder.decode(value,{stream:true});if(wire.includes('assistant.delta')&&!wire.includes('chat.completed'))sawPartial=true}
 assert(sawPartial,'native deltas reach HTTP before completion');const streamed=wire.trim().split('\n').map(line=>JSON.parse(line));assert(streamed.some(e=>e.kind==='assistant.delta'&&e.content==='Chief '));assert.equal(streamed.at(-1).kind,'chat.completed')
 const pc=await chats.events(chats.get(chief.id),0,500,new AbortController().signal)
 assert(JSON.stringify(pc).includes('Chief reply'));assert.equal(pc.events.find(e=>e.kind==='user.message').attachments.length,2)
 const forwarded=legion.messages(p.id,'commander').find(m=>m.sender==='chief');assert.equal(forwarded.attachments.length,2);assert.equal(forwarded.receiver,'commander')
 assert.equal(chats.list().length,2,'chief never appears in global list');assert.equal(store.nodes(p.id,['step']).length,0,'Chief never takes planning/execution ownership')
 const before=requests;await new Promise(r=>setTimeout(r,60));assert.equal(requests,before,'no periodic assistant work')
 const {SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js'),persistence=ctx.get('sessionPersistence'),snapshot=await persistence.stat(SessionId(b.sessionId))
 const globalFile=await fetch(base+'/v2/chats/'+b.id+'/attachments',{method:'POST',headers:{'content-type':'text/plain','x-filename':'delete-fixture.txt'},body:'delete only fixture metadata'});assert.equal(globalFile.status,200);assert.equal(chats.uploads(b.id).length,1)
 const deleted=await fetch(base+'/v2/chats/'+b.id,{method:'DELETE'});assert.equal(deleted.status,200,await deleted.text());assert.throws(()=>chats.get(b.id),/not found/);assert.equal(store.db.prepare('SELECT count(*) AS n FROM chat_uploads WHERE chat_id=?').get(b.id).n,0);assert(!existsSync(snapshot.location.path),'native message log removed');assert.equal(await persistence.stat(SessionId(b.sessionId)),undefined);assert(await persistence.stat(SessionId(a.sessionId)),'other conversation survives');assert.equal((await fetch(base+'/v2/chats/'+b.id+'/events')).status,404)
 assert.equal((await fetch(base+'/v2/chats/'+chief.id,{method:'DELETE'})).status,422)
 console.log('STREAM_BEFORE_COMPLETION=true; DELETE_NATIVE_MESSAGES=true; DELETE_UPLOAD_METADATA=true; OTHER_CHAT_UNCHANGED=true')
 console.log('GLOBAL_CHAT_NATIVE=true; selected_model_reached_provider=true; selected_reasoning_reached_provider=true; unassigned_model_reached_provider=true; original_worker_bindings=true; independent_sessions=true; bounded_tools=true; hint_forwarded=true; no_worker_takeover=true; history_resumed=true; no_periodic_calls=true; chief_native=true; native_file_image=true; attachment_read=true; attachments_forwarded=true; model=local-protocol-fixture')
}finally{if(http)await new Promise(r=>http.close(r));await closeChat?.();await ctx?.fiber.dispose();store.close();for(const r of outputs)r.destroy();await new Promise(r=>model.close(r));rmSync(work,{recursive:true,force:true})}
