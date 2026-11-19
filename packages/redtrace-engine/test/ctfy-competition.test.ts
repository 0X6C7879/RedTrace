import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { EngineConfig } from '../src/types.ts'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const src=process.env.CTFY_TEST_ROOT??path.resolve(import.meta.dirname,'../src')
const {Store}:typeof import('../src/store.ts')=await import(pathToFileURL(path.join(src,'store.ts')).href)
const {LegionStore}:typeof import('../src/legion-store.ts')=await import(pathToFileURL(path.join(src,'legion-store.ts')).href)
const {legionTools}:typeof import('../src/legion-tools.ts')=await import(pathToFileURL(path.join(src,'legion-tools.ts')).href)
const {discoverBenchmarkTasks}:typeof import('../src/benchmark.ts')=await import(pathToFileURL(path.join(src,'benchmark.ts')).href)

function fixture(t: TestContext) {
 const root=mkdtempSync(path.join(os.tmpdir(),'ctfy-selection-')),script=path.join(root,'skills/tpctf-api/scripts/tpctf.py')
 mkdirSync(path.dirname(script),{recursive:true})
 writeFileSync(script,`import json,sys
args=sys.argv[1:]
if args[0]=='competitions':
 print(json.dumps({'items':[{'id':'suite-a','title':'Practice','kind':'event','is_registered':True,'phase':'running','play_open':True},{'id':'suite-b','title':'CYBENCH','kind':'suite','is_registered':True,'phase':'running','play_open':True}]}))
elif '--competition' not in args:
 print(json.dumps({'ok':False,'code':'competition_ambiguous','detail':'Select a competition'}));sys.exit(1)
else:
 cid=args[args.index('--competition')+1]
 print(json.dumps({'items':[{'id':'T1','name':'Task '+cid,'scoring':'scored','my_team_fully_solved':False,'questions':[{'id':'flag'}]}]}))
`)
 const db=path.join(root,'engine.db'),store=new Store(db)
 const project=store.createProject({mode:'benchmark',title:'ctfy',origin:'CTFy authorized fixture',goal:'Complete CYBENCH'}).project
 new LegionStore(store,project.id).claimCommand()
 const commonEnv:Record<string,string>={CTFY_PLAY_TOKEN:'fixture-token'}
 const config={workers:[],providers:{},maxWorkers:4,maxProjectWorkers:4,maxRunningProjects:1,maxSteps:null,decideTimeout:30,executeTimeout:30,concludeTimeout:5,bootstrapTimeout:30,bootstrapConcludeTimeout:5,workspaceRoot:path.join(root,'workspaces'),commonEnv} satisfies EngineConfig
 const platform=()=>legionTools(store,'commander',project.id,null,()=>{},config).find(t=>t.name==='legion_platform_list')!
 t.after(()=>{store.close();rmSync(root,{recursive:true,force:true})})
 return {root,db,store,project,config,platform}
}

test('CTFy discovery offers choices without a global competition ID or phantom task Graphs',async t=>{
 const f=fixture(t),r=(await f.platform().execute('choices',{})).details as any
 assert.equal(r.selectionRequired,true)
 assert.deepEqual(r.competitions.map((c:{id:string;title:string})=>[c.id,c.title]),[['suite-a','Practice'],['suite-b','CYBENCH']])
 assert.equal(f.store.projectGraphs(f.project.id).length,0)
 assert.equal(f.store.project(f.project.id).ctfyCompetitionId,undefined)
 assert(!JSON.stringify(r).includes('fixture-token'))
})

test('Commander selects competition_id once; refresh reuses it and passes scope into Worker Graphs',async t=>{
 const f=fixture(t),selected=(await f.platform().execute('choose',{competition_id:'suite-b'})).details as any
 assert.equal(selected.competition_id,'suite-b')
 assert.equal(f.store.project(f.project.id).ctfyCompetitionId,'suite-b')
 assert.equal(f.config.commonEnv.CTFY_COMPETITION_ID,undefined)
 const graph=f.store.projectGraphs(f.project.id)[0]
 assert.equal(graph.title,'Task suite-b')
 assert.match(f.store.forGraph(f.project.id,graph.id).node<import('../src/types.ts').Fact>(f.project.id,graph.originId).description,/"competition_id":"suite-b"/)
 assert.equal(((await f.platform().execute('refresh',{})).details as any).competition_id,'suite-b')
 assert.equal(f.store.projectGraphs(f.project.id).length,1)
 await assert.rejects(f.platform().execute('switch',{competition_id:'suite-a'}),/another competition|different competition/i)
 assert.equal(f.store.project(f.project.id).ctfyCompetitionId,'suite-b')
})

test('Project selections are isolated, persisted, and override the optional legacy global default',async t=>{
 const f=fixture(t)
 f.config.commonEnv.CTFY_COMPETITION_ID='suite-a'
 await f.platform().execute('choose',{competition_id:'suite-b'})
 const second=f.store.createProject({mode:'benchmark',title:'second',origin:'CTFy authorized fixture',goal:'practice'}).project
 await discoverBenchmarkTasks(f.store,f.config,second.id)
 assert.equal(f.store.project(second.id).ctfyCompetitionId,'suite-a')
 assert.equal(f.store.project(f.project.id).ctfyCompetitionId,'suite-b')
 assert.equal(f.config.commonEnv.CTFY_COMPETITION_ID,'suite-a')
 const reopened=new Store(f.db)
 try {assert.equal(reopened.project(f.project.id).ctfyCompetitionId,'suite-b')}finally{reopened.close()}
})

test('platform list uses fresh common_env settings instead of a stale Commander snapshot',async t=>{
 const f=fixture(t),current={...f.config,commonEnv:{...f.config.commonEnv,CTFY_COMPETITION_ID:'suite-b'}}
 const tool=legionTools(f.store,'commander',f.project.id,null,()=>{},f.config,undefined,()=>current).find(t=>t.name==='legion_platform_list')!
 assert.equal(((await tool.execute('refresh',{})).details as any).competition_id,'suite-b')
})

test('malformed CTFy responses do not silently become an empty successful discovery',async t=>{
 const f=fixture(t),script=path.join(f.root,'skills/tpctf-api/scripts/tpctf.py')
 writeFileSync(script,'import json\nprint(json.dumps({"unexpected":[]}))\n')
 await assert.rejects(discoverBenchmarkTasks(f.store,f.config,f.project.id),/competition list is missing items/)
 await assert.rejects(discoverBenchmarkTasks(f.store,f.config,f.project.id,undefined,'suite-b'),/challenge list is missing items/)
 assert.equal(f.store.project(f.project.id).ctfyCompetitionId,undefined)
 assert.equal(f.store.projectGraphs(f.project.id).length,0)
})
