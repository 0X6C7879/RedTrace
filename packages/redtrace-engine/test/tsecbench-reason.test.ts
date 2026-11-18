import{LegionStore}from'../src/legion-store.ts'
import{legionTools}from'../src/legion-tools.ts'
import { Capabilities } from '../src/capabilities.ts'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { graphTools, graphUpdate } from '../src/runner.ts'
import { tsecbenchQuery } from '../src/benchmark.ts'
import type { EngineConfig, Worker, Step, Input } from '../src/types.ts'

test('Commander only reads task list; platform lifecycle, hints and raw evidence are unavailable',async()=>{const root=mkdtempSync(path.join(os.tmpdir(),'legion-platform-')),skill=path.join(root,'skills/tsecbench-api');mkdirSync(skill+'/scripts',{recursive:true});writeFileSync(skill+'/scripts/tsecbench.py','import json,sys\nprint(json.dumps({"challenges":[]}))\n');const store=new Store(':memory:');try{const p=store.createProject({mode:'benchmark',title:'Benchmark',origin:'TSecBench authorized fixture',goal:'verify'}).project;new LegionStore(store).claimCommand();const tools=legionTools(store,'commander',store.projects()[0].id,null,()=>{},{workspaceRoot:root+'/workspaces'} as EngineConfig);assert((await tools.find(t=>t.name==='legion_platform_list')!.execute('list',{})).details);for(const name of ['legion_instance','legion_platform_hint','legion_read_run','legion_evidence_read','tsecbench_submit'])assert(!tools.some(t=>t.name===name));assert.equal(store.nodeCount(p.id,'fact'),1)}finally{store.close();rmSync(root,{recursive:true,force:true})}})

test('TSecBench CLI adapter preserves SDK business errors without registering Worker platform tools', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tsecbench-errors-')), skill = path.join(root, 'skills', 'tsecbench-api')
  mkdirSync(path.join(skill, 'scripts'), { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), 'fixture')
  writeFileSync(path.join(skill, 'scripts', 'tsecbench.py'), 'import json,sys\nprint(json.dumps({"ok":False,"error":"VpnCheckError","message":"VPN fixture returned 502","code":"vpn_check_failed"}),file=sys.stderr)\nsys.exit(2)\n')
  const store = new Store(':memory:')
  const worker: Worker = {name:'fixture',backend:'mock',provider:'mock',model:'',enabled:true,reason:false,explore:true,bootstrap:false,maxRunning:1,priority:0}
  try {
    const project=store.createProject({title:'fixture',origin:'TSecBench',goal:'check',bootstrap:false}).project
    const step=store.addStep(project.id,{description:'check',sourceIds:['origin']}),run=store.claim(project.id,'execute',worker,step.id)
    const config={workspaceRoot:path.join(root,'workspaces'),maxSteps:null} as EngineConfig
    const tools=graphTools({store,run,worker,config,signal:new AbortController().signal},()=>{})
    assert.ok(!tools.some(tool=>tool.name.startsWith('tsecbench_')))
    await assert.rejects(tsecbenchQuery(config,['list']), {
      message:'VPN fixture returned 502', details:{ok:false,error:'VpnCheckError',message:'VPN fixture returned 502',code:'vpn_check_failed'},
    })
    assert.equal(store.project(project.id).factSeq,0)
    assert.equal(store.project(project.id).benchmarkHosts,undefined)
  } finally {store.close();rmSync(root,{recursive:true,force:true})}
})


test('TSecBench CLI preserves inherited proxy settings', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  for (const relative of [new Capabilities(path.resolve(import.meta.dirname,'../../../.redtrace'),path.resolve(import.meta.dirname,'../../..')).directory('tsecbench-api')+'/scripts/tsecbench.py']) {
    const script = relative
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
  const skill = path.join(root, 'skills', 'tsecbench-api')
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
    assert.deepEqual(await tsecbenchQuery(config, ['list']), { args: ['list'] })
  } finally {
    if (previous === undefined) delete process.env.REDTRACE_BENCHMARK_PYTHON
    else process.env.REDTRACE_BENCHMARK_PYTHON = previous
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
