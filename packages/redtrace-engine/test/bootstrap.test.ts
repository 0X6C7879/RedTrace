import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Configuration } from '../src/config.ts'

test('initial Mission is a Soldier Step, not an independent Bootstrap agent', () => {
  const store=new Store(':memory:')
  try {const graph=store.createProject({title:'fixture',origin:'authorized fixture',goal:'verified evidence',bootstrap:true});assert.equal(graph.steps.length,1);assert.equal(graph.steps[0].role,'soldier');assert.equal(graph.steps[0].taskKey,'initial');assert.equal(graph.steps[0].bootstrap,true);assert.throws(()=>store.claim(graph.project.id,'decide',{name:'retired',backend:'mock'}),/replaced by Commander/)}finally{store.close()}
})
test('all new ordinary Steps carry a Soldier role and task identity',()=>{
  const store=new Store(':memory:');try{const p=store.createProject({title:'fixture',origin:'fixture',goal:'fixture'}).project;const s=store.addStep(p.id,{description:'work',sourceIds:['origin']});assert.equal(s.role,'soldier');assert.equal(s.taskKey,'goal')}finally{store.close()}
})
test('a Soldier initial Mission cannot succeed without confirmed evidence',()=>{
  const store=new Store(':memory:');try{const g=store.createProject({title:'fixture',origin:'fixture',goal:'fixture',bootstrap:true});const r=store.claim(g.project.id,'execute',{name:'soldier',backend:'mock'},g.steps[0].id);store.finishRun(r.id,'succeeded');assert.equal(store.run(r.id).status,'failed');assert.match(store.run(r.id).error!,/Soldier Mission/)}finally{store.close()}
})
test('configuration exposes only four-role capabilities and task types',()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'legion-config-'));try{const c=new Configuration(root);c.initialize();c.commit(c.read().revision,raw=>{raw.workers=[{name:'fixture',provider:'mock',roles:['commander','soldier']}]});const snapshot=c.snapshot();assert.deepEqual(snapshot.workers[0].task_types,['commander','soldier']);assert.ok(!('reason'in snapshot.workers[0]));assert.ok(!('explore'in snapshot.workers[0]));assert.ok(!('bootstrap'in snapshot.workers[0]));assert.deepEqual(Object.keys(snapshot.tasks).sort(),['commander','general','scout','soldier'])}finally{rmSync(root,{recursive:true,force:true})}
})
