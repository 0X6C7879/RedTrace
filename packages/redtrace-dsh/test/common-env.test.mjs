import assert from 'node:assert/strict'
import test from 'node:test'

import { applyCommonEnv } from '../lib/domain.js'
import { scrubbedParentEnv } from '../../../vendor/deepseek-harness/packages/subprocess/subprocess/lib/index.js'

test('applyCommonEnv publishes values and the allowlist, and drops removed names', () => {
  const env = { DSH_FORWARD_ENV: 'OLD_TOKEN,OTHER' , OLD_TOKEN: 'stale', KEEP: 'yes' }
  applyCommonEnv({ BENCHMARK_TOKEN: 'secret', BENCHMARK_BASE_URL: 'https://benchmark.test' }, env)
  assert.equal(env.BENCHMARK_TOKEN, 'secret')
  assert.equal(env.BENCHMARK_BASE_URL, 'https://benchmark.test')
  assert.equal(env.OLD_TOKEN, undefined)
  assert.equal(env.DSH_FORWARD_ENV, 'BENCHMARK_BASE_URL,BENCHMARK_TOKEN')
  assert.equal(env.KEEP, 'yes')

  applyCommonEnv({ BENCHMARK_BASE_URL: 'https://v2.test' }, env)
  assert.equal(env.BENCHMARK_TOKEN, undefined)
  assert.equal(env.DSH_FORWARD_ENV, 'BENCHMARK_BASE_URL')
})

test('applyCommonEnv with no common_env clears the allowlist', () => {
  const env = { DSH_FORWARD_ENV: 'BENCHMARK_TOKEN', BENCHMARK_TOKEN: 'secret' }
  applyCommonEnv(undefined, env)
  assert.equal(env.BENCHMARK_TOKEN, undefined)
  assert.equal(env.DSH_FORWARD_ENV, '')
})

test('scrubbedParentEnv keeps allowlisted credential-shaped names and drops the rest', () => {
  const previous = { ...process.env }
  try {
    process.env.DSH_FORWARD_ENV = 'BENCHMARK_TOKEN,benchmark lowercase x-BAD'
    process.env.BENCHMARK_TOKEN = 'deliberate'
    process.env.BENCHMARK_BASE_URL = 'https://benchmark.test'
    process.env.PROVIDER_API_KEY = 'must-not-leak'
    const env = scrubbedParentEnv()
    assert.equal(env.BENCHMARK_TOKEN, 'deliberate')
    assert.equal(env.BENCHMARK_BASE_URL, 'https://benchmark.test')
    assert.equal(env.PROVIDER_API_KEY, undefined)
    assert.equal(env.DSH_FORWARD_ENV, undefined)
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in previous)) delete process.env[key]
    }
    Object.assign(process.env, previous)
  }
})
