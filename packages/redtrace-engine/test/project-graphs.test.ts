import {scoutedSpawn} from './scout-fixture.ts'
import assert from 'node:assert/strict'
import {test} from 'node:test'
import type {Project,Worker,Goal} from '../src/types.ts'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {legionTools} from '../src/legion-tools.ts'
const create=(s:Store,title:string,mode:Project['mode']='general')=>s.createProject({title,origin:'Authorized local fixture',goal:'Verify fixture',mode}).project
const worker:Pick<Worker,'name'|'backend'>={name:'fixture',backend:'mock'}
test('Project Commanders have separate identity, STATE and delivered event boundaries',()=>{
 const s=new Store(':memory:');try{const a=create(s,'A'),b=create(s,'B'),la=new LegionStore(s,a.id),lb=new LegionStore(s,b.id)
 assert.notEqual(la.campaign().sessionId,lb.campaign().sessionId)
 la.claimCommand();la.saveState(a.id,'commander','A only');assert.equal(lb.campaign().state,'')
 assert.throws(()=>la.readChanges(b.id));assert.throws(()=>s.forProject(a.id).node(b.id,'origin'))
 const delta=la.readChanges(a.id);la.finishCommand({[a.id]:delta.cursor},'saved');assert.deepEqual(lb.campaign().cursors,{})
 }finally{s.close()}
})
test('three Benchmark Graphs isolate nodes, references, Run, events and completion',()=>{
 const s=new Store(':memory:');try{const p=create(s,'Benchmark','benchmark'),legion=new LegionStore(s,p.id)
 const graphs=['A','B','C'].map(taskKey=>s.createGraph(p.id,{taskKey,title:taskKey,origin:'Local '+taskKey,goal:'Verify '+taskKey}))
 assert.equal(s.projectGraphs(p.id).length,3);assert.equal(new Set(graphs.map(g=>g.originId)).size,3);assert.equal(new Set(graphs.map(g=>g.goalId)).size,3)
 const runs=graphs.map(g=>{const v=s.forGraph(p.id,g.id),step=scoutedSpawn(legion,p.id,{graphId:g.id,taskKey:g.taskKey!,role:'soldier',description:'observe',sourceIds:[g.originId]});const run=v.claim(p.id,'execute',worker,step.id);const fact=v.addFact(p.id,'observed '+g.taskKey,{runId:run.id,evidence:[{description:'local fixture observation'}]});v.addFinding(p.id,{title:'result',description:'result',factIds:[fact.id],runId:run.id});v.finishRun(run.id,'succeeded');return{run,fact,step}})
 const a=s.forGraph(p.id,graphs[0].id),b=s.forGraph(p.id,graphs[1].id)
 const manualA=a.addFact(p.id,'manual A'),manualB=b.addFact(p.id,'manual B');assert.throws(()=>a.node(p.id,manualB.id),/another Graph/);assert.equal(a.node(p.id,manualA.id).id,manualA.id)
 assert.equal(a.graph(p.id).facts.length,3);assert.equal(a.nodes(p.id,['finding']).length,1)
 assert.throws(()=>a.node(p.id,runs[1].fact.id));assert.throws(()=>a.run(runs[1].run.id))
 assert.throws(()=>a.addStep(p.id,{description:'cross',sourceIds:[runs[1].fact.id]}))
 assert.throws(()=>s.addStep(p.id,{description:'cross',goalId:graphs[0].goalId,sourceIds:[runs[1].fact.id]}))
 assert.throws(()=>a.updateGoal(p.id,graphs[0].goalId,{status:'achieved',evidenceIds:[runs[1].fact.id]}))
 assert(a.events(p.id).every(e=>e.graphId===graphs[0].id));assert(a.graphDelta(p.id).nodes.every(n=>n.graphId===graphs[0].id))
 a.updateGoal(p.id,graphs[0].goalId,{status:'achieved',evidenceIds:[runs[0].fact.id]});assert.equal(s.project(p.id).status,'active');assert.equal(b.node<Goal>(p.id,graphs[1].goalId).status,'open')
 assert.throws(()=>s.createGraph(p.id,{taskKey:'A',title:'duplicate',origin:'o',goal:'g'}))
 }finally{s.close()}
})
test('General directly funds Soldier or General without Scout classification; scoped tools reject foreign Project',async()=>{
 const s=new Store(':memory:');try{const p=create(s,'General'),other=create(s,'other'),l=new LegionStore(s,p.id);l.claimCommand()
 assert.equal(s.projectGraphs(p.id).length,1);assert.throws(()=>s.createGraph(p.id,{taskKey:'x',title:'x',origin:'o',goal:'g'}))
 const tools=legionTools(s.forProject(p.id),'commander',p.id,null,()=>{}),spawn=tools.find(t=>t.name==='legion_step')!
 for(const role of ['worker'])await spawn.execute('',{projectId:p.id,description:'direct',sourceIds:['origin']})
 assert.equal(s.graph(p.id).steps.length,1)
 await assert.rejects(()=>spawn.execute('',{projectId:other.id,taskKey:'x',role:'soldier',description:'cross',sourceIds:['origin']}))
 }finally{s.close()}
})

test('Benchmark classification, same-Graph squads and durable HELP/REPORT preserve existing role rules',()=>{
 const s=new Store(':memory:');try{const p=create(s,'Benchmark roles','benchmark'),l=new LegionStore(s,p.id),graphs=['easy','hard'].map(taskKey=>s.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
 assert.throws(()=>l.spawn(p.id,{role:'soldier',taskKey:'easy',description:'initial independent exploration',sourceIds:[graphs[0].originId]}),/Scout/)
 const facts=graphs.map((g,i)=>{const step=l.spawn(p.id,{role:'scout',taskKey:g.taskKey!,description:'observe',sourceIds:[g.originId]}),run=s.claim(p.id,'execute',worker,step.id),fact=s.addFact(p.id,'observed',{runId:run.id});s.finishRun(run.id,'succeeded');l.classify(p.id,g.taskKey!,i?'hard':'easy',[fact.id]);return fact})
 const soldier=l.spawn(p.id,{role:'soldier',taskKey:'easy',description:'solve easy',sourceIds:[facts[0].id]}),general=l.spawn(p.id,{role:'general',taskKey:'hard',description:'solve hard',sourceIds:[facts[1].id]}),a=s.claim(p.id,'execute',worker,soldier.id),b=s.forGraph(p.id,general.graphId!).claim(p.id,'plan',worker)
 const squads=['soldier','scout'].map(role=>l.spawn(p.id,{role:role as 'soldier'|'scout',taskKey:'hard',description:'specialist',sourceIds:[facts[1].id],parentRunId:b.id}))
 assert(squads.every(step=>step.graphId===general.graphId));assert.equal(l.spawn(p.id,{role:'soldier',taskKey:'hard',description:'third',sourceIds:[facts[1].id],parentRunId:b.id}).graphId,general.graphId)
 assert.throws(()=>l.spawn(p.id,{role:'soldier',taskKey:'easy',description:'cross',sourceIds:[facts[0].id],parentRunId:b.id}),/same-task/)
 assert.throws(()=>l.message(p.id,a.id,b.id,'MESSAGE','cross graph'),/another Graph/)
 const child=s.claim(p.id,'execute',worker,squads[0].id),message=l.message(p.id,child.id,b.id,'HELP','Need a verified angle');assert.equal(message.status,'pending');assert.equal(l.messages(p.id,b.id)[0].type,'HELP');l.delivery(p.id,b.id,message.id,'queued');l.delivery(p.id,b.id,message.id,'admitted');assert.equal(l.messages(p.id,b.id)[0].status,'admitted')
 const before=s.nodeCount(p.id,'fact');l.message(p.id,b.id,'commander','REPORT','unverified result');assert.equal(s.nodeCount(p.id,'fact'),before)
 }finally{s.close()}
})

test('three task Workers share Scheduler capacity concurrently and initial Hints stay graph-scoped',async()=>{
 const {Scheduler}=await import('../src/scheduler.ts'),{launchContext}=await import('../src/runner.ts'),s=new Store(':memory:')
 const p=create(s,'Concurrent tasks','benchmark'),l=new LegionStore(s,p.id),graphs=['A','B','C'].map(taskKey=>s.createGraph(p.id,{taskKey,title:taskKey,origin:'local',goal:'verify'}))
 for(const g of graphs){s.forGraph(p.id,g.id).addInput(p.id,'hint','private '+g.taskKey);scoutedSpawn(l,p.id,{role:'soldier',taskKey:g.taskKey!,description:'observe',sourceIds:[g.originId]})}
 const contexts:any[]=[],route:Worker={...worker,provider:'mock',model:'fixture',enabled:true,maxRunning:3,priority:0,roles:['soldier']};let release!:()=>void;const held=new Promise<void>(resolve=>release=resolve)
 const scheduler=new Scheduler(s,{workers:[route],providers:{},maxWorkers:3,maxProjectWorkers:3,maxRunningProjects:1,maxSteps:null,workspaceRoot:'/tmp/redtrace-graph-workspaces'} as any,async context=>{contexts.push(context);await held;context.store.addFact(p.id,'verified',{runId:context.run.id})})
 try{scheduler.start();for(let i=0;i<100&&contexts.length<3;i++)await new Promise<void>(r=>setImmediate(r));assert.equal(contexts.length,3);assert.equal(new Set(contexts.map(c=>c.run.workspaceRoot)).size,3)
 for(const c of contexts){const launch=launchContext(s,c.run.id);assert.equal(launch.graphId,c.run.graphId);assert.equal(launch.hints?.items.length,1);assert(launch.hints?.items[0].content.includes(graphs.find(g=>g.id===c.run.graphId)!.taskKey!))}
 }finally{release();await scheduler.close();s.close()}
})

test('Commander yields its single Project slot and observes other Projects in global capacity',async()=>{
 const s=new Store(':memory:');try{const p=create(s,'A'),q=create(s,'B'),l=new LegionStore(s,p.id);l.claimCommand();l.saveCampaign({...l.campaign(),workerName:'commander'})
 const route:Worker={name:'commander',roles:['commander'],provider:'mock',model:'fixture',enabled:true,maxRunning:2,priority:0,backend:'mock'}
 let tools=legionTools(s.forProject(p.id),'commander',p.id,null,()=>{},{workers:[route],maxWorkers:10,maxProjectWorkers:1} as any)
 const single=await tools.find(t=>t.name==='legion_wait')!.execute('',{projectId:p.id,after:0});assert.equal((single.details as {mustFinish:boolean}).mustFinish,true)
 const step=s.addStep(q.id,{description:'other Project',sourceIds:['origin']});s.claim(q.id,'execute',worker,step.id)
 tools=legionTools(s.forProject(p.id),'commander',p.id,null,()=>{},{workers:[route],maxWorkers:2,maxProjectWorkers:5} as any)
 const global=await tools.find(t=>t.name==='legion_wait')!.execute('',{projectId:p.id,after:0});assert.equal((global.details as {mustFinish:boolean}).mustFinish,true)
 }finally{s.close()}
})
