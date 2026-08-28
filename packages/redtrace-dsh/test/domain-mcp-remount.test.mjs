import assert from 'node:assert/strict'
import test from 'node:test'

import { Domain, mcpSignature } from '../lib/domain.js'
import { disposeState, initState, state } from '../lib/state.js'

test('mcpSignature is key-order insensitive but content sensitive', () => {
  const a = [{ serverName: 'chrome-devtools', args: ['--headless'], env: { CI: '1' } }]
  const b = [{ env: { CI: '1' }, args: ['--headless'], serverName: 'chrome-devtools' }]
  assert.equal(mcpSignature(a), mcpSignature(b))

  const changed = [{ serverName: 'chrome-devtools', args: ['--headless', '--isolated'], env: { CI: '1' } }]
  assert.notEqual(mcpSignature(a), mcpSignature(changed))
  assert.notEqual(mcpSignature(a), mcpSignature([]))
})

test('Domain.refresh remounts MCP clients only when configs change', async () => {
  initState({ server: 'http://127.0.0.1:1', root: '/tmp', sessionRoot: '/tmp', skillsDir: '/tmp', workspacesDir: '/tmp' })
  try {
    const shared = state()
    const first = { revision: 'r1', workers: [], mcpConfigs: [{ serverName: 'a', command: 'npx' }] }
    const same = { revision: 'r1', workers: [], mcpConfigs: [{ command: 'npx', serverName: 'a' }] }
    const next = { revision: 'r2', workers: [], mcpConfigs: [{ serverName: 'b', command: 'npx' }] }
    const queue = [first, same, next]

    const originalFetch = globalThis.fetch
    const remounts = []
    shared.remountMcp = async configs => {
      remounts.push(configs)
      shared.mcpSignature = mcpSignature(configs)
    }
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify(queue.shift()) })

    const domain = new Domain({}, { server: 'http://127.0.0.1:1' })
    await domain.refresh()
    await domain.refresh()
    await domain.refresh()

    assert.equal(remounts.length, 2, 'remount on first sight and on change, not on identical configs')
    assert.equal(remounts[0][0].serverName, 'a')
    assert.equal(remounts[1][0].serverName, 'b')

    globalThis.fetch = originalFetch
  } finally {
    disposeState()
  }
})

test('Domain.refresh skips remount when the snapshot omits mcpConfigs', async () => {
  initState({ server: 'http://127.0.0.1:1', root: '/tmp', sessionRoot: '/tmp', skillsDir: '/tmp', workspacesDir: '/tmp' })
  try {
    const shared = state()
    const originalFetch = globalThis.fetch
    const remounts = []
    shared.remountMcp = async configs => { remounts.push(configs) }
    globalThis.fetch = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ revision: 'r1', workers: [] }) })

    const domain = new Domain({}, { server: 'http://127.0.0.1:1' })
    await domain.refresh()
    assert.equal(remounts.length, 0)

    globalThis.fetch = originalFetch
  } finally {
    disposeState()
  }
})
