import { Configuration } from '../src/config.ts'
import { providerProfiles } from '../src/models.ts'
import { mount } from '../../redtrace-dsh/lib/loader.js'

export const name = 'redtrace-llm-pi-ai'
export const inject = ['llm']

/** One immutable credential generation, scoped to the native model adapter. */
export async function apply(ctx, config) {
  let keys = {}
  if (config.credentialSource) {
    const { root, filename, revision } = config.credentialSource
    const configuration = new Configuration(root, filename), saved = configuration.read()
    if (saved.revision !== revision) throw new Error('Model configuration changed before adapter activation')
    keys = providerProfiles(configuration.resolve(saved.raw)).env
  }
  const inherited = ctx.get('launchEnvironment')
  const scoped = ctx.isolate('launchEnvironment').isolate('credentials')
  const get = name => Object.hasOwn(keys, name) ? { value: keys[name], source: 'process' } : inherited?.get(name)
  scoped.provide('launchEnvironment', { get, getFrom: (name, sources) => sources.includes('process') && Object.hasOwn(keys, name)
    ? get(name) : inherited?.getFrom(name, sources) })
  // Generated model keys remain read-only, never copied into a plaintext store or process.env.
  await mount(scoped, 'vendor/deepseek-harness/packages/credentials/credentials-local/lib/index.js', { watch: false })
  await mount(scoped, 'vendor/deepseek-harness/packages/llm/llm-pi-ai/lib/index.js', { providers: config.providers ?? {} })
  installModelPolling(ctx, config.providers ?? {}, config.polling)
}

// pi-ai can emit usage before a failed finish; only content commits an attempt.
function canFailover(reason, signal) {
  if (signal?.aborted || reason.kind !== 'error') return false
  const failure = reason.failure
  // Sapper: transient throttling belongs to DSH retry, not credential rotation.
  if (failure.code === 'RATE_LIMIT') return false
  if (['INVALID_REQUEST', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED'].includes(failure.code)) return false
  const status = failure.status ?? Number(failure.message.match(/\b([45]\d{2})\b/)?.[1])
  if (status) return [401, 402, 403, 404, 408, 429].includes(status) || status >= 500
  return ['AUTH', 'QUOTA_EXCEEDED', 'RATE_LIMIT', 'SERVER', 'TIMEOUT', 'TRANSPORT', 'STREAM_CLOSED', 'EMPTY_RESPONSE', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL'].includes(failure.code)
}

const addUsage = (left = {}, right = {}) => Object.fromEntries(
  [...new Set([...Object.keys(left), ...Object.keys(right)])].map(key => [key, (left[key] ?? 0) + (right[key] ?? 0)]),
)

/** Same exact model ID shares one round-robin cursor across Workers. */
export function installModelPolling(ctx, providers, polling = {}) {
  if (polling.enabled === false) return
  const groups = new Map(), cursors = new Map(), routed = new WeakSet()
  for (const [provider, profile] of Object.entries(providers)) {
    for (const model of profile.models ?? []) {
      const members = groups.get(model.id) ?? []
      if (!members.includes(provider)) members.push(provider)
      groups.set(model.id, members)
    }
  }
  for (const [model, names] of Object.entries(polling.models ?? {})) groups.set(model, names.filter(name => groups.get(model)?.includes(name)))
  ctx.on('llm/stream', async function* (options, next) {
    const members = groups.get(options.model)
    if (routed.has(options) || !members?.includes(options.provider) || members.length < 2) { yield* next(); return }
    const start = cursors.get(options.model) ?? (Object.hasOwn(polling.models ?? {}, options.model) ? 0 : members.indexOf(options.provider))
    cursors.set(options.model, (start + 1) % members.length)
    const session = options.sessionId ? ctx.get('sessions')?.get(options.sessionId) : undefined
    let spent = {}
    for (let attempt = 0; attempt < members.length; attempt++) {
      if (options.signal?.aborted) {
        yield { type: 'finish', reason: { kind: 'aborted', failure: { code: 'ABORTED', message: 'LLM polling aborted by caller' } } }
        return
      }
      const provider = members[(start + attempt) % members.length]
      const changed = provider !== options.provider
      // A response from another endpoint must not replay opaque state attributed to the Worker's endpoint.
      const request = changed ? { ...options, provider, messages: options.messages.map(message =>
        message.role === 'assistant' && message.source?.replayState !== undefined
          ? { ...message, source: { ...message.source, replayState: undefined } } : message) } : options
      if (changed) routed.add(request)
      session?.append('llm/polling', { requestedProvider: options.provider, provider, model: options.model, attempt: attempt + 1 })
      let emitted = false, usage
      for await (const chunk of changed ? ctx.get('llm').stream(request) : next()) {
        if (chunk.type === 'usage') { usage = chunk.usage; continue }
        if (chunk.type === 'finish') {
          if (!emitted && attempt + 1 < members.length && canFailover(chunk.reason, options.signal)) {
            spent = addUsage(spent, usage)
            const code = chunk.reason.failure.code
            session?.append('llm/polling-failed', { provider, model: options.model, code })
            ctx.logger.warn('LLM polling: %s/%s failed (%s); trying next provider', provider, options.model, code)
            break
          }
          if (usage || Object.keys(spent).length) yield { type: 'usage', usage: addUsage(spent, usage) }
          yield changed ? { ...chunk, replayState: undefined } : chunk
          return
        }
        emitted = true
        yield chunk
      }
    }
  })
}

export async function probeModel(ctx, configuration, config, worker, signal) {
  let llm
  const saved = configuration.read()
  const fiber = ctx.isolate('llm').plugin(async scoped => {
    await mount(scoped, 'vendor/deepseek-harness/packages/llm/llm/lib/index.js')
    await mount(scoped, 'packages/redtrace-engine/compat/llm.mjs', {
      // Connection tests must exercise the selected endpoint, never a healthy sibling.
      providers: { [worker.provider]: providerProfiles(config).providers[worker.provider] },
      credentialSource: { root: configuration.root, filename: configuration.filename, revision: saved.revision },
    })
    llm = scoped.get('llm')
  })
  try {
    await fiber.await()
    let finished = false
    for await (const chunk of llm.stream({ provider: worker.provider, model: worker.model,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Reply with OK.' }] }], maxTokens: 64, signal })) {
      if (chunk.type === 'finish') {
        if (!['stop', 'length'].includes(chunk.reason.kind)) throw new Error(chunk.reason.failure?.message ?? `Provider probe ended: ${chunk.reason.kind}`)
        finished = true
      }
    }
    if (!finished) throw new Error('Provider stream ended without completion')
  } finally { await fiber.dispose() }
}

export async function admitToolImages(attachments, result) {
  const images = result.content.filter(block => block.type === 'image' && typeof block.data === 'string')
  if (!images.length) return result
  if (!attachments) throw new Error('DSH attachment service is unavailable')
  const refs = await attachments.saveImages(images.map(image => ({ data: Buffer.from(image.data, 'base64'), mediaType: image.mimeType })))
  let next = 0
  return { ...result, content: result.content.map(block => images.includes(block) ? { type: 'image', attachment: refs[next++] } : block) }
}
