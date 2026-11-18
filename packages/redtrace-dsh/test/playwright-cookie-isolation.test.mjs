import assert from 'node:assert/strict'
import test from 'node:test'
import { createContext } from '../../../skills/playwright-skill/lib/helpers.js'

test('Playwright does not inherit cookies from shared environment headers', async t => {
  const keys = ['PW_HEADER_NAME', 'PW_HEADER_VALUE', 'PW_EXTRA_HEADERS']
  const previous = keys.map(key => process.env[key])
  t.after(() => keys.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key]
    else process.env[key] = previous[i]
  }))
  const browser = { newContext: async ({ extraHTTPHeaders }) => extraHTTPHeaders }
  process.env.PW_HEADER_NAME = 'cOoKiE'
  process.env.PW_HEADER_VALUE = 'fixture=shared'
  assert.equal(await createContext(browser), undefined)

  delete process.env.PW_HEADER_NAME
  process.env.PW_EXTRA_HEADERS = JSON.stringify({ cOoKiE: 'fixture=shared', 'X-Fixture': 'retained' })
  assert.deepEqual(await createContext(browser), { 'X-Fixture': 'retained' })
  assert.deepEqual(await createContext(browser, { extraHTTPHeaders: { Cookie: 'fixture=explicit' } }),
    { 'X-Fixture': 'retained', Cookie: 'fixture=explicit' })
})
