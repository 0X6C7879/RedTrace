import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveReasoningEffort } from '../lib/agent.js'

function llmWith(efforts) {
  return {
    async resolveModelInfo(provider, model) {
      return {
        provider,
        id: model,
        name: model,
        ...(efforts === undefined
          ? {}
          : { reasoning: { efforts: efforts.map(id => ({ id, name: id })) } }),
      }
    },
  }
}

test('auto_max selects the highest exact-model effort regardless of catalog order', async () => {
  const route = { provider: 'anthropic-gw', model: 'claude', reasoning: 'auto_max' }
  const effort = await resolveReasoningEffort(llmWith(['medium', 'off', 'xhigh', 'high']), route)
  assert.equal(effort, 'xhigh')
})

test('auto_max uses max when the exact route exposes it', async () => {
  const route = { provider: 'openai-gw', model: 'gpt', reasoning: 'auto_max' }
  assert.equal(await resolveReasoningEffort(llmWith(['off', 'high', 'max']), route), 'max')
})

test('auto_max preserves the provider default when no reasoning capability is known', async () => {
  const route = { provider: 'custom-gw', model: 'future-model', reasoning: 'auto_max' }
  assert.equal(await resolveReasoningEffort(llmWith(undefined), route), undefined)
})

test('an explicit effort is validated against the exact model capability', async () => {
  const route = { provider: 'glm-gw', model: 'glm', reasoning: 'high' }
  assert.equal(await resolveReasoningEffort(llmWith(['off', 'low', 'high']), route), 'high')
  await assert.rejects(
    resolveReasoningEffort(llmWith(['off', 'low']), route),
    /does not support configured reasoning effort "high"/,
  )
})

