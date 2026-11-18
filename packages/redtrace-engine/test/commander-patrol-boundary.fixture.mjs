import {domainFixtureRequest} from './domain-fixture.mjs'
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
const {runCommander}=await import(process.argv[2]??'../compat/legion.mjs')
const root=mkdtempSync(path.join(os.tmpdir(),'patrol-boundary-')),configuration=new Configuration(root);configuration.initialize()
const store=new Store(root+'/engine.db'),p=store.createProject({mode:'benchmark',title:'local fixture',origin:'authorized local',goal:'verify'}).project,legion=new LegionStore(store),sizes=[],rounds=[],text=m=>typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join('')
let ctx,calls=0
if(process.env.REDTRACE_LEGACY_STATE_PROBE)legion.saveCampaign({...legion.campaign(p.id),state:'LEGACY_TACTICAL_BODY',nativeCompactionSummary:'LEGACY_TACTICAL_SUMMARY'})
const model=createServer(async(req,res)=>{
 let raw='';for await(const b of req)raw+=b;const body=domainFixtureRequest(JSON.parse(raw),res);sizes.push(Buffer.byteLength(raw));const boundary=body.messages.findLastIndex(m=>{try{return JSON.parse(text(m)).patrol===true}catch{return false}}),tools=body.messages.slice(boundary+1).flatMap(m=>m.tool_calls??[]),name=tools.length?'legion_wait':'legion_board';calls++
 if(process.env.REDTRACE_LEGACY_STATE_PROBE)assert(!JSON.stringify(body.messages).includes('LEGACY_TACTICAL'),'legacy tactics must not enter a native model request')
 if(!tools.length)rounds.push(Buffer.byteLength(raw))
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{content:name==='legion_board'?'local fixture scheduling analysis. '.repeat(300):'',tool_calls:[{index:0,id:'call-'+calls,type:'function',function:{name,arguments:JSON.stringify(name==='legion_wait'?{through:legion.campaign(p.id).cursors[p.id]?.acknowledged??0}:{})}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
})
try{
 await new Promise(r=>model.listen(0,'127.0.0.1',r));configuration.commit(configuration.read().revision,raw=>{raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+model.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:1000000,max_tokens:512,reasoning:'off',reasoning_efforts:false}]}};raw.workers=[{name:'commander',roles:['commander'],provider:'fixture',model:'fixture'}]})
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js');ctx=new Context()
 for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']){const m=await load(file);await ctx.plugin(m.default??m).await()}
 const persistence=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js');await ctx.plugin(persistence,{root:root+'/sessions'}).await();const llm=await import('../compat/llm.mjs');await ctx.plugin(llm,{providers:providerProfiles(configuration.resolvedSnapshot().config).providers,credentialSource:{root,filename:configuration.filename,revision:configuration.read().revision}}).await()
 const engine={store,legion,configuration,commanderSessions:new Map()},worker=configuration.resolvedSnapshot().config.workers[0]
 for(let i=0;i<8;i++)await runCommander(ctx,engine,worker,AbortSignal.timeout(10000),p.id)
 const resident=engine.commanderSessions.get(p.id),events=resident.handle.agent.session.snapshotEvents(),replacements=events.filter(e=>e.type==='user/message'&&e.data.source?.redtracePatrolCheckpoint)
 assert.equal(rounds.length,8)
 if(!process.argv[2]){assert(rounds.at(-1)<rounds[1]*1.15,JSON.stringify(rounds));assert(replacements.length>=7);assert.equal(events.filter(e=>e.type==='tool/call').length,16);assert(events.some(e=>e.type==='assistant/message'))}
 console.log(JSON.stringify({native:true,requests:sizes.length,roundInputBytes:rounds,maxInputBytes:Math.max(...sizes),loggedReplacements:replacements.length,rawToolCalls:events.filter(e=>e.type==='tool/call').length,sessionId:legion.campaign(p.id).sessionId}))
 await resident.handle.dispose()
}finally{await ctx?.fiber.dispose();store.close();model.closeAllConnections();await new Promise(r=>model.close(r));rmSync(root,{recursive:true,force:true})}
