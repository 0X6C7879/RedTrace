import { Store } from '../src/store.ts'
import {domainFixtureRequest} from './domain-fixture.mjs'
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
import os from 'node:os'
import path from 'node:path'
import {Configuration} from '../src/config.ts'
const root=path.resolve(import.meta.dirname,'../../..'),work=mkdtempSync(path.join(os.tmpdir(),'artex-native-')),configuration=new Configuration(work)
symlinkSync(root+'/static',work+'/static');configuration.initialize()
let api,projectId,child,closed,modelError,logs='',plannerRead=false,plannerBatched=false,workerExecution=false
const text=m=>typeof m.content==='string'?m.content:(m.content??[]).map(p=>p.text??'').join('')
const get=async route=>{const r=await fetch(api+route);assert(r.ok);return r.json()}
const model=createServer(async(req,res)=>{try{
 let raw='';for await(const b of req)raw+=b;const body=domainFixtureRequest(JSON.parse(raw),res),system=body.messages.filter(m=>m.role==='system').map(text).join('\n'),names=body.tools.map(t=>t.function.name)
 projectId??=system.match(/Assigned Project=(\S+)/)?.[1]
 const graph=(await get('/v2/projects/'+projectId+'/graphs'))[0],fgs=graph?await get('/v2/projects/'+projectId+'?graphId='+graph.id):{steps:[]},calls=body.messages.flatMap(m=>m.tool_calls??[]).map(c=>c.function.name)
 let name,args
 if(system.includes('You are COMMANDER')){
  if(!graph?.planner){const db=new Store(work+'/.redtrace/engine.db');db.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,'A',JSON.stringify({platformMetadata:{flag_count:2}}));db.close();name='legion_spawn';args={taskKey:'A',role:'general',mission:'Plan independent local proof Steps'}}
  else{name='legion_wait';args={through:(await get('/v2/legion?projectId='+projectId)).campaign.cursors[projectId]?.acknowledged??0}}
 }else if(system.includes('You are GENERAL')){
  assert(!names.some(n=>/^(bash|shell|http_|browser|mcp__|submit_fact|submit_finding|resource_)/.test(n)));assert(names.includes('read'),'retained native Spill must remain readable')
  const children=fgs.steps.filter(s=>s.plannerId),proofs=children.flatMap(s=>s.factIds),ready=proofs.length===2&&children.every(s=>s.status==='done')
  if(!children.length){name='legion_steps';args={steps:['proof A','proof B'].map(description=>({description,sourceIds:[graph.originId]}))};plannerBatched=true}
  else if(ready&&!calls.includes('legion_read_run')){const runs=await get('/v2/projects/'+projectId+'/runs');name='legion_read_run';args={runId:runs.find(r=>r.stepId===children[0].id).id};plannerRead=true}
  else if(ready&&!calls.includes('TodoWrite')){name='TodoWrite';args={todos:[{content:'local objective',status:'completed',acceptance:'two retained native proof files',stepIds:children.map(s=>s.id),factIds:proofs}]}}
  else if(ready){name='legion_accept';args={expectedVersion:fgs.goals.find(g=>g.id===graph.goalId).version,evidenceIds:proofs}}
  else{name='legion_plan_done';args={state:'two Workers dispatched; review their retained proof and actual trace'}}
 }else{
  assert(system.includes('You are SOLDIER'));assert(names.includes('bash'));assert(!names.includes('TodoWrite'));assert(!names.includes('legion_todos'));assert(!names.includes('legion_step'));workerExecution=true
  const step=fgs.steps.find(s=>s.role==='soldier'&&body.messages.map(text).join('\n').includes(s.id)),runs=await get('/v2/projects/'+projectId+'/runs'),run=runs.find(r=>r.stepId===step.id&&r.status==='running')
  if(!calls.includes('submit_fact')){mkdirSync(run.workspaceRoot,{recursive:true});writeFileSync(path.join(run.workspaceRoot,'proof.txt'),'literal native local protocol evidence '+step.id);name='submit_fact';args={title:'native proof '+step.id,description:'verified local fixture output',evidence:[{description:'actual retained file bytes',path:'proof.txt'}]}}
  else{name='finish_step';args={summary:'assigned local Step verified',...(system.includes('You are SCOUT')?{difficulty:'easy',family:'local-fixture'}:{})}}
 }
 assert(names.includes(name),name)
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta:{tool_calls:[{index:0,id:'call-'+Date.now()+'-'+Math.random(),type:'function',function:{name,arguments:JSON.stringify(args)}}]},finish_reason:'tool_calls'}]})+'\n\ndata: [DONE]\n\n')
}catch(e){modelError=e;res.writeHead(500);res.end(String(e))}})
try{
 await new Promise(r=>model.listen(0,'127.0.0.1',r));configuration.commit(configuration.read().revision,raw=>{raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+model.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:100000,max_tokens:512,reasoning:'off',reasoning_efforts:false}]}};raw.workers=['commander','general','soldier'].map(role=>({name:role,roles:[role],provider:'fixture',model:'fixture',max_running:3}));raw.runtime={max_workers:6,max_project_workers:6,max_running_projects:1};raw.tasks.commander.max_intents=4;raw.tasks.commander.inspection_interval=1;raw.tasks.commander.idle_inspection_interval=1})
 const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));api='http://127.0.0.1:'+port
 child=spawn(process.execPath,[root+'/scripts/run-redtrace-node.mjs','--root',work,'--host','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,DSH_HOME:work+'/.dsh',REDTRACE_SOURCE_ROOT:root,REDTRACE_CODE_ROOT:root,REDTRACE_DSH_ROOT:root,REDTRACE_DATA_ROOT:work+'/.redtrace'},stdio:['ignore','pipe','pipe']});closed=new Promise(r=>child.once('close',r));for(const s of [child.stdout,child.stderr])s.on('data',b=>logs=(logs+b).slice(-20000))
 const until=Date.now()+20000;while(Date.now()<until){try{if((await fetch(api+'/runtime/config')).ok)break}catch{}await delay(40)}
 const response=await fetch(api+'/v2/projects',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'benchmark',title:'native Planner fixture',origin:'authorized local protocol fixture only',goal:'verify two local proof files',bootstrap:false})});assert(response.ok);projectId=(await response.json()).project.id

 const deadline=Date.now()+25000;let done=false
 while(Date.now()<deadline){if(modelError)throw modelError;if((await get('/v2/projects/'+projectId)).project.status==='completed'){done=true;break}await delay(50)}
 assert(done,logs);assert(plannerBatched&&plannerRead&&workerExecution)
 console.log('ARTEX_NATIVE=true; planner_no_attack_tools=true; worker_execution_tools=true; atomic_parallel_steps=true; fact_todo_acceptance=true; worker_trace_read=true')
}finally{child?.kill('SIGTERM');await closed;model.closeAllConnections();await new Promise(r=>model.close(r));rmSync(work,{recursive:true,force:true})}
