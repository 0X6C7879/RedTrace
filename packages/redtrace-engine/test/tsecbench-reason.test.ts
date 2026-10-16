import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { graphTools, graphUpdate } from '../src/runner.ts'
import type { EngineConfig, Worker, Step, Input } from '../src/types.ts'

test('Reason can only query TSecBench challenges and confirmed hints', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tsecbench-reason-'))
  const skill = path.join(root, '.redtrace', 'skills', 'tsecbench-api')
  mkdirSync(path.join(skill, 'scripts'), { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: tsecbench-api\ndescription: test\n---\n')
  writeFileSync(path.join(skill, 'scripts', 'tsecbench.py'), 'import json,sys\nprint(json.dumps({"args":sys.argv[1:]}))\n')
  const store = new Store(':memory:')
  const worker: Worker = { name: 'reason', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: true, explore: false, bootstrap: false, maxRunning: 1, priority: 0 }
  const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 1, maxProjectWorkers: 1, maxRunningProjects: 1, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: path.join(root, 'workspaces') }
  try {
    const id = store.createProject({ title: 'Benchmark', origin: 'Complete TSec Benchmark', goal: 'Solve challenges' }).project.id
    const run = store.claim(id, 'decide', worker)
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal }, () => {})
    const benchmark = tools.filter(tool => tool.name.startsWith('tsecbench_'))
    assert.deepEqual(benchmark.map(tool => tool.name), ['tsecbench_list', 'tsecbench_vpn', 'tsecbench_hint'])
    assert.deepEqual((await benchmark[0].execute('list', {})).details, { args: ['list'] })
    // The VPN probe is a deliberate Reason action now that nothing runs it implicitly.
    assert.deepEqual((await benchmark[1].execute('vpn', {})).details, { args: ['vpn'] })
    assert.deepEqual((await benchmark[2].execute('no', { unique_code: 'g-01', confirm_score_penalty: false })).details, { ok: false, error: 'score_penalty_confirmation_required' })
    assert.deepEqual((await benchmark[2].execute('yes', { unique_code: 'g-01', confirm_score_penalty: true })).details, { args: ['hint', 'g-01', '--confirm-score-penalty'] })
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('Explore owns Fact publication; TSecBench lifecycle tools never publish Facts', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'tsecbench-explore-'))
  const skill = path.join(root, '.redtrace', 'skills', 'tsecbench-api')
  mkdirSync(path.join(skill, 'scripts'), { recursive: true })
  writeFileSync(path.join(skill, 'SKILL.md'), '---\nname: tsecbench-api\ndescription: test\n---\n')
  writeFileSync(path.join(skill, 'scripts', 'tsecbench.py'), `import json,sys
cmd=sys.argv[1]
value={
 'start': {'unique_code':sys.argv[2], 'container_addr':['127.0.0.1:8080']},
 'submit': {'correct':True, 'correct_flag_count':1, 'total_flag_count':4, 'awarded':300},
 'close': {'unique_code':sys.argv[2], 'closed':True},
}[cmd]
print(json.dumps({'ok':True,cmd:value}))
`)
  const store = new Store(':memory:')
  const worker: Worker = { name: 'explore', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }
  const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 1, maxProjectWorkers: 1, maxRunningProjects: 1, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: path.join(root, 'workspaces') }
  try {
    const id = store.createProject({ title: 'Benchmark', origin: 'Authorized TSecBench b-01 web target', goal: 'Complete it' }).project.id
    const step = store.addStep(id, { description: 'Start and submit b-01', sourceIds: ['origin'] })
    const run = store.claim(id, 'execute', worker, step.id)
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal }, () => {})
    const byName = (name: string) => tools.find(item => item.name === name)!
    const cursor = () => store.events(id, 0, 500).at(-1)?.id ?? 0
    const startCursor = cursor(), evidenceBefore = store.project(id).evidenceSeq ?? store.project(id).factSeq
    assert.deepEqual((await byName('tsecbench_start').execute('start', { unique_code: 'b-01' })).details, { unique_code: 'b-01', container_addr: ['127.0.0.1:8080'] })
    assert.equal(store.project(id).evidenceSeq, evidenceBefore)
    assert.deepEqual(store.project(id).benchmarkHosts, { 'b-01': ['127.0.0.1:8080'] })
    const observations = store.nodes<Input>(id, ['observation'])
    assert.equal(observations.length, 1)
    assert.equal(observations[0].stepId, step.id)
    assert.match(observations[0].content, /Platform started TSecBench b-01.*127\.0\.0\.1:8080/)
    assert.equal(store.node<Step>(id, step.id, 'step').factIds.length, 0)
    assert.equal(graphUpdate(store, id, startCursor, null).wake, false)
    const submitCursor = cursor(), criticalBefore = store.project(id).criticalSeq ?? 0
    assert.equal(((await byName('tsecbench_submit').execute('submit', { unique_code: 'b-01', flag: 'flag{fixture}' })).details as { correct: boolean }).correct, true)
    assert.equal(store.project(id).evidenceSeq, evidenceBefore)
    assert.equal(store.project(id).criticalSeq ?? 0, criticalBefore)
    assert.equal(graphUpdate(store, id, submitCursor, null).wake, false)
    await byName('tsecbench_submit').execute('duplicate', { unique_code: 'b-01', flag: 'flag{fixture}' })
    assert.equal(store.project(id).evidenceSeq, evidenceBefore)
    assert.equal(store.node<Step>(id, step.id, 'step').factIds.length, 0)
    assert.equal(store.project(id).criticalSeq ?? 0, criticalBefore)
    assert.equal(graphUpdate(store, id, submitCursor, null).wake, false)
    const factCursor = cursor()
    await byName('submit_fact').execute('explore-fact', {
      description: 'Explore verified platform confirmed 1/4 flags',
      evidence: [{ description: 'Fixture SDK returned correct=true, correct_flag_count=1, total_flag_count=4' }],
    })
    assert.equal(store.project(id).evidenceSeq, evidenceBefore + 1)
    assert.equal(store.node<Step>(id, step.id, 'step').factIds.length, 1)
    assert.equal(graphUpdate(store, id, factCursor, null).wake, true)
    assert.equal((graphTools.toString().match(/store\.addFact\(/g) ?? []).length, 1)
    assert.deepEqual((await byName('tsecbench_close').execute('close', { unique_code: 'b-01' })).details, { unique_code: 'b-01', closed: true })
    assert.deepEqual(store.project(id).benchmarkHosts, {})
    assert.match(store.graph(id).facts.map(fact => fact.description).join('\n'), /platform confirmed 1\/4 flags/)
    for (const response of [
      { unique_code: 'wrong-challenge', container_addr: ['127.0.0.1:8080'] },
      { unique_code: 'b-01', container_addr: [] },
      { unique_code: 'b-01', container_addr: ['http://user:password@127.0.0.1:8080'] },
    ]) {
      writeFileSync(path.join(skill, 'scripts', 'tsecbench.py'), `import json\nprint(${JSON.stringify(JSON.stringify({ start: response }))})\n`)
      await assert.rejects(byName('tsecbench_start').execute('invalid-start', { unique_code: 'b-01' }), /invalid challenge or target list|credential-bearing target/)
      assert.equal(store.project(id).evidenceSeq, evidenceBefore + 1)
      assert.equal(store.nodes<Input>(id, ['observation']).length, 1)
      assert.deepEqual(store.project(id).benchmarkHosts, {})
    }
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})


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
    const result:any=await tools.find(tool=>tool.name==='tsecbench_start')!.execute('start',{unique_code:'fixture'})
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
    const run = store.claim(id, 'decide', worker)
    const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 1, maxProjectWorkers: 1, maxRunningProjects: 1, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: path.join(root, 'workspaces'), commonEnv: { PATH: root } }
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal }, () => {})
    assert.deepEqual((await tools.find(tool => tool.name === 'tsecbench_list')!.execute('list', {})).details, { args: ['list'] })
  } finally {
    if (previous === undefined) delete process.env.REDTRACE_BENCHMARK_PYTHON
    else process.env.REDTRACE_BENCHMARK_PYTHON = previous
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
