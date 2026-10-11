import type { EngineConfig } from './types.ts'

/** DSH model declarations; protocol translation belongs solely to llm-pi-ai. */
export function providerProfiles(config: EngineConfig) {
  const providers: Record<string, unknown> = {}, env: Record<string, string> = {}
  for (const [name, p] of Object.entries(config.providers)) {
    const keyName = `REDTRACE_DSH_KEY_${Buffer.from(name).toString('hex').toUpperCase()}`
    const key = p.apiKey ?? (p.apiKeyEnv ? process.env[p.apiKeyEnv] : undefined)
    if (key) env[keyName] = key
    providers[name] = { displayName: name, api: p.api, baseURL: p.baseUrl.replace(/\/$/, ''), apiKeyEnv: keyName,
      models: p.models.map(m => ({ id: m.id, name: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens, input: ['text', 'image'],
        ...(m.thinkingFormat === 'none' ? { reasoningEfforts: false } : m.reasoningEfforts == null || m.reasoningEfforts === true ? {} : { reasoningEfforts: m.reasoningEfforts }),
        ...(p.api === 'openai-completions' ? { compat: { supportsDeveloperRole: false,
          ...(['deepseek', 'openai'].includes(m.thinkingFormat ?? '') ? { thinkingFormat: m.thinkingFormat } : {}) } } : {}) })) }
  }
  return { providers, env }
}
