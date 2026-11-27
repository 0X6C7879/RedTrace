import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { registerHooks } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const baseline = process.argv.indexOf('--baseline')
const revision = baseline < 0 ? undefined : process.argv[baseline + 1] ?? 'HEAD'
if (revision) {
  const sources = new Map(['store.ts', 'run-trace.ts'].map(name => {
    const relative = `packages/redtrace-engine/src/${name}`
    return [new URL(relative, `file://${root}`).href, execFileSync('git', ['show', `${revision}:${relative}`], { cwd: root, encoding: 'utf8' })]
  }))
  registerHooks({ load(url, context, next) {
    const source = sources.get(url)
    return source === undefined ? next(url, context) : { source, format: 'module-typescript', shortCircuit: true }
  } })
}
const { Store } = await import('../packages/redtrace-engine/src/store.ts')
const { readRunTrace } = await import('../packages/redtrace-engine/src/run-trace.ts')
let { recordRunEvent } = await import('../packages/redtrace-engine/compat/run-audit.mjs')
if (revision) {
  const source = execFileSync('git', ['show', `${revision}:packages/redtrace-engine/compat/cordis.mjs`], { cwd: root, encoding: 'utf8' })
  const start = source.indexOf("    const unlisten = ctx.on('session/event'")
  const begin = source.indexOf('      const data = event.data ?? {}', start)
  const end = source.indexOf("      if(event.type==='tool/result')engine.legion.settleHandoff", begin)
  assert.ok(start >= 0 && begin > start && end > begin, 'Baseline Run event handler not found')
  const { eventProjection, accumulateUsage } = await import('../packages/redtrace-dsh/lib/audit.js')
  const legacy = new Function('store', 'run', 'task', 'event', 'eventProjection', 'accumulateUsage', 'json', source.slice(begin, end))
  recordRunEvent = (store, run, task, event) => legacy(store, run, task, event, eventProjection, accumulateUsage, value => JSON.parse(JSON.stringify(value)))
}
const directory = mkdtempSync(path.join(tmpdir(), 'redtrace-runtime-bench-'))
const filename = path.join(directory, 'engine.db')
const worker = { name: 'fixture', backend: 'mock', provider: 'mock', model: '', enabled: true, roles: ['soldier'], reason: false, explore: true, bootstrap: false, maxRunning: 8, priority: 0 }
let store
try {
  store = new Store(filename)
  const project = store.createProject({ title: 'Runtime benchmark', origin: 'Local fixture', goal: 'Verify retained records' }).project
  const runs = Array.from({ length: 4 }, (_, i) => store.claim(project.id, 'execute', worker, store.addStep(project.id, { description: `Fixture ${i}`, sourceIds: ['origin'] }).id))
  const tasks = runs.map(run => ({ sessionId: run.id }))
  const output = 'Local retained output 中文 😀\n'.repeat(10_000)
  let peakHeapBytes = 0
  const memory = () => { peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed) }
  const cpu = process.cpuUsage()
  const begin = performance.now()
  for (let turn = 0; turn < 40; turn++) {
    for (const [i, run] of runs.entries()) {
      const callId = `${i}-${turn}`
      const events = [
        { type: 'step/start', data: { turn, step: 0 } },
        { type: 'assistant/message', data: { turn, step: 0, usage: { inputTokens: 10, outputTokens: 2 }, message: { content: [] } } },
        { type: 'tool/call', data: { callId, name: 'read', arguments: { file_path: 'local-fixture.txt' } } },
        { type: 'tool/result', data: { message: { source: { callId }, content: [{ type: 'text', text: output }] } } },
        { type: 'step/end', data: { turn, step: 0 } },
        ...Array.from({ length: 5 }, () => ({ type: 'tool/prepare', data: {} })),
      ]
      for (const [j, event] of events.entries()) recordRunEvent(store, run, tasks[i], { ...event, seq: turn * 10 + j, time: 1_790_000_000_000 + turn * 10 + j })
      memory()
    }
    await new Promise(resolve => setImmediate(resolve))
  }
  const ingestMs = performance.now() - begin
  const traceStart = performance.now()
  for (let i = 0; i < 120; i++) {
    const page = readRunTrace(store, project.id, runs[i % runs.length].id, { limit: 30 })
    assert.equal(page.events.length, 30)
    assert.equal(page.events.find(event => event.kind === 'tool.completed').summary, output.slice(0, 180))
    assert.equal(page.total, 80)
    assert.equal(store.run(runs[i % runs.length].id).pendingTools.length, 0)
    memory()
  }
  const traceMs = performance.now() - traceStart
  const detail = readRunTrace(store, project.id, runs[0].id, { eventId: readRunTrace(store, project.id, runs[0].id).events.find(event => event.kind === 'tool.completed').id })
  assert.equal(detail.event.content, output)
  assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM tool_calls').get().n, 160)
  assert.equal(store.runCosts(runs[0].id).totalTokens, 480)
  store.close(); store = undefined
  const reopenStart = performance.now()
  store = new Store(filename)
  const reopenMs = performance.now() - reopenStart
  const reopenWalBytes = statSync(filename + '-wal').size
  const usage = process.cpuUsage(cpu)
  store.close(); store = undefined
  const diskBytes = readdirSync(directory).reduce((total, name) => total + statSync(path.join(directory, name)).size, 0)
  console.log(JSON.stringify({ ingestMs, traceMs, reopenMs, reopenWalBytes, diskBytes, peakHeapBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024, cpuMs: (usage.user + usage.system) / 1000, calls: 160, tracePages: 120 }))
} finally {
  store?.close()
  rmSync(directory, { recursive: true, force: true })
}
