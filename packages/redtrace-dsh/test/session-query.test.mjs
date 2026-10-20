import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { load } from '../lib/loader.js'
import { PluginManager } from '../lib/plugins.js'
import { mountReasonTools } from '../../redtrace-engine/compat/cordis.mjs'

test('session query and identities stay absent for all roles, including an older manifest', async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'redtrace-no-session-query-'))
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  for (const file of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js', 'packages/redtrace-dsh/lib/core.js']) {
    const module = await load(file); await ctx.plugin(module.default ?? module).await()
  }
  const manifest = path.join(root, 'plugins.json')
  writeFileSync(manifest, JSON.stringify({ version: 1, enabled: ['redtrace-trace-search'] }))
  const manager = new PluginManager(ctx, { sessionRoot: root, pluginsManifest: manifest }, root)
  assert.equal(manager.running('redtrace-trace-search'), false)
  assert.ok(!manager.list().some(p => p.id === 'redtrace-trace-search'))
  await assert.rejects(manager.start('redtrace-trace-search'), /unknown plugin/)
  const { createScope } = await load('vendor/deepseek-harness/packages/core/scope/lib/index.js')
  for (const role of ['reason', 'explore', 'bootstrap']) {
    const carrier = ctx.plugin({ inject: ['tools', 'systemPrompt'], apply() {} }); await carrier.await()
    const agent = { options: {}, session: ctx.sessions.create(undefined, { meta: { cwd: root, agentPreset: role } }) }
    const scope = createScope(carrier.ctx, agent); agent.ctx = scope.ctx
    if (role === 'reason') await mountReasonTools(scope.ctx)
    for (const name of ['session_search', 'session_trace', 'session_event_read', 'session_event_search', 'session_event_trace']) assert.equal(ctx.tools.get(name, agent), undefined, `${role}: ${name}`)
    const prompt = await ctx.systemPrompt.assemble({ scope: agent })
    assert.ok(!prompt.sections.some(section => section.name === 'redtrace:session-identities'))
  }
})
