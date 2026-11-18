import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Configuration } from '../src/config.ts'

test('General waits for Planner to create its first Step, even with a legacy bootstrap flag', () => {
  const store=new Store(':memory:')
  try {const graph=store.createProject({title:'fixture',origin:'authorized fixture',goal:'verified evidence',bootstrap:true});assert.equal(graph.steps.length,0,'General first Step is created by Planner');assert.throws(()=>store.claim(graph.project.id,'decide',{name:'retired',backend:'mock'}),/replaced by Commander/)}finally{store.close()}
})
test('General ordinary Steps carry Soldier identity',()=>{
  const store=new Store(':memory:');try{const p=store.createProject({title:'fixture',origin:'fixture',goal:'fixture'}).project;const s=store.addStep(p.id,{description:'work',sourceIds:['origin']});assert.equal(s.role,'soldier');assert.equal(s.taskKey,'goal')}finally{store.close()}
})
test('a General Soldier Step cannot succeed without confirmed evidence',()=>{
  const store=new Store(':memory:');try{const g=store.createProject({title:'fixture',origin:'fixture',goal:'fixture',bootstrap:true});const step=store.addStep(g.project.id,{description:'Planner assigned',sourceIds:['origin'],creator:'general'});const r=store.claim(g.project.id,'execute',{name:'soldier',backend:'mock'},step.id);store.finishRun(r.id,'succeeded');assert.equal(store.run(r.id).status,'failed');assert.match(store.run(r.id).error!,/Worker must return/)}finally{store.close()}
})
test('configuration exposes the three Benchmark and two General role types',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'legion-config-'));try{const c=new Configuration(root);c.initialize();c.commit(c.read().revision,raw=>{raw.workers=[{name:'fixture',provider:'mock',roles:['commander','soldier']}]});const snapshot=c.snapshot();assert.deepEqual(snapshot.workers[0].task_types,['commander','soldier']);assert.ok(!('reason'in snapshot.workers[0]));assert.ok(!('explore'in snapshot.workers[0]));assert.ok(!('bootstrap'in snapshot.workers[0]));assert.deepEqual(Object.keys(snapshot.tasks).sort(),['commander','general','soldier'])}finally{rmSync(root,{recursive:true,force:true})}
})
