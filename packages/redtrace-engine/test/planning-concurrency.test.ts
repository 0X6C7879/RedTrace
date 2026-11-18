const {domainFixtureRequest}=await import(new URL('./domain-fixture.mjs',import.meta.url).href)
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { legionTools } from '../src/legion-tools.ts'
import { Configuration } from '../src/config.ts'
import { Scheduler } from '../src/scheduler.ts'
import { serveEngine } from '../src/index.ts'
import { providerProfiles } from '../src/models.ts'
import { load } from '../../redtrace-dsh/lib/loader.js'

const settle = async () => { for (let i = 0; i < 12; i++) await new Promise(resolve => setImmediate(resolve)) }
const mission = (store: Store, projectId: string, taskKey: string, description = taskKey) => {
  const graph = store.projectGraphs(projectId).find(g => g.taskKey === taskKey)!
  return { role: 'soldier' as const, taskKey, description, graphId: graph.id, goalId: graph.goalId, sourceIds: [graph.originId] }
}
const tasks = (store: Store, id: string) => new Set(store.runsByStatus('running', id).map(r => r.graphId)).size

test('question limit round-trips and clears through settings; nonpositive values are rejected', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'question-settings-')), e = await serveEngine({ root, autoStart: false, port: 0 })
  const url = 'http://127.0.0.1:' + (e.server.address() as any).port + '/worker-config/runtime-tasks'
  const save = async (limit: number | undefined) => {
    const value = e.configuration.snapshot()
    return fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expected_revision: value.revision, runtime: value.runtime, tasks: { ...value.tasks, commander: { ...value.tasks.commander, max_benchmark_tasks: limit } } }) })
  }
  try {
    assert.equal(e.configuration.resolvedSnapshot().config.maxBenchmarkTasks, null)
    const response = await save(3); assert.equal(response.status, 200)
    assert.equal((await response.json() as any).tasks.commander.max_benchmark_tasks, 3)
    assert.equal(e.configuration.resolvedSnapshot().config.maxBenchmarkTasks, 3)
    assert.equal((await save(0)).status, 422); assert.equal(e.configuration.resolvedSnapshot().config.maxBenchmarkTasks, 3)
    assert.equal((await save(undefined)).status, 200); assert.equal(e.configuration.resolvedSnapshot().config.maxBenchmarkTasks, null)
  } finally { await e.close(); rmSync(root, { recursive: true, force: true }) }
})

test('resident planning tools enforce live Max Step in both project modes and question capacity independently', async t => {
  const store = new Store(':memory:'), legion = new LegionStore(store), root = mkdtempSync(path.join(os.tmpdir(), 'planning-limits-'))
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  const c = new Configuration(root); c.initialize(); let config = { ...c.resolvedSnapshot().config, maxSteps: 1, maxBenchmarkTasks: 1 }
  const p = store.createProject({ mode: 'benchmark', title: 'questions', origin: 'local fixture', goal: 'verify' }).project
  for (const taskKey of ['A', 'B']) store.createGraph(p.id, { taskKey, title: taskKey, origin: 'local fixture', goal: 'verify' })
  legion.claimCommand(p.id)
  const tools = legionTools(store, 'commander', p.id, 1, () => {}, config, undefined, () => config)
  const spawn = (taskKey: string, text = taskKey) => tools.find(t => t.name === 'legion_spawn')!.execute('fixture', { taskKey, role: 'soldier', mission: text })
  await spawn('A'); await spawn('A','queued direction'); config = {...config,maxSteps:2}; await spawn('A', 'independent evidence-based reinforcement')
  await assert.rejects(spawn('B'), /Question concurrency limit/)
  assert.equal(new LegionStore(store, p.id).questionCapacity(config.maxBenchmarkTasks).activeTasks, 1)
  config = { ...config, maxBenchmarkTasks: 2 }; await spawn('B')
  assert.equal(new LegionStore(store, p.id).questionCapacity(config.maxBenchmarkTasks).taskSlots, 0)
  const g = store.createProject({ mode: 'general', title: 'directions', origin: 'local fixture', goal: 'verify' }).project
  config={...config,maxSteps:1}
  legion.claimCommand(g.id)
  const general = legionTools(store, 'commander', g.id, 1, () => {}, config, undefined, () => config)
  const add = (description: string) => general.find(t => t.name === 'legion_step')!.execute('fixture', { projectId: g.id, description, sourceIds: ['origin'] })
  await add('direction one'); await add('direction two')
  config = { ...config, maxSteps: 2 }; await add('direction three')
  assert.equal(store.planningCapacity(g.id, config.maxSteps).remainingSteps, 2)
})

test('Scheduler fills question slots first, refills on completion and hot-loads without cancelling running work', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'question-dispatch-')), c = new Configuration(root); c.initialize()
  let config = { ...c.resolvedSnapshot().config, maxWorkers: 20, maxProjectWorkers: 10, maxRunningProjects: 5, maxBenchmarkTasks: 2, maxSteps: 2,
    workers: [{ name: 'pool', enabled: true, priority: 0, maxRunning: 20, backend: 'mock' as const, provider: 'mock', model: 'mock', roles: ['soldier' as const, 'soldier' as const] }] }
  const store = new Store(':memory:'), legion = new LegionStore(store), done = new Map<string, () => void>()
  const scheduler = new Scheduler(store, config, async ({ run, signal }) => new Promise<void>(resolve => { done.set(run.id, resolve); signal.addEventListener('abort', () => resolve(), { once: true }) }))
  const p = store.createProject({ mode: 'benchmark', title: 'questions', origin: 'local fixture', goal: 'verify' }).project
  for (const taskKey of ['A', 'B', 'C']) {
    store.createGraph(p.id, { taskKey, title: taskKey, origin: 'local fixture', goal: 'verify' })
    legion.spawn(p.id, mission(store, p.id, taskKey))
  }
  legion.spawn(p.id, mission(store, p.id, 'A', 'different mechanism'))
  try {
    scheduler.start(); await settle(); assert.equal(tasks(store, p.id), 2)
    const order = [...done.keys()].map(id => store.projectGraph(p.id, store.run(id).graphId!).taskKey)
    assert.deepEqual(order.slice(0, 2), ['A', 'B'], 'cover distinct questions before reinforcing A')
    config = { ...config, maxBenchmarkTasks: 3 }; scheduler.update(config); await settle(); assert.equal(tasks(store, p.id), 3)
    config = { ...config, maxBenchmarkTasks: 1 }; scheduler.update(config); await settle(); assert.equal(tasks(store, p.id), 3, 'lowering the cap must not abort work')
    for (const r of store.runsByStatus('running', p.id)) { store.addFact(p.id, 'verified fixture result', { runId: r.id, evidence: [{ description: 'local fixture only' }] }); done.get(r.id)!() }
    await settle(); assert.equal(store.runsByStatus('running', p.id).length, 0)
    const graph = store.createGraph(p.id, { taskKey: 'D', title: 'D', origin: 'local fixture', goal: 'verify' })
    legion.spawn(p.id, mission(store, p.id, 'D')); await settle(); assert.equal(tasks(store, p.id), 1)
    assert.equal(store.runsByStatus('running', p.id)[0].graphId, graph.id)
  } finally { await scheduler.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('General Max Step limits execution of existing queued directions, excludes unmet dependencies and hot-loads upward', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'general-frontier-')), c = new Configuration(root); c.initialize()
  const config = { ...c.resolvedSnapshot().config, maxWorkers: 20, maxProjectWorkers: 10, maxSteps: 2,
    workers: [{ name: 'pool', enabled: true, priority: 0, maxRunning: 20, backend: 'mock' as const, provider: 'mock', model: 'mock', roles: ['soldier' as const] }] }
  const store = new Store(':memory:'), done = new Map<string, () => void>()
  const scheduler = new Scheduler(store, config, async ({ run, signal }) => new Promise<void>(resolve => { done.set(run.id, resolve); signal.addEventListener('abort', () => resolve(), { once: true }) }))
  const p = store.createProject({ mode: 'general', title: 'directions', origin: 'local fixture', goal: 'verify' }).project
  store.stepLimit=()=>null
  const first = store.addStep(p.id, { description: 'independent A', sourceIds: ['origin'] })
  store.addStep(p.id, { description: 'independent B', sourceIds: ['origin'] })
  store.addStep(p.id, { description: 'independent C', sourceIds: ['origin'] })
  const dependent = store.addStep(p.id, { description: 'needs actual A result', sourceIds: ['origin'], dependsOn: [first.id] })
  try {
    scheduler.start(); await settle(); assert.equal(store.runsByStatus('running', p.id).length, 2)
    assert(!store.runsByStatus('running', p.id).some(r => r.stepId === dependent.id))
    scheduler.update({ ...config, maxSteps: 3 }); await settle(); assert.equal(store.runsByStatus('running', p.id).length, 3)
    scheduler.update({ ...config, maxSteps: 1 }); await settle(); assert.equal(store.runsByStatus('running', p.id).length, 3)
    for (const r of store.runsByStatus('running', p.id)) { store.addFact(p.id, 'verified fixture result', { runId: r.id, evidence: [{ description: 'local fixture only' }] }); done.get(r.id)!() }
    await settle(); assert.equal(store.runsByStatus('running', p.id).length, 1)
    assert.equal(store.runsByStatus('running', p.id)[0].stepId, dependent.id)
  } finally { await scheduler.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('unknown outcomes retain a question slot and are never replayed to fill concurrency', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'unknown-question-')), c = new Configuration(root); c.initialize()
  const config = { ...c.resolvedSnapshot().config, maxBenchmarkTasks: 1, workers: [{ name: 'pool', enabled: true, priority: 0, maxRunning: 4, backend: 'mock' as const, provider: 'mock', model: 'mock', roles: ['soldier' as const] }] }
  const store = new Store(':memory:'), p = store.createProject({ mode: 'benchmark', title: 'unknown', origin: 'local fixture', goal: 'verify' }).project, legion = new LegionStore(store, p.id)
  for (const taskKey of ['A','B']) store.createGraph(p.id, { taskKey, title: taskKey, origin: 'local fixture', goal: 'verify' })
  const first = legion.spawn(p.id, mission(store, p.id, 'A')), run = store.claim(p.id, 'execute', config.workers[0], first.id)
  store.finishRun(run.id, 'unknown', 'external result requires verification')
  assert.equal(legion.questionCapacity(1).activeTasks, 1)
  assert.throws(() => legion.spawn(p.id, mission(store, p.id, 'B'), 1), /Question concurrency limit/)
  legion.spawn(p.id, mission(store, p.id, 'B'))
  let calls = 0
  const scheduler = new Scheduler(store, config, async () => { calls++ })
  try { scheduler.start(); await settle(); assert.equal(calls, 0); assert.equal(store.run(run.id).status, 'unknown') }
  finally { await scheduler.close(); store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('settings and planner contracts retain one Max Step setting for both modes', () => {
  const root = path.resolve(import.meta.dirname, '../../..'), html = readFileSync(root + '/static/index.html', 'utf8')
  assert(html.includes('最大题目并发')); assert(html.includes('每张 Graph 执行 Step 上限'))
  assert(html.includes('max_benchmark_tasks:Number(value.tasks.commander.max_benchmark_tasks)'))
  const general = readFileSync(root + '/packages/redtrace-engine/prompts/general-planner.md', 'utf8')
  const benchmark = readFileSync(root + '/packages/redtrace-engine/prompts/benchmark-commander.md', 'utf8')
  assert(general.includes('not a creation budget or a target queue length'))
  assert(benchmark.includes('Fill distinct eligible tasks up to configured targetTasks before reinforcement'))
  assert(benchmark.includes('Max Step caps claimed execution Steps per Graph'))
})

test('native planners fill distinct ready slots and read hot-loaded targets in the same Benchmark Session', { timeout: 30000 }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'native-planning-capacity-')), configuration = new Configuration(root); configuration.initialize()
  const store = new Store(':memory:'), legion = new LegionStore(store), observed: any[] = []
  const benchmark = store.createProject({ mode: 'benchmark', title: 'questions', origin: 'local fixture', goal: 'verify' }).project
  const general = store.createProject({ mode: 'general', title: 'directions', origin: 'local fixture', goal: 'verify' }).project
  for (const taskKey of ['A','B','C']) store.createGraph(benchmark.id, { taskKey, title: taskKey, origin: 'local fixture', goal: 'verify' })
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk
    const body = domainFixtureRequest(JSON.parse(raw),res), text = body.messages.map((m: any) => typeof m.content === 'string' ? m.content : (m.content ?? []).map((b: any) => b.text ?? '').join('\n')).join('\n')
    const id = text.match(/Assigned Project=(proj_\d+)/)![1]
    const capacity = JSON.parse(text.match(/Live planning capacity: (\{[^\n]+\})/)![1]); observed.push({ id, ...capacity })
    const bench = id === benchmark.id
    const queued=store.nodes(general.id,['step']).length
    const available = bench ? capacity.taskSlots : Math.max(0,Math.min(3,capacity.maxSteps)-queued)
    const name = available > 0 ? bench ? 'legion_spawn' : 'legion_step' : bench ? 'legion_wait' : 'legion_finish'
    const args = available > 0 ? bench ? { taskKey: capacity.unassignedTaskKeys[0], role: 'soldier', mission: 'recon independent question ' + capacity.unassignedTaskKeys[0] }
      : { projectId: id, description: 'distinct ready direction ' + (queued + 1), sourceIds: ['origin'] }
      : bench ? {through:0} : { processed: {}, state: 'Existing independent directions cover configured Max Step; wait for new evidence.' }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call-' + observed.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }] }) + '\n\ndata: [DONE]\n\n')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  configuration.commit(configuration.read().revision, raw => {
    raw.runtime = { max_workers: 20, max_project_workers: 10, max_running_projects: 5 }
    raw.tasks!.commander.max_intents = 2; raw.tasks!.commander.max_benchmark_tasks = 2
    raw.providers = { fixture: { api: 'openai-completions', base_url: 'http://127.0.0.1:' + (server.address() as any).port + '/v1', api_key: 'fixture', models: [{ id: 'fixture', context_window: 100000, max_tokens: 1000, reasoning: 'off', reasoning_efforts: false }] } }
    raw.workers = [{ name: 'general', provider: 'fixture', model: 'fixture', roles: ['commander','general'], max_running: 5 }]
  })
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'), ctx = new Context()
  const engine: any = { store, legion, configuration, commanderSessions: new Map() }
  try {
    for (const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js','packages/redtrace-dsh/lib/core.js']) { const m = await load(file); await ctx.plugin(m.default ?? m).await() }
    const persistence = await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'); await ctx.plugin(persistence, { root: root + '/sessions' }).await()
    const llm = await import(new URL('../compat/llm.mjs', import.meta.url).href)
    await ctx.plugin(llm, { providers: providerProfiles(configuration.resolvedSnapshot().config).providers, credentialSource: { root, filename: configuration.filename, revision: configuration.read().revision } }).await()
    const { runCommander } = await import(new URL('../compat/legion.mjs', import.meta.url).href)
    const cycle = (id: string) => runCommander(ctx, engine, configuration.resolvedSnapshot().config.workers[0], AbortSignal.timeout(10000), id)
    await cycle(benchmark.id); await cycle(general.id)
    assert.equal(legion.questionCapacity.call(new LegionStore(store, benchmark.id), 2).activeTasks, 2)
    assert.equal(store.nodeCount(general.id,'step'), 2)
    const agent = engine.commanderSessions.get(benchmark.id).handle.agent
    configuration.commit(configuration.read().revision, raw => { raw.tasks!.commander.max_intents = 3; raw.tasks!.commander.max_benchmark_tasks = 3 })
    await cycle(benchmark.id); await cycle(general.id)
    assert.equal(engine.commanderSessions.get(benchmark.id).handle.agent, agent)
    assert.equal(new LegionStore(store, benchmark.id).questionCapacity(3).activeTasks, 3)
    assert.equal(store.nodeCount(general.id,'step'), 3)
    configuration.commit(configuration.read().revision, raw => { raw.tasks!.commander.max_benchmark_tasks = 5; raw.tasks!.commander.max_intents = 5 })
    await cycle(benchmark.id); await cycle(general.id)
    assert.equal(store.nodes(benchmark.id, ['step']).length, 3, 'fewer remaining questions: do not invent or duplicate missions')
    assert.equal(store.nodes(general.id, ['step']).length, 3, 'fewer distinct viable directions: do not manufacture work to fill Max Step')
    assert(observed.some(c => c.id === general.id && c.maxSteps === 3 && c.remainingSteps === 3))
    assert(observed.some(c => c.id === benchmark.id && c.maxTasks === 5 && c.targetTasks === 3 && c.taskSlots === 0))
  } finally {
    for (const resident of engine.commanderSessions.values()) await resident.handle.dispose()
    await ctx.fiber.dispose(); store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true })
  }
})
