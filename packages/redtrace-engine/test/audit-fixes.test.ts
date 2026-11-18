import { Capabilities } from '../src/capabilities.ts'
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Configuration } from '../src/config.ts'
import { Operations } from '../src/operations.ts'
import { createPlanGuard } from '../src/plan-guard.ts'
import { livePlan } from '../src/runner.ts'
import { executionResult } from '../src/execution-result.ts'
import type { EngineConfig, Worker, Step } from '../src/types.ts'

const worker: Worker = {name:'audit-fixture',backend:'mock',provider:'mock',model:'',enabled:true,reason:true,explore:true,bootstrap:false,maxRunning:8,priority:0}
test('WAL NORMAL and incremental evidence preserve live execution contracts while explicit amendments still invalidate them', () => {
 const root=mkdtempSync(path.join(os.tmpdir(),'redtrace-merge-')),store=new Store(path.join(root,'engine.db'))
 try {
  assert.equal(store.db.prepare('PRAGMA synchronous').get()!.synchronous,1)
  const project=store.createProject({title:'merge',origin:'fixture',goal:'fixture',bootstrap:false}).project
  const a=store.addFact(project.id,'same',{creator:'human'}),b=store.addFact(project.id,'same',{creator:'human'})
  const step=store.addStep(project.id,{description:'fixture',sourceIds:[b.id]}),run=store.claim(project.id,'execute',worker,step.id),guard=createPlanGuard(store,run.id)
  const before=livePlan(store,run.id)
  assert.equal(livePlan(store,run.id),before)
  store.addFact(project.id,'Correction to '+a.id+'; independently observed proof')
  assert.equal(store.node<Step>(project.id,step.id).planVersion,1);assert.equal(guard.check({name:'bash',rootCallId:'same-turn'}),undefined)
  assert.ok(livePlan(store,run.id).includes(b.id));assert.equal(livePlan(store,run.id),before)
  const current=store.node(project.id,step.id)
  store.updateStep(project.id,step.id,{description:'new contract',expectedVersion:current.version,mode:'amend'})
  assert.match(guard.check({name:'bash',rootCallId:'old'})!,/Plan changed/)
 } finally {store.close();rmSync(root,{recursive:true,force:true})}
})
test('configuration snapshot skips repeated reads/decryption and notices immediate atomic commits', () => {
 const root=mkdtempSync(path.join(os.tmpdir(),'redtrace-config-cache-')),config=new Configuration(root)
 try {
  config.initialize();let reads=0,resolves=0
  const read=config.read.bind(config),resolve=config.resolve.bind(config)
  config.read=()=>{reads++;return read()};config.resolve=raw=>{resolves++;return resolve(raw)}
  const first=config.resolvedSnapshot()
  for(let i=0;i<30;i++)assert.equal(config.resolvedSnapshot(),first)
  assert.equal(reads,1);assert.equal(resolves,1)
  config.commit(first.revision,raw=>{raw.tasks!.commander.max_intents=7})
  assert.equal(config.resolvedSnapshot().config.maxSteps,7)
 } finally {rmSync(root,{recursive:true,force:true})}
})
test('Operations completion wakes waiting callers and cleans listeners on cancellation/timeout',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'redtrace-wait-')),store=new Store(':memory:'),ops=new Operations(store,root,()=>false)
 try {
  const project=store.createProject({title:'wait',origin:'fixture',goal:'fixture',bootstrap:false}).project
  ops.wake=()=>{}
  const resource=ops.create(project.id,{kind:'webshell',name:'fixture',target:'http://127.0.0.1',actor_type:'human',actor:'fixture'}).resource
  const task=ops.createTask(project.id,resource.id,{action:'command',arguments:{command:'fixture'},actor_type:'human',actor:'fixture'})
  const signal=new AbortController(),waiting=ops.waitTask(task.id,2000,signal.signal)
  ops.finish(task.id,executionResult('fixture-output',0))
  assert.equal((await waiting).status,'succeeded');assert.equal(store.changes.listenerCount(`operation:${task.id}`),0)
  const next=ops.createTask(project.id,resource.id,{action:'command',arguments:{command:'fixture'},actor_type:'human',actor:'fixture'})
  const cancelled=new AbortController(),pending=ops.waitTask(next.id,2000,cancelled.signal);cancelled.abort()
  await assert.rejects(pending,/cancelled/);assert.equal(store.changes.listenerCount(`operation:${next.id}`),0)
  assert.equal((await ops.waitTask(next.id,1,new AbortController().signal)).status,'queued')
 } finally {await ops.close();store.close();rmSync(root,{recursive:true,force:true})}
})
test('harness streams text and reasoning deltas without SQLite work',async()=>{
 const { eventProjection }=await import('../../redtrace-dsh/lib/audit.js')
 const source=readFileSync(new URL('../compat/cordis.mjs',import.meta.url),'utf8')
 const start=source.indexOf("    const unlisten = ctx.on('session/event'"),end=source.indexOf('    const cancel =',start)
 assert.ok(start>=0&&end>start)
 let listener:any;const emitted:any[]=[]
 const store={changes:{emit:(...args:any[])=>emitted.push(args)},transaction:()=>{throw new Error('delta reached SQLite')}}
 const ctx={on:(_name:string,callback:any)=>{listener=callback;return()=>{}}}
 const task:any={sessionId:'stream-fixture'},run={id:'stream-fixture',projectId:'fixture'}
 new Function('ctx','run','store','task','eventProjection',source.slice(start,end))(ctx,run,store,task,eventProjection)
 listener({id:run.id},{type:'assistant/chunk',seq:1,data:{chunk:{type:'text-delta',text:'flag{raw}'}}})
 listener({id:run.id},{type:'assistant/chunk',seq:2,data:{chunk:{type:'reasoning-delta',text:'raw token'}}})
 assert.deepEqual(emitted.map(row=>row[2].kind),['assistant.delta','thinking.delta'])
 assert.equal(emitted[0][2].content,'flag{raw}');assert.equal(emitted[1][2].content,'raw token')
})
test('Skill entrypoints keep native submissions, unattended continuation and headless defaults',()=>{
 const root=new URL('../../../skills/',import.meta.url)
 for(const name of ['targeted-pentest','recon-crawl','api-testing','exploit-file-upload','exploit-ssrf','exploit-smuggling','exploit-race','exploit-logic','exploit-sqli','exploit-xss','shell','tunnel','service-attack','privesc-linux','privesc-win','ad-attack']){
  const skill=readFileSync(new URL(`${name}/SKILL.md`,root),'utf8')
  assert.doesNotMatch(skill,/submit_sub_agent_output|record_finding|spawn_subagent|cookies_export|browser navigate|~\/\.claude\/skills\/(?:bin|shared)|等操作者选/)
  assert.match(skill,/fgs_publish.*action[:=]"?fact/);assert.match(skill,/finish_step/)
 }
 const benchmark=readFileSync(new Capabilities(path.resolve(import.meta.dirname,'../../../.redtrace'),path.resolve(import.meta.dirname,'../../..')).directory('tsecbench-api')+'/SKILL.md','utf8')
 assert.doesNotMatch(benchmark,/活跃实例最多|取提示使用 CLI/);assert.match(benchmark,/Commander 只读平台状态并调度/)
 const playwright=readFileSync(new URL('playwright-skill/SKILL.md',root),'utf8')
 assert.doesNotMatch(playwright,/headless: false|visible browser by default/)
})
