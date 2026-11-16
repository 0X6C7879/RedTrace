import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { serveEngine } from '../src/index.ts'
const { load, mount } = await import(new URL('../../redtrace-dsh/lib/loader.js', import.meta.url).href)
const { inspectToolCatalog } = await import(new URL('../compat/tool-catalog.mjs', import.meta.url).href)
const { runtimeCatalog } = await import(new URL('../compat/console.mjs', import.meta.url).href)

test('idle tool page lists real role/native/REA Schemas, including disabled tools, without starting Agents', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'schema-catalog-test-'))
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'), ctx = new Context()
  const stopped = new Set(['redtrace-c2', 'redtrace-web', 'redtrace-knowledge'])
  const manager = { availableForTask: (id: string) => !stopped.has(id), running: (id: string) => !stopped.has(id) }
  const engine = await serveEngine({ root, autoStart: false, port: 0, runtimeCatalog: async () => runtimeCatalog(ctx, engine,
    await inspectToolCatalog(ctx, engine, manager, { skillsDir: root + '/skills' })) })
  try {
    for (const module of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js', 'vendor/deepseek-harness/packages/subprocess/subprocess-local/lib/index.js', 'packages/redtrace-dsh/lib/core.js']) await mount(ctx, module)
    const before = ctx.get('tools').definitions().map((t: any) => t.name)
    const projects = engine.store.projects().length
    await inspectToolCatalog(ctx, engine, manager, { skillsDir: root + '/skills' })
    const get = async () => (await (await fetch('http://127.0.0.1:' + (engine.server.address() as any).port + '/console/tools')).json()) as any
    const first = await get(), find = (name: string) => first.tools.find((tool: any) => tool.name === name)
    for (const name of ['read', 'bash', 'skill', 'terminal_open', 'legion_board', 'submit_fact', 'resource_register', 'c2_listener_create', 'tsecbench_submit', 'mcp__rea__binary_session']) assert(find(name), name)
    assert.equal(find('tsecbench_submit').enabled, false, 'Disabled Skill keeps its Schema in the catalog without granting the tool')
    assert.equal(find('c2_listener_create').enabled, false)
    assert.equal(find('web_search').enabled, false)
    assert.equal(find('submit_fact').enabled, true)
    assert.equal(find('legion_board').manageable, true)
    assert.equal(find('read').manageable, false)
    assert.equal(find('submit_fact').scopes.length, 0)
    assert.equal(first.tools.filter((t: any) => t.name.startsWith('mcp__rea__')).length, 59)
    assert(!find('nmap')); assert(!find('reverse_tools'))
    assert(find('legion_board').roles.includes('commander:general'))
    assert(first.tools.some((t: any) => t.name === 'legion_board' && t.roles.includes('commander:benchmark')))
    engine.configuration.commit(engine.configuration.read().revision, raw => { raw.tool_settings = { submit_fact: { enabled: false } } })
    const second = await get()
    assert.equal(second.tools.find((t: any) => t.name === 'submit_fact').enabled, false)
    assert.equal(second.tools.length, first.tools.length)
    stopped.delete('redtrace-c2')
    assert.equal((await get()).tools.find((t: any) => t.name === 'c2_listener_create').enabled, true)
    assert.deepEqual(ctx.get('tools').definitions().map((t: any) => t.name), before)
    assert.equal(ctx.get('agents').list().length, 0)
    assert.equal(engine.store.projects().length, projects)
    console.log('CATALOG=' + JSON.stringify({ schemas: first.tools.length, enabled: first.tools.filter((t: any) => t.enabled).length, disabled: first.tools.filter((t: any) => !t.enabled).length, agents: 0 }))
  } finally { await ctx.fiber.dispose(); await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
