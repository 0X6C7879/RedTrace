import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { serveEngine } from '../src/index.ts'
import { graphTools } from '../src/runner.ts'
import { validateTaskPlugins } from '../src/task-plugins.ts'
import type { EngineConfig, Step, Worker } from '../src/types.ts'

const worker: Worker = { name: 'fixture', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: true, explore: true, bootstrap: true, maxRunning: 4, priority: 0 }
const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 4, maxProjectWorkers: 4, maxRunningProjects: 1, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: '/tmp' }
const input = { description: 'Analyze fixture', sourceIds: ['origin'], plugins: ['redtrace-reverse'] }

test('task declarations are optional, validated and persisted without a database migration', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-step-plugins-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let store = new Store(path.join(root, 'state.db'))
  try {
    const id = store.createProject({ title: 'Tasks', origin: 'Scope', goal: 'Analyze', bootstrap: false }).project.id
    assert.equal(store.addStep(id, { description: 'Ordinary', sourceIds: ['origin'] }).plugins, undefined)
    for (const value of [null, {}, ['redtrace-core'], ['missing'], ['redtrace-reverse', 'redtrace-reverse']]) assert.throws(() => validateTaskPlugins(value), /Invalid task plugins/)
    const step = store.addStep(id, input)
    store.close(); store = new Store(path.join(root, 'state.db'))
    assert.deepEqual(store.node<Step>(id, step.id, 'step').plugins, input.plugins)
    store.updateStep(id, step.id, { plugins: [] })
    assert.equal(store.node<Step>(id, step.id, 'step').plugins, undefined)
  } finally { store.close() }
})

test('claim, pause/resume and replace preserve task permissions; running amend cannot change them', () => {
  const store = new Store(':memory:')
  try {
    const id = store.createProject({ title: 'Tasks', origin: 'Scope', goal: 'Analyze', bootstrap: false }).project.id
    const step = store.addStep(id, input), run = store.claim(id, 'execute', worker, step.id)
    store.finishRun(run.id, 'paused')
    assert.equal(store.claim(id, 'execute', worker, step.id).id, run.id)
    assert.deepEqual(store.node<Step>(id, step.id, 'step').plugins, input.plugins)
    const current = store.node<Step>(id, step.id, 'step')
    assert.throws(() => store.updateStep(id, step.id, { plugins: [], mode: 'amend', expectedVersion: current.version }), /require replace/)
    const next = store.updateStep(id, step.id, { description: 'Retry same task', mode: 'replace', expectedVersion: current.version })
    assert.deepEqual(next.plugins, input.plugins)
    assert.equal(next.replacementPending, true)
    store.finishRun(run.id, 'cancelled')
    assert.equal(store.node<Step>(id, next.id, 'step').status, 'pending')
  } finally { store.close() }
})

test('Reason selects plugins in its existing tools, with no MCP schemas or extra control tool', async () => {
  const store = new Store(':memory:')
  try {
    const id = store.createProject({ title: 'Tasks', origin: 'Scope', goal: 'Analyze', bootstrap: false }).project.id
    const run = store.claim(id, 'decide', worker)
    let allowed = true
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal, taskPluginAllowed: () => allowed }, () => {})
    assert.equal(tools.some(t => /mcp__rea__|reverse_tools|start_plugin/.test(t.name)), false)
    const add = tools.find(t => t.name === 'add_step')!, update = tools.find(t => t.name === 'update_step')!
    assert.ok(Buffer.byteLength(JSON.stringify(JSON.parse(JSON.stringify(add.parameters)).properties.plugins)) < 512)
    await add.execute('create', input)
    const step = store.nodes<Step>(id, ['step'])[0]
    assert.deepEqual(step.plugins, input.plugins)
    allowed = false
    await assert.rejects(add.execute('disabled', input), /Task plugin is disabled/)
    assert.equal(store.nodes(id, ['step']).length, 1)
    await update.execute('clear', { id: step.id, expectedVersion: step.version, plugins: [] })
    assert.equal(store.node<Step>(id, step.id, 'step').plugins, undefined)
  } finally { store.close() }
})

test('v2 and legacy HTTP contracts retain declarations, reject invalid values and allow clearing', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-step-plugins-api-'))
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  t.after(async () => { await engine.close(); rmSync(root, { recursive: true, force: true }) })
  const port = (engine.server.address() as { port: number }).port
  const request = async (url: string, method: string, data: unknown) => {
    const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) })
    return { status: r.status, data: await r.json() as Step & { project: { id: string } } }
  }
  const project = await request('/v2/projects', 'POST', { title: 'Task', origin: 'Scope', goal: 'Analyze', bootstrap: false })
  const base = `/v2/projects/${project.data.project.id}/steps`
  const step = await request(base, 'POST', input)
  assert.equal(step.status, 201); assert.deepEqual(step.data.plugins, input.plugins)
  assert.equal((await request(base, 'POST', { ...input, plugins: ['redtrace-core'] })).status, 422)
  assert.equal((await request(base, 'POST', { ...input, plugins: ['redtrace-reverse', 'redtrace-reverse'] })).status, 422)
  const cleared = await request(`${base}/${step.data.id}`, 'PATCH', { plugins: [], expectedVersion: step.data.version })
  assert.equal(cleared.status, 200); assert.equal(cleared.data.plugins, undefined)
  const legacy = await request(`/projects/${project.data.project.id}/intents`, 'POST', { from: ['origin'], description: input.description, creator: 'human', plugins: input.plugins })
  assert.equal(legacy.status, 201); assert.deepEqual(legacy.data.plugins, input.plugins)
})
