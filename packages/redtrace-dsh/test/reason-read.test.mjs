import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { load } from '../lib/loader.js'
import { PluginManager } from '../lib/plugins.js'
import { mountReasonTools } from '../../redtrace-engine/compat/cordis.mjs'

const V = 'vendor/deepseek-harness/packages'
const body = result => result.content.map(block => block.text ?? '').join('')

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'redtrace-reason-read-')), cwd = path.join(root, 'project')
  mkdirSync(cwd)
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
  const ctx = new Context()
  t.after(async () => { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  for (const entry of [`${V}/session/session-projection/lib/index.js`, 'packages/redtrace-dsh/lib/core.js']) {
    const module = await load(entry); await ctx.plugin(module.default ?? module).await()
  }
  const manager = new PluginManager(ctx, { sessionRoot: root, pluginsManifest: path.join(root, 'plugins.json') }, root)
  await manager.start('redtrace-trace-search'); await manager.start('redtrace-spill')
  const carrier = ctx.plugin({ inject: ['tools', 'systemPrompt'], apply() {} }); await carrier.await()
  const { createScope } = await load(`${V}/core/scope/lib/index.js`)
  const agent = { options: {}, session: ctx.sessions.create(undefined, { meta: { cwd } }) }
  const scope = createScope(carrier.ctx, agent); agent.ctx = scope.ctx
  await mountReasonTools(scope.ctx)
  let id = 0
  const call = (args, signal = new AbortController().signal) => ctx.tools.execute({ name: 'read', arguments: args, agent, callId: `read-${++id}`, signal })
  return { ctx, root, cwd, agent, call }
}

test('Reason reads complete large files and preserves native read cards without widening Execute', async t => {
  const { ctx, cwd, agent, call } = await fixture(t)
  const text = `HEAD\n${'中'.repeat(6000)}\n${'fixture evidence line\n'.repeat(2999)}TAIL`
  writeFileSync(path.join(cwd, 'large.txt'), text)
  const result = await call({ file_path: 'large.txt' })
  assert.equal(result.isError, false, body(result))
  assert.equal(result.value.lines.length, 3002)
  assert.equal(result.value.lines[1].text, '中'.repeat(6000))
  assert.equal(result.value.lines.at(-1).text, 'TAIL')
  assert.equal(result.value.lines.map(line => line.text).join('\n'), text)
  assert.doesNotMatch(body(result), /truncated|Output capped|Full formatted result stored at:/)
  const card = ctx.tools.get('read', agent).presentResult({ file_path: 'large.txt' }, result)
  assert.equal(card.card, 'read'); assert.equal(card.totalLines, 3002)
  assert.equal(card.lines[1].text.length, 6000)
  const window = await call({ file_path: 'large.txt', offset: 2, limit: 2500 })
  assert.equal(window.isError, false, body(window))
  assert.equal(window.value.lines.length, 2500)
  assert.equal(window.value.lines[0].number, 2)
  const tail = await call({ file_path: 'large.txt', offset: 3002 })
  assert.deepEqual(tail.value.lines, [{ number: 3002, text: 'TAIL' }])
  const native = ctx.tools.get('read')
  assert.match(native.parameters.properties.limit.description, /2000/)
  assert.notEqual(native, ctx.tools.get('read', agent))
  assert.equal(agent.ctx.get('spillStore'), undefined)
  for (const name of ['write', 'edit', 'bash', 'pwsh']) assert.equal(ctx.tools.get(name, agent), undefined)
  const prompt = (await ctx.systemPrompt.assemble({ scope: agent })).sections.map(section => section.text).join('\n')
  assert.match(prompt, /complete file by default/)
  assert.doesNotMatch(prompt, /Use offset and limit to continue reading large files/)
})

test('Reason accepts private, foreign and symlink paths while retaining file validation and cancellation', async t => {
  const { ctx, root, cwd, agent, call } = await fixture(t)
  const foreign = path.join(root, 'foreign.txt'), secret = path.join(cwd, '.env')
  writeFileSync(foreign, 'SYNTHETIC_FOREIGN'); writeFileSync(secret, 'SYNTHETIC_SECRET')
  symlinkSync(foreign, path.join(cwd, 'link.txt'))
  for (const [file_path, text] of [[foreign, 'SYNTHETIC_FOREIGN'], ['../foreign.txt', 'SYNTHETIC_FOREIGN'], ['link.txt', 'SYNTHETIC_FOREIGN'], ['.env', 'SYNTHETIC_SECRET']]) {
    const result = await call({ file_path }); assert.equal(result.isError, false, body(result)); assert.equal(result.value.lines[0].text, text)
  }
  writeFileSync(path.join(cwd, 'empty.txt'), '')
  assert.deepEqual((await call({ file_path: 'empty.txt' })).value.lines, [])
  writeFileSync(path.join(cwd, 'unicode.txt'), 'α\r\n\n尾\n')
  assert.deepEqual((await call({ file_path: 'unicode.txt' })).value.lines.map(line => line.text), ['α', '', '尾'])
  for (const args of [{ file_path: '' }, { file_path: 'missing.txt' }, { file_path: cwd },
    { file_path: secret, offset: 0 }, { file_path: secret, offset: 1.5 }, { file_path: secret, limit: 0 },
    { file_path: secret, limit: -1 }, { file_path: secret, limit: 1.5 }, { file_path: secret, offset: 2 }]) {
    assert.equal((await call(args)).isError, true, JSON.stringify(args))
  }
  const controller = new AbortController(); controller.abort()
  const cancelled = await call({ file_path: secret }, controller.signal)
  assert.equal(cancelled.isError, true); assert.match(body(cancelled), /abort/i)
  const native = ctx.tools.get('read', agent)
  const controller2 = new AbortController(); controller2.abort()
  await assert.rejects(native.execute({ file_path: secret }, { agent, signal: controller2.signal }), /abort/i)
})
