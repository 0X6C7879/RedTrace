import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn} from 'node:child_process'
import {mkdtempSync,symlinkSync,rmSync,writeFileSync} from 'node:fs'
import {setTimeout as delay} from 'node:timers/promises'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
const repo=path.resolve(process.env.REDTRACE_METRICS_REPO??path.resolve(import.meta.dirname,'../../..'))
const {Configuration}=await import(pathToFileURL(repo+'/packages/redtrace-engine/src/config.ts'))
const {Store}=await import(pathToFileURL(repo+'/packages/redtrace-engine/src/store.ts'))
const root=mkdtempSync('/tmp/redtrace-request-'),out=path.resolve(process.argv[2]),labels={},captures={}
let child,logs='',failure
symlinkSync(repo+'/static',root+'/static')
symlinkSync(repo+'/skills',root+'/skills')
const text=m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)
const payloads=body=>body.messages.flatMap(m=>{try{return [JSON.parse(text(m))]}catch{return []}})
const server=createServer(async(req,res)=>{try{
 let raw='';for await(const b of req)raw+=b
 const body=JSON.parse(raw),all=JSON.stringify(body.messages),id=Object.keys(labels).find(id=>all.includes(id)),sys=body.messages.filter(m=>m.role==='system').map(text).join('\n'),tools=body.tools??[],names=tools.map(t=>t.function.name)
 let label=labels[id]
 if(/(?:你是 |You are )COMMANDER/.test(sys))label=label==='Benchmark Commander'?label:undefined
 else if(/(?:你是 |You are )GENERAL/.test(sys))label=['Benchmark General','General Planner'].includes(label)?label:undefined
 else if(sys.includes('漏洞报告撰写 agent'))label='Reporter'
 else if(!/(?:你是 |You are )SOLDIER/.test(sys))label=undefined
 if(['Benchmark Specialist','Custom Executor'].includes(label)&&!/(?:Specialist 分工|Specialist assignment)/.test(sys))label=undefined
 if(label)(captures[label]??=[]).push(body)
 let delta={content:'Local request observation only.'},name,args
 const payload=payloads(body).findLast(p=>p?.plannerRound||p?.frontier||p?.patrol)
 if(/(?:你是 |You are )COMMANDER/.test(sys)){name='legion_messages';args={action:'wait',through:payload?.cursor??0}}
 else if(label==='Benchmark General'){name='legion_plan';args={action:'done',state:'Confirmed local planning state',through:payload.plannerRound.triggers.cursor}}
 else if(/(?:你是 |You are )GENERAL/.test(sys)){name='legion_finish';args={processed:payload?.changes?{[id]:payload.changes.cursor}:{},state:'Confirmed local General state'}}
 else if(label&&['General Soldier','Custom Executor','Benchmark Specialist'].includes(label)&&captures[label].length===1){name='fgs_query';args={action:'changes'}}
 if(label&&['Benchmark General','General Planner'].includes(label)&&captures[label].length===1)setTimeout(()=>{const db=new Store(root+'/.redtrace/engine.db'),g=db.projectGraphs(id)[0];db.forGraph(id,g.id).addFact(id,'new local fixture report',{evidence:[{description:'local fixture'}]});db.close()},1200)
 if(name){assert(names.includes(name),label+': missing '+name);delta={tool_calls:[{index:0,id:'fixture-'+Date.now(),type:'function',function:{name,arguments:JSON.stringify(args)}}]}}
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: '+JSON.stringify({id:'fixture',object:'chat.completion.chunk',created:1,model:'fixture',choices:[{index:0,delta,finish_reason:delta.tool_calls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n')
 }catch(error){failure=error;res.writeHead(500);res.end(String(error))}})
try{
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const c=new Configuration(root);c.initialize();c.commit(c.read().revision,raw=>{
 raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:'+server.address().port+'/v1',api_key:'fixture',models:[{id:'fixture',context_window:100000,max_tokens:512,reasoning:'off',reasoning_efforts:false}]}}
 raw.workers=['commander','general','soldier'].map(role=>({name:role,roles:[role],provider:'fixture',model:'fixture',max_running:20}));raw.runtime={max_workers:30,max_project_workers:10,max_running_projects:10}
 })
 const store=new Store(root+'/.redtrace/engine.db')
 for(const [label,mode,role] of [['Benchmark Commander','benchmark',null],['General Planner','general',null],['Benchmark General','benchmark','general'],['Benchmark Soldier','benchmark','soldier'],['Benchmark Specialist','benchmark','soldier'],['General Soldier','general','soldier'],['Custom Executor','general','soldier'],['Reporter','general','soldier']]){
 const p=store.createProject({mode,title:label,origin:'Authorized local fixture scope',goal:'Verify local request context',bootstrap:false}).project;labels[p.id]=label
 if(!role)continue
 const graph=mode==='benchmark'?store.createGraph(p.id,{taskKey:label,title:label,origin:'Local fixture scope',goal:'Verify fixture'}):store.projectGraphs(p.id)[0],s=store.forGraph(p.id,graph.id),fact=s.addFact(p.id,'Necessary dependency',{evidence:[{description:'local fixture'}]})
 for(let i=0;i<30;i++)s.addFact(p.id,'Old evidence '+i,{evidence:[{description:'historical local fixture'}]})
 if(label==='Reporter'){const f=s.addFinding(p.id,{title:'Fixture finding',severity:'low',type:'fixture',description:'Local fixture',factIds:[fact.id]});s.requestFindingReport(p.id,f.id)}
 else if(role==='general')store.addPlanner(p.id,graph.id,{description:'Plan local fixture',sourceIds:[graph.originId,fact.id]})
 else s.addStep(p.id,{role,taskKey:label,description:'Verify dependency',sourceIds:[graph.originId,fact.id],goalId:graph.goalId,...(['Benchmark Specialist','Custom Executor'].includes(label)?{specialist:{name:'fixture',responsibilities:'local proof',capabilities:['local evidence'],scope:'fixture'}}:{})})
 }
 store.close();child=spawn(process.execPath,[repo+'/scripts/run-redtrace-node.mjs','--root',root,'--host','127.0.0.1','--port','0'],{cwd:repo,env:{...process.env,DSH_HOME:root+'/.dsh',REDTRACE_DATA_ROOT:root+'/.redtrace',REDTRACE_SOURCE_ROOT:repo,REDTRACE_DSH_ROOT:repo},stdio:['ignore','pipe','pipe']});for(const stream of [child.stdout,child.stderr])stream.on('data',b=>logs+=b)
 for(let i=0;i<200;i++){if(failure)throw failure;if(Object.keys(captures).length===8&&captures['General Planner']?.length>=2&&captures['Benchmark General']?.length>=2&&captures['General Soldier']?.length>=2&&captures['Custom Executor']?.length>=2)break;await delay(100)}
 assert.equal(Object.keys(captures).length,8,'Missing captures: '+Object.keys(captures)+'\n'+logs)
 for(const [label,requests] of Object.entries(captures)){
 const names=requests[0].tools.map(t=>t.function.name)
 if(['Benchmark General','General Planner'].includes(label))for(const n of names)assert(!/^(bash|pwsh|edit|write|glob|grep|job_|web_|mcp__|resource_|remote_|terminal_|skill$|fgs_publish$)/.test(n),label+': '+n)
 if(label==='Benchmark Commander')assert(!names.some(n=>/^(fgs_|TodoWrite|legion_goal|legion_steps|legion_accept)/.test(n)))
 if(['General Soldier','Custom Executor','Benchmark Specialist'].includes(label)){
 assert(!names.includes('legion_todo'));assert(!names.includes('legion_experience'));assert(!names.includes('legion_roster'));assert(names.includes('bash'));assert(JSON.stringify(requests[0].messages).includes('taskPlanner'))
 for(const request of requests.slice(1))for(const m of request.messages.filter(m=>m.role==='tool')){assert(!text(m).includes('acknowledgementBoundary'));assert(!text(m).includes('planningCapacity'))}
 }
 if(label==='Benchmark Soldier'){assert(names.includes('legion_todo'));assert(names.includes('legion_experience'));const catalog=JSON.stringify(requests[0].messages);for(const name of ['tsecbench-api','ctf-web','stagnation-recovery'])assert(catalog.includes('`'+name+'`'),'missing Skill '+name)}
 }
 for(const label of ['Benchmark General','General Planner']){
 const next=payloads(captures[label].at(-1)).findLast(p=>p?.plannerRound||p?.frontier)
 assert(next);if(label==='Benchmark General'){assert(next.plannerRound.frontier);assert(!next.plannerRound.overview)}else{assert(next.frontier);assert(!next.overview);assert(!next.scope);assert(!next.goal)}
 }
 writeFileSync(out,JSON.stringify(captures,null,2));writeFileSync(out+'.log',logs)
 console.log('ROLE_REQUEST_ACCEPTANCE=true; roles=8; General_no_execution=true; Commander_no_task_planning=true; Executor_no_roster=true; Resume_frontier=true; Worker_FGS_trimmed=true')
 console.log(JSON.stringify(Object.fromEntries(Object.entries(captures).map(([k,v])=>[k,{requests:v.length,tools:v[0].tools.length,schemaBytes:Buffer.byteLength(JSON.stringify(v[0].tools))}]))))
}finally{if(child){const done=new Promise(r=>child.once('close',r));child.kill('SIGTERM');await done}server.closeAllConnections();await new Promise(r=>server.close(r));rmSync(root,{recursive:true,force:true})}
