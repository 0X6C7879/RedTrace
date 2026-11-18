import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {Scheduler} from '../src/scheduler.ts'
import type {EngineConfig} from '../src/types.ts'
const settle=async()=>{for(let i=0;i<12;i++)await new Promise(r=>setImmediate(r))}
const config={workers:[{name:'fixture',backend:'mock',enabled:true,roles:['soldier','general'],provider:'p',model:'a',maxRunning:1,priority:0}],providers:{p:{api:'openai-completions',baseUrl:'http://127.0.0.1',models:[{id:'a',contextWindow:10000,maxTokens:100},{id:'b',contextWindow:10000,maxTokens:100}]}},maxWorkers:1,maxProjectWorkers:1,maxRunningProjects:1,maxSteps:null,decideTimeout:60,executeTimeout:60,concludeTimeout:10,bootstrapTimeout:60,bootstrapConcludeTimeout:10,workspaceRoot:'/unused'} as EngineConfig

test('Worker survives more than three failures, rotates configured models, preserves Session and respects tool uncertainty',async()=>{
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'outage',origin:'local',goal:'verify'}).project;new LegionStore(store)
 const g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),step=store.forGraph(p.id,g.id).addStep(p.id,{role:'soldier',taskKey:'T',description:'work',sourceIds:[g.originId]})
 const attempts:string[]=[],ids:string[]=[];let healthy=false
 const scheduler=new Scheduler(store,config,async({run,worker})=>{attempts.push(worker.model!);ids.push(run.id);if(healthy){store.addFact(p.id,'fixture proof',{runId:run.id,evidence:[{description:'local fixture'}]});return;}const r=store.run(run.id);r.failureCode=attempts.length%2?'INVALID_REQUEST':'AUTH';r.checkpoint={sessionId:run.id};store.saveRun(r);throw Error('fixture model failure')})
 try{scheduler.start();await settle();for(let i=0;i<12;i++){scheduler.watchdog();await settle();const s=store.node(p.id,step.id,'step') as any;assert.equal(s.status,'paused');assert(s.retryAfter>Date.now());assert(s.retryAfter-Date.now()<=60000);s.retryAfter=Date.now()-1;store.saveNode(s);scheduler.wake();await settle()}
 assert.equal(attempts.length,13);assert.deepEqual(attempts.slice(0,5),['a','b','a','b','a']);assert.equal(new Set(ids).size,1)
 const r=store.run(ids[0]);r.pendingTools=['unknown'];store.saveRun(r);scheduler.watchdog();await settle();assert.equal(attempts.length,13);r.pendingTools=[];store.saveRun(r)
 healthy=true;scheduler.watchdog();const s=store.node(p.id,step.id,'step') as any;s.retryAfter=Date.now()-1;store.saveNode(s);scheduler.wake();await settle();assert.equal(store.run(ids[0]).status,'succeeded')
 console.log('WORKER_RECOVERY=13 failures tolerated; configured route alternation; same Session; pending tools blocked; recovery succeeded')
 }finally{await scheduler.close();store.close()}
})

test('General remains schedulable through a simulated ten-hour model outage; successful round clears failures',()=>{
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'planner',origin:'local',goal:'verify'}).project;new LegionStore(store)
 const g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'});store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]});const scoped=store.forGraph(p.id,g.id)
 const now=Date.now;let clock=now();Date.now=()=>clock
 try{for(let i=0;i<600;i++){const run=scoped.claim(p.id,'plan',config.workers[0]);run.failureCode='SERVER';store.saveRun(run);store.finishRun(run.id,'failed','fixture outage');const planner=store.projectGraph(p.id,g.id).planner!;assert.equal(planner.status,'pending');assert(planner.retryAfter!>clock);assert(planner.retryAfter!-clock<=60000);clock+=60000}
 const run=scoped.claim(p.id,'plan',config.workers[0]);store.finishRun(run.id,'succeeded');assert.equal(store.projectGraph(p.id,g.id).planner!.failureCount,0)
 console.log('GENERAL_RECOVERY=600 failures / simulated 10h; backoff <=60s; success resets counter')
 }finally{Date.now=now;store.close()}
})
