import {mkdtempSync,mkdirSync,readdirSync,existsSync,symlinkSync,rmSync,readFileSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import {pathToFileURL} from 'node:url'
import assert from 'node:assert/strict'
const repo="/Users/lxy/Downloads/RedTrace",work=mkdtempSync(path.join(os.tmpdir(),'redtrace-ui-probe-'))
let engine
try{
 execFileSync('tar',['-xzf',path.resolve(process.argv[2]),'-C',work])
 const src=work+'/packages/redtrace-engine/src';mkdirSync(src,{recursive:true})
 for(const file of readdirSync(repo+'/packages/redtrace-engine/src'))if(!existsSync(src+'/'+file))symlinkSync(repo+'/packages/redtrace-engine/src/'+file,src+'/'+file)
 symlinkSync(repo+'/packages/redtrace-engine/node_modules',work+'/packages/redtrace-engine/node_modules','dir')
 const {serveEngine}=await import(pathToFileURL(src+'/index.ts')),{legionTools}=await import(pathToFileURL(src+'/legion-tools.ts'))
 engine=await serveEngine({root:work,port:0,autoStart:false})
 const p=engine.store.createProject({mode:'general',title:'UI fixture',origin:'local',goal:'verify'}).project,g=engine.store.projectGraphs(p.id)[0]
 const before=JSON.stringify(engine.store.graph(p.id));engine.legion.claimCommand(p.id)
 const memory=engine.legion.planningTodos?.(p.id),write=legionTools(engine.store,'commander',p.id,null,()=>{},undefined,memory).find(t=>t.name==='TodoWrite')
 if(write)await write.execute('same-input',{projectId:p.id,graphId:g.id,todos:[{content:'entry',status:'completed'},{content:'credentials',status:'in_progress'}]})
 const url='http://127.0.0.1:'+engine.server.address().port+'/v2/projects/'+p.id+'/graph'
 const response=await fetch(url),snapshot=await response.json();assert.equal(response.status,200)
 const panel=existsSync(work+'/static/index.html')&&readFileSync(work+'/static/index.html','utf8').includes('aria-label="当前任务阶段计划"')
 if(snapshot.planningTodos)assert.deepEqual(snapshot.planningTodos.map(t=>t.status),['completed','in_progress'])
 assert.equal(JSON.stringify(engine.store.graph(p.id)),before)
 console.log('TodoWrite='+!!write+'; project_detail_TodoList='+!!(panel&&snapshot.planningTodos)+'; rows='+(snapshot.planningTodos?.length??0)+'; FGS_unchanged=true')
}finally{await engine?.close();rmSync(work,{recursive:true,force:true})}
