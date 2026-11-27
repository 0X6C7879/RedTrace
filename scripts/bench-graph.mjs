import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { registerHooks } from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const baseline = process.argv.indexOf('--baseline')
const revision = baseline < 0 ? undefined : process.argv[baseline + 1] ?? 'HEAD'
if (revision) {
  const file = 'packages/redtrace-engine/src/fgs.ts'
  const url = new URL('../' + file, import.meta.url).href
  const source = execFileSync('git', ['show', `${revision}:${file}`], { cwd: fileURLToPath(new URL('../', import.meta.url)), encoding: 'utf8' })
  registerHooks({ load(id, context, next) { return id === url ? { source, format: 'module-typescript', shortCircuit: true } : next(id, context) } })
}
const { Store } = await import('../packages/redtrace-engine/src/store.ts')
const { projectFgs, liveSteps } = await import('../packages/redtrace-engine/src/fgs.ts')
const store = new Store(':memory:')
try {
  const { project } = store.createProject({ title: 'Graph benchmark', origin: 'Local fixture', goal: 'Render pending work' })
  const step = store.addStep(project.id, { description: 'Queued fixture', sourceIds: ['origin'] })
  const graph = store.graph(project.id)
  const goal = graph.goals[0]
  graph.goals.push(...Array.from({ length: 200 }, (_, i) => ({ ...goal, id: `goal-${i}`, parentId: goal.id })))
  graph.steps = Array.from({ length: 4000 }, (_, i) => ({ ...step, id: `step-${i}`, sourceIds: ['origin', 'origin'], goalId: graph.goals[i % graph.goals.length].id }))
  const timings = []
  let signature
  const cpu = process.cpuUsage()
  for (let i = -2; i < 9; i++) {
    const begin = performance.now()
    const projection = projectFgs(graph), live = liveSteps(graph)
    timings.push(performance.now() - begin)
    if (i === 0) signature = createHash('sha256').update(JSON.stringify({ projection, live })).digest('hex')
    assert.equal(projection.nodes.filter(node => node.nodeType === 'goal' || node.nodeType === 'subgoal').reduce((sum, node) => sum + node.activeSteps, 0), 4000)
    assert.equal(live.nodes.length, 4000)
    assert.equal(live.edges.length, 8000)
    assert.equal(new Set(live.edges.map(edge => JSON.stringify([edge.source, edge.target]))).size, 8000)
  }
  const usage = process.cpuUsage(cpu)
  const measured = timings.slice(2).sort((a, b) => a - b)
  console.log(JSON.stringify({ goals: graph.goals.length, steps: graph.steps.length, edges: 8000, signature, medianMs: measured[4], cpuMs: (usage.user + usage.system) / 1000, peakRssBytes: process.resourceUsage().maxRSS * 1024 }))
} finally { store.close() }
