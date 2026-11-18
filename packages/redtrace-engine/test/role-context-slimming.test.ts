import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.ts'
import {graphTools,launchContext,livePlan} from '../src/runner.ts'
import {verbTools} from '../src/capability-verbs.ts'
import type {EngineConfig} from '../src/types.ts'

test('executors keep dependencies, references and messaging, not roster, experience or scheduling capacity',async()=>{
 const store=new Store(':memory:'),worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,maxRunning:4,priority:0},config={workspaceRoot:'/tmp/role-context-fixture',maxSteps:4} as EngineConfig
 try{for(const mode of ['general','benchmark'] as const){
 const p=store.createProject({mode,title:'fixture',origin:'scope constraint',goal:'goal constraint',bootstrap:false}).project
 const g=mode==='benchmark'?store.createGraph(p.id,{taskKey:'task',title:'task',origin:'task scope',goal:'task goal'}):store.projectGraphs(p.id)[0],s=store.forGraph(p.id,g.id)
 if(mode==='benchmark')store.addPlanner(p.id,g.id,{description:'general',sourceIds:[g.originId]})
 const fact=s.addFact(p.id,'important dependency',{evidence:[{description:'retained source'}]})
 const step=s.addStep(p.id,{role:mode==='benchmark'?'soldier':'soldier',taskKey:'task',description:'execute constraint',sourceIds:[g.originId,fact.id],goalId:g.goalId,...(mode==='benchmark'?{specialist:{name:'specialist',responsibilities:'proof',capabilities:['shell'],scope:'local'}}:{})})
 s.addInput(p.id,'hint','generic hint');s.addInput(p.id,'hint','step hint','user',step.id)
 const run=store.claim(p.id,'execute',worker,step.id),ctx={store:s,run,worker,config,signal:new AbortController().signal},tools=graphTools(ctx,()=>{}),names=tools.map(t=>t.name)
 for(const n of ['legion_roster','legion_experience_search','legion_experience_capture','TodoWrite','legion_step'])assert(!names.includes(n),n)
 for(const n of ['submit_fact','submit_finding','project_evidence_read','evidence_read','legion_message','legion_inbox','legion_state','legion_wait'])assert(names.includes(n),n)
 const launch=launchContext(store,run.id);assert(!('planningCapacity' in launch));assert(!('step' in launch));assert.equal(launch.dependencies?.[0].id,fact.id);assert.equal(launch.hints?.items[0].content,'step hint');assert(livePlan(store,run.id).includes('execute constraint'))
 const result=await tools.find(t=>t.name==='read_graph')!.execute('read',{id:fact.id});assert(!JSON.stringify(result).includes('planningCapacity'))
 const verbs=verbTools(ctx,{operations:{} as any});assert(!verbs.some(t=>t.name==='remote_file_touch'));assert(verbs.some(t=>t.name==='remote_file_write'));assert(verbs.some(t=>t.name==='remote_file_hash'))
 }}finally{store.close()}
})

test('Planner wake keeps active frontier and changed nodes instead of repeating initial historical overview',async()=>{
 const store=new Store(':memory:'),worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,maxRunning:4,priority:0}
 try{
 const p=store.createProject({mode:'benchmark',title:'fixture',origin:'scope',goal:'goal',bootstrap:false}).project,g=store.createGraph(p.id,{taskKey:'task',title:'task',origin:'scope',goal:'goal'}),s=store.forGraph(p.id,g.id)
 store.addPlanner(p.id,g.id,{description:'plan',sourceIds:[g.originId]});const run=s.claim(p.id,'plan',worker),first=launchContext(store,run.id) as any
 assert(first.plannerRound.overview);store.completePlanning(run.id,first.plannerRound.triggers.cursor,'confirmed state');store.finishRun(run.id,'succeeded')
 const fact=s.addFact(p.id,'new verified result',{evidence:[{description:'reference'}]});await new Promise(r=>setTimeout(r,850));const next=s.claim(p.id,'plan',worker),wake=launchContext(store,next.id,[],null,true) as any
 assert(!wake.plannerRound.overview);assert(wake.plannerRound.frontier.changedNodes.some((n:any)=>n.id===fact.id));assert(wake.plannerRound.frontier.goals.length);assert.equal(wake.plannerRound.state,'confirmed state')
 }finally{store.close()}
})
