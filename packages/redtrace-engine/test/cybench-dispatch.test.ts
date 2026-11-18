import assert from 'node:assert/strict'
import test from 'node:test'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { taskTodoOwner } from '../src/legion-todos.ts'
import { graphTools, launchContext } from '../src/runner.ts'
import type { EngineConfig, Step } from '../src/types.ts'
for(const count of [1,null,3]) test('Benchmark flag_count='+count+' routes without Scout classification',()=>{
 const store=new Store(':memory:');try{
 const p=store.createProject({mode:'benchmark',title:'CyBench',origin:'local fixture',goal:'verify'}).project,l=new LegionStore(store,p.id),g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}),scoped=store.forGraph(p.id,g.id)
 if(count!==null)store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?)').run(p.id,'T',JSON.stringify({platformMetadata:{flag_count:count}}))
 const owner=l.spawn(p.id,{role:count===3?'soldier':'general',taskKey:'T',description:'solve',sourceIds:[g.originId]})
 assert.equal(owner.role,count===3?'general':'soldier');assert(taskTodoOwner(owner as import('../src/types.ts').TaskAssignment,store))
 const worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,maxRunning:4,priority:0},run=owner.role==='general'?scoped.claim(p.id,'plan',worker):store.claim(p.id,'execute',worker,owner.id),ctx={store:scoped,run,worker,config:{workspaceRoot:'/tmp/roles-fixture',maxSteps:1} as EngineConfig,signal:new AbortController().signal},tools=graphTools(ctx,()=>{})
 assert(tools.some(t=>t.name==='TodoWrite'));assert(tools.some(t=>t.name==='legion_experience_search'));assert.equal(tools.some(t=>t.name==='submit_fact'),count!==3)
 if(count===3){const child=l.spawn(p.id,{role:'soldier',taskKey:'T',description:'execute assigned Step',sourceIds:[g.originId],parentRunId:run.id});assert.equal(child.role,'soldier');assert.equal(child.plannerId,owner.id);assert(!taskTodoOwner(child,store))}
 assert.equal(store.nodes<Step>(p.id,['step']).some(s=>s.role==='scout'),false)
 assert(launchContext(store,run.id).planningTodos?.length)
 }finally{store.close()}
})
