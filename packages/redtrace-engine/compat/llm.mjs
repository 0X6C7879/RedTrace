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
}

export async function probeModel(ctx, configuration, config, worker, signal) {
  let llm
  const saved = configuration.read()
  const fiber = ctx.isolate('llm').plugin(async scoped => {
    await mount(scoped, 'vendor/deepseek-harness/packages/llm/llm/lib/index.js')
    await mount(scoped, 'packages/redtrace-engine/compat/llm.mjs', {
      providers: providerProfiles(config).providers,
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
