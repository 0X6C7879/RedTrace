import { createModels, createProvider, getSupportedThinkingLevels } from '@earendil-works/pi-ai'
import type { Api, Model, ProviderStreams, ThinkingLevelMap } from '@earendil-works/pi-ai'
import type { ThinkingLevel } from '@earendil-works/pi-agent-core'
import type { EngineConfig, Worker } from './types.ts'

export async function modelSession(config: EngineConfig, worker: Worker) {
  const provider = config.providers[worker.provider], entry = provider?.models.find(m => m.id === worker.model)
  if (!provider || !entry) throw new Error(`Model not configured: ${worker.provider}/${worker.model}`)
  const apiKey = provider.apiKey ?? (provider.apiKeyEnv ? process.env[provider.apiKeyEnv] : undefined)
  if (!apiKey) throw new Error(`Provider credential unavailable: ${worker.provider}`)
  const streams: ProviderStreams = provider.api === 'anthropic-messages'
    ? await import('@earendil-works/pi-ai/api/anthropic-messages')
    : provider.api === 'openai-responses' ? await import('@earendil-works/pi-ai/api/openai-responses')
      : await import('@earendil-works/pi-ai/api/openai-completions')
  const thinkingFormat: 'deepseek' | 'openai' | undefined = entry.thinkingFormat === 'deepseek' || entry.thinkingFormat === 'openai' ? entry.thinkingFormat : undefined
  const compat = provider.api === 'openai-completions' ? { supportsDeveloperRole: false, ...(thinkingFormat ? { thinkingFormat } : {}) } : thinkingFormat ? { thinkingFormat } : undefined
  const model: Model<Api> = { id: entry.id, name: entry.id, api: provider.api, provider: worker.provider, baseUrl: provider.baseUrl,
    reasoning: entry.reasoningEfforts !== false && entry.thinkingFormat !== 'none', input: ['text', 'image'], contextWindow: entry.contextWindow, maxTokens: entry.maxTokens,
    ...(entry.reasoningEfforts && typeof entry.reasoningEfforts === 'object' ? { thinkingLevelMap: entry.reasoningEfforts as ThinkingLevelMap } : {}),
    ...(compat ? { compat } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  const models = createModels()
  models.setProvider(createProvider({ id: worker.provider, models: [model], api: streams, auth: { apiKey: { name: worker.provider, resolve: async () => ({ auth: { apiKey }, source: 'RedTrace configuration' }) } } }))
  const supported = getSupportedThinkingLevels(model)
  const requested = entry.reasoning ?? 'auto_max'
  const thinkingLevel: ThinkingLevel = requested === 'auto_max' ? supported.at(-1) ?? 'off' : requested as ThinkingLevel
  if (thinkingLevel !== 'off' && !supported.includes(thinkingLevel)) throw new Error(`Model does not support reasoning level ${thinkingLevel}`)
  return { models, model, thinkingLevel }
}
