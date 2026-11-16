import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {mkdtempSync,rmSync} from 'node:fs'
import {randomUUID} from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import {Configuration} from '../src/config.ts'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {providerProfiles} from '../src/models.ts'
import {load} from '../../redtrace-dsh/lib/loader.js'
import {runCommander} from '../compat/legion.mjs'

const work=mkdtempSync(path.join(os.tmpdir(),'redtrace-todos-')),configuration=new Configuration(work)
configuration.initialize()
const store=new Store(work+'/engine.db'),legion=new LegionStore(store)
const project=store.createProject({mode:'general',title:'serial fixture',origin:'authorized local protocol fixture',goal:'verify credentials'}).project
const graph=store.projectGraphs(project.id)[0]
const initial=[{content:'verify entry',status:'in_progress'},{content:'verify credentials',status:'pending'}]
let wake=0,ctx,modelError,requests=0
const textOf=m=>typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join('')
const model=createServer(async(req,res)=>{
 try{
  let text='';for await(const b of req)text+=b
  const input=JSON.parse(text);requests++
  assert(input.tools.some(t=>t.function.name==='TodoWrite'))
  const injected=input.messages.map(textOf).map(s=>{try{return JSON.parse(s)}catch{return null}}).filter(s=>s?.instruction?.includes('compact legion_board')).at(-1)
  assert(injected,'each wake must carry compact instructions and cursors')
  assert(!('graphs' in injected),'wake-up must not inject full FGS')
  assert.deepEqual(injected.planningTodos,wake===1?[]:wake<=3?initial:[{content:'verify entry',status:'completed'},{content:'verify credentials',status:'in_progress'}],'every wake inherits the current task plan, including a fresh native session')
  const current={todos:legion.planningTodos(project.id).list(graph.id),fgs:store.graph(project.id)}
  const boundary=input.messages.findLastIndex(m=>{try{return !!JSON.parse(textOf(m)).instruction?.includes('compact legion_board')}catch{return false}})
  const calls=input.messages.slice(boundary+1).flatMap(m=>m.tool_calls??[]).map(c=>c.function.name)
  for(const message of input.messages.filter(m=>m.role==='system'))assert(!textOf(message).includes('"todos":['),'mutable lists do not belong in the system prompt')
  assert.deepEqual(current.todos,wake===1&&!calls.includes('TodoWrite')?[]:wake<3||wake===3&&!calls.includes('TodoWrite')?initial:[{content:'verify entry',status:'completed'},{content:'verify credentials',status:wake===5&&calls.includes('TodoWrite')?'completed':'in_progress'}])
   const entry=current.fgs.facts.find(f=>f.title==='ENTRY_VERIFIED')
   const credentials=current.fgs.facts.find(f=>f.title==='CREDENTIALS_VERIFIED')
  if(wake<3)assert(!entry)
   if(wake>=3)assert(entry)
   const details=input.messages.slice(boundary+1).filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(textOf(m))}catch{return null}}).filter(m=>m?.kind==='fact')
   const unread=[entry,credentials].filter(Boolean).find(f=>!details.some(d=>d.id===f.id))
   for(const detail of details)assert(detail.evidence.length)
  let name,args
   if(!calls.includes('legion_board')){name='legion_board';args={}}
   else if(!calls.includes('legion_todos')){name='legion_todos';args={projectId:project.id,graphId:graph.id}}
   else if(unread){name='legion_read_node';args={projectId:project.id,id:unread.id,detail:'doc'}}
   else if(!calls.includes('TodoWrite')){
   name='TodoWrite';args={projectId:project.id,graphId:graph.id,todos:wake<3?initial:[{content:'verify entry',status:'completed'},{content:'verify credentials',status:credentials?'completed':'in_progress'}]}
  }else if(wake===1&&calls.filter(n=>n==='legion_step').length<3){
   const n=calls.filter(n=>n==='legion_step').length
   name='legion_step';args={projectId:project.id,description:n===0?'stage 1 entry':('independent '+n),sourceIds:[graph.originId],goalId:graph.goalId}
  }else if(wake===3&&!calls.includes('legion_step')){
   name='legion_step';args={projectId:project.id,description:'stage 2 credentials',sourceIds:[entry.id],goalId:graph.goalId}
  }else{name='legion_finish';args={processed:{},state:'Verified fixture STATE wake '+wake}}
  res.writeHead(200,{'Content-Type':'text/event-stream'})
  res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
 }catch(error){modelError=error;res.writeHead(500);res.end(String(error))}
})
try{
 await new Promise(r=>model.listen(0,'127.0.0.1',r))
 configuration.commit(configuration.read().revision,raw=>{
  raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+model.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:100000,max_tokens:1000,reasoning:'off',reasoning_efforts:false}]}}
  raw.workers=[{name:'commander',roles:['planner'],provider:'fixture',model:'fixture',max_running:8}]
  raw.runtime={max_workers:8,max_project_workers:8,max_running_projects:2}
 })
 const {Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js');ctx=new Context()
 for(const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']){const m=await load(file);await ctx.plugin(m.default??m).await()}
 const persistence=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js');await ctx.plugin(persistence,{root:work+'/sessions'}).await()
 const llm=await import('../compat/llm.mjs');await ctx.plugin(llm,{providers:providerProfiles(configuration.resolvedSnapshot().config).providers,credentialSource:{root:work,filename:configuration.filename,revision:configuration.read().revision}}).await()
 const engine={store,legion,configuration},worker=configuration.resolvedSnapshot().config.workers[0],execute={name:'fixture',backend:'mock'}
 const cycle=async()=>{wake++;await runCommander(ctx,engine,worker,AbortSignal.timeout(15000),project.id);if(modelError)throw modelError}
 const todos=()=>legion.planningTodos(project.id).list(graph.id)
 await cycle();assert.deepEqual(todos(),initial)
 const steps=store.graph(project.id).steps;assert.equal(steps.length,3);assert(!steps.some(s=>s.description==='stage 2 credentials'))
 const independent=steps.filter(s=>s.description.startsWith('independent')).map(s=>store.claim(project.id,'execute',execute,s.id))
 assert.equal(store.runsByStatus('running',project.id).length,2)
 for(const run of independent)store.finishRun(run.id,'failed','local fixture complete')
 const first=steps.find(s=>s.description==='stage 1 entry'),run=store.claim(project.id,'execute',execute,first.id)
 legion.message(project.id,run.id,'commander','REPORT','Worker claims success, no supporting Fact')
 store.finishRun(run.id,'failed','no verified entry')
 await cycle();assert.deepEqual(todos(),initial);assert.equal(store.graph(project.id).steps.length,3)
 const fact=store.addFact(project.id,'ENTRY_VERIFIED',{evidence:[{description:'local deterministic fixture: entry=verified'}]})
 const old=legion.campaign(project.id)
 legion.saveCampaign({...old,previousSessionId:old.sessionId,sessionId:'command-'+randomUUID(),hasSession:false})
 await cycle();assert.notEqual(legion.campaign(project.id).sessionId,old.sessionId)
 assert.deepEqual(todos().map(t=>t.status),['completed','in_progress'])
 const next=store.graph(project.id).steps.find(s=>s.description==='stage 2 credentials');assert.deepEqual(next.sourceIds,[fact.id])
 const second=store.claim(project.id,'execute',execute,next.id)
 store.addFact(project.id,'Credentials not verified yet',{runId:second.id,evidence:[{description:'local fixture reports blocker, not success'}]})
 store.finishRun(second.id,'succeeded')
 await cycle();assert.deepEqual(todos().map(t=>t.status),['completed','in_progress']);assert.equal(store.graph(project.id).steps.length,4)
 store.addFact(project.id,'CREDENTIALS_VERIFIED',{evidence:[{description:'local deterministic fixture: credentials=verified'}]})
 await cycle();assert.deepEqual(todos().map(t=>t.status),['completed','completed'])
 assert.equal(store.node(project.id,graph.goalId).status,'open','Todo completion never accepts a Goal')
 console.log('TODOS_NATIVE_DSH=true; wakes=5; fresh_session_memory=true; resumed_session_memory=true; failure_does_not_advance=true; Step_done_without_required_Fact_does_not_advance=true; Fact_advances_next_stage=true; no_duplicate_dispatch=true; independent_parallel=true; todo_snapshot_each_wake=true; model=local-protocol-fixture')
}finally{await ctx?.fiber.dispose();store.close();model.closeAllConnections();await new Promise(r=>model.close(r));rmSync(work,{recursive:true,force:true})}
