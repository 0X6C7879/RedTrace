import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as contractsApply } from '../lib/contracts.js'
import { apply as resourceApply } from '../lib/resource.js'

test('registers only the contracts allowed for each task', async () => {
  const expected = {
    reason: [
      'redtrace_intent_create',
      'redtrace_reason_noop',
      'redtrace_project_complete',
      'redtrace_graph_node',
      'redtrace_graph_context',
      'redtrace_graph_path',
    ],
    bootstrap: ['redtrace_bootstrap_conclude'],
    explore: ['redtrace_explore_conclude'],
  }
  for (const [task, names] of Object.entries(expected)) {
    const tools = []
    await contractsApply({ tools: { register(tool) { tools.push(tool) } } }, { types: [task] })
    assert.deepEqual(tools.map(tool => tool.name), names)
    for (const tool of tools) {
      assert.equal(tool.parameters.type, 'object')
      assert.equal(typeof tool.parameters.properties, 'object')
    }
  }
})

test('registers shared-resource tools; explore may register, bootstrap reads only', async () => {
  const explore = []
  await resourceApply({ tools: { register(tool) { explore.push(tool) } } }, { register: true, types: ['explore'] })
  assert.deepEqual(explore.map(tool => tool.name), [
    'redtrace_resource_register',
    'redtrace_resource_list',
    'redtrace_resource_get',
  ])

  const bootstrap = []
  await resourceApply({ tools: { register(tool) { bootstrap.push(tool) } } }, { register: false, types: ['bootstrap'] })
  assert.deepEqual(bootstrap.map(tool => tool.name), ['redtrace_resource_list', 'redtrace_resource_get'])
  for (const tool of [...explore, ...bootstrap]) {
    assert.equal(tool.parameters.type, 'object')
  }
})

test('bootstrap conclude passes complete_description through; explore never does', async () => {
  const bootstrap = []
  await contractsApply({ tools: { register(tool) { bootstrap.push(tool) } } }, { types: ['bootstrap'] })
  const bootstrapConclude = bootstrap.find(tool => tool.name === 'redtrace_bootstrap_conclude')
  assert.deepEqual(Object.keys(bootstrapConclude.parameters.properties).sort(), ['complete_description', 'description'])
  assert.deepEqual(bootstrapConclude.parameters.required, ['description'])

  const explore = []
  await contractsApply({ tools: { register(tool) { explore.push(tool) } } }, { types: ['explore'] })
  const exploreConclude = explore.find(tool => tool.name === 'redtrace_explore_conclude')
  assert.deepEqual(Object.keys(exploreConclude.parameters.properties), ['description'])

  const previous = {
    type: process.env.REDTRACE_TASK_TYPE,
    project: process.env.REDTRACE_PROJECT_ID,
    worker: process.env.REDTRACE_WORKER,
    server: process.env.REDTRACE_SERVER,
    fetch: globalThis.fetch,
  }
  process.env.REDTRACE_TASK_TYPE = 'bootstrap'
  process.env.REDTRACE_PROJECT_ID = 'proj/1'
  process.env.REDTRACE_WORKER = 'boot'
  process.env.REDTRACE_SERVER = 'http://redtrace.test'
  process.env.REDTRACE_INTENT_ID = 'i001'
  const observed = []
  globalThis.fetch = async (url, init) => {
    observed.push({ url: String(url), body: JSON.parse(init.body) })
    return { ok: true, async json() { return { fact: { id: 'f001' }, intent: {}, completed: true } } }
  }
  let concluded = false
  try {
    await bootstrapConclude.execute(
      { description: 'flag captured', complete_description: 'goal satisfied' },
      { concludeTurn() { concluded = true } },
    )
    assert.equal(observed.length, 1)
    assert.equal(observed[0].url, 'http://redtrace.test/projects/proj%2F1/intents/i001/conclude')
    assert.deepEqual(observed[0].body, {
      worker: 'boot',
      description: 'flag captured',
      complete_description: 'goal satisfied',
    })
    assert.equal(concluded, true)

    process.env.REDTRACE_TASK_TYPE = 'explore'
    await exploreConclude.execute({ description: 'found something' }, { concludeTurn() {} })
    assert.equal(observed.length, 2)
    assert.deepEqual(observed[1].body, { worker: 'boot', description: 'found something' })
  } finally {
    delete process.env.REDTRACE_INTENT_ID
    for (const [name, value] of [
      ['REDTRACE_TASK_TYPE', previous.type], ['REDTRACE_PROJECT_ID', previous.project],
      ['REDTRACE_WORKER', previous.worker], ['REDTRACE_SERVER', previous.server],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    globalThis.fetch = previous.fetch
  }
})

test('Reason graph recall queries the canonical Blackboard without ending the turn', async () => {
  const tools = []
  await contractsApply({ tools: { register(tool) { tools.push(tool) } } }, { types: ['reason'] })
  const graphNode = tools.find(tool => tool.name === 'redtrace_graph_node')
  const previous = {
    type: process.env.REDTRACE_TASK_TYPE,
    project: process.env.REDTRACE_PROJECT_ID,
    worker: process.env.REDTRACE_WORKER,
    server: process.env.REDTRACE_SERVER,
    fetch: globalThis.fetch,
  }
  process.env.REDTRACE_TASK_TYPE = 'reason'
  process.env.REDTRACE_PROJECT_ID = 'proj/1'
  process.env.REDTRACE_WORKER = 'reasoner'
  process.env.REDTRACE_SERVER = 'http://redtrace.test'
  let observed
  globalThis.fetch = async (url, init) => {
    observed = { url: String(url), init }
    return { ok: true, async json() { return { found: true, node: { id: 'f 1' } } } }
  }
  let concluded = false
  try {
    const value = await graphNode.execute({ node_id: 'f 1' }, { concludeTurn() { concluded = true } })
    assert.deepEqual(value, { found: true, node: { id: 'f 1' } })
    assert.equal(observed.url, 'http://redtrace.test/projects/proj%2F1/blackboard/nodes/f%201')
    assert.equal(observed.init.headers['X-RedTrace-Worker'], 'reasoner')
    assert.equal(concluded, false)
  } finally {
    for (const [name, value] of [
      ['REDTRACE_TASK_TYPE', previous.type], ['REDTRACE_PROJECT_ID', previous.project],
      ['REDTRACE_WORKER', previous.worker], ['REDTRACE_SERVER', previous.server],
    ]) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    globalThis.fetch = previous.fetch
  }
})
