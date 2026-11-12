import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
const root=process.argv[2];
if(!existsSync(root+'/packages/redtrace-engine/src/legion-store.ts')){console.log('LEGION_SUPPORTED=false');process.exit(0);}
const {Store}=await import(pathToFileURL(root+'/packages/redtrace-engine/src/store.ts'));
const {LegionStore}=await import(pathToFileURL(root+'/packages/redtrace-engine/src/legion-store.ts'));
const store=new Store(':memory:');
const legion=new LegionStore(store);
const p=store.createProject({title:'fixture',origin:'authorized local fixture',goal:'verified result'}).project;
const step=legion.spawn(p.id,{role:'general',taskKey:'fixture-a',description:'fixture mission',sourceIds:['origin']});
assert.equal(step.role,'general');
legion.park(p.id,'fixture-a','fixture blocked','new evidence');
assert.equal(store.node(p.id,step.id).status,'parked');
legion.reactivate(p.id,'fixture-a','fixture evidence arrived');
assert.equal(store.node(p.id,step.id).status,'pending');
console.log('LEGION_SUPPORTED=true; role=general; park=parked; reactivate=pending');
store.close();
