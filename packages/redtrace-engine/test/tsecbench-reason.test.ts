import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { graphTools } from '../src/runner.ts'
import type { EngineConfig, Worker } from '../src/types.ts'

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
    assert.deepEqual(benchmark.map(tool => tool.name), ['tsecbench_list', 'tsecbench_hint'])
    assert.deepEqual((await benchmark[0].execute('list', {})).details, { args: ['list'] })
    assert.deepEqual((await benchmark[1].execute('no', { unique_code: 'g-01', confirm_score_penalty: false })).details, { ok: false, error: 'score_penalty_confirmation_required' })
    assert.deepEqual((await benchmark[1].execute('yes', { unique_code: 'g-01', confirm_score_penalty: true })).details, { args: ['hint', 'g-01', '--confirm-score-penalty'] })
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})
