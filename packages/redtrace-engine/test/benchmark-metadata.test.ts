import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { discoverBenchmarkTasks, recordBenchmarkSubmission } from '../src/benchmark.ts'
import { LegionStore } from '../src/legion-store.ts'
import { Store } from '../src/store.ts'
import type { EngineConfig, Fact } from '../src/types.ts'

test('TSecBench list persists only display metadata and leaves scheduling unchanged on metadata-only refresh', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'redtrace-benchmark-metadata-'))
  const script = path.join(root, 'skills/tsecbench-api/scripts/tsecbench.py')
  mkdirSync(path.dirname(script), { recursive: true })
  writeFileSync(script, 'import pathlib, sys\nassert sys.argv[1:] == ["list"]\nprint(pathlib.Path(__file__).with_suffix(".json").read_text())\n')
  const store = new Store(':memory:')
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const p = store.createProject({ mode: 'benchmark', title: 'Fixture', origin: 'TSecBench fixture', goal: 'Verify' }).project
  const legion = new LegionStore(store, p.id)
  const live = { unique_code: 'active', title: 'Active', description: 'Fixture statement', flag_count: 3, correct_flag_count: 0, is_completed: false, difficulty: 'medium', total_score: 90, extra: 'RAW_LIST_FIELD' }
  const completed = { unique_code: 'done', title: 'Done without a Graph', is_completed: true, flag_count: 1, correct_flag_count: 1 }
  const partial = { unique_code: 'partial', correct_flag_count: 0 }
  const refresh = async () => {
    writeFileSync(script.replace(/\.py$/, '.json'), JSON.stringify({ ok: true, challenges: [live, completed, partial] }))
    await discoverBenchmarkTasks(store, { workspaceRoot: path.join(root, 'workspaces') } as EngineConfig, p.id)
  }
  await refresh()
  const view = () => legion.board().projects[0].platform
  assert.deepEqual(view().active, { title: 'Active', flag_count: 3, correct_flag_count: 0, is_completed: false, difficulty: 'medium', total_score: 90, submitted: false, accepted: false })
  assert.deepEqual(view().partial, { title: 'partial', flag_count: null, correct_flag_count: 0, is_completed: null, difficulty: null, total_score: null, submitted: false, accepted: false })
  assert.equal(view().done.is_completed, true)
  const graph = store.projectGraphs(p.id).find(g => g.taskKey === 'active')!
  assert.ok(!store.projectGraphs(p.id).some(g => g.taskKey === 'done'), 'platform-only completion does not create a Graph')
  const origin = store.node<Fact>(p.id, graph.originId, 'fact').description
  assert.match(origin, /Fixture statement/)
  assert.doesNotMatch(origin, /RAW_LIST_FIELD|correct_flag_count/)

  const snapshot = () => {
    const { lines, ...board } = legion.boardSummary()
    return {
      capacity: legion.questionCapacity(2), board,
      context: lines.map(line => line.replaceAll(/@\d{4}-\d\d-\d\dT[\d:.]+Z/g, '')),
      graphs: store.projectGraphs(p.id), steps: store.nodes(p.id, ['step']), runs: store.runs(p.id),
    }
  }
  const before = snapshot()
  live.correct_flag_count = 2
  live.difficulty = 'hard'
  await refresh()
  assert.equal(view().active.correct_flag_count, 2)
  assert.equal(view().active.difficulty, 'hard')
  assert.deepEqual(snapshot(), before, 'platform display progress and difficulty do not change existing scheduling state or model context')

  recordBenchmarkSubmission(store, p.id, 'active', { correct: true, total_flag_count: 3, correct_flag_count: 3 })
  assert.equal(view().active.accepted, true)
  assert.equal(view().active.is_completed, false, 'submission does not supersede the list observation')
  live.is_completed = true
  await refresh()
  assert.equal(view().active.is_completed, true)
  live.is_completed = false
  await refresh()
  assert.equal(view().active.is_completed, false, 'the newest list observation is authoritative in the UI')
})
