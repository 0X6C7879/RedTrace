import type { EngineConfig, Provider } from './types.ts'

// Unknown gateway IDs need an explicit declaration; a settings label is not capability evidence.
export function modelReasoningEfforts(model: Provider['models'][number]) {
  if (model.thinkingFormat === 'none' || model.reasoningEfforts === false) return false
  return model.reasoningEfforts && typeof model.reasoningEfforts === 'object' ? model.reasoningEfforts
    : undefined
}

/** DSH model declarations; protocol translation belongs solely to llm-pi-ai. */
export function providerProfiles(config: EngineConfig) {
  const providers: Record<string, unknown> = {}, env: Record<string, string> = {}
  for (const [name, p] of Object.entries(config.providers)) {
    const keyName = `REDTRACE_DSH_KEY_${Buffer.from(name).toString('hex').toUpperCase()}`
    const key = p.apiKey ?? (p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined)
    if (key) env[keyName] = key
    providers[name] = { displayName: name, api: p.api, baseURL: p.baseUrl.replace(/\/$/, ''), apiKeyEnv: keyName,
      models: p.models.map(m => ({ id: m.id, name: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: ['text', 'image'],
        ...(modelReasoningEfforts(m) === undefined ? {} : { reasoningEfforts: modelReasoningEfforts(m) }),
        ...(p.api === 'openai-completions' ? { compat: { supportsDeveloperRole: false,
          ...(['deepseek', 'openai'].includes(m.thinkingFormat ?? '') ? { thinkingFormat: m.thinkingFormat } : {}) } } : {}) })) }
  }
  return { providers, env }
}
