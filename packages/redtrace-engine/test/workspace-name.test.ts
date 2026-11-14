import assert from 'node:assert/strict'
import {test} from 'node:test'
import path from 'node:path'
import {Store} from '../src/store.ts'
import {Scheduler} from '../src/scheduler.ts'
import type {EngineConfig, Worker} from '../src/types.ts'

test('Workers group by question title, keep run isolation and retain resumed paths', async()=>{
  const store=new Store(':memory:')
  const project=store.createProject({mode:'benchmark',title:'Benchmark task',origin:'local',goal:'verify'}).project
  const route:Worker={name:'fixture',backend:'mock',provider:'mock',model:'fixture',enabled:true,maxRunning:3,priority:0,roles:['scout']}
  const cases=[['中文题目 · SQL injection','中文题目 · SQL injection'],['题目 / 路径\\测试?','题目 _ 路径_测试_'],['旧题目','existing-graph-id']]
  const expected=new Map<string,string>()
  let resumedId:string|undefined
  for(const [i,[title,directory]]of cases.entries()){
    const graph=store.createGraph(project.id,{taskKey:String(i),title,origin:'local',goal:'verify'})
    const step=store.forGraph(project.id,graph.id).addStep(project.id,{role:'scout',taskKey:String(i),description:'verify cwd',sourceIds:[graph.originId]})
    expected.set(graph.id,directory)
    if(i===2){
      const run=store.claim(project.id,'execute',route,step.id)
      run.workspaceRoot=path.join('/tmp/redtrace-title-fixture',project.id,'agents',directory,run.id)
      store.saveRun(run);store.finishRun(run.id,'paused');resumedId=run.id
    }
  }
  const contexts:any[]=[]
  let release!:()=>void
  const held=new Promise<void>(resolve=>release=resolve)
  const scheduler=new Scheduler(store,{workers:[route],providers:{},maxWorkers:3,maxProjectWorkers:3,maxRunningProjects:1,maxSteps:null,workspaceRoot:'/tmp/redtrace-title-fixture'} as EngineConfig,async context=>{
    contexts.push(context);await held;context.store.addFact(project.id,'verified',{runId:context.run.id})
  })
  try{
    scheduler.start()
    for(let i=0;i<100&&contexts.length<3;i++)await new Promise<void>(resolve=>setImmediate(resolve))
    assert.equal(contexts.length,3)
    for(const {run}of contexts)assert.equal(run.workspaceRoot,path.join('/tmp/redtrace-title-fixture',project.id,'agents',expected.get(run.graphId)!,run.id))
    assert(contexts.some(({run})=>run.id===resumedId))
    assert.equal(new Set(contexts.map(({run})=>run.workspaceRoot)).size,3)
  }finally{release();await scheduler.close();store.close()}
})
