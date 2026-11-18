import test from 'node:test'
import assert from 'node:assert/strict'
import {Store} from '../src/store.ts'
import {graphTools} from '../src/runner.ts'
import {legionTools} from '../src/legion-tools.ts'
import {CommanderTodos, TASK_PLANNING_TOOLS} from '../src/legion-todos.ts'
import {resourceTools} from '../src/capability-verbs.ts'
import type {EngineConfig, LegionRole} from '../src/types.ts'

test('fixed role schemas preserve planning ownership and specialists inherit Soldier without capability routing',()=>{
 const store=new Store(':memory:')
 try {
  const worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,maxRunning:4,priority:0},config={workspaceRoot:'/tmp/redtrace-role-fixture',workers:[]} as unknown as EngineConfig
  for(const mode of ['general','benchmark'] as const){
   const p=store.createProject({mode,title:mode,origin:'local fixture',goal:'verify',bootstrap:false}).project
   const commander=legionTools(store,'commander',p.id,null,()=>{},config,new CommanderTodos()).map(t=>t.name)
   assert.equal(commander.includes('TodoWrite'),mode==='general')
   assert.equal(commander.includes('legion_accept'),mode==='general')
   assert(!commander.some(name=>/^(submit_|resource_|remote_|mcp__)/.test(name)))
   let plain:string[]=[]
   for(const role of (mode==='benchmark'?['general','soldier','specialist']:['soldier','report'])){
    const graph=mode==='benchmark'?store.createGraph(p.id,{taskKey:role,title:role,origin:'fixture',goal:'verify'}):store.projectGraphs(p.id)[0]
    const step=role==='general'?store.addPlanner(p.id,graph.id,{description:'fixture',sourceIds:[graph.originId]}):store.forGraph(p.id,graph.id).addStep(p.id,{role:(role==='specialist'||role==='report'?(mode==='benchmark'?'soldier':'soldier'):role) as LegionRole,...(role==='report'?{reportFindingId:'fixture-finding'}:{}),taskKey:role,description:'fixture',sourceIds:[graph.originId],goalId:graph.goalId,...(role==='specialist'?{specialist:{name:'reverse',responsibilities:'analyze',capabilities:['reverse'],scope:'fixture'}}:{})})
    const run=role==='general'?store.forGraph(p.id,graph.id).claim(p.id,'plan',worker):store.claim(p.id,'execute',worker,step.id),context={store:store.forGraph(p.id,graph.id),run,worker,config,signal:new AbortController().signal}
    const tools=graphTools(context,()=>{}),names=tools.map(t=>t.name)
    assert.equal(names.includes('legion_step'),mode==='benchmark'&&role==='general')
    if(role==='reporter'||role==='report')assert.deepEqual(names.sort(),['evidence_read','project_evidence_read','read_execution','read_graph','read_graph_delta','update_finding_report'].sort())
    else if(role==='general'){assert(!names.includes('submit_fact'));assert(!names.includes('submit_finding'));assert(names.includes('legion_plan_done'));assert(names.includes('legion_read_run'));assert(names.includes('TodoWrite'))}
    else {
     assert(names.includes('submit_fact'));assert(names.includes('legion_handoff'))
     assert.equal(names.includes('TodoWrite'),mode==='benchmark'&&['general','soldier'].includes(role))
     assert(names.includes('submit_finding'))
     const resources=resourceTools(context,{operations:{}} as any).map(t=>t.name)
     assert(resources.includes('resource_register'))
    }
    if(role==='soldier'||role==='soldier')plain=names
    if(role==='specialist')assert.deepEqual(names,plain.filter(name=>!TASK_PLANNING_TOOLS.has(name)&&name!=='legion_experience_search'))
    store.finishRun(run.id,'cancelled')
   }
  }
 }finally{store.close()}
})
