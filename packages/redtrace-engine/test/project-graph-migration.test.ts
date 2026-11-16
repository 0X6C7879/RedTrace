import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {execFileSync} from 'node:child_process'
import {pathToFileURL} from 'node:url'
import {DatabaseSync} from 'node:sqlite'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'
// Pin the pre-Graph schema fixture: HEAD now already contains project_graphs.
const repo=path.resolve(import.meta.dirname,'../../..')
for(const count of [1,2])test('schema-2 migration preserves IDs, references, Runs/audit and '+count+' Project Campaign history',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'redtrace-graph-migration-'))
 try{
 for(const file of ['store.ts','types.ts'])writeFileSync(path.join(dir,file),execFileSync('git',['show','4ea86474:packages/redtrace-engine/src/'+file],{cwd:repo}))
 const{Store:LegacyStore}=await import(pathToFileURL(path.join(dir,'store.ts')).href),old=new LegacyStore(path.join(dir,'engine.db'))
 const projects=[];for(let i=0;i<count;i++){const p=old.createProject({title:'legacy '+i,origin:'scope',goal:'verify'}).project,step=old.addStep(p.id,{description:'legacy',sourceIds:['origin']}),run=old.claim(p.id,'execute',{name:'fixture',backend:'mock'},step.id),fact=old.addFact(p.id,'proof',{runId:run.id,evidence:[{description:'original proof'}]});old.addFinding(p.id,{title:'deliverable',description:'proof',factIds:[fact.id],runId:run.id});old.finishRun(run.id,'succeeded');projects.push(p.id)}
 old.db.exec('CREATE TABLE campaign(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL)');const campaign={sessionId:'legacy-session',status:'idle',state:'legacy original STATE',cursors:Object.fromEntries(projects.map(id=>[id,{delivered:1,acknowledged:1}]))};old.db.prepare('INSERT INTO campaign VALUES (1,?)').run(JSON.stringify(campaign))
 const ids=old.db.prepare('SELECT project_id,id,kind FROM nodes ORDER BY project_id,id').all(),events=old.db.prepare('SELECT id,project_id FROM events ORDER BY id').all(),runs=old.runs(),audits=old.db.prepare('SELECT id,project_id FROM audit_runs ORDER BY id').all();old.close()
 const upgraded=new Store(path.join(dir,'engine.db'));try{
 const l=new LegionStore(upgraded);assert.deepEqual(upgraded.db.prepare('SELECT project_id,id,kind FROM nodes ORDER BY project_id,id').all(),ids);assert.deepEqual(upgraded.db.prepare("SELECT id,project_id FROM events WHERE type<>'legion.role_migrated' ORDER BY id").all(),events);assert.deepEqual(upgraded.db.prepare('SELECT id,project_id FROM audit_runs ORDER BY id').all(),audits)
 assert.equal(upgraded.runs().length,runs.length);for(const p of upgraded.projects()){assert.equal(p.mode,'general');const graph=upgraded.projectGraphs(p.id)[0];assert.equal(graph.type,'main');assert(upgraded.graph(p.id).facts.every(f=>f.graphId===graph.id));assert(upgraded.runs(p.id).every(r=>r.graphId===graph.id))}
 assert.equal(new Set(l.campaigns().map(c=>c.sessionId)).size,count);if(count===1){assert.equal(l.campaign(projects[0]).sessionId,'legacy-session');assert.equal(l.campaign(projects[0]).state,campaign.state)}else{assert(l.campaigns().every(c=>c.state===''&&c.sessionId!=='legacy-session'))}
 assert.deepEqual(JSON.parse(String(upgraded.db.prepare('SELECT data FROM campaign_archive').get()!.data)),campaign);assert.equal(upgraded.db.prepare('PRAGMA foreign_key_check').all().length,0)
 }finally{upgraded.close()}
 const reopened=new Store(path.join(dir,'engine.db'));assert.equal(reopened.projectGraphs(projects[0]).length,1);reopened.close()
 }finally{rmSync(dir,{recursive:true,force:true})}
})
test('migration failure rolls back graph registry, columns and Campaign rename atomically',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'redtrace-graph-rollback-'));try{
 for(const file of ['store.ts','types.ts'])writeFileSync(path.join(dir,file),execFileSync('git',['show','4ea86474:packages/redtrace-engine/src/'+file],{cwd:repo}))
 const{Store:LegacyStore}=await import(pathToFileURL(path.join(dir,'store.ts')).href),old=new LegacyStore(path.join(dir,'engine.db'));old.createProject({title:'legacy',origin:'scope',goal:'verify'});old.db.exec("CREATE TRIGGER migration_failure BEFORE UPDATE ON nodes BEGIN SELECT RAISE(ABORT,'fixture migration failure'); END");old.close()
 assert.throws(()=>new Store(path.join(dir,'engine.db')),/fixture migration failure/)
 const db=new DatabaseSync(path.join(dir,'engine.db'));try{assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name='project_graphs'").get(),undefined);assert(!db.prepare('PRAGMA table_info(nodes)').all().some(c=>c.name==='graph_id'));assert.equal(db.prepare('SELECT COUNT(*) AS n FROM nodes').get()!.n,2)}finally{db.close()}
 }finally{rmSync(dir,{recursive:true,force:true})}
})
