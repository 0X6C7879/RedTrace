import{LegionStore}from'../src/legion-store.ts'
import{legionTools}from'../src/legion-tools.ts'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { graphTools, graphUpdate } from '../src/runner.ts'
import type { EngineConfig, Worker, Step, Input } from '../src/types.ts'

test('Commander owns platform lifecycle and paid hints require explicit confirmation',async()=>{const root=mkdtempSync(path.join(os.tmpdir(),'legion-platform-')),skill=path.join(root,'.redtrace/skills/tsecbench-api');mkdirSync(skill+'/scripts',{recursive:true});writeFileSync(skill+'/scripts/tsecbench.py','import json,sys\nprint(json.dumps({"args":sys.argv[1:]}))\n');const store=new Store(':memory:');try{const p=store.createProject({title:'Benchmark',origin:'TSecBench authorized fixture',goal:'verify'}).project;new LegionStore(store).claimCommand();const tools=legionTools(store,'commander',store.projects()[0].id,null,()=>{},{workspaceRoot:root+'/workspaces'} as EngineConfig);assert.deepEqual((await tools.find(t=>t.name==='legion_platform_list')!.execute('list',{projectId:p.id})).details,{args:['list']});const hint=tools.find(t=>t.name==='legion_platform_hint')!;await assert.rejects(hint.execute('no',{projectId:p.id,taskKey:'a',confirmScorePenalty:false}),/Score penalty/);assert.deepEqual((await hint.execute('yes',{projectId:p.id,taskKey:'a',confirmScorePenalty:true})).details,{args:['hint','a','--confirm-score-penalty']});assert.equal(store.nodeCount(p.id,'fact'),1)}finally{store.close();rmSync(root,{recursive:true,force:true})}})

test('Soldier keeps list/submission but cannot start or close shared instances; SDK submission never publishes a Fact',async()=>{const root=mkdtempSync(path.join(os.tmpdir(),'legion-platform-worker-')),skill=path.join(root,'.redtrace/skills/tsecbench-api');mkdirSync(skill+'/scripts',{recursive:true});writeFileSync(skill+'/SKILL.md','fixture');writeFileSync(skill+'/scripts/tsecbench.py','import json,sys\nprint(json.dumps({"ok":True,"submit":{"correct":True,"awarded":300}}))\n');const store=new Store(':memory:'),worker={name:'soldier',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,maxRunning:1,priority:0};try{const p=store.createProject({title:'Benchmark',origin:'TSecBench authorized fixture',goal:'verify'}).project,step=store.addStep(p.id,{description:'submit',sourceIds:['origin']}),run=store.claim(p.id,'execute',worker,step.id),tools=graphTools({store,run,worker,config:{workspaceRoot:root+'/workspaces',maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{});assert.deepEqual(tools.filter(t=>t.name.startsWith('tsecbench_')).map(t=>t.name),['tsecbench_list','tsecbench_submit']);const result=await tools.find(t=>t.name==='tsecbench_submit')!.execute('submit',{unique_code:'a',flag:'flag{fixture}'});assert.equal((result.details as any).correct,true);assert.equal(store.nodeCount(p.id,'fact'),1);await tools.find(t=>t.name==='submit_fact')!.execute('proof',{title:'Submission verified',description:'SDK confirmed fixture submission correct; 300 awarded',evidence:[{description:'actual SDK response correct=true, awarded=300'}]});assert.equal(store.nodeCount(p.id,'fact'),2)}finally{store.close();rmSync(root,{recursive:true,force:true})}})



test('Explore has native read-only list and preserves SDK business errors before target validation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tsecbench-errors-')), skill = path.join(root, '.redtrace', 'skills', 'tsecbench-api')
  mkdirSync(path.join(skill, 'scripts'), { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), 'fixture')
  writeFileSync(path.join(skill, 'scripts', 'tsecbench.py'), 'import json,sys\nprint(json.dumps({"ok":False,"error":"VpnCheckError","message":"VPN fixture returned 502","code":"vpn_check_failed"}),file=sys.stderr)\nsys.exit(2)\n')
  const store = new Store(':memory:')
  const worker: Worker = {name:'fixture',backend:'mock',provider:'mock',model:'',enabled:true,reason:false,explore:true,bootstrap:false,maxRunning:1,priority:0}
  try {
    const project=store.createProject({title:'fixture',origin:'TSecBench',goal:'check',bootstrap:false}).project
    const step=store.addStep(project.id,{description:'check',sourceIds:['origin']}),run=store.claim(project.id,'execute',worker,step.id)
    const tools=graphTools({store,run,worker,config:{workspaceRoot:path.join(root,'workspaces'),maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{})
    assert.ok(tools.some(tool=>tool.name==='tsecbench_list'))
    const result:any=await tools.find(tool=>tool.name==='tsecbench_list')!.execute('list',{})
    assert.equal(result.isError,true)
    assert.equal(result.details.error,'VPN fixture returned 502')
    assert.equal(result.details.context.code,'vpn_check_failed')
    assert.equal(store.project(project.id).factSeq,0)
    assert.equal(store.project(project.id).benchmarkHosts,undefined)
  } finally {store.close();rmSync(root,{recursive:true,force:true})}
})


test('TSecBench CLI preserves inherited proxy settings', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  for (const relative of ['skills/tsecbench-api/scripts/tsecbench.py', '.redtrace/skills/tsecbench-api/scripts/tsecbench.py']) {
    const script = path.join(root, relative)
    if (!existsSync(script)) continue
    execFileSync('python3', ['-c', `
import argparse, importlib.util, os, sys, urllib.request
spec = importlib.util.spec_from_file_location('tsecbench', sys.argv[1])
cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cli)
proxies = {key: 'http://127.0.0.1:1' for key in ('HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy')}
os.environ.update(proxies, NO_PROXY='localhost', no_proxy='localhost')
class SDK:
    @staticmethod
    def TSecBenchmark(**kwargs):
        assert kwargs == {'base_url': 'https://fixture.invalid', 'token': 'fixture', 'auto_check_vpn': False}
        assert all(not urllib.request.proxy_bypass_environment(host) for host in ('10.0.100.58', 'tsecbench.zc.tencent.com'))
        assert urllib.request.proxy_bypass_environment('localhost') == bool(bypass)
        assert dict(os.environ) == inherited
        return object()
cli.load_sdk = lambda: SDK
for bypass in ({'NO_PROXY': 'localhost', 'no_proxy': 'localhost'}, {}):
    for key in ('NO_PROXY', 'no_proxy'):
        os.environ.pop(key, None)
    os.environ.update(bypass)
    inherited = dict(os.environ)
    cli.client_context(argparse.Namespace(base_url='https://fixture.invalid', token='fixture'))
`, script], { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } })
  }
})

test('TSecBench uses the configured Python even when python3 is absent from Worker PATH', async () => {
  const python = execFileSync('python3', ['-c', 'import sys;print(sys.executable)'], { encoding: 'utf8' }).trim()
  const root = mkdtempSync(path.join(os.tmpdir(), 'tsecbench-python-'))
  const skill = path.join(root, '.redtrace', 'skills', 'tsecbench-api')
  mkdirSync(path.join(skill, 'scripts'), { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), 'fixture')
  writeFileSync(path.join(skill, 'scripts', 'tsecbench.py'), 'import json,sys\nprint(json.dumps({"args":sys.argv[1:]}))\n')
  const store = new Store(':memory:')
  const worker: Worker = { name: 'fixture', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: true, explore: false, bootstrap: false, maxRunning: 1, priority: 0 }
  const previous = process.env.REDTRACE_BENCHMARK_PYTHON
  try {
    process.env.REDTRACE_BENCHMARK_PYTHON = python
    const id = store.createProject({ title: 'Interpreter', origin: 'TSecBench', goal: 'Use configured interpreter' }).project.id
    const run = store.claim(id,'execute',worker,store.addStep(id,{description:'Read SDK fixture',sourceIds:['origin']}).id)
    const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 1, maxProjectWorkers: 1, maxRunningProjects: 1, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: path.join(root, 'workspaces'), commonEnv: { PATH: root } }
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal }, () => {})
    assert.deepEqual((await tools.find(tool => tool.name === 'tsecbench_list')!.execute('list', {})).details, { args: ['list'] })
  } finally {
    if (previous === undefined) delete process.env.REDTRACE_BENCHMARK_PYTHON
    else process.env.REDTRACE_BENCHMARK_PYTHON = previous
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
