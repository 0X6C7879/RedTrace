import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Configuration} from '../src/config.ts'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {providerProfiles} from '../src/models.ts'
import {createCommanderController} from '../compat/legion.mjs'
import {load} from '../../redtrace-dsh/lib/loader.js'
const work=mkdtempSync(path.join(os.tmpdir(),'benchmark-patrol-')),config=new Configuration(work);config.initialize()
const store=new Store(work+'/engine.db'),legion=new LegionStore(store),busy=store.createProject({mode:'benchmark',title:'busy',origin:'local',goal:'verify'}).project,idle=store.createProject({mode:'benchmark',title:'idle',origin:'local',goal:'verify'}).project,general=store.createProject({mode:'general',title:'general',origin:'local',goal:'verify'}).project
const graph=store.createGraph(busy.id,{taskKey:'T',title:'local',origin:'local',goal:'verify'})
store.forGraph(busy.id,graph.id).addStep(busy.id,{role:'scout',taskKey:'T',description:'classify',sourceIds:[graph.originId]})
const calls=new Map(),counts=id=>calls.get(id)??0
const patrolInputs=[]
let ctx,controller,watchdogs=0,peak=0,requests=0,failProject
const server=createServer(async(req,res)=>{
  let text='';for await(const b of req)text+=b;const body=JSON.parse(text),id=[busy.id,idle.id,general.id].find(id=>JSON.stringify(body.messages).includes(id));assert.ok(id)
  requests++;peak=Math.max(peak,requests);await new Promise(r=>realTimeout(r,10));requests--
  if(failProject===id){res.writeHead(400,{'Content-Type':'application/json'});res.end(JSON.stringify({error:{message:'invalid fixture request'}}));return}
  const finish=body.messages.at(-1)?.tool_call_id?.startsWith('changes-');if(finish)calls.set(id,counts(id)+1)
  const bench=id!==general.id
  const delta={tool_calls:[{index:0,id:(finish?'finish-':'changes-')+counts(id),type:'function',function:finish?{name:bench?'legion_wait':'legion_finish',arguments:JSON.stringify(bench?{through:legion.campaign(id).cursors[id].delivered}:{processed:{[id]:legion.campaign(id).cursors[id].delivered},state:'full STATE for '+id+'; next patrol'})}:{name:'legion_read_changes',arguments:JSON.stringify(bench?{}:{projectId:id})}}]}
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
})
// Advance only controller timers. Native DSH, HTTP, cancellation and Session ownership remain real.
const realTimeout=globalThis.setTimeout,realInterval=globalThis.setInterval,realClear=globalThis.clearTimeout,realClearInterval=globalThis.clearInterval,realNow=Date.now,base=realNow(),timers=new Set()
let clock=0
const timer=(fn,delay,interval)=>{const t={fn,delay,at:clock+delay,interval,unref(){return this}};timers.add(t);return t}
const settle=async(predicate=()=>true)=>{for(let i=0;i<600;i++){await new Promise(r=>realTimeout(r,5));if(predicate())return}throw Error('fixture did not settle: '+JSON.stringify({campaigns:legion.campaigns(),calls:[...calls],timers:[...timers].map(t=>t.delay)}))}
const advance=async(ms)=>{const end=clock+ms;while(true){const due=[...timers].filter(t=>t.at<=end).sort((a,b)=>a.at-b.at)[0];if(!due)break;clock=due.at;if(due.interval)due.at+=due.delay;else timers.delete(due);due.fn();await settle();}clock=end;await settle()}
try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r))
  config.commit(config.read().revision,raw=>{raw.runtime={max_workers:4,max_project_workers:3,max_running_projects:4};raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+server.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:20000,max_tokens:512,reasoning:'off',reasoning_efforts:false}]}};raw.workers=[{name:'commander',roles:['commander'],provider:'fixture',model:'fixture',max_running:4}]})
  const{Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js');ctx=new Context()
  for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']){const m=await load(file);await ctx.plugin(m.default??m).await()}
  const persist=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js');await ctx.plugin(persist,{root:work+'/sessions'}).await()
  const llm=await import('../compat/llm.mjs');await ctx.plugin(llm,{providers:providerProfiles(config.resolvedSnapshot().config).providers,credentialSource:{root:work,filename:config.filename,revision:config.read().revision}}).await()
  globalThis.setTimeout=(fn,delay,...args)=>[60000,90000].includes(delay)?timer(()=>fn(...args),delay,false):realTimeout(fn,delay,...args)
  globalThis.setInterval=(fn,delay,...args)=>delay===15000?timer(()=>fn(...args),delay,true):realInterval(fn,delay,...args)
  globalThis.clearTimeout=t=>timers.has(t)?timers.delete(t):realClear(t)
  globalThis.clearInterval=t=>timers.has(t)?timers.delete(t):realClearInterval(t)
  Date.now=()=>base+clock
  ctx.on('session/event',(session,event)=>{if(event.type==='user/message'){try{const p=JSON.parse(event.data.content[0].text);if(p.patrol)patrolInputs.push({sessionId:String(session.id),payload:p})}catch{}}})
  const scheduler={maintenance:false,wake(){},watchdog(){watchdogs++},start(){},async stopProject(){}}
  const engine={store,legion,configuration:config,scheduler};controller=createCommanderController(ctx,engine)
  for(const id of [busy.id,idle.id])legion.saveState(id,'commander','full STATE for '+id+'; next patrol')
  controller.start()
  await settle(()=>legion.campaign(busy.id).nextInspectionAt===base+60000&&legion.campaign(idle.id).nextInspectionAt===base+90000&&legion.campaign(general.id).status==='idle'&&counts(general.id)===1)
  assert.equal(counts(busy.id),1);assert.equal(counts(idle.id),1);assert.ok(peak>=2,'Projects retain independent concurrent Commanders')
  assert.equal(legion.campaigns().filter(c=>c.status==='running').length,0,'waiting must release every command slot')
  const busySession=legion.campaign(busy.id).sessionId,busyAgent=ctx.get('agents').get(busySession)
  assert.ok(busyAgent,'sleeping Commander retains its native Agent')
  store.forGraph(busy.id,graph.id).addInput(busy.id,'hint','event during patrol wait');legion.message(idle.id,'commander','commander','MESSAGE','wait until fixed patrol');await settle()
  assert.equal(counts(busy.id),1);assert.equal(counts(idle.id),1)
  await advance(59000);assert.equal(counts(busy.id),1);assert.equal(counts(idle.id),1)
  await advance(1000);await settle(()=>counts(busy.id)===2&&legion.campaign(busy.id).nextInspectionAt===base+120000)
  assert.equal(watchdogs,4);assert.equal(counts(idle.id),1);assert.equal(legion.campaign(busy.id).sessionId,busySession);assert.equal(ctx.get('agents').get(busySession),busyAgent,'the exact same native Agent survives the next patrol');const inputs=patrolInputs.filter(p=>p.sessionId===busySession);assert.equal(inputs.length,2);assert.ok('state' in inputs[0].payload);assert.ok(!('state' in inputs[1].payload));assert.ok(!('instruction' in inputs[1].payload))
  await advance(30000);await settle(()=>counts(idle.id)===2&&legion.campaign(idle.id).nextInspectionAt===base+180000)
  assert.equal(watchdogs,6);assert.equal(counts(busy.id),2);assert.equal(legion.messages(idle.id,'commander')[0].status,'admitted','patrol inbox is admitted once in the bootstrap turn')
  store.forGraph(general.id,store.projectGraphs(general.id)[0].id).addInput(general.id,'hint','General mode remains event-driven');await settle(()=>counts(general.id)===2&&legion.campaign(general.id).status==='idle')
  await engine.commanderSessions.get(busy.id).handle.dispose();await advance(15000);await settle(()=>legion.campaign(busy.id).restarts===1&&legion.campaign(busy.id).status==='idle');assert.notEqual(ctx.get('agents').get(busySession),busyAgent,'15-second Watchdog restores a natively exited resident Agent')
  for(let i=2;i<=3;i++){
    const c=legion.campaign(busy.id);legion.saveCampaign({...c,status:'stopped',failureCode:'TRANSPORT'})
    await advance(15000);await settle(()=>legion.campaign(busy.id).restarts===i&&legion.campaign(busy.id).status==='idle')
  }
  const capped=counts(busy.id);legion.saveCampaign({...legion.campaign(busy.id),status:'stopped',failureCode:'TRANSPORT'})
  await advance(15000);assert.equal(counts(busy.id),capped);assert.equal(legion.campaign(busy.id).restarts,3)
  assert.equal(legion.campaign(busy.id).sessionId,busySession,'recovery reuses native history and persisted STATE')
  assert.match(legion.campaign(busy.id).state,/full STATE/)
  failProject=idle.id;await advance(30000);await settle(()=>legion.campaign(idle.id).status==='stopped');assert.equal(legion.campaign(idle.id).failureCode,'INVALID_REQUEST');const permanent=counts(idle.id);await advance(15000);assert.equal(counts(idle.id),permanent);assert.equal(legion.campaign(idle.id).restarts,undefined)
  console.log('BENCHMARK_PATROL=true; normal=60000; idle=90000; watchdog=15000; event_wake=false; general_event_wake=true; concurrent_projects=true; waiting_capacity_released=true; native_restart_cap=3; STATE_continuity=true; same_native_agent=true; subsequent_patrol_is_delta_only=true')
}finally{
  await controller?.close();Date.now=realNow;globalThis.setTimeout=realTimeout;globalThis.setInterval=realInterval;globalThis.clearTimeout=realClear;globalThis.clearInterval=realClearInterval
  await ctx?.fiber.dispose();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(work,{recursive:true,force:true})
}
