import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {serveEngine} from '../src/index.ts'
import {ProjectEvidence} from '../src/project-evidence.ts'
test('real API creates modes, three Graphs, scoped FGS, Commander hints and graph-filtered audit',async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'redtrace-graphs-api-')),e=await serveEngine({root,port:0,autoStart:false}),base='http://127.0.0.1:'+((e.server.address() as any).port)
 const call=async(route:string,method='GET',body?:unknown)=>{const r=await fetch(base+route,{method,headers:{'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,data:await r.json() as any}}
 try{
 assert.equal((await call('/v2/projects','POST',{title:'missing mode',origin:'scope',goal:'verify'})).status,422)
 const p=(await call('/v2/projects','POST',{mode:'benchmark',title:'Three tasks',origin:'authorized local fixture',goal:'verify',hints:[{content:'route this after discovery',creator:'human'}]})).data.project
 const general=(await call('/v2/projects','POST',{mode:'general',title:'General',origin:'local',goal:'verify'})).data.project
 const graphs=[];for(const taskKey of ['one','two','three']){const result=await call('/v2/projects/'+p.id+'/graphs','POST',{taskKey,title:taskKey,origin:'local '+taskKey,goal:'verify '+taskKey});assert.equal(result.status,201);graphs.push(result.data)}
 assert.equal((await call('/v2/projects/'+p.id+'/graphs')).data.length,3);assert.equal((await call('/v2/projects/'+general.id+'/graphs')).data.length,1)
 assert.equal((await call('/v2/projects/'+p.id+'/graph')).status,422)
 assert.equal((await call('/v2/projects/'+general.id+'/graph?graphId='+graphs[0].id)).status,404)
 const a='/v2/projects/'+p.id+'/graph?graphId='+graphs[0].id,b='/v2/projects/'+p.id+'/graph?graphId='+graphs[1].id
 assert.equal((await call(a)).data.goals[0].id,graphs[0].goalId)
 const hint=await call('/v2/projects/'+p.id+'/hints?graphId='+graphs[0].id,'POST',{content:'A-only instruction',creator:'human'});assert.equal(hint.status,201);assert.equal(hint.data.message.receiver,'commander');assert.equal(hint.data.message.status,'pending');assert.equal((await call(a)).data.hints.length,1);assert.equal((await call(b)).data.hints.length,0)
 assert.equal((await call('/v2/projects/'+general.id+'/commander')).data.projects.length,1);assert.equal((await call('/v2/projects/'+general.id+'/commander')).data.messages.length,0)
 const scoped=e.store.forGraph(p.id,graphs[0].id),step=scoped.addStep(p.id,{description:'local proof',sourceIds:['origin']}),run=scoped.claim(p.id,'execute',{name:'fixture',backend:'mock'},step.id);scoped.addFact(p.id,'verified',{runId:run.id});scoped.finishRun(run.id,'succeeded')
 assert.equal((await call('/audit/tasks/'+p.id+'/runs?graphId='+graphs[0].id)).data.length,1);assert.equal((await call('/audit/tasks/'+p.id+'/runs?graphId='+graphs[1].id)).data.length,0)
 mkdirSync(path.join(root,'workspaces',p.id),{recursive:true});const artifact=new ProjectEvidence(scoped,path.join(root,'workspaces')).publish(p.id,Buffer.from('A proof'),{description:'fixture'})
 assert.equal((await call('/v2/projects/'+p.id+'/evidence/'+artifact.id+'?graphId='+graphs[0].id)).status,200);assert.equal((await call('/v2/projects/'+p.id+'/evidence/'+artifact.id+'?graphId='+graphs[1].id)).status,404)
 assert.equal(e.store.db.prepare('PRAGMA foreign_key_check').all().length,0)
 }finally{await e.close();rmSync(root,{recursive:true,force:true})}
})
