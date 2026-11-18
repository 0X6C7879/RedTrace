import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,rmSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
import {graphTools} from '../src/runner.ts'
import {legionTools} from '../src/legion-tools.ts'
import type {EngineConfig,Finding} from '../src/types.ts'
const worker={name:'fixture',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,priority:0,maxRunning:2}
function fixture(t:any,mode:'general'|'benchmark'='general'){
 const root=mkdtempSync(path.join(os.tmpdir(),'report-delivery-')),store=new Store(root+'/engine.db'),project=store.createProject({mode,title:'reports',origin:'local fixture',goal:'verify',bootstrap:false}).project
 const graph=mode==='benchmark'?store.createGraph(project.id,{taskKey:'T',title:'T',origin:'local',goal:'verify'}):store.projectGraphs(project.id)[0],scoped=store.forGraph(project.id,graph.id)
 mkdirSync(root+'/'+project.id,{recursive:true});t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 const step=scoped.addStep(project.id,{role:'soldier',taskKey:'T',description:'verify target',sourceIds:[graph.originId]}),run=scoped.claim(project.id,'execute',worker,step.id),fact=scoped.addFact(project.id,'verified fixture',{runId:run.id}),finding=scoped.addFinding(project.id,{title:'verified issue',description:'fixture',severity:'low',type:'fixture',factIds:[fact.id],runId:run.id})
 const config={workspaceRoot:root,maxSteps:null} as EngineConfig
 return{root,store,scoped,project,graph,step,run,finding,config}
}
for(const mode of ['benchmark','general'] as const)test(mode+' Finding creates no automatic report Step or Session',t=>{
 const f=fixture(t,mode);assert.equal(f.scoped.nodeCount(f.project.id,'step'),1);assert.equal(f.store.runs(f.project.id).length,1)
 assert.equal(f.finding.report,undefined)
 assert.throws(()=>f.scoped.addStep(f.project.id,{role:'reporter',taskKey:'T',description:'retired fixed role',sourceIds:[f.finding.id]}),/Invalid.*role/)
 const names=graphTools({store:f.scoped,run:f.run,worker,config:f.config,signal:new AbortController().signal},()=>{}).map(t=>t.name)
 assert.equal(names.includes('update_finding_report'),mode==='general')
})
test('General Planner requests report in active producer Session; saving does not end other work',async t=>{
 const f=fixture(t);let finished=false;new LegionStore(f.store,f.project.id).claimCommand()
 const planner=legionTools(f.store,'commander',f.project.id,null,()=>{},f.config).find(t=>t.name==='legion_report')!
 const assigned=(await planner.execute('report',{projectId:f.project.id,findingId:f.finding.id})).details as any
 assert.equal(assigned.id,f.step.id);assert.equal(f.store.runs(f.project.id).length,1)
 const tools=graphTools({store:f.scoped,run:f.run,worker,config:f.config,signal:new AbortController().signal},()=>{finished=true})
 const saved=await tools.find(t=>t.name==='update_finding_report')!.execute('save',{finding_id:f.finding.id,expectedVersion:f.finding.version??1,report:'## 摘要\nfixture\n## 内容\nretained proof'})
 assert(!saved.terminate);assert(!finished);assert.equal(f.store.run(f.run.id).status,'running')
 assert.equal(f.store.node<Finding>(f.project.id,f.finding.id).report!.runId,f.run.id)
})
test('finished producer with checkpoint reuses its Run and requires a newly saved report',async t=>{
 const f=fixture(t);const current=f.store.run(f.run.id);current.checkpoint={sessionId:current.id};f.store.saveRun(current);f.store.finishRun(current.id,'succeeded')
 const report=f.scoped.requestFindingReport(f.project.id,f.finding.id);assert.equal(report.id,f.step.id);assert.equal(report.role,'soldier');assert.equal(report.status,'paused')
 const resumed=f.scoped.claim(f.project.id,'execute',worker,report.id);assert.equal(resumed.id,f.run.id);assert.equal(f.store.runs(f.project.id).length,1)
 assert.equal(f.store.finishRun(resumed.id,'succeeded').status,'failed','old execution proof is not a new report')
})
test('unavailable producer context creates one explicit report-only Soldier Step',t=>{
 const f=fixture(t);f.store.finishRun(f.run.id,'succeeded')
 const report=f.scoped.requestFindingReport(f.project.id,f.finding.id);assert.notEqual(report.id,f.step.id);assert.equal(report.role,'soldier');assert.equal(report.reportFindingId,f.finding.id)
 assert.equal(f.scoped.requestFindingReport(f.project.id,f.finding.id).id,report.id);assert.equal(f.scoped.nodeCount(f.project.id,'step'),2)
})

test('explicit independent consolidation uses an ordinary Soldier without disturbing its producer',t=>{
 const f=fixture(t),report=f.scoped.requestFindingReport(f.project.id,f.finding.id,true)
 assert.notEqual(report.id,f.step.id);assert.equal(report.role,'soldier');assert.equal(report.reportFindingId,f.finding.id)
 assert.equal(f.store.run(f.run.id).status,'running');assert.equal(f.scoped.nodeCount(f.project.id,'step'),2)
})
test('legacy unstarted automatic Benchmark Reporter is cancelled without deleting Finding or reports',t=>{
 const f=fixture(t,'benchmark'),report=f.scoped.requestFindingReport(f.project.id,f.finding.id)
 f.store.db.prepare("UPDATE nodes SET data=json_set(data,'$.role','reporter') WHERE project_id=? AND id=?").run(f.project.id,report.id)
 const db=f.root+'/engine.db';const reopened=new Store(db)
 try{const old=reopened.node<any>(f.project.id,report.id);assert.equal(old.role,'soldier');assert.equal(old.status,'cancelled');assert.equal(old.reportFindingId,f.finding.id);assert.equal(reopened.node<Finding>(f.project.id,f.finding.id).title,f.finding.title)}finally{reopened.close()}
})
