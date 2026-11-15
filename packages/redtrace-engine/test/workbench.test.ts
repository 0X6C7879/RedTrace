import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {legionTools} from '../src/legion-tools.ts'
import {workerInstances} from '../src/workbench.ts'
import {ChatStore,chatTools} from '../src/chat.ts'
import {serveEngine} from '../src/index.ts'
import {Scheduler} from '../src/scheduler.ts'
import type {EngineConfig,Step} from '../src/types.ts'
const worker={name:'fixture',roles:['soldier','general'] as ('soldier'|'general')[],backend:'mock' as const,provider:'mock',model:'fixture',enabled:true,maxRunning:4,priority:0}
const specialist={name:'CodeAudit',responsibilities:'review the assigned endpoint',capabilities:['source audit'],scope:'local fixture endpoint only'}
for(const mode of ['benchmark','general'] as const)test(mode+' shares custom Agent creation, independent execution, STATE relay and stop-loss',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const p=store.createProject({mode,title:'fixture',origin:'authorized local fixture',goal:'verify'}).project,legion=new LegionStore(store,p.id)
 const graph=mode==='benchmark'?store.createGraph(p.id,{taskKey:'a',title:'a',origin:'local',goal:'verify'}):store.projectGraphs(p.id)[0]
 const mission={role:'soldier' as const,taskKey:'a',graphId:graph.id,description:'first independent angle',sourceIds:[graph.originId],specialist},a=legion.spawn(p.id,mission),b=legion.spawn(p.id,{...mission,description:'second independent angle',specialist:undefined})
 assert.deepEqual(store.node<Step>(p.id,a.id,'step').specialist,specialist)
 assert.throws(()=>legion.spawn(p.id,mission),/different angle/)
 if(mode==='general')assert.throws(()=>legion.spawn(p.id,{...mission,role:'scout'}),/no Scout/)
 const r=store.claim(p.id,'execute',worker,a.id);store.addFact(p.id,'first run evidence',{runId:r.id,creator:worker.name});legion.requestHandoff(r.id,'confirmed source and failed angle');store.finishRun(r.id,'cancelled');legion.completeHandoff(p.id,a.id);const successor=store.claim(p.id,'execute',worker,a.id)
 store.addFact(p.id,'second run evidence',{runId:successor.id,creator:worker.name});assert.deepEqual(workerInstances(store,p.id).map(w=>w.facts),[1,1]);assert.equal(successor.predecessorRunId,r.id);assert.deepEqual(store.node<Step>(p.id,a.id,'step').specialist,specialist)
 const instances=workerInstances(store,p.id);assert.deepEqual(instances.map(w=>w.label),['CodeAudit1','CodeAudit2']);assert.equal(new Set(instances.map(w=>w.id)).size,2)
 legion.park(p.id,'a','verified blocker','new evidence');assert.equal(store.node<Step>(p.id,b.id,'step').status,'parked')
})

test('Benchmark ownership transfers from Soldier planner to General without duplicating TodoList; General Commander alone plans',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const p=store.createProject({mode:'benchmark',title:'fixture',origin:'local',goal:'verify'}).project,legion=new LegionStore(store,p.id),g=store.createGraph(p.id,{taskKey:'a',title:'a',origin:'local',goal:'verify'})
 const spawn=(role:'soldier'|'general',description:string)=>{const step=legion.spawn(p.id,{role,taskKey:'a',graphId:g.id,description,sourceIds:[g.originId]});const r=store.claim(p.id,'execute',worker,step.id);return legionTools(store,r.id,p.id,null,()=>{})}
 const first=spawn('soldier','first planner'),todo=first.find(t=>t.name==='TodoWrite')!;await todo.execute('write',{todos:[{content:'verified stage',status:'in_progress'}]})
 assert(!spawn('soldier','different angle').some(t=>t.name==='TodoWrite'))
 const general=spawn('general','complex multi-stage escalation');assert(general.some(t=>t.name==='TodoWrite'));await assert.rejects(todo.execute('stale',{todos:[]}),/ownership transferred/)
 assert.equal(legion.planningTodos(p.id).list(g.id).length,1)
 const q=store.createProject({mode:'general',title:'general',origin:'local',goal:'verify'}).project,l=new LegionStore(store,q.id);l.claimCommand()
 assert(legionTools(store,'commander',q.id,null,()=>{},undefined,l.planningTodos(q.id)).some(t=>t.name==='TodoWrite'))
 const s=l.spawn(q.id,{role:'general',taskKey:'a',description:'execute only',sourceIds:['origin']}),r=store.claim(q.id,'execute',worker,s.id)
 assert(!legionTools(store,r.id,q.id,null,()=>{}).some(t=>['TodoWrite','legion_goal','legion_accept'].includes(t.name)))
})

test('General Scout migration is idempotent and retains original native audit history and mission',()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'workbench-migration-'));try{
  let s=new Store(dir+'/db'),p=s.createProject({mode:'general',title:'legacy',origin:'local',goal:'verify'}).project,step=s.addStep(p.id,{description:'existing recon',sourceIds:['origin']});step.role='scout';s.saveNode(step);s.close()
  s=new Store(dir+'/db');assert.equal(s.node<Step>(p.id,step.id,'step').role,'soldier');assert.equal(s.node<Step>(p.id,step.id,'step').description,'existing recon');assert.equal(s.events(p.id).filter(e=>e.type==='legion.role_migrated').length,1);s.close();s=new Store(dir+'/db');assert.equal(s.events(p.id).filter(e=>e.type==='legion.role_migrated').length,1);s.close()
 }finally{rmSync(dir,{recursive:true,force:true})}
})

test('real API conversation scopes, stable instance labels, paging, human sender and persistent global isolation',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'workbench-api-')),engine=await serveEngine({root:dir,port:0,autoStart:false}),base='http://127.0.0.1:'+(engine.server.address() as any).port
 const req=async(url:string,body?:unknown)=>{const response=await fetch(base+url,body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}:undefined);assert.equal(response.status,200);return response.json()}
 try{
 const s=engine.store,p=s.createProject({mode:'benchmark',title:'bench',origin:'local',goal:'verify'}).project,graphs=['a','b'].map(taskKey=>s.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
 const runs=graphs.map(g=>{const step=engine.legion.spawn(p.id,{role:'soldier',taskKey:g.taskKey!,description:g.title,sourceIds:[g.originId]});const run=s.claim(p.id,'execute',worker,step.id);s.runEvent(run.id,'assistant.message',{content:g.title});return run})
 const board=await req('/v2/projects/'+p.id+'/workbench');assert.deepEqual(board.workers.map((w:any)=>w.label),['Soldier1','Soldier2']);assert.equal(board.conversations.length,2)
 engine.legion.planningTodos(p.id).replace(graphs[0].id,[{content:'A only',status:'in_progress'}]);engine.legion.planningTodos(p.id).replace(graphs[1].id,[{content:'B only',status:'pending'}]);
 const url='/v2/projects/'+p.id+'/conversation?graphId='+graphs[0].id,page=await req(url);assert.equal(page.todos[0].content,'A only');assert.equal((await req('/v2/projects/'+p.id+'/conversation?graphId='+graphs[1].id)).todos[0].content,'B only');assert.deepEqual((await req('/v2/projects/'+p.id+'/conversation')).todos,[]);assert.equal(page.events.length,1);assert.equal(page.events[0].content,'a');assert.equal((await req(url+'&after='+page.cursor)).events.length,0)
 const order=await req('/v2/legion/message',{projectId:p.id,receiver:'commander',type:'MESSAGE',content:'user command'});assert.equal(order.message.sender,'human')
 const chat=await req('/v2/chats',{title:'global a'}),other=await req('/v2/chats',{title:'global b'});assert.notEqual(chat.sessionId,other.sessionId);assert.notEqual(chat.sessionId,engine.legion.campaign(p.id).sessionId)
 assert.equal((await req('/v2/chats?query=global%20a')).length,1);assert.equal((await req('/v2/chats/'+chat.id+'/events')).events.length,0)
 const tools=chatTools(s);assert(!tools.some(t=>['legion_spawn','legion_accept','TodoWrite'].includes(t.name)))
 const count=s.nodes(p.id,['step']).length;await tools.find(t=>t.name==='project_hint')!.execute('hint',{projectId:p.id,graphId:graphs[0].id,content:'explicit graph Hint'});assert.equal(s.nodes(p.id,['step']).length,count);assert.equal(s.forGraph(p.id,graphs[0].id).nodes(p.id,['hint']).length,1);assert.equal(s.forGraph(p.id,graphs[1].id).nodes(p.id,['hint']).length,0)
 assert.equal(runs.length,2)
 }finally{await engine.close();const reopened=new Store(dir+'/.redtrace/engine.db');assert.equal(new ChatStore(reopened).list().length,2);reopened.close();rmSync(dir,{recursive:true,force:true})}
})

test('global DSH chats consume existing global and route capacity without serializing Workers',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const p=store.createProject({mode:'general',title:'parallel',origin:'local',goal:'verify'}).project,legion=new LegionStore(store),chats=new ChatStore(store),chat=chats.create('occupied');chats.save({...chat,status:'running',workerName:worker.name})
 for(let i=0;i<3;i++)legion.spawn(p.id,{role:'soldier',taskKey:'angle-'+i,description:'work '+i,sourceIds:['origin']})
 const config={workers:[{...worker,maxRunning:3}],providers:{},maxWorkers:3,maxProjectWorkers:3,maxRunningProjects:1,maxSteps:null,workspaceRoot:'/tmp',executeTimeout:5,concludeTimeout:1} as EngineConfig
 let release!:()=>void;const wait=new Promise<void>(r=>release=r),scheduler=new Scheduler(store,config,async()=>wait)
 try{scheduler.start();await new Promise(r=>setImmediate(r));assert.equal(scheduler.activeRuns.length,2);chats.save({...chats.get(chat.id),status:'idle'});scheduler.wake();await new Promise(r=>setImmediate(r));assert.equal(scheduler.activeRuns.length,3)}finally{release();await scheduler.close()}
})

test('independent global conversations use real DSH tools, persistence and native resume',{timeout:60000},async()=>{
 const result=await promisify(execFile)(process.execPath,[new URL('./global-chat.fixture.mjs',import.meta.url).pathname],{maxBuffer:2e6});assert.match(result.stdout,/GLOBAL_CHAT_NATIVE=true/)
})

test('General Chief is project-scoped, on-demand, independently persistent, and cannot write FGS or escape Project',async t=>{
 const store=new Store(':memory:');t.after(()=>store.close());const p=store.createProject({mode:'general',title:'one',origin:'local',goal:'verify'}).project,q=store.createProject({mode:'general',title:'two',origin:'local',goal:'verify'}).project,chats=new ChatStore(store),chief=chats.chief(p.id),other=chats.chief(q.id);
 assert.equal(chats.chief(p.id).id,chief.id);assert.notEqual(chief.sessionId,other.sessionId);assert.equal(chats.list().length,0);assert.equal(chief.status,'idle');
 new LegionStore(store,p.id).planningTodos(p.id).replace(store.projectGraphs(p.id)[0].id,[{content:'真实 Commander 阶段',status:'in_progress'}]);
 const tools=chatTools(store.forProject(p.id),chief,chats);const plan=await tools.find(t=>t.name==='project_query')!.execute('plan',{projectId:p.id,kind:'plan'});assert.equal((plan.details as any).todos[0].content,'真实 Commander 阶段');assert(!tools.some(t=>['legion_spawn','legion_goal','TodoWrite'].includes(t.name)));
 const projects=await tools.find(t=>t.name==='projects')!.execute('query',{});assert.equal((projects.details as any[]).length,1);
 await assert.rejects(tools.find(t=>t.name==='project_query')!.execute('escape',{projectId:q.id,kind:'graphs'}),/scope|Project/i);
 await tools.find(t=>t.name==='commander_message')!.execute('deliver',{projectId:p.id,content:'adjust from human'});assert.equal(new LegionStore(store,p.id).messages(p.id,'commander')[0].sender,'chief');assert.equal(store.nodes(p.id,['step']).length,0);
 store.db.prepare('DELETE FROM projects WHERE id=?').run(p.id);assert.throws(()=>chats.get(chief.id),/not found/);
})


test('conversation catalog omits secrets and Commander selections use existing next-cycle state without interrupting it',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'composer-route-')),e=await serveEngine({root:dir,port:0,autoStart:false});const base='http://127.0.0.1:'+(e.server.address() as any).port;
 try{
 e.configuration.commit(e.configuration.read().revision,raw=>{raw.providers={fixture:{api:'openai-completions',base_url:'http://127.0.0.1:1/v1',api_key:'secret-fixture',models:[{id:'reasoning-model',context_window:30000,max_tokens:1000,reasoning_efforts:{low:'low',high:'high'}}]}};raw.workers=[{name:'a',roles:['commander'],provider:'fixture',model:'reasoning-model',max_running:2},{name:'b',roles:['commander'],provider:'fixture',model:'reasoning-model',max_running:2},{name:'soldier',roles:['soldier'],provider:'fixture',model:'reasoning-model',max_running:2}]});
 const choices=await (await fetch(base+'/v2/chats/models')).json();assert.deepEqual(choices.map((m:any)=>m.name),['a','b']);assert(!JSON.stringify(choices).includes('secret-fixture'));assert.deepEqual(choices[1].reasoningEfforts,['low','high']);
 const p=e.store.createProject({mode:'benchmark',title:'route test',origin:'local',goal:'verify'}).project,c=e.legion.campaign(p.id);c.status='running';e.legion.saveCampaign(c);
 const send=(body:any)=>fetch(base+'/v2/legion/message',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({projectId:p.id,receiver:'commander',type:'MESSAGE',content:'next cycle',...body})});
 assert.equal((await send({worker:'b',reasoning:'high'})).status,200);assert.equal(e.legion.campaign(p.id).nextWorker,'b');assert.equal(e.legion.campaign(p.id).reasoning,'high');assert.equal(e.legion.campaign(p.id).status,'running');
 const count=e.legion.messages(p.id,'commander').length;assert.equal((await send({worker:'soldier'})).status,422);assert.equal((await send({worker:'b',reasoning:'ultra'})).status,422);assert.equal(e.legion.messages(p.id,'commander').length,count);
 assert.equal((await send({worker:null,reasoning:null})).status,200);assert.equal(e.legion.campaign(p.id).nextWorker,undefined);assert.equal(e.legion.campaign(p.id).reasoning,undefined);
 }finally{await e.close();rmSync(dir,{recursive:true,force:true})}
});
