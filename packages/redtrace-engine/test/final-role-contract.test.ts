import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {graphTools,launchContext,generalPlanningContext,taskPlanningContext} from '../src/runner.ts'
import type {EngineConfig,Step,Run} from '../src/types.ts'
const worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,maxRunning:4,priority:0}
const config={workspaceRoot:'/tmp/redtrace-final-contract',maxSteps:2} as EngineConfig

for(const mode of ['general','benchmark'] as const)test(mode+' Executor receives Planner identity and FGS evidence/cursors, never Planner scheduling fields',async()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({mode,title:'contract',origin:'local',goal:'verify'}).project,g=mode==='benchmark'?store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}):store.projectGraphs(p.id)[0],s=store.forGraph(p.id,g.id)
 if(mode==='benchmark')store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]})
 const prun=mode==='benchmark'?s.claim(p.id,'plan',worker):undefined
 const step=s.addStep(p.id,{role:'soldier',taskKey:'T',description:'execute',sourceIds:[g.originId]}),run=store.claim(p.id,'execute',worker,step.id),payload=launchContext(s,run.id)
 assert.equal(payload.taskPlanner?.receiver,prun?.id??'commander');assert.equal(payload.taskPlanner?.role,'general')
 for(const key of ['acknowledgementBoundary','planningCapacity','planningTodos'])assert(!(key in payload),key)
 const tools=graphTools({store:s,run,worker,config,signal:new AbortController().signal},()=>{})
 for(const name of ['legion_roster','legion_experience_capture','legion_experience_search','TodoWrite'])assert(!tools.some(t=>t.name===name),name)
 for(const [name,args] of [['read_graph',{}],['read_graph',{id:g.originId}],['read_graph_delta',{}]] as const){
 const result=(await tools.find(t=>t.name===name)!.execute('fixture',args)).details as Record<string,unknown>
 for(const key of ['acknowledgementBoundary','planningCapacity','planningTodos'])assert(!(key in result),name+':'+key)
 if(name==='read_graph_delta')assert('cursor' in result)
 }
 if(prun){const names=graphTools({store:s,run:prun,worker,config,signal:new AbortController().signal},()=>{});assert((await names.find(t=>t.name==='read_graph')!.execute('planner',{})).details);assert('acknowledgementBoundary' in ((await names.find(t=>t.name==='read_graph')!.execute('planner',{})).details as object))}
 assert(taskPlanningContext(store,step).taskPlanner)
 }finally{store.close()}
})

test('General Resume carries Frontier, deltas, reports and unfinished Todo, not full overview or Origin',()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({title:'resume',origin:'local',goal:'verify'}).project,l=new LegionStore(store,p.id),g=store.projectGraphs(p.id)[0]
 l.planningTodos(p.id).replace(g.id,[{content:'remaining',status:'pending'}]);l.claimCommand()
 const first=generalPlanningContext(store,p.id);assert(first.scope&&first.goal&&first.overview&&first.frontier)
 l.finishCommand({[p.id]:first.changes.cursor},'confirmed');l.claimCommand()
 store.addFact(p.id,'new report',{evidence:[{description:'local fixture'}]})
 const next=generalPlanningContext(store,p.id,true)
 assert(!('scope' in next));assert(!('goal' in next));assert(!('overview' in next));assert(next.frontier)
 assert(next.changes.events.some(e=>e.type==='fact.added'));assert.deepEqual(next.planningTodos,[{content:'remaining',status:'pending'}])
 }finally{store.close()}
})

test('long-task Planner reads SQL-bounded pending/frontier/recent Runs, never full execution history',()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({mode:'benchmark',title:'bounded',origin:'local',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),s=store.forGraph(p.id,g.id)
 store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]})
 for(let i=0;i<65;i++){const step=s.addStep(p.id,{role:'soldier',taskKey:'T',description:'queued '+i,sourceIds:[g.originId]});store.saveRun({id:'historic-'+i,projectId:p.id,graphId:g.id,stepId:step.id,activity:'execute',status:'failed',worker:'fixture',backend:'mock',startedAt:new Date().toISOString(),endedAt:new Date().toISOString(),checkpoint:null,baseRevision:1,pendingTools:[],error:'fixture',inputTokens:0,outputTokens:0,cacheReadTokens:0,cacheWriteTokens:0} as Run)}
 const run=s.claim(p.id,'plan',worker),originalRuns=Store.prototype.runs,originalNodes=Store.prototype.nodes
 Store.prototype.runs=function(id,page){assert(page?.limit||page?.statuses,'unbounded Run read');return originalRuns.call(this,id,page)}
 Store.prototype.nodes=function(this: Store,id,kinds,page){assert(page?.limit,'unbounded node read');return originalNodes.call(this,id,kinds,page) as ReturnType<typeof originalNodes>} as typeof originalNodes
 try{for(const incremental of [false,true]){const payload=launchContext(s,run.id,[],2,incremental) as any;assert.equal(payload.plannerRound.queue.total,65);assert.equal(payload.plannerRound.queue.ids.length,40);assert.equal(payload.plannerRound.totalRuns,65);assert.equal(payload.plannerRound.workers.length,12);if(incremental){assert(payload.plannerRound.frontier);assert(!payload.plannerRound.overview)}}}finally{Store.prototype.runs=originalRuns;Store.prototype.nodes=originalNodes}
 }finally{store.close()}
})

test('unknown-flag Soldier upgrades to General on the same Graph without recreating evidence, Todo or Steps',()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({mode:'benchmark',title:'upgrade',origin:'local',goal:'verify'}).project,l=new LegionStore(store,p.id),g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),s=store.forGraph(p.id,g.id)
 const soldier=l.spawn(p.id,{role:'soldier',taskKey:'T',description:'autonomous',sourceIds:[g.originId]}),run=store.claim(p.id,'execute',worker,soldier.id),fact=s.addFact(p.id,'verified entry',{runId:run.id,evidence:[{description:'local fixture'}]}),todos=[{content:'continue verified entry',status:'in_progress' as const,factIds:[fact.id]}]
 l.planningTodos(p.id).replace(g.id,todos)
 const before=s.graph(p.id),general=l.spawn(p.id,{role:'general',taskKey:'T',description:'take over planning',sourceIds:[fact.id]})
 assert.equal(general.role,'general');assert.equal(general.graphId,g.id);assert.deepEqual(s.graph(p.id).facts,before.facts);assert.deepEqual(s.graph(p.id).steps,before.steps);assert.deepEqual(l.planningTodos(p.id).list(g.id),todos)
 const tools=graphTools({store:s,run,worker,config,signal:new AbortController().signal},()=>{})
 for(const name of ['TodoWrite','legion_accept','legion_roster','legion_experience_search'])assert(!tools.some(t=>t.name===name),name)
 assert.throws(()=>s.addStep(p.id,{role:'general',taskKey:'T',description:'never execute',sourceIds:[g.originId],specialist:{name:'wrong',responsibilities:'execute',scope:'local',capabilities:[]}}),/Invalid benchmark role/)
 }finally{store.close()}
})
