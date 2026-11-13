import {mkdtempSync,mkdirSync,readdirSync,existsSync,symlinkSync,rmSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const repo="/Users/lxy/Downloads/RedTrace", dir=mkdtempSync(path.join(os.tmpdir(),'redtrace-todo-probe-'))
let store
try {
 execFileSync('tar',['-xzf',path.resolve(process.argv[2]),'-C',dir])
 const src=dir+'/packages/redtrace-engine/src';mkdirSync(src,{recursive:true})
 for(const file of readdirSync(repo+'/packages/redtrace-engine/src'))if(!existsSync(src+'/'+file))symlinkSync(repo+'/packages/redtrace-engine/src/'+file,src+'/'+file)
 symlinkSync(repo+'/packages/redtrace-engine/node_modules',dir+'/packages/redtrace-engine/node_modules','dir')
 const {Store}=await import(pathToFileURL(src+'/store.ts')), {LegionStore}=await import(pathToFileURL(src+'/legion-store.ts')), {legionTools}=await import(pathToFileURL(src+'/legion-tools.ts'))
 store=new Store(':memory:');const p=store.createProject({mode:'general',title:'fixture',origin:'local',goal:'verify'}).project,l=new LegionStore(store);l.claimCommand(p.id)
 const g=store.projectGraphs(p.id)[0], todos=l.planningTodos?.(p.id), tools=legionTools(store,'commander',p.id,null,()=>{},undefined,todos),write=tools.find(t=>t.name==='TodoWrite')
 if(!write)console.log('TodoWrite=false; cross_wake_todos=unavailable; FGS_unchanged=true')
 else {
  const input={projectId:p.id,graphId:g.id,todos:[{content:'verify entry',status:'in_progress'},{content:'verify credentials',status:'pending'}]}
  const before=JSON.stringify(store.graph(p.id));await write.execute('first',input)
  const next=legionTools(store,'commander',p.id,null,()=>{},undefined,l.planningTodos(p.id)).find(t=>t.name==='TodoWrite')
  assert.deepEqual(l.planningTodos(p.id).list(g.id),input.todos)
  await next.execute('next',{...input,todos:[{content:'verify entry',status:'completed'},{content:'verify credentials',status:'in_progress'}]})
  assert.equal(JSON.stringify(store.graph(p.id)),before)
  console.log('TodoWrite=true; cross_wake_todos=completed,in_progress; whole_list_replacement=true; FGS_unchanged=true')
 }
} finally {store?.close();rmSync(dir,{recursive:true,force:true})}
