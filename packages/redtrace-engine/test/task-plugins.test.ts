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

test('legacy task declarations are validated at compatibility boundaries but not stored in new Steps', t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-step-plugins-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  let store = new Store(path.join(root, 'state.db'))
  try {
    const id = store.createProject({ title: 'Tasks', origin: 'Scope', goal: 'Analyze', bootstrap: false }).project.id
    assert.equal(store.addStep(id, { description: 'Ordinary', sourceIds: ['origin'] }).plugins, undefined)
    for (const value of [null, {}, ['redtrace-core'], ['missing'], ['redtrace-reverse', 'redtrace-reverse']]) assert.throws(() => validateTaskPlugins(value), /Invalid task plugins/)
    const step = store.addStep(id, input)
    store.close(); store = new Store(path.join(root, 'state.db'))
    assert.equal(store.node<Step>(id, step.id, 'step').plugins, undefined)
    store.updateStep(id, step.id, { plugins: [] })
    assert.equal(store.node<Step>(id, step.id, 'step').plugins, undefined)
  } finally { store.close() }
})

test('legacy tool declarations do not revise a running contract; real replacements retain lifecycle checks', () => {
  const store = new Store(':memory:')
  try {
    const id = store.createProject({ title: 'Tasks', origin: 'Scope', goal: 'Analyze', bootstrap: false }).project.id
    const step = store.addStep(id, input), run = store.claim(id, 'execute', worker, step.id)
    store.finishRun(run.id, 'paused')
    assert.equal(store.claim(id, 'execute', worker, step.id).id, run.id)
    assert.equal(store.node<Step>(id, step.id, 'step').plugins, undefined)
    const current = store.node<Step>(id, step.id, 'step')
    const unchanged = store.updateStep(id, step.id, { plugins: [], mode: 'amend', expectedVersion: current.version })
    assert.equal(unchanged.planVersion, current.planVersion)
    assert.equal(unchanged.id, step.id)
    const next = store.updateStep(id, step.id, { description: 'Retry same task', mode: 'replace', expectedVersion: current.version })
    assert.equal(next.plugins, undefined)
    assert.equal(next.replacementPending, true)
    store.finishRun(run.id, 'cancelled')
    assert.equal(store.node<Step>(id, next.id, 'step').status, 'pending')
  } finally { store.close() }
})

test('Reason schemas do not select tools and plugin management does not block planning goals', async () => {
  const store = new Store(':memory:')
  try {
    const id = store.createProject({ title: 'Tasks', origin: 'Scope', goal: 'Analyze', bootstrap: false }).project.id
    const run = store.claim(id, 'decide', worker)
    let allowed = true
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal, taskPluginAllowed: () => allowed }, () => {})
    assert.equal(tools.some(t => /mcp__rea__|reverse_tools|start_plugin/.test(t.name)), false)
    const add = tools.find(t => t.name === 'add_step')!, update = tools.find(t => t.name === 'update_step')!
    assert.equal(JSON.parse(JSON.stringify(add.parameters)).properties.plugins, undefined)
    assert.equal(JSON.parse(JSON.stringify(add.parameters)).properties.requires, undefined)
    await add.execute('create', input)
    const step = store.nodes<Step>(id, ['step'])[0]
    assert.equal(step.plugins, undefined)
    allowed = false
    await add.execute('disabled-policy-does-not-change-goal', input)
    assert.equal(store.nodes(id, ['step']).length, 2)
    await update.execute('clear', { id: step.id, expectedVersion: step.version, plugins: [] })
    assert.equal(store.node<Step>(id, step.id, 'step').plugins, undefined)
  } finally { store.close() }
})

test('v2 and legacy HTTP contracts ignore valid legacy declarations and preserve input validation', async t => {
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
  assert.equal(step.status, 201); assert.equal(step.data.plugins, undefined)
  assert.equal((await request(base, 'POST', { ...input, plugins: ['redtrace-core'] })).status, 422)
  assert.equal((await request(base, 'POST', { ...input, plugins: ['redtrace-reverse', 'redtrace-reverse'] })).status, 422)
  const cleared = await request(`${base}/${step.data.id}`, 'PATCH', { plugins: [], expectedVersion: step.data.version })
  assert.equal(cleared.status, 200); assert.equal(cleared.data.plugins, undefined)
  const legacy = await request(`/projects/${project.data.project.id}/intents`, 'POST', { from: ['origin'], description: input.description, creator: 'human', plugins: input.plugins })
  assert.equal(legacy.status, 201); assert.equal(legacy.data.plugins, undefined)
})
