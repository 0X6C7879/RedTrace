import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Configuration } from '../src/config.ts'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { providerProfiles } from '../src/models.ts'
import { createCommanderController } from '../compat/legion.mjs'
import { load } from '../../redtrace-dsh/lib/loader.js'

const directory = mkdtempSync(path.join(os.tmpdir(), 'redtrace-session-shutdown-'))
const configuration = new Configuration(directory)
configuration.initialize()
const store = new Store(path.join(directory, 'engine.db'))
const project = store.createProject({ mode: 'benchmark', title: 'Shutdown fixture', origin: 'Authorized local protocol fixture', goal: 'Retain original input across shutdown' }).project
const legion = new LegionStore(store, project.id)
const { promise: requested, resolve: modelRequested } = Promise.withResolvers()
const model = createServer(async (req, _res) => { for await (const _ of req) {} modelRequested() })
let ctx, controller
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  configuration.commit(configuration.read().revision, raw => {
    raw.providers = { fixture: { api: 'openai-completions', base_url: `http://127.0.0.1:${model.address().port}/v1`, api_key: 'fixture', models: [{ id: 'fixture', context_window: 20000, max_tokens: 512, reasoning: 'off', reasoning_efforts: false }] } }
    raw.workers = [{ name: 'fixture', roles: ['commander'], provider: 'fixture', model: 'fixture' }]
  })
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
  ctx = new Context()
  for (const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js', 'packages/redtrace-dsh/lib/core.js']) {
    const module = await load(file)
    await ctx.plugin(module.default ?? module).await()
  }
  const persistence = await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js')
  await ctx.plugin(persistence, { root: path.join(directory, 'sessions') }).await()
  const llm = await import('../compat/llm.mjs')
  await ctx.plugin(llm, { providers: providerProfiles(configuration.resolvedSnapshot().config).providers, credentialSource: { root: directory, filename: configuration.filename, revision: configuration.read().revision } }).await()
  controller = createCommanderController(ctx, { store, legion, configuration, scheduler: { maintenance: false, wake() {}, watchdog() {} } })
  controller.start()
  await requested
  const sessionId = legion.campaign().sessionId
  await Promise.all([ctx.fiber.dispose(), controller.close()])
  const campaign = legion.campaign()
  assert.equal(campaign.status, 'stopped')
  assert.ok(!campaign.error?.includes('flush'), campaign.error)
  assert.equal(campaign.pendingTools?.length ?? 0, 0)
  const reader = new Context()
  try {
    await reader.plugin(persistence, { root: path.join(directory, 'sessions') }).await()
    const handle = await reader.get('sessionPersistence').open(sessionId, 'read')
    try {
      const page = await handle.read()
      assert.ok(page.events.some(event => event.type === 'user/message'), 'shutdown must retain the original patrol input')
      assert.ok(page.events.some(event => event.type === 'system/message' && JSON.stringify(event.data).includes(project.objective)), 'shutdown must retain the original objective')
    } finally { await handle.close() }
  } finally { await reader.fiber.dispose() }
  console.log('CONCURRENT_SHUTDOWN=true; NO_UNDEFINED_FLUSH=true; SESSION_INPUT_DURABLE=true; pendingTools=0')
} finally {
  await controller?.close()
  await ctx?.fiber.dispose()
  store.close()
  model.closeAllConnections()
  await new Promise(resolve => model.close(resolve))
  rmSync(directory, { recursive: true, force: true })
}
