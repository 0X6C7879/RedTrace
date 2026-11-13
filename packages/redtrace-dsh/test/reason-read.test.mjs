import assert from'node:assert/strict'
import test from'node:test'
import{mkdtempSync,mkdirSync,writeFileSync,rmSync}from'node:fs'
import os from'node:os'
import path from'node:path'
import{execFile}from'node:child_process'
import{promisify}from'node:util'
import{Store}from'../../redtrace-engine/src/store.ts'
import{LegionStore}from'../../redtrace-engine/src/legion-store.ts'
import{ProjectEvidence}from'../../redtrace-engine/src/project-evidence.ts'
import{legionTools}from'../../redtrace-engine/src/legion-tools.ts'
test('Commander reads only hash-verified Project evidence, not arbitrary host/secret paths',async t=>{const root=mkdtempSync(path.join(os.tmpdir(),'legion-commander-read-')),store=new Store(':memory:');t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})});const p=store.createProject({title:'fixture',origin:'local',goal:'verify'}).project,q=store.createProject({title:'foreign',origin:'local',goal:'verify'}).project;mkdirSync(root+'/'+p.id);mkdirSync(root+'/'+q.id);const evidence=new ProjectEvidence(store,root),a=evidence.publish(p.id,Buffer.from('retained proof'),{description:'actual fixture'});new LegionStore(store,store.projects()[0].id).claimCommand();const tools=legionTools(store,'commander',store.projects()[0].id,null,()=>{},{workspaceRoot:root});for(const name of['read','write','edit','bash','pwsh','submit_fact'])assert.ok(!tools.some(t=>t.name===name));const read=tools.find(t=>t.name==='legion_evidence_read');assert.equal((await read.execute('local',{projectId:p.id,artifactId:a.id})).details.content,'retained proof');await assert.rejects(read.execute('foreign',{projectId:q.id,artifactId:a.id}),/not found|another Project/);writeFileSync(root+'/'+p.id+'/'+a.path,'tampered');await assert.rejects(read.execute('tamper',{projectId:p.id,artifactId:a.id}),/hash mismatch/)})
test('native Commander mounts no target filesystem tools and resumes a fresh compacted Session',{timeout:90000},async()=>{const r=await promisify(execFile)(process.execPath,[new URL('../../redtrace-engine/test/legion-commander-context.fixture.mjs',import.meta.url).pathname]);assert.match(r.stdout,/COMMANDER_NATIVE_RELAY=true/)})
