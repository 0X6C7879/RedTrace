import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { serveEngine } from '../src/index.ts'
import vm from 'node:vm'
import { callArguments } from '../src/console-api.ts'

test('native audit argument parsing preserves malformed attempts instead of inventing parameters',()=>{assert.deepEqual(callArguments('{broken'),{raw:'{broken'});assert.deepEqual(callArguments('{"name":"sample"}'),{name:'sample'})})

const source = path.resolve(import.meta.dirname, '../../..')
test('console reads General and Benchmark Findings from the original graph and preserves evidence', async () => {
  const root=mkdtempSync(path.join(os.tmpdir(),'console-api-'))
  const engine=await serveEngine({root,autoStart:false,port:0})
  const url='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
  const get=async(p:string)=>{const r=await fetch(url+p);return {status:r.status,data:await r.json() as any}}
  try {
    const p=engine.store.createProject({title:'General',origin:'local fixture',goal:'verify'}).project
    const b=engine.store.createProject({mode:'benchmark',title:'Benchmark',origin:'local fixture',goal:'verify'}).project
    const graph=engine.store.createGraph(b.id,{taskKey:'alpha',title:'Alpha',origin:'local fixture',goal:'verify'})
    for(const [project,store] of [[p,engine.store.forProject(p.id)],[b,engine.store.forGraph(b.id,graph.id)]] as const){
      const fact=store.addFact(project.id,'Literal fixture proof',{title:'Proof',evidence:[{description:'local stdout',runId:'producer',toolCallId:'proof-call'}]})
      store.addFinding(project.id,{title:'Verified fixture',description:'Summary',severity:'high',type:'fixture',factIds:[fact.id],assetIds:['fixture.test'],details:{content:'actual method'}})
    }
    const list=(await get('/console/findings')).data
    assert.equal(list.length,2);assert.equal(list.filter((f:any)=>f.severity==='high').length,2)
    assert.equal(list.find((f:any)=>f.projectId===b.id).graphTitle,'Alpha')
    assert.equal(list[0].details,undefined)
    const f=list.find((f:any)=>f.projectId===b.id),detail=(await get('/console/findings/'+b.id+'/'+f.id)).data
    assert.equal(detail.details.content,'actual method');assert.equal(detail.facts[0].evidence[0].toolCallId,'proof-call')
    assert.equal((await get('/console/findings/'+p.id+'/missing')).status,404)
  } finally {await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('tool counts deduplicate completions and retain real native skill/PTC calls; CLI availability is observed', async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'console-tools-'))
  mkdirSync(root+'/tools');writeFileSync(root+'/tools/tool_list.md','- '+String.fromCharCode(96)+'node'+String.fromCharCode(96)+'\n- '+String.fromCharCode(96)+'redtrace-nonexistent-cli'+String.fromCharCode(96)+'\n')
  const engine=await serveEngine({root,autoStart:false,port:0,runtimeCatalog:()=>({tools:[{name:'skill',source:'DSH',scope:'real-scope',status:'registered'},{name:'mcp__echo__echo',source:'MCP',scope:'global',status:'registered'}],mcp:[{name:'echo',state:'connected',toolCount:1}]})})
  try{
    const p=engine.store.createProject({title:'audit fixture',origin:'local',goal:'verify'}).project
    const metadata={id:'audit-run',project_id:p.id,task_type:'soldier',status:'completed'}
    engine.store.audit(metadata,[{kind:'tool.started',title:'skill',call_id:'one',arguments:JSON.stringify({name:'sample'}),timestamp:'2026-11-15T00:00:00Z'},{kind:'tool.completed',title:'skill',call_id:'one',arguments:{name:'sample'},timestamp:'2026-11-15T00:00:01Z',error:false},{kind:'tool.started',title:'bash',call_id:'two',arguments:JSON.stringify({command:'node --version'}),timestamp:'2026-11-15T00:00:02Z'},{kind:'tool.completed',title:'bash',call_id:'two',error:true,timestamp:'2026-11-15T00:00:03Z'},{kind:'tool.started',title:'mcp__echo__echo',call_id:'sub',root_call_id:'root',timestamp:'2026-11-15T00:00:04Z'}])
    const data=await(await fetch('http://127.0.0.1:'+(engine.server.address() as {port:number}).port+'/console/tools')).json() as any
    assert.ok(data.tools.some((t:any)=>t.name==='bash'&&t.source==='历史调用'&&t.manageable),'CLI rows must not hide native Shell controls');assert.equal(data.stats.calls,3);assert.equal(data.stats.failures,1)
    assert.equal(data.tools.find((t:any)=>t.name==='skill').calls,1)
    assert.equal(data.tools.find((t:any)=>t.name==='node').calls,1)
    assert.equal(data.tools.find((t:any)=>t.name==='redtrace-nonexistent-cli').status,'unavailable')
    assert.equal(data.calls.find((c:any)=>c.name==='skill').arguments.name,'sample')
    assert.equal(data.mcp[0].state,'connected')
  }finally{await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('workspace preview/download share the real directory boundary and preserve binary bytes',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'console-files-')),engine=await serveEngine({root,autoStart:false,port:0})
  try{
    const p=engine.store.createProject({title:'files',origin:'local',goal:'verify'}).project
    const dir=path.join(engine.configuration.workspaceRoot,p.id,'proof');mkdirSync(dir,{recursive:true})
    const bytes=Buffer.from([0,1,2,255]);writeFileSync(dir+'/binary.dat',bytes);writeFileSync(dir+'/notes.txt','literal proof\n');writeFileSync(root+'/outside.txt','private fixture');symlinkSync(root+'/outside.txt',dir+'/escape.txt')
    const graph=engine.store.projectGraphs(p.id)[0]
    mkdirSync(path.join(engine.configuration.workspaceRoot,p.id,'agents',graph.id),{recursive:true})
    const api='http://127.0.0.1:'+(engine.server.address() as {port:number}).port+'/audit/tasks/'+p.id+'/workspace'
    const listing=await(await fetch(api+'?path=agents')).json() as any
    const legacy=listing.entries.find((entry:any)=>entry.name===graph.id)
    assert.equal(legacy.display_name,graph.title);assert.equal(legacy.path,'agents/'+graph.id)
    const preview=await(await fetch(api+'/file?path=proof/notes.txt')).json() as any;assert.equal(preview.content,'literal proof\n')
    const response=await fetch(api+'/download?path=proof/binary.dat');assert.match(response.headers.get('content-disposition')!,/attachment/);assert.deepEqual(Buffer.from(await response.arrayBuffer()),bytes)
    assert.equal((await fetch(api+'/download?path=../outside.txt')).status,400)
    assert.equal((await fetch(api+'/download?path=proof/escape.txt')).status,400)
    assert.equal((await fetch(api+'/download?path=proof')).status,404)
  }finally{await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('Skills files are read from the same catalog DSH mounts; traversal and disabled packages are handled',async()=>{
  const root=mkdtempSync(path.join(os.tmpdir(),'console-skills-'));mkdirSync(root+'/skills/sample/scripts',{recursive:true});writeFileSync(root+'/skills/sample/SKILL.md','---\nname: sample\ndescription: sample\n---\nBody\n');writeFileSync(root+'/skills/sample/scripts/main.py','print("actual file")\n')
  const engine=await serveEngine({root,autoStart:false,port:0})
  try{
    assert.equal(engine.capabilities.skillsDir,root+'/skills');assert.equal(existsSync(root+'/.redtrace/skills'),false)
    const api='http://127.0.0.1:'+(engine.server.address() as {port:number}).port
    assert.equal((await(await fetch(api+'/capabilities/skills/sample/files/scripts/main.py')).json() as any).content,'print("actual file")\n')
    engine.capabilities.setEnabled('sample',false);assert.equal(engine.capabilities.skill('sample').enabled,false);assert.equal(existsSync(root+'/skills/sample'),false);assert.equal(existsSync(root+'/skills/.disabled/sample/SKILL.md'),true)
    engine.capabilities.setEnabled('sample',true);assert.equal(engine.capabilities.skill('sample').enabled,true)
    assert.equal((await fetch(api+'/capabilities/skills/sample/files/.redtrace.json')).status,404)
  }finally{await engine.close();rmSync(root,{recursive:true,force:true})}
})

test('navigation order is exact and management controls leave core task views intact',()=>{
  const html=readFileSync(source+'/static/index.html','utf8'),nav=html.slice(html.indexOf('<nav class='),html.indexOf('</nav>'))
  const labels=['任务','发现','工作空间','WebShell','打开 C2','LLM','Skills','MCP','工具','插件','日志','设置']
  let cursor=-1;for(const label of labels){const next=nav.indexOf('aria-label="'+label+'"');assert.ok(next>cursor,label);cursor=next}
  for(const token of ["view==='benchmark'","view !== 'benchmark'","operationsPage()","pluginsPage()",'C2','Commander','FGS'])assert.ok(html.includes(token),token)
  const settings=html.slice(html.indexOf('<section x-show="appPage === \'settings\'"'),html.indexOf('<!--',html.indexOf('<section x-show="appPage === \'settings\'"')))
  assert.ok(!settings.includes('Provider 模型服务'))
})


test('console keeps the original RedTrace palette and introduces no replacement root or body colors',()=>{
 const html=readFileSync(source+'/static/index.html','utf8'),css=readFileSync(source+'/static/console.css','utf8')
 assert.match(html,/redtrace-theme\.css\?v=20260916-detail-tab-1/)
 assert.doesNotMatch(css,/:root\s*\{|--rt-[a-z-]+\s*:|color-scheme\s*:|(?:^|})\s*body\s*\{/)
 assert.match(css,/background:var\(--rt-surface\)/)
})


test('creating a Skill after previewing a helper file opens the editable SKILL.md',()=>{
 const context=vm.createContext({window:{}});vm.runInContext(readFileSync(source+'/static/capabilities.js','utf8'),context)
 const page=context.window.skillsPage();page.filePath='scripts/helper.py';page.createNew()
 assert.equal(page.filePath,'SKILL.md');assert.match(page.draft.content,/# Skill name/)
})
