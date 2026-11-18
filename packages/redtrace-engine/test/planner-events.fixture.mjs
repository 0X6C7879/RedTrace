import {domainFixtureRequest} from './domain-fixture.mjs'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {Configuration} from '../src/config.ts'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {providerProfiles} from '../src/models.ts'
import {load} from '../../redtrace-dsh/lib/loader.js'
import {createCommanderController} from '../compat/legion.mjs'

const root=mkdtempSync(path.join(os.tmpdir(),'planner-events-')),configuration=new Configuration(root)
configuration.initialize()
const store=new Store(root+'/engine.db'),legion=new LegionStore(store),p=store.createProject({title:'events',origin:'local fixture',goal:'verify'}).project
let ctx,controller,error,calls=0,rounds=0,observed=[],throttled=false,watchdog,stopProject=false
const interval=globalThis.setInterval
globalThis.setInterval=(fn,ms,...args)=>{if(ms===15000)watchdog=fn;return interval(fn,ms,...args)}
const textOf=m=>typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join('')
const model=createServer(async(req,res)=>{
 try{
  let raw='';for await(const b of req)raw+=b
  if(!throttled){throttled=true;res.writeHead(429,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'429 fixture throttled'}}));return}
  const input=domainFixtureRequest(JSON.parse(raw),res),boundary=input.messages.findLastIndex(m=>m.role==='user'&&(()=>{try{return !!(JSON.parse(textOf(m)).instruction||JSON.parse(textOf(m)).frontier)}catch{return false}})())
  const tools=input.messages.slice(boundary+1).flatMap(m=>m.tool_calls??[])
  let name,args
  if(!tools.length){rounds++;name='legion_read_changes';args={projectId:p.id}}
  else{
   const result=JSON.parse(textOf(input.messages.filter(m=>m.role==='tool').at(-1)));observed.push(...result.events.map(e=>e.type))
   name=stopProject?'legion_stop':'legion_finish';args=stopProject?{reason:'fixture reasonable directions exhausted',state:'Keep negative evidence and TodoList'}:{processed:{[p.id]:result.cursor},state:'Verified event cycle '+rounds}
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'event-fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-'+(++calls),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
 }catch(e){error=e;res.writeHead(500);res.end(String(e))}
})
const until=async predicate=>{for(let i=0;i<300;i++){if(error)throw error;if(predicate())return;await delay(10)}throw Error('Planner event fixture did not settle')}
try{
 await new Promise(r=>model.listen(0,'127.0.0.1',r))
 configuration.commit(configuration.read().revision,raw=>{
  raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+model.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:100000,max_tokens:1000,reasoning:'off',reasoning_efforts:false}]}}
  raw.workers=[{name:'general',roles:['general'],provider:'fixture',model:'fixture',max_running:2}]
 })
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js');ctx=new Context()
 for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']){const m=await load(file);await ctx.plugin(m.default??m).await()}
 const persistence=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js');await ctx.plugin(persistence,{root:root+'/sessions'}).await()
 const llm=await import('../compat/llm.mjs');await ctx.plugin(llm,{providers:providerProfiles(configuration.resolvedSnapshot().config).providers,credentialSource:{root,filename:configuration.filename,revision:configuration.read().revision}}).await()
 controller=createCommanderController(ctx,{store,legion,configuration,scheduler:{maintenance:false,wake(){},watchdog(){}}});controller.start()
 await until(()=>rounds===1&&legion.campaign(p.id).status==='idle');await delay(900);assert.equal(rounds,1,'zero-Step cycle must sleep, not spin')
 const fact=store.addFact(p.id,'verified fixture',{evidence:[{description:'fixture'}]})
 await delay(150)
 const step=store.addStep(p.id,{description:'completed work',sourceIds:[fact.id]}),run=store.claim(p.id,'execute',{name:'pool',backend:'mock'},step.id)
 store.addFact(p.id,'Worker result',{runId:run.id,evidence:[{description:'fixture result'}]});store.finishRun(run.id,'succeeded')
 store.addFinding(p.id,{title:'new Finding',description:'fixture',type:'fixture',severity:'low',factIds:[fact.id]})
 await delay(400);assert.equal(rounds,1,'FGS bursts are debounced, not immediately dispatched')
 await until(()=>rounds===2&&legion.campaign(p.id).status==='idle');await delay(900);assert.equal(rounds,2,'one round consumes the entire event burst')
 for(const type of ['fact.added','execute.succeeded','finding.added'])assert(observed.includes(type),type)
 const stopped=legion.campaign(p.id);legion.saveCampaign({...stopped,status:'stopped',failureCode:'TIMEOUT',error:'fixture API exhaustion'})
 watchdog();await until(()=>rounds===3&&legion.campaign(p.id).status==='idle')
 assert.equal(legion.campaign(p.id).restarts,1)
 assert(observed.includes('legion.planner_restarted'))
 legion.saveCampaign({...legion.campaign(p.id),status:'stopped',failureCode:'SERVER',restarts:3})
 watchdog();await delay(900);assert.equal(rounds,3,'exhausted recovery must not spin')
 stopProject=true;legion.saveCampaign({...legion.campaign(p.id),status:'idle'});store.addInput(p.id,'hint','review exhausted scope')
 await until(()=>store.project(p.id).status==='stopped'&&legion.campaign(p.id).status==='idle')
 assert.equal(legion.campaign(p.id).error,undefined);assert.deepEqual(legion.campaign(p.id).pendingTools,[])
 const after=rounds;await controller.close();store.addInput(p.id,'hint','after close');await delay(900);assert.equal(rounds,after,'closed controller retains no debounce timer')
 console.log('PLANNER_EVENTS=true; native_429_retry=true; planner_failure_recovery=true; recovery_limit=true; debounce_ms=800; burst_rounds=1; zero_step_round_sleeps=true; fact_completion_finding_triggers=true; closed_timer_clean=true; model=local-protocol-fixture')
}finally{globalThis.setInterval=interval;await controller?.close();await ctx?.fiber.dispose();store.close();model.closeAllConnections();await new Promise(r=>model.close(r));rmSync(root,{recursive:true,force:true})}
