import assert from 'node:assert/strict'
import test from 'node:test'

import { mcpSignature } from '../lib/domain.js'

test('mcpSignature is key-order insensitive but content sensitive', () => {
  const a = [{ serverName: 'chrome-devtools', args: ['--headless'], env: { CI: '1' } }]
  const b = [{ env: { CI: '1' }, args: ['--headless'], serverName: 'chrome-devtools' }]
  assert.equal(mcpSignature(a), mcpSignature(b))

  const changed = [{ serverName: 'chrome-devtools', args: ['--headless', '--isolated'], env: { CI: '1' } }]
  assert.notEqual(mcpSignature(a), mcpSignature(changed))
  assert.notEqual(mcpSignature(a), mcpSignature([]))
})
