import { Type } from 'typebox'
import { createHash } from 'node:crypto'
import { body } from './http.ts'
import type { Router } from './http.ts'
import type { Configuration, RawConfig } from './config.ts'
import { HttpError } from './types.ts'
import type { ProbeModel } from './index.ts'

const text = Type.String({ minLength: 1 }), revision = Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]+$' })
const positive = Type.Integer({ minimum: 1 }), policy = Type.Union(['auto_max', 'max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'off'].map(v => Type.Literal(v)))
const workerSchema = Type.Object({ expected_revision: revision, original_name: Type.Optional(Type.Union([text, Type.Null()])), name: text, provider: text, roles: Type.Optional(Type.Array(Type.Union(['commander','general','soldier','scout'].map(role => Type.Literal(role))), { uniqueItems: true })), model: Type.Optional(text), enabled: Type.Optional(Type.Boolean()), priority: Type.Integer(), max_running: positive })
const providerSchema = Type.Object({ expected_revision: revision, name: text, api: Type.Optional(Type.Union(['openai-completions', 'openai-responses', 'anthropic-messages'].map(v => Type.Literal(v)))), base_url: text, api_key: Type.Optional(Type.Union([Type.String(), Type.Null()])), api_key_env: Type.Optional(Type.Union([Type.String(), Type.Null()])), models: Type.Array(Type.Object({ id: text, context_window: Type.Optional(positive), max_tokens: Type.Optional(positive), reasoning: Type.Optional(policy), reasoning_efforts: Type.Optional(Type.Union([Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()])), Type.Boolean(), Type.Null()])), thinking_format: Type.Optional(Type.Union(['auto', 'deepseek', 'openai', 'none'].map(v => Type.Literal(v)))) }), { minItems: 1 }) })
export function configRoutes(router: Router, configuration: Configuration, probeModel?: ProbeModel) {
  const checkRevision = (expected: string) => { if (configuration.read().revision !== expected) throw new HttpError(409, 'worker configuration changed; reload before saving') }
  const workerIndex = (raw: RawConfig, name: string) => { const i = raw.workers.findIndex(w => w.name === name); if (i < 0) throw new HttpError(400, 'Worker not found'); return i }
  const workerValue = (b: any, previous?: RawConfig['workers'][number]) => ({ ...previous, ...(b.roles !== undefined ? { roles: b.roles } : {}), name: b.name, provider: b.provider, model: b.model ?? 'mock', enabled: b.enabled ?? true, priority: b.priority, max_running: b.max_running })
  const testCache = new Map<string, { at: number; value: { ok: boolean; status: number | null; duration_ms: number; detail: string; cached: boolean } }>()
  const probeWorker = async (b: any, original: string | null, signal: AbortSignal) => {
    checkRevision(b.expected_revision)
    const { raw: saved } = configuration.read(), raw = structuredClone(saved), i = original ? workerIndex(raw, original) : -1
    const value = workerValue(b, i >= 0 ? raw.workers[i] : undefined)
    if (i >= 0) raw.workers[i] = value; else raw.workers.push(value)
    const config = configuration.resolve(raw), worker = config.workers.find(w => w.name === b.name)!
    const key = createHash('sha256').update(JSON.stringify({ worker, provider: config.providers[worker.provider] })).digest('hex'), cached = testCache.get(key)
    if (cached && Date.now() - cached.at < 60000) return { ...cached.value, cached: true }
    const start = Date.now()
    if (worker.backend !== 'mock') {
      try {
        if (!probeModel) throw new Error('DSH model service is unavailable')
        await probeModel(config, worker, AbortSignal.any([signal, AbortSignal.timeout(30000)]))
      } catch { throw new HttpError(422, 'Provider connection test failed; verify the endpoint, model and credentials') }
    }
    const result = { ok: true, status: worker.backend === 'mock' ? null : 200, duration_ms: Date.now() - start, detail: worker.backend === 'mock' ? 'mock worker needs no connection' : 'Connection successful', cached: false }
    testCache.set(key, { at: Date.now(), value: result }); return result
  }
  router.add('POST', '/worker-config/providers/:provider/test', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: revision, model: text }))
    const { raw } = configuration.read()
    if (!raw.providers?.[c.params.provider]) throw new HttpError(404, 'Provider not found')
    const worker = raw.workers.find(w => w.provider === c.params.provider)
    return probeWorker({ ...worker, name: worker?.name ?? '__provider_probe', provider: c.params.provider, model: b.model, enabled: true, priority: worker?.priority ?? 0, max_running: worker?.max_running ?? 1, expected_revision: b.expected_revision }, worker?.name ?? null, c.signal)
  })
  router.add('GET', '/worker-config', () => configuration.snapshot())
  router.add('PUT', '/worker-config/llm-polling', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: revision, enabled: Type.Boolean(), models: Type.Record(Type.String(), Type.Array(text, { uniqueItems: true })) }))
    return configuration.commit(b.expected_revision, raw => { raw.llm_polling = { enabled: b.enabled, models: b.models } })
  })
  const task = Type.Object({ timeout: Type.Integer({ minimum: 5 }), conclude_timeout: Type.Integer({ minimum: 5 }) })
  router.add('PUT', '/worker-config/runtime-tasks', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: revision, runtime: Type.Object({ max_workers: positive, max_project_workers: positive, max_running_projects: positive }), tasks: Type.Object({ commander: Type.Object({ timeout: Type.Integer({ minimum: 5 }), conclude_timeout: Type.Integer({ minimum: 5 }), max_intents: Type.Optional(positive) }), general: task, soldier: task, scout: task }) }))
    return configuration.commit(b.expected_revision, raw => { raw.runtime = { ...raw.runtime, ...b.runtime }; raw.tasks = b.tasks })
  })
  router.add('PUT', '/worker-config/common-env', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: revision, entries: Type.Array(Type.Object({ name: text, value: Type.String() })) }))
    if (new Set(b.entries.map(e => e.name)).size !== b.entries.length) throw new HttpError(400, 'Duplicate environment names')
    if (b.entries.some(e => !/^[A-Z][A-Z0-9_]*$/.test(e.name))) throw new HttpError(422, 'Environment names must match ^[A-Z][A-Z0-9_]*$')
    return configuration.commit(b.expected_revision, raw => { raw.common_env = Object.fromEntries(b.entries.map(e => [e.name, e.value])) })
  })
  for (const method of ['POST', 'PUT']) router.add(method, `/worker-config/providers${method === 'PUT' ? '/:provider' : ''}`, async c => {
    const b = await body(c.req, providerSchema)
    const result = configuration.commit(b.expected_revision, raw => {
      raw.providers ??= {}; const original = method === 'PUT' ? raw.providers[c.params.provider] : undefined
      if (method === 'PUT' && !original) throw new HttpError(400, 'Provider not found')
      if (raw.providers[b.name] && (method === 'POST' || b.name !== c.params.provider)) throw new HttpError(409, 'Provider already exists')
      const value = { api: b.api ?? 'openai-completions' as const, base_url: b.base_url, api_key: b.api_key === null || b.api_key === undefined ? original?.api_key : b.api_key,
        api_key_env: b.api_key_env ?? undefined, models: b.models.map(m => ({ id: m.id, context_window: m.context_window ?? 1000000, max_tokens: m.max_tokens ?? 128000, reasoning: m.reasoning ?? 'auto_max', reasoning_efforts: m.reasoning_efforts, thinking_format: m.thinking_format ?? 'auto' })) }
      if (method === 'PUT' && b.name !== c.params.provider) { delete raw.providers[c.params.provider]; for (const w of raw.workers) if (w.provider === c.params.provider) w.provider = b.name }
      raw.providers[b.name] = value
      for (const [model, names] of Object.entries(raw.llm_polling?.models ?? {})) raw.llm_polling!.models![model] = names
        .map(name => method === 'PUT' && name === c.params.provider ? b.name : name)
        .filter(name => raw.providers![name]?.models.some(m => m.id === model))
    })
    if (method === 'POST') { c.res.statusCode = 201; const { send } = await import('./http.ts'); send(c.res, result, 201) } else return result
  })
  router.add('DELETE', '/worker-config/providers/:provider', c => {
    const expected = c.url.searchParams.get('expected_revision') ?? ''; if (!/^[a-f0-9]{64}$/.test(expected)) throw new HttpError(422, 'Invalid expected_revision')
    return configuration.commit(expected, raw => { if (!raw.providers?.[c.params.provider]) throw new HttpError(400, 'Provider not found'); if (raw.workers.some(w => w.provider === c.params.provider)) throw new HttpError(409, 'Provider is referenced by workers'); delete raw.providers[c.params.provider]; for (const names of Object.values(raw.llm_polling?.models ?? {})) { const i = names.indexOf(c.params.provider); if (i >= 0) names.splice(i, 1) } })
  })
  for (const method of ['POST', 'PUT']) router.add(method, `/worker-config/workers${method === 'PUT' ? '/:worker' : ''}`, async c => {
    const b = await body(c.req, workerSchema)
    await probeWorker(b, method === 'PUT' ? c.params.worker : null, c.signal)
    const result = configuration.commit(b.expected_revision, raw => {
      const i = method === 'PUT' ? workerIndex(raw, c.params.worker) : -1
      if (raw.workers.some((w, index) => index !== i && w.name === b.name)) throw new HttpError(409, 'Worker already exists')
      const value = workerValue(b, i >= 0 ? raw.workers[i] : undefined)
      if (i >= 0) raw.workers[i] = value; else raw.workers.push(value)
    })
    if (method === 'POST') { const { send } = await import('./http.ts'); send(c.res, result, 201) } else return result
  })
  router.add('POST', '/worker-config/workers/:worker/copy', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: revision }))
    const { raw } = configuration.read(), source = raw.workers[workerIndex(raw, c.params.worker)]
    if (source.provider === 'mock') throw new HttpError(400, 'mock Workers cannot be copied in the Web UI')
    let n = 1; while (raw.workers.some(w => w.name === `${source.name}-copy${n === 1 ? '' : n}`)) n++
    const copied = { ...source, name: `${source.name}-copy${n === 1 ? '' : n}`, expected_revision: b.expected_revision }
    await probeWorker(copied, null, c.signal)
    return configuration.commit(b.expected_revision, raw => {
      raw.workers.push({ ...source, name: copied.name })
    })
  })
  router.add('PATCH', '/worker-config/workers/:worker/enabled', async c => { const b = await body(c.req, Type.Object({ expected_revision: revision, enabled: Type.Boolean() })); if (b.enabled) { const { raw } = configuration.read(), worker = raw.workers[workerIndex(raw, c.params.worker)]; await probeWorker({ ...worker, expected_revision: b.expected_revision, enabled: true }, c.params.worker, c.signal) }; return configuration.commit(b.expected_revision, raw => { raw.workers[workerIndex(raw, c.params.worker)].enabled = b.enabled }) })
  router.add('DELETE', '/worker-config/workers/:worker', c => { const expected = c.url.searchParams.get('expected_revision') ?? ''; if (!/^[a-f0-9]{64}$/.test(expected)) throw new HttpError(422, 'Invalid expected_revision'); return configuration.commit(expected, raw => { raw.workers.splice(workerIndex(raw, c.params.worker), 1) }) })
  router.add('POST', '/worker-config/test', async c => {
    const b = await body(c.req, workerSchema); return probeWorker(b, b.original_name ?? null, c.signal)
  })
}
