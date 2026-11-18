import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {Store} from '../src/store.ts'
import {LegionStore,executionTime} from '../src/legion-store.ts'
import {tokenUsage} from '../src/token-usage.ts'
import {createPlanGuard} from '../src/plan-guard.ts'
import {graphTools} from '../src/runner.ts'
import type {EngineConfig,Run} from '../src/types.ts'

function fixture(t:any){const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'fixture',origin:'local',goal:'proof'}).project,g=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local',goal:'proof A'});t.after(()=>store.close());const scoped=store.forGraph(p.id,g.id),step=scoped.addStep(p.id,{role:'soldier',taskKey:'A',description:'solve A',sourceIds:[g.originId]}),worker={name:'fixture',backend:'mock' as const},run=store.claim(p.id,'execute',worker,step.id);return{store,p,g,scoped,step,worker,run}}

test('active execution excludes three hours offline and overlapping workers do not multiply stagnation',()=>{
 const run=(start:number,end:number|null,status='succeeded')=>({startedAt:new Date(start).toISOString(),endedAt:end===null?null:new Date(end).toISOString(),status}) as Run
 const minute=60000,runs=[run(0,10*minute),run(5*minute,12*minute),run(190*minute,null,'running')]
 assert.equal(executionTime(runs,195*minute),17*minute)
 assert.equal(executionTime(runs,195*minute,190*minute),5*minute)
 assert.equal(executionTime([run(0,null,'paused')],195*minute),0)
})

test('coordinator campaign usage replaces its duplicate audit subtotal; task roles and cache buckets stay disjoint',t=>{
 const f=fixture(t),legion=new LegionStore(f.store,f.p.id)
 f.store.audit({id:'command',project_id:f.p.id,task_type:'commander',input_tokens:10,output_tokens:2,cache_read_tokens:100},[])
 f.store.audit({id:f.run.id,project_id:f.p.id,graph_id:f.g.id,task_type:'soldier',input_tokens:20,output_tokens:3,cache_read_tokens:200},[])
 legion.saveCampaign({...legion.campaign(),usage:{inputTokens:10,outputTokens:2,cacheReadTokens:100,cacheWriteTokens:0}})
 const global=tokenUsage(f.store),task=tokenUsage(f.store,f.p.id,f.g.id)
 assert.equal(global.total,335);assert.equal(global.breakdown.commander.total,112);assert.equal(task.total,223);assert.equal(task.breakdown.soldier.cacheRead,200);assert.equal(task.breakdown.commander.total,0)
})

test('Soldier can author a durable plan, but initialized Goal alone cannot authorize attack execution',t=>{
 const f=fixture(t),guard=createPlanGuard(f.store,f.run.id);guard.beginTurn()
 assert.match(guard.check({name:'bash',rootCallId:'before'})!,/TodoWrite/)
 assert.equal(guard.check({name:'TodoWrite',rootCallId:'plan'}),undefined)
 f.store.db.prepare('UPDATE commander_todos SET data=? WHERE graph_id=?').run(JSON.stringify([{content:'proof A',status:'completed'}]),f.g.id)
 assert.match(guard.check({name:'bash',rootCallId:'legacy-placeholder'})!,/TodoWrite/)
 new LegionStore(f.store,f.p.id).planningTodos(f.p.id).replace(f.g.id,[{content:'inspect entry',status:'in_progress',acceptance:'retained service response'},{content:'verify objective',status:'pending'}])
 assert.equal(guard.check({name:'bash',rootCallId:'after'}),undefined)
})

test('unfinished autonomous Soldier cannot silently retire as a completed Step; explicit task exhaustion remains possible',async t=>{
 const f=fixture(t);f.scoped.addFact(f.p.id,'partial verified result',{runId:f.run.id,evidence:[{description:'local fixture'}]})
 const tools=graphTools({store:f.scoped,run:f.run,worker:f.worker as any,config:{maxSteps:null,workspaceRoot:'/tmp'} as EngineConfig,signal:new AbortController().signal},()=>{})
 await assert.rejects(tools.find(t=>t.name==='finish_step')!.execute('finish',{summary:'partial task only'}),/Task Goal is still open/)
 assert.equal(f.store.run(f.run.id).status,'running')
 await tools.find(t=>t.name==='legion_task_stop')!.execute('stop',{reason:'tested directions exhausted',state:'partial proof retained'})
 assert.equal(f.scoped.node<any>(f.p.id,f.g.goalId).status,'cancelled')
})

test('conversation token rows reflect selected task roles and cannot leak Commander or another task',()=>{
 const c=vm.createContext({window:{}});vm.runInContext(readFileSync(new URL('../../../static/workbench.js',import.meta.url),'utf8'),c)
 const app=c.window.redtraceWorkbench;app.workbench={project:{mode:'benchmark'},usage:{breakdown:{commander:{total:99,input:1,output:2,cacheRead:96,cacheWrite:0}}}};app.conversationId='commander';assert.equal(app.conversationTokenRows()[0].total,99)
 app.conversationId='A';app.conversationUsage={breakdown:{commander:{total:99},soldier:{total:5},general:{total:3}}};assert.deepEqual(Array.from(app.conversationTokenRows(),(r:any)=>r.role),['general','soldier'])
})

test('native Commander patrol requests remain bounded while one Session retains complete raw tool audit',{timeout:40000},async()=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util')
 const {stdout}=await promisify(execFile)(process.execPath,[new URL('./commander-patrol-boundary.fixture.mjs',import.meta.url).pathname],{timeout:30000,maxBuffer:1024*1024,env:{...process.env,REDTRACE_LEGACY_STATE_PROBE:'1'}})
 const result=JSON.parse(stdout.trim().split('\n').at(-1)!);assert(result.native);assert.equal(result.requests,16);assert.equal(result.rawToolCalls,16);console.log(JSON.stringify(result))
})

test('same native Run pause/resume also excludes the offline interval from scheduling recommendations',t=>{
 const f=fixture(t),minute=60000,at=Date.now(),iso=(offset:number)=>new Date(at+offset*minute).toISOString()
 const run=f.store.run(f.run.id);run.startedAt=iso(-186);f.store.saveRun(run)
 f.store.db.prepare("UPDATE events SET created_at=? WHERE type='execute.started' AND json_extract(data,'$.runId')=?").run(iso(-186),run.id)
 f.store.event(f.p.id,'execute.paused',f.step,{runId:run.id});f.store.db.prepare('UPDATE events SET created_at=? WHERE id=(SELECT MAX(id) FROM events)').run(iso(-185))
 f.store.event(f.p.id,'execute.started',f.step,{runId:run.id});f.store.db.prepare('UPDATE events SET created_at=? WHERE id=(SELECT MAX(id) FROM events)').run(iso(-5))
 const task=new LegionStore(f.store,f.p.id).tactics(f.p.id,at)[0]
 assert.equal(task.elapsedMs,6*minute);assert.equal(task.stalledMinutes,6);assert.equal(task.recommendation,'tactical')
 f.store.audit({id:run.id,project_id:f.p.id,graph_id:f.g.id,task_type:'soldier'},[{kind:'tool.completed',timestamp:iso(-1),content:'last confirmed resumed activity'}])
 f.store.finishRun(run.id,'unknown','Process stopped before run completion')
 assert.equal(new LegionStore(f.store,f.p.id).tactics(f.p.id,at)[0].elapsedMs,5*minute)
})

test('crash detection time is not charged as three hours of verified work',t=>{
 const f=fixture(t),minute=60000,at=Date.now(),iso=(offset:number)=>new Date(at+offset*minute).toISOString(),run=f.store.run(f.run.id)
 run.startedAt=iso(-186);f.store.saveRun(run);f.store.db.prepare("UPDATE events SET created_at=? WHERE type='execute.started' AND json_extract(data,'$.runId')=?").run(iso(-186),run.id)
 f.store.audit({id:run.id,project_id:f.p.id,graph_id:f.g.id,task_type:'soldier'},[{kind:'tool.completed',timestamp:iso(-185),content:'last confirmed fixture activity'}])
 f.store.finishRun(run.id,'unknown','Process stopped before run completion')
 assert.equal(new LegionStore(f.store,f.p.id).tactics(f.p.id,at)[0].elapsedMs,minute)
})

test('a user-stopped project is not rendered as an unexpected Commander scheduling failure',()=>{
 const c=vm.createContext({window:{}});vm.runInContext(readFileSync(new URL('../../../static/workbench.js',import.meta.url),'utf8'),c)
 const app=c.window.redtraceWorkbench;app.legion={campaign:{status:'stopped',error:'Project stopped or deleted'}};app.workbench={project:{status:'stopped'}};assert.equal(app.commanderError(),'')
 app.workbench.project.status='active';app.legion.campaign.error='route expired';assert.equal(app.commanderError(),'route expired')
 app.conversationId='A';app.conversationGraphId=()=> 'A';app.conversationTodos=()=>[{content:'proof A',status:'completed'}];app.workbench.goals=[{graphId:'A',description:'proof A'}];assert.equal(app.todoPlaceholder(),true)
})
