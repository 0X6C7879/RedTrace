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
