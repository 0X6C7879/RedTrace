import {scoutedSpawn} from './scout-fixture.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {Scheduler} from '../src/scheduler.ts'
import {launchContext} from '../src/runner.ts'
import {domainTools,TOOL_DOMAINS,domainAction} from '../../redtrace-dsh/src/tool-domains.ts'
import {toolAllowed} from '../src/console-api.ts'
import {Configuration} from '../src/config.ts'
import type {EngineConfig,GraphPlanner,Step} from '../src/types.ts'
const worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',roles:['general','soldier','scout','worker'] as ('general'|'soldier'|'scout'|'worker')[],enabled:true,priority:0,maxRunning:100}
const settle=async()=>{for(let i=0;i<30;i++)await new Promise(r=>setImmediate(r))}
const config={workers:[worker],providers:{},maxSteps:3,maxWorkers:100,maxProjectWorkers:100,maxRunningProjects:10,maxBenchmarkTasks:10,workspaceRoot:os.tmpdir()} as EngineConfig

test('ten Benchmark Graphs each claim three of ten queued Steps; General has identical per-Graph semantics',async()=>{
 for(const mode of ['benchmark','general'] as const){const store=new Store(':memory:'),p=store.createProject({mode,title:mode,origin:'local',goal:'verify'}).project
 const graphs=mode==='benchmark'?Array.from({length:10},(_,i)=>store.createGraph(p.id,{taskKey:String(i),title:String(i),origin:'local',goal:'verify'})):store.projectGraphs(p.id)
 for(const graph of graphs)for(let i=0;i<10;i++)store.forGraph(p.id,graph.id).addStep(p.id,{description:'queued '+i,sourceIds:[graph.originId],priority:i,role:mode==='benchmark'?'soldier':'worker',taskKey:graph.taskKey??graph.id})
 const scheduler=new Scheduler(store,config,async({signal})=>new Promise<void>(r=>signal.addEventListener('abort',()=>r(),{once:true})))
 try{scheduler.start();await settle();assert.equal(scheduler.activeRuns.length,graphs.length*3);for(const graph of graphs){assert.equal(store.planningCapacity(p.id,3,graph.id).activeSteps,3);assert.equal(store.forGraph(p.id,graph.id).nodeCount(p.id,'step'),10);const priorities=scheduler.activeRuns.filter(r=>r.graphId===graph.id).map(r=>store.node<Step>(p.id,r.stepId!,'step').priority).sort((a,b)=>b-a);assert.deepEqual(priorities,[9,8,7])}}finally{await scheduler.close();store.close()}}
})

test('paused claims reserve, resume their own slot, unknown results block replacement until confirmed, explicit cancellation frees',()=>{
 const store=new Store(':memory:'),p=store.createProject({title:'reservation',origin:'local',goal:'verify'}).project;store.stepLimit=()=>1
 try{const a=store.addStep(p.id,{description:'A',sourceIds:['origin']}),b=store.addStep(p.id,{description:'B',sourceIds:['origin']}),run=store.claim(p.id,'execute',worker,a.id)
 store.finishRun(run.id,'paused');assert.equal(store.planningCapacity(p.id).activeSteps,1);assert.throws(()=>store.claim(p.id,'execute',worker,b.id),/Step limit/)
 assert.equal(store.claim(p.id,'execute',worker,a.id).id,run.id);store.finishRun(run.id,'unknown');assert.throws(()=>store.claim(p.id,'execute',worker,b.id),/Step limit/)
 store.resolveUnknown(run.id,'fixture confirms terminal cancellation; no outstanding tool');const next=store.claim(p.id,'execute',worker,b.id);store.finishRun(next.id,'paused');store.updateStep(p.id,b.id,{status:'cancelled'});assert.equal(store.planningCapacity(p.id).activeSteps,0)
 }finally{store.close()}
})

test('Max Step=1 allows a Graph Planner plus one execution Worker; role identity never consumes capacity',()=>{
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'planner',origin:'local',goal:'verify'}).project,graph=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local',goal:'verify'}),legion=new LegionStore(store),scope=store.forGraph(p.id,graph.id);store.stepLimit=()=>1
 try{scoutedSpawn(legion,p.id,{role:'general',taskKey:'A',description:'plan',sourceIds:[graph.originId]});const planner=scope.claim(p.id,'plan',worker);assert.equal(planner.stepId,null);assert.equal(scope.planningCapacity(p.id).activeSteps,0)
 const step=scoutedSpawn(legion,p.id,{role:'scout',taskKey:'A',description:'recon',sourceIds:[graph.originId]}) as Step;store.claim(p.id,'execute',worker,step.id);assert.equal(scope.planningCapacity(p.id).activeSteps,1);assert.equal(scope.nodeCount(p.id,'step'),1)
 }finally{store.close()}
})

test('persistent Planner delivery is not processing; failure/reopen/handoff keep unprocessed events and the same TodoList',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'planner-cursor-'));let store=new Store(root+'/db')
 try{const p=store.createProject({mode:'benchmark',title:'events',origin:'local',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local',goal:'verify'}),scope=store.forGraph(p.id,g.id),legion=new LegionStore(store)
 scoutedSpawn(legion,p.id,{role:'general',taskKey:'A',description:'plan',sourceIds:[g.originId]});const run=scope.claim(p.id,'plan',worker),payload=launchContext(scope,run.id) as any,through=payload.plannerRound.triggers.cursor
 store.completePlanning(run.id,through,'tentative round');store.finishRun(run.id,'failed','fixture transport');assert.equal(store.projectGraph(p.id,g.id).planner!.cursor.acknowledged,0)
 store.close();store=new Store(root+'/db');let planner=store.projectGraph(p.id,g.id).planner!;planner.retryAfter=0;store.savePlanner(planner)
 const retry=store.forGraph(p.id,g.id).claim(p.id,'plan',worker);assert.equal(retry.id,run.id,'same Session on retry');assert.equal(JSON.parse(String(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(retry.id)!.data)).status,'running','resident Planner Audit reopens with its native Run');const redelivery=store.plannerEvents(store.projectGraph(p.id,g.id).planner!);assert(redelivery.events.some(e=>e.id===through))
 assert.throws(()=>store.completePlanning(retry.id,through+100,'skip'),/Acknowledgement/);store.completePlanning(retry.id,redelivery.cursor,'confirmed');store.finishRun(retry.id,'succeeded');assert.equal(store.projectGraph(p.id,g.id).planner!.cursor.acknowledged,redelivery.cursor)
 assert.equal(store.plannerWakeAt(store.projectGraph(p.id,g.id).planner!),Infinity,'quiet Planner has no heartbeat model call')
 store.forGraph(p.id,g.id).addInput(p.id,'hint','new evidence direction');store.db.prepare("UPDATE events SET created_at=? WHERE type='hint.added'").run(new Date(Date.now()-1000).toISOString());const active=store.forGraph(p.id,g.id).claim(p.id,'plan',worker)
 new LegionStore(store).requestHandoff(active.id,'confirmed chain and next action','upgraded');store.finishRun(active.id,'cancelled');planner=store.projectGraph(p.id,g.id).planner!;assert.equal(planner.status,'pending');assert.equal(planner.cursor.acknowledged,redelivery.cursor);assert.equal(new LegionStore(store).planningTodos(p.id).list(g.id).length,1)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('domain Schemas validate action requirements and preserve role/config denial, including stale dispatch',async()=>{
 const {Type}=await import('typebox'),{Check}=await import('typebox/value');let enabled=true,calls=0
 const original=[{name:'resource_list',description:'list',parameters:Type.Object({kind:Type.Optional(Type.String())},{additionalProperties:false}),execute:async(_id:string,_args:unknown)=>++calls},{name:'resource_register',description:'register',parameters:Type.Object({kind:Type.String(),name:Type.String()},{additionalProperties:false}),execute:async(_id:string,_args:unknown)=>++calls}]
 const tools=domainTools(original,name=>name!=='resource_register'||enabled),tool=tools[0]
 assert.equal(tool.name,'resource_manage');assert(!Check(tool.parameters,{action:'register',kind:'file'}));assert(Check(tool.parameters,{action:'register',kind:'file',name:'proof'}));assert(!Check(tool.parameters,{action:'nope'}));await tool.execute('id',{action:'list'});enabled=false;await assert.rejects(async()=>tool.execute('id',{action:'register',kind:'file',name:'proof'}),/disabled/);assert.equal(calls,1)
 const readonly=domainTools(original.slice(0,1))[0];assert.deepEqual((readonly.parameters as any).properties.action.enum,['list']);assert(!Object.keys(readonly.parameters.properties).includes('name'),'role aggregation cannot grant missing write action')
 const settings={resource_manage:{enabled:true,actions:{register:{enabled:false}}}};assert(!toolAllowed(settings,'resource_list','scout'));assert(toolAllowed(settings,'resource_list','soldier'));assert(!toolAllowed(settings,'resource_register','soldier'));assert(!domainAction('bash'));assert(Object.keys(TOOL_DOMAINS).length>10)
})

test('legacy per-tool settings migrate to domain action policy without enabling denied actions',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'domain-settings-')),c=new Configuration(root);c.initialize()
 try{c.commit(c.read().revision,raw=>{raw.tool_settings={webshell_test:{enabled:true,roles:['soldier']},webshell_register:{enabled:false}}})
 const raw=c.read().raw;assert(!raw.tool_settings?.webshell_register);assert.equal(raw.tool_settings?.webshell_manage.actions?.register.enabled,false);assert(toolAllowed(raw.tool_settings,'webshell_test','soldier'));assert(!toolAllowed(raw.tool_settings,'webshell_test','scout'));assert(!toolAllowed(raw.tool_settings,'webshell_register','soldier'))
 c.commit(c.read().revision,()=>{});assert.deepEqual(c.read().raw.tool_settings,raw.tool_settings)
 }finally{rmSync(root,{recursive:true,force:true})}
})

test('legacy General Step migrates once into Graph actor without losing Session, STATE, Todos, evidence or delegation lineage',()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'planner-migration-'));let store=new Store(root+'/db')
 try{const p=store.createProject({mode:'benchmark',title:'legacy',origin:'local',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local',goal:'verify'}),scope=store.forGraph(p.id,g.id)
 const legacy=scope.addStep(p.id,{role:'soldier',taskKey:'A',description:'legacy General',sourceIds:[g.originId]}),run=store.claim(p.id,'execute',worker,legacy.id);const child=scope.addStep(p.id,{role:'soldier',taskKey:'A',description:'delegate',sourceIds:[g.originId],parentStepId:legacy.id});legacy.role='general';legacy.handoff='retain exact next action';store.saveNode(legacy);new LegionStore(store).planningTodos(p.id).replace(g.id,[{content:'multi-stage chain',status:'in_progress',stepIds:[legacy.id,child.id]}]);store.close()
 store=new Store(root+'/db');const planner=store.projectGraph(p.id,g.id).planner!
 assert.equal(planner.handoff,'retain exact next action');assert.equal(store.run(run.id).id,run.id);assert.equal(store.run(run.id).activity,'plan');assert.equal(store.run(run.id).stepId,null);assert.equal(store.forGraph(p.id,g.id).nodeCount(p.id,'step'),1);assert.equal(store.node<Step>(p.id,child.id).plannerId,planner.id);assert.equal(store.readNode(p.id,legacy.id,'doc').description,'legacy General');assert.equal(store.planningCapacity(p.id,1,g.id).activeSteps,0)
 const todos=new LegionStore(store).planningTodos(p.id);todos.replace(g.id,todos.list(g.id));assert.deepEqual(todos.list(g.id)[0].stepIds,[legacy.id,child.id]);store.close();store=new Store(root+'/db');assert.equal(store.projectGraph(p.id,g.id).planner!.legacyAssignments!.length,1)
 }finally{store.close();rmSync(root,{recursive:true,force:true})}
})

test('Trace index excludes Thinking/parameters, preserves totals/search/pages and expands literal original events',async()=>{
 const {readRunTrace}=await import('../src/run-trace.ts'),store=new Store(':memory:'),p=store.createProject({title:'audit',origin:'local',goal:'verify'}).project,s=store.addStep(p.id,{description:'collect',sourceIds:['origin']}),r=store.claim(p.id,'execute',worker,s.id)
 try{store.audit({id:r.id,project_id:p.id},[{kind:'thinking.message',content:'private reasoning '.repeat(1000)},{kind:'tool.started',call_id:'A',arguments:{payload:'large argument '.repeat(1000)}},{kind:'tool.completed',call_id:'A',content:'unique-chain-token proof'},{kind:'assistant.message',content:'next stage'}]);const first=readRunTrace(store,p.id,r.id,{limit:1});assert(!JSON.stringify(first).includes('private reasoning'));assert(!JSON.stringify(first).includes('large argument'));assert.equal(first.total,4);assert(first.hasMore)
 const search=readRunTrace(store,p.id,r.id,{query:'unique-chain-token'});assert.equal(search.matching,1);const exact=readRunTrace(store,p.id,r.id,{eventId:search.events![0].id});assert.equal(exact.event!.content,'unique-chain-token proof');const next=readRunTrace(store,p.id,r.id,{after:first.nextAfter!,limit:1});assert(next.events![0].id>first.events![0].id)
 }finally{store.close()}
})

test('Planner handoff waits for its own tool result and starts a fresh Session only after confirmed stop',()=>{
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'relay',origin:'local',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local',goal:'verify'}),scope=store.forGraph(p.id,g.id),legion=new LegionStore(store)
 try{scoutedSpawn(legion,p.id,{role:'general',taskKey:'A',description:'plan',sourceIds:[g.originId]});const run=scope.claim(p.id,'plan',worker);store.toolStarted(run.id,'relay',{name:'legion_handoff'});legion.queueHandoff(run.id,'retain full chain','upgraded');legion.settleHandoff(run.id);assert.equal(store.projectGraph(p.id,g.id).planner!.status,'running');store.toolEnded(run.id,'relay',{});legion.settleHandoff(run.id);assert.equal(store.projectGraph(p.id,g.id).planner!.status,'parked');store.finishRun(run.id,'cancelled');const next=scope.claim(p.id,'plan',{name:'upgraded',backend:'mock'});assert.notEqual(next.id,run.id);assert.equal(next.predecessorRunId,run.id);assert.equal(next.handoff,'retain full chain');assert.equal(scope.planningCapacity(p.id,1).activeSteps,0)
 }finally{store.close()}
})

test('native stale/nested domain calls cannot bypass per-action role policy',async()=>{
 const {serveEngine}=await import('../src/index.ts'),{load,mount}=await import(new URL('../../redtrace-dsh/lib/loader.js',import.meta.url).href),{mountToolSettings,platformToolOptions}=await import(new URL('../compat/console.mjs',import.meta.url).href)
 const root=mkdtempSync(path.join(os.tmpdir(),'domain-native-')),engine=await serveEngine({root,autoStart:false,port:0}),{Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),ctx=new Context()
 try{for(const module of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','vendor/deepseek-harness/packages/subprocess/subprocess-local/lib/index.js','packages/redtrace-dsh/lib/core.js'])await mount(ctx,module)
 mountToolSettings(ctx,engine);const p=engine.store.createProject({title:'policy',origin:'local',goal:'verify'}).project,step=engine.store.addStep(p.id,{description:'execute',sourceIds:['origin']}),run=engine.store.claim(p.id,'execute',worker,step.id),{SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js'),{createScope}=await load('vendor/deepseek-harness/packages/core/scope/lib/index.js'),carrier=ctx.plugin({inject:['tools','systemPrompt'],apply(){}});await carrier.await()
 const agent:any={options:{},session:ctx.sessions.create(SessionId(run.id),{meta:{cwd:root}})},scope=createScope(carrier.ctx,agent);agent.ctx=scope.ctx
 let calls=0;const tool=domainTools([{name:'resource_list',description:'read',parameters:{type:'object',properties:{}},execute:async(_args:any,_execution:any)=>({ran:++calls})},{name:'resource_register',description:'write',parameters:{type:'object',properties:{name:{type:'string'}},required:['name']},execute:async(_args:any,_execution:any)=>({ran:++calls})}])[0]
 scope.ctx.tools.register({...tool,redtrace:true,output:{schema:{type:'object',additionalProperties:true},render:()=>[{type:'text',text:'ran'}]},execute:(args:any)=>tool.execute(args,{})},platformToolOptions(engine,tool.name,'worker'))
 const stale=await ctx.tools.resolve({agent,signal:new AbortController().signal});engine.configuration.commit(engine.configuration.read().revision,raw=>{raw.tool_settings={resource_manage:{enabled:true,actions:{register:{enabled:true,roles:['soldier']}}}}})
 const {ToolExecutionPipeline}=await load('vendor/deepseek-harness/packages/core/tools/lib/pipeline.js'),pipeline=new ToolExecutionPipeline(ctx),blocked=await pipeline.prepare({name:'resource_manage',callId:'nested',rootCallId:'root',arguments:{action:'register',name:'fixture'},agent,toolSet:stale,parent:{},signal:new AbortController().signal})
 assert.equal(blocked.kind,'post-result');assert.equal(calls,0);stale.dispose();await scope.dispose();await carrier.dispose()
 }finally{await ctx.fiber.dispose();await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('Graph Planner debounce is 800 ms after the latest relevant event, not the first burst event',()=>{
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'debounce',origin:'local',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local',goal:'verify'}),scope=store.forGraph(p.id,g.id)
 try{scoutedSpawn(new LegionStore(store),p.id,{role:'general',taskKey:'A',description:'plan',sourceIds:[g.originId]});const run=scope.claim(p.id,'plan',worker),changes=store.plannerEvents(store.projectGraph(p.id,g.id).planner!);store.completePlanning(run.id,changes.cursor,'wait for evidence');store.finishRun(run.id,'succeeded');const first=scope.addInput(p.id,'hint','first'),last=scope.addInput(p.id,'hint','latest')
 store.db.prepare('UPDATE events SET created_at=? WHERE node_id=?').run(new Date(Date.now()-2000).toISOString(),first.id);store.db.prepare('UPDATE events SET created_at=? WHERE node_id=?').run(new Date(Date.now()-100).toISOString(),last.id)
 assert(store.plannerWakeAt(store.projectGraph(p.id,g.id).planner!)>Date.now()+500)
 }finally{store.close()}
})

test('local Watchdog ignores healthy tool activity and emits one stall trigger per idle interval',async()=>{
 const store=new Store(':memory:'),p=store.createProject({mode:'benchmark',title:'watchdog',origin:'local',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'A',title:'A',origin:'local',goal:'verify'}),scope=store.forGraph(p.id,g.id)
 scoutedSpawn(new LegionStore(store),p.id,{role:'general',taskKey:'A',description:'plan',sourceIds:[g.originId]});scope.addStep(p.id,{description:'execute',sourceIds:[g.originId]})
 let rounds=0;const scheduler=new Scheduler(store,config,async ctx=>{if(ctx.run.activity==='plan'){rounds++;const changes=store.plannerEvents(store.projectGraph(p.id,g.id).planner!);store.completePlanning(ctx.run.id,changes.cursor,'Workers continue')}else await new Promise<void>(r=>ctx.signal.addEventListener('abort',()=>r(),{once:true}))})
 try{scheduler.start();await settle();const run=store.runsByStatus('running',p.id).find(r=>r.activity==='execute')!;run.startedAt=new Date(Date.now()-10*60_000).toISOString();store.saveRun(run);const metadata=JSON.parse(String(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id)!.data));store.audit(metadata,[{kind:'tool.completed',timestamp:new Date().toISOString(),call_id:'healthy',content:'ongoing tool activity'}]);scheduler.watchdog();await settle();assert.equal(rounds,1);assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='planner.stalled'").get()!.n,0)
 store.db.prepare("UPDATE audit_events SET data=json_set(data,'$.timestamp',?) WHERE run_id=?").run(new Date(Date.now()-6*60_000).toISOString(),run.id);scheduler.watchdog();scheduler.watchdog();assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE type='planner.stalled'").get()!.n,1)
 }finally{await scheduler.close();store.close()}
})

test('tool statistics fold immutable legacy names into domain/action without rewriting Audit',async()=>{
 const {toolStatistics}=await import('../src/tool-stats.ts'),store=new Store(':memory:'),p=store.createProject({title:'stats',origin:'local',goal:'verify'}).project,step=store.addStep(p.id,{description:'execute',sourceIds:['origin']}),run=store.claim(p.id,'execute',worker,step.id)
 try{const metadata=JSON.parse(String(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id)!.data));store.audit(metadata,[{kind:'tool.started',title:'http_batch',call_id:'legacy',arguments:{requests:[]}},{kind:'tool.completed',title:'http_batch',call_id:'legacy',content:'old'},{kind:'tool.started',title:'http_session',call_id:'current',arguments:{action:'batch',requests:[]}},{kind:'tool.completed',title:'http_session',call_id:'current',content:'new'}]);const stats=toolStatistics(store,new URL('http://fixture/?tool=http_session'),['http_session']);assert.equal(stats.stats.calls,2);assert.equal(stats.tools[0].name,'http_session');assert.equal(stats.actions[0].action,'batch');assert.equal(stats.actions[0].calls,2);assert(stats.history.some(h=>h.original_name==='http_batch'));assert(store.db.prepare("SELECT 1 FROM audit_events WHERE json_extract(data,'$.title')='http_batch'").get())
 }finally{store.close()}
})
