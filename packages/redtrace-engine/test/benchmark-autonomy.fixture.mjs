import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync,mkdirSync,writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {Configuration} from '../src/config.ts'
import {Scheduler} from '../src/scheduler.ts'
import {graphTools,activityPrompt,launchContext} from '../src/runner.ts'
import {providerProfiles} from '../src/models.ts'
import {createCommanderController} from '../compat/legion.mjs'
import {load} from '../../redtrace-dsh/lib/loader.js'
const ownerRole=process.argv[2]==='hard'?'general':'soldier',difficulty=ownerRole==='general'?'hard':'easy'
const work=mkdtempSync(path.join(os.tmpdir(),'benchmark-autonomy-')),configuration=new Configuration(work);configuration.initialize()
const store=new Store(work+'/engine.db'),legion=new LegionStore(store),p=store.createProject({mode:'benchmark',title:'local autonomy',origin:'authorized local protocol fixture',goal:'verify task'}).project
const realTimeout=globalThis.setTimeout,realInterval=globalThis.setInterval,realClear=globalThis.clearTimeout,realClearInterval=globalThis.clearInterval,realNow=Date.now,base=realNow(),timers=new Set()
let clock=0,ctx,controller,scheduler,requests=0,modelError;const roles=new Set(),commanderTools=new Set(),workerTools=new Set()
const timer=(fn,delay,interval)=>{const t={fn,delay,at:clock+delay,interval,unref(){return this}};timers.add(t);return t}
const settle=async predicate=>{for(let i=0;i<1000;i++){if(modelError)throw modelError;if(predicate())return;await new Promise(r=>realTimeout(r,5))}throw Error('fixture did not settle: '+JSON.stringify(legion.board().projects[0]))}
const advance=async ms=>{const end=clock+ms;for(const t of [...timers].sort((a,b)=>a.at-b.at)){if(t.at>end)continue;clock=t.at;if(t.interval)t.at+=t.delay;else timers.delete(t);t.fn();await new Promise(r=>realTimeout(r,5))}clock=end}
const text=m=>typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join('')
const server=createServer(async(req,res)=>{try{
 let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw),system=body.messages.filter(m=>m.role==='system').map(text).join('\n'),role=['COMMANDER','SCOUT','SOLDIER','GENERAL'].find(r=>system.includes('You are '+r));assert.ok(role);roles.add(role);requests++
 const names=body.tools.map(t=>t.function.name);for(const n of names)(role==='COMMANDER'?commanderTools:workerTools).add(n)
 let name,args
 if(role==='COMMANDER'){
  assert(!names.includes('legion_accept'));assert(!names.includes('legion_classify'));assert(!names.includes('legion_read_node'))
  const boundary=body.messages.findLastIndex(m=>{try{return JSON.parse(text(m)).patrol}catch{return false}}),calls=body.messages.slice(boundary+1).flatMap(m=>m.tool_calls??[]).map(c=>c.function.name),task=legion.tactics(p.id).find(t=>t.taskKey==='T')
  if(!calls.includes('legion_board')){name='legion_board';args={}}
  else if(!task?.stepIds.length){name='legion_spawn';args={taskKey:'T',role:'scout',mission:'classify local fixture and publish verdict'}}
  else if(task.classification?.difficulty===difficulty&&!store.nodes(p.id,['step']).some(s=>s.role===ownerRole)){name='legion_spawn';args={taskKey:'T',role:ownerRole,mission:'solve locally, maintain FGS and accept task from proof'}}
  else if(!calls.includes('legion_read_changes')){name='legion_read_changes';args={}}
  else{name='legion_wait';args={through:legion.campaign(p.id).cursors[p.id].delivered}}
 }else{
  const calls=body.messages.flatMap(m=>m.tool_calls??[]).map(c=>c.function.name),run=store.runsByStatus('running',p.id).find(r=>store.node(p.id,r.stepId,'step').role===role.toLowerCase()),step=store.node(p.id,run.stepId,'step')
  if(role==='GENERAL'){
   assert(!names.includes('submit_fact'));assert(!names.includes('http_request'));assert(!names.includes('bash'))
   const child=store.nodes(p.id,['step']).find(s=>s.parentStepId===step.id),childRun=child&&store.latestRun(p.id,child.id)
   if(!child){name='legion_step';args={description:'verify target objective',sourceIds:step.sourceIds}}
   else if(childRun&&!calls.includes('legion_read_run')){name='legion_read_run';args={runId:childRun.id}}
   else if(child.factIds.length){name='legion_accept';args={expectedVersion:store.node(p.id,step.goalId,'goal').version,evidenceIds:child.factIds}}
   else{name='legion_plan_done';args={state:'Worker dispatched; inspect retained proof next round'}}
  }else if(!calls.includes('submit_fact')){mkdirSync(run.workspaceRoot,{recursive:true});writeFileSync(path.join(run.workspaceRoot,'proof.txt'),'actual deterministic local protocol stdout');name='submit_fact';args={title:role==='SCOUT'?'product and version verified':'task result verified',description:'Local deterministic protocol evidence',evidence:[{description:'actual local fixture result',path:'proof.txt'}]}}
  else if(role==='SCOUT'){name='finish_step';args={summary:'classification complete',difficulty,family:'generic-local-product'}}
  else if(step.parentStepId){name='finish_step';args={summary:'one assigned Step verified'}}
  else{name='legion_accept';args={expectedVersion:store.node(p.id,step.goalId,'goal').version,evidenceIds:step.factIds}}
 }
 assert(names.includes(name),role+' missing '+name)
 const delta={tool_calls:[{index:0,id:'call-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]};res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
}catch(error){modelError=error;res.writeHead(500);res.end(String(error))}})
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));configuration.commit(configuration.read().revision,raw=>{raw.runtime={max_workers:4,max_project_workers:4,max_running_projects:1};raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+server.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:100000,max_tokens:512,reasoning:'off',reasoning_efforts:false}]}};raw.workers=['commander','scout','soldier','general'].map(role=>({name:role,roles:[role],provider:'fixture',model:'fixture',max_running:1}))})
 const{Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js');ctx=new Context()
 for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']){const m=await load(file);await ctx.plugin(m.default??m).await()}
 const persist=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js');await ctx.plugin(persist,{root:work+'/sessions'}).await();const llm=await import('../compat/llm.mjs');await ctx.plugin(llm,{providers:providerProfiles(configuration.resolvedSnapshot().config).providers,credentialSource:{root:work,filename:configuration.filename,revision:configuration.read().revision}}).await()
 const{createUserMessage}=await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js'),{SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
 scheduler=new Scheduler(store,configuration.resolvedSnapshot().config,async context=>{
  const step=store.node(p.id,context.run.stepId,'step');let handle,finished=false
  const tools=graphTools(context,()=>{finished=true}),setup=async scoped=>{
   scoped.tools.restrict({allow:[]});scoped.systemPrompt.section({name:'fixture-role',order:0,text:()=>activityPrompt('execute',step,'benchmark')})
   scoped.on('session/event',(_s,e)=>{if(e.type==='tool/call')store.toolStarted(context.run.id,String(e.data.callId),e.data,false);if(e.type==='tool/result'&&e.data.message?.source?.callId)store.toolEnded(context.run.id,String(e.data.message.source.callId),e.data)})
   for(const tool of tools)scoped.tools.register({name:tool.name,description:tool.description,parameters:JSON.parse(JSON.stringify(tool.parameters)),output:{schema:{type:'object',additionalProperties:true},render:(_a,v)=>v.content},async execute(args,execution){const output=await tool.execute(execution.callId,args,execution.signal);if(output.terminate)execution.concludeTurn();return output}})
  }
  const cancel=()=>handle.agent.cancel({kind:'hook',reason:'fixture contract stopped'})
  try{handle=await ctx.get('agents').create({sessionId:SessionId(context.run.id),meta:{cwd:work},agentOptions:{provider:'fixture',model:'fixture'},setup});context.signal.addEventListener('abort',cancel,{once:true});handle.agent.followup(createUserMessage({content:[{type:'text',text:JSON.stringify(launchContext(store,context.run.id))}],source:{kind:'user'}}));await handle.agent.whenIdle();assert(finished||context.signal.aborted)}finally{context.signal.removeEventListener('abort',cancel);if(handle){await ctx.get('sessions').flush(handle.agent.session);await handle.dispose()}}
 })
 globalThis.setTimeout=(fn,delay,...args)=>[60000,90000].includes(delay)?timer(()=>fn(...args),delay,false):realTimeout(fn,delay,...args);globalThis.setInterval=(fn,delay,...args)=>delay===15000?timer(()=>fn(...args),delay,true):realInterval(fn,delay,...args);globalThis.clearTimeout=t=>timers.has(t)?timers.delete(t):realClear(t);globalThis.clearInterval=t=>timers.has(t)?timers.delete(t):realClearInterval(t);Date.now=()=>base+clock
 const engine={store,legion,configuration,scheduler};controller=createCommanderController(ctx,engine);scheduler.start();controller.start()
 await settle(()=>legion.tactics(p.id)[0]?.classification?.difficulty===difficulty&&legion.campaign(p.id).status==='idle'&&legion.campaign(p.id).nextInspectionAt===base+60000)
 const session=legion.campaign(p.id).sessionId,agent=ctx.get('agents').get(session);assert(agent);assert.equal(store.nodes(p.id,['step']).length,1)
 await advance(60000);await settle(()=>store.project(p.id).status==='completed');await settle(()=>!ctx.get('agents').get(session))
 assert.deepEqual([...roles].sort(),(ownerRole==='general'?['COMMANDER','SCOUT','GENERAL','SOLDIER']:['COMMANDER','SCOUT','SOLDIER']).sort());assert(workerTools.has('legion_accept'));assert(!commanderTools.has('legion_accept'));assert.equal(store.projectGraphs(p.id)[0].status,'completed');assert.equal(legion.campaign(p.id).endgame,'all tasks completed')
 const runs=store.runs(p.id);assert(runs.every(r=>!r.pendingTools.length&&r.status!=='unknown'),JSON.stringify(runs));assert(runs.length>=(ownerRole==='general'?3:2))
 console.log('BENCHMARK_AUTONOMY=true; deterministic_task_init=true; scout_verdict=true; operator_FGS_acceptance=true; all_tasks_complete=true; no_unknown_tool_outcome=true; native_roles='+[...roles].join(','))
}finally{await controller?.close();await scheduler?.close();Date.now=realNow;globalThis.setTimeout=realTimeout;globalThis.setInterval=realInterval;globalThis.clearTimeout=realClear;globalThis.clearInterval=realClearInterval;await ctx?.fiber.dispose();store.close();server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(work,{recursive:true,force:true})}
