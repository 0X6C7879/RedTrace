import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, symlinkSync } from 'node:fs'
import fs from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initState, disposeState } from '../lib/state.js'
import { PluginManager, PluginError, registerPluginRoutes } from '../lib/plugins.js'
import * as core from '../lib/core.js'

function fakeContext() {
  const mounts = []
  const ctx = {
    mounts,
    plugin(module, config) {
      const record = { module, config, disposed: false }
      mounts.push(record)
      return {
        async await() {},
        async dispose() { record.disposed = true },
      }
    },
  }
  return ctx
}

function fakeResponse() {
  const res = {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(body) {
      res.body = body ?? ''
    },
  }
  return res
}

function pluginBody(payload) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
}

function makeManager(root, manifestPath, loadModule) {
  const ctx = fakeContext()
  const config = {
    runtime: true,
    server: 'http://127.0.0.1:9',
    root,
    sessionRoot: root,
    skillsDir: root,
    workspacesDir: root,
    pluginsManifest: manifestPath,
  }
  return { ctx, config, manager: new PluginManager(ctx, config, root, loadModule) }
}

function scratch(name) {
  const dir = mkdtempSync(path.join(tmpdir(), `redtrace-plugins-${name}-`))
  mkdirSync(path.join(dir, 'plugins'), { recursive: true })
  return dir
}

const tick = () => new Promise(resolve => setImmediate(resolve))

test('task plugin is default-on and autonomous; explicit stop veto persists', async t => {
  const root = scratch('task-policy'), manifest = path.join(root, 'plugins.json')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { manager } = makeManager(root, manifest, async () => ({}))
  await manager.boot()
  assert.equal(manager.running('redtrace-reverse'), true)
  assert.equal(manager.view('redtrace-reverse').taskSelectable, undefined)
  assert.equal(manager.taskPluginAllowed('redtrace-reverse'), true)
  assert.equal(manager.availableForTask('redtrace-reverse', ['redtrace-reverse']), true)
  assert.equal(manager.availableForTask('redtrace-reverse', []), true)
  assert.equal(manager.taskPluginAllowed('redtrace-core'), false)
  await manager.start('redtrace-reverse')
  assert.equal(manager.availableForTask('redtrace-reverse', []), true, 'global start makes the lazy feature available to Explore')
  await manager.stop('redtrace-reverse')
  assert.equal(manager.availableForTask('redtrace-reverse', ['redtrace-reverse']), false)
  const restarted = makeManager(root, manifest, async () => ({})).manager
  await restarted.boot()
  assert.equal(restarted.taskPluginAllowed('redtrace-reverse'), false)
  assert.equal(restarted.taskPluginAllowed('redtrace-reverse'), false)
  await restarted.start('redtrace-reverse')
  assert.equal(restarted.availableForTask('redtrace-reverse', ['redtrace-reverse']), true)
  assert.equal(restarted.availableForTask('redtrace-reverse', []), true)
  assert.equal(restarted.availableForTask('redtrace-fs-search', []), restarted.running('redtrace-fs-search'))
})

test('boot mounts enabled plugins in order; kernel entries are locked', async (t) => {
  const root = scratch('boot')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { ctx, manager } = makeManager(root, path.join(root, 'plugins.json'), async () => ({}))

  await manager.boot()
  const views = manager.list()

  const kernel = views.filter((view) => view.source === 'kernel')
  assert.equal(kernel.length, 8)
  assert.equal(kernel.some(view => view.id === 'settings'), false)
  assert.ok(kernel.every((view) => view.status === 'running' && !view.canStop && !view.canUninstall))
  assert.equal(manager.view('redtrace-core').canStop, false)
  assert.equal(manager.view('redtrace-domain').canStop, false)
  assert.equal(manager.view('redtrace-attachment').canStop, false)

  // Every catalog entry carries a non-empty one-liner and a longer intro;
  // neither may leak external project names.
  for (const view of views.filter((item) => item.source !== 'user')) {
    assert.ok(view.description.trim().length > 0, `${view.id} description`)
    assert.ok(typeof view.intro === 'string' && view.intro.trim().length > 0, `${view.id} intro`)
    assert.ok(!/Cairn|FastAPI/i.test(`${view.description}${view.intro}`), `${view.id} leaks an external project name`)
  }

  // Dependency order: core first, scheduler last; Spill belongs only to Execute scopes.
  assert.equal(ctx.mounts[0].module, core)
  assert.equal(ctx.mounts.at(-1).module.name, 'redtrace-scheduler')
  assert.equal(ctx.mounts.length, 4)
  assert(!ctx.mounts.some(m=>['redtrace-c2','redtrace-webshell'].includes(m.module.name)))
  assert.ok(!ctx.mounts.some(mount => mount.module.name === 'redtrace-session-query'))
  assert.ok(!ctx.mounts.some(mount => mount.module.name === 'redtrace-spill'))

  // Every builtin entry boots running unless it is explicitly opt-in (defaultOff).
  const optIn = new Set([
    'redtrace-credentials', 'redtrace-file-references',
    'redtrace-lsp', 'redtrace-reverse',
  ])
  for (const view of views.filter((item) => item.source === 'builtin')) {
    assert.ok(view.status === 'running' || optIn.has(view.id), `${view.id} boots ${view.status}`)
  }
})

test('removed PTC stays absent even when an older manifest enables it', async t => {
  const root = scratch('retired-ptc'), manifest = path.join(root, 'plugins.json')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  writeFileSync(manifest, JSON.stringify({ version: 1, enabled: ['redtrace-ptc'] }))
  const { manager, ctx } = makeManager(root, manifest, async () => ({ apply() {} }))
  await manager.boot()
  assert.equal(manager.running('redtrace-ptc'), false)
  assert.ok(!manager.list().some(p => p.id === 'redtrace-ptc'))
  assert.ok(ctx.mounts.every(({ module }) => module?.name !== 'redtrace-code-runtime'))
  await assert.rejects(manager.start('redtrace-ptc'), /unknown plugin/)
})

test('boot removes retired HTTP plugin flags without touching other registrations', async t => {
  const root = scratch('retired-http'), manifest = path.join(root, 'plugins.json')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const user = [{ id: 'fixture', module: 'plugins/fixture.js', enabled: false }]
  writeFileSync(manifest, JSON.stringify({
    version: 1, enabled: ['redtrace-browser-http', 'redtrace-file-references'],
    disabled: ['redtrace-http', 'redtrace-web'], user,
  }))
  const { manager } = makeManager(root, manifest)
  await manager.boot()
  for (const id of ['redtrace-http', 'redtrace-browser-http']) {
    assert.ok(!manager.list().some(entry => entry.id === id))
    await assert.rejects(manager.start(id), /unknown plugin/)
  }
  assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')), {
    version: 1, enabled: ['redtrace-file-references'], disabled: ['redtrace-web'], user,
  })
})

test('efficiency features boot enabled by default and remain explicitly switchable', async (t) => {
  const root = scratch('optin')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'plugins.json')

  // A fresh manifest enables the efficiency features; unrelated opt-ins stay stopped.
  const first = makeManager(root, manifestPath, async () => ({ apply() {} }))
  await first.manager.boot()
  assert.equal(first.manager.view('redtrace-lsp').status, 'stopped')
  assert.ok(!first.manager.list().some(p => p.id === 'redtrace-ptc'))
  await assert.rejects(first.manager.start('redtrace-ptc'), /unknown plugin/)
  assert.equal(first.manager.view('redtrace-file-references').status, 'stopped')
  assert.ok(!first.manager.list().some(p => ['redtrace-shell', 'redtrace-remote-terminal'].includes(p.id)))
  for (const id of ['redtrace-knowledge', 'redtrace-critical-events']) {
    assert.equal(first.manager.view(id).status, 'running')
  }
  assert.equal(first.manager.view('redtrace-pivot').status, 'running')
  assert.equal(first.manager.view('redtrace-session-probe').status, 'running')
  assert.ok(first.ctx.mounts.every(({ module }) => module?.name !== 'redtrace-credentials'))

  // Starting one records the opt-in and mounts its host-plane module.
  await first.manager.start('redtrace-credentials')
  await tick()
  assert.equal(first.manager.view('redtrace-credentials').status, 'running')
  assert.ok(first.ctx.mounts.some(({ module }) => module?.name === 'redtrace-credentials'))
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).enabled, ['redtrace-credentials'])

  // A session-scoped capability has no host fiber; start only flips the gate.
  await first.manager.start('redtrace-web')
  assert.equal(first.manager.view('redtrace-web').status, 'running')
  assert.ok(!first.ctx.mounts.some(({ module }) => module?.name === 'redtrace-web'))

  // The enabled list survives restarts; stopping removes the opt-in.
  const next = makeManager(root, manifestPath, async () => ({ apply() {} }))
  await next.manager.boot()
  assert.equal(next.manager.view('redtrace-credentials').status, 'running')
  assert.equal(next.manager.view('redtrace-web').status, 'running')
  assert.equal(next.manager.view('redtrace-lsp').status, 'stopped')

  await next.manager.stop('redtrace-web')
  assert.equal(next.manager.view('redtrace-web').status, 'stopped')
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).enabled, ['redtrace-credentials'])
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).disabled, ['redtrace-web'])
})

test('boot honors the manifest: disabled plugins stay unmounted', async (t) => {
  const root = scratch('disabled')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'plugins.json')
  writeFileSync(manifestPath, JSON.stringify({
    version: 1,
    disabled: ['redtrace-webshell', 'redtrace-commander', 'redtrace-shell', 'redtrace-remote-terminal'],
    enabled: ['redtrace-shell', 'redtrace-remote-terminal'],
  }))

  initState({
    server: 'http://127.0.0.1:9', root, sessionRoot: root, skillsDir: root, workspacesDir: root,
  })
  t.after(() => disposeState())
  const { ctx, manager } = makeManager(root, manifestPath, async () => ({}))

  await manager.boot()
  const views = manager.list()

  assert.equal(views.find((view) => view.id === 'redtrace-webshell').status, 'stopped')
  assert.equal(views.find(view => view.id === 'redtrace-terminal').status, 'running')
  assert.ok(!views.some(view => ['redtrace-shell', 'redtrace-remote-terminal'].includes(view.id)))
  assert.equal(views.find((view) => view.id === 'redtrace-commander').status, 'stopped')
  assert.ok(ctx.mounts.every(({ module }) => module.name !== 'redtrace-webshell'))

  // The scheduler consults this set: reason must not be dispatchable.
  const shared = (await import('../lib/state.js')).state()
  assert.equal(shared.presets.has('commander'), false)
  assert.equal(shared.presets.has('soldier'), true)
})

test('stop and start toggle fibers live and persist across restarts', async (t) => {
  const root = scratch('toggle')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'plugins.json')
  const { ctx, manager } = makeManager(root, manifestPath, async () => ({}))
  await manager.boot()

  const webshell = ctx.mounts.find(({ module }) => module.name === 'redtrace-webshell')
  const stopped = await manager.stop('redtrace-webshell')
  assert.equal(stopped.status, 'stopped')
  assert.equal(webshell, undefined, 'Family tools mount per execution scope, not globally')
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).disabled, ['redtrace-webshell'])

  await manager.start('redtrace-webshell')
  await tick()
  assert.equal(manager.view('redtrace-webshell').status, 'running')
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).disabled, [])

  // Stop again, then a fresh manager on the same manifest boots with the
  // plugin stopped: the lifecycle survives restarts through the manifest.
  await manager.stop('redtrace-webshell')
  const next = makeManager(root, manifestPath, async () => ({}))
  await next.manager.boot()
  assert.equal(next.manager.view('redtrace-webshell').status, 'stopped')
})

test('plugin stop waits for running session refresh', async (t) => {
  const root = scratch('session-refresh')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  initState({ server: 'http://127.0.0.1:9', root, sessionRoot: root, skillsDir: root, workspacesDir: root })
  t.after(() => disposeState())
  const ctx = fakeContext(), config = { sessionRoot: root, pluginsManifest: path.join(root, 'plugins.json') }
  let block = false, release, entered
  const waiting = new Promise(resolve => { entered = resolve })
  const manager = new PluginManager(ctx, config, root, async () => ({}), {}, async () => {
    if (block) { entered(); await new Promise(resolve => { release = resolve }) }
  })
  await manager.boot()
  block = true
  let settled = false
  const stopping = manager.stop('redtrace-web').then(() => { settled = true })
  await waiting
  assert.equal(settled, false)
  release()
  await stopping
  assert.equal(manager.running('redtrace-web'), false)
})

test('stop rejects unknown ids', async (t) => {
  const root = scratch('unknown')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { manager } = makeManager(root, path.join(root, 'plugins.json'), async () => ({}))
  await manager.boot()

  await assert.rejects(() => manager.stop('nope'), PluginError)
  await assert.rejects(() => manager.stop('redtrace-core'), PluginError)
  await assert.rejects(() => manager.stop('redtrace-domain'), PluginError)
})

test('add validates id, module path, and plugin shape; uninstall removes files', async (t) => {
  const root = scratch('user')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'plugins.json')
  const modules = new Map([
    ['plugins/good/index.js', { apply() {} }],
    ['plugins/bad-shape/index.js', { nope: true }],
  ])
  const { ctx, manager } = makeManager(root, manifestPath, async (relative) => {
    if (!modules.has(relative)) throw new Error('module not found')
    return modules.get(relative)
  })
  await manager.boot()

  await assert.rejects(() => manager.add({ id: 'Bad Id', module: 'plugins/good/index.js' }), PluginError)
  await assert.rejects(() => manager.add({ id: 'dup', module: 'redtrace-core' }), PluginError)
  await assert.rejects(() => manager.add({ id: 'esc', module: '../outside.js' }), PluginError)
  await assert.rejects(() => manager.add({ id: 'missing', module: 'plugins/missing/index.js' }), PluginError)
  await assert.rejects(() => manager.add({ id: 'bad', module: 'plugins/bad-shape/index.js' }), PluginError)

  const added = await manager.add({
    id: 'good', label: '好插件', module: 'plugins/good/index.js',
    description: '演示用的自定义插件', config: { key: 'value' },
  })
  assert.equal(added.source, 'user')
  assert.equal(added.canUninstall, true)
  assert.equal(added.description, '演示用的自定义插件')
  assert.equal(added.intro, '演示用的自定义插件')
  assert.deepEqual(added.config, { key: 'value' })
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).user, [
    { id: 'good', label: '好插件', description: '演示用的自定义插件', module: 'plugins/good/index.js', config: { key: 'value' } },
  ])

  // Without a description the intro stays hidden (null), not empty text.
  const plain = await manager.add({ id: 'plain', module: 'plugins/good/index.js' })
  assert.equal(plain.description, '')
  assert.equal(plain.intro, null)
  mkdirSync(path.join(root, 'plugins', 'good'), { recursive: true })
  const moduleFile = path.join(root, 'plugins', 'good', 'index.js')
  writeFileSync(moduleFile, 'export default { apply() {} }\n')
  await manager.uninstall('plain')
  assert.ok(existsSync(moduleFile), 'uninstall must preserve files still used by good')

  // Uninstall disposes, clears the manifest, and deletes plugins/<id>/.
  const userMount = ctx.mounts.find(({ module }) => module === modules.get('plugins/good/index.js'))
  await manager.uninstall('good')
  assert.equal(userMount.disposed, true)
  assert.deepEqual(JSON.parse(readFileSync(manifestPath, 'utf8')).user, [])
  assert.equal(existsSync(path.join(root, 'plugins', 'good')), false)
  await assert.rejects(() => manager.uninstall('good'), PluginError)
})

test('module paths resolve inside a root with a trailing slash', async (t) => {
  const root = scratch('trailing')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { manager } = makeManager(`${root}/`, path.join(root, 'plugins.json'), async () => ({ apply() {} }))
  await manager.boot()
  // repoRoot from the loader URL carries a trailing slash; in-repo paths must
  // still resolve and out-of-repo paths must still be rejected.
  assert.equal(manager.resolveModule('plugins/x/index.js'), 'plugins/x/index.js')
  assert.throws(() => manager.resolveModule('../outside.js'), PluginError)
})

test('HTTP API: list, add, start/stop, and unknown routes', async (t) => {
  const root = scratch('api')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'plugins.json')
  const { manager } = makeManager(root, manifestPath, async () => ({ apply() {} }))
  await manager.boot()

  const routes = []
  const webServer = { register(route) { routes.push(route) }, registerFallback() {} }
  registerPluginRoutes({ webServer }, manager)
  const route = routes.find((item) => item.kind === 'prefix' && item.path === '/__redtrace/plugins')
  assert.ok(route, 'plugins prefix route must be registered')

  const call = async (method, url, body) => {
    const res = fakeResponse()
    const req = { method, url, ...(body === undefined ? {} : { ...pluginBody(body) }) }
    await route.handler(req, res)
    for (let i = 0; i < 100 && res.status === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return res
  }

  const list = await call('GET', '/__redtrace/plugins')
  assert.equal(list.status, 200)
  assert.equal(JSON.parse(list.body).plugins.length, 31)
  for (const id of ['redtrace-trace-search', 'redtrace-repeat-reminder', 'redtrace-shell', 'redtrace-remote-terminal', 'redtrace-ptc', 'redtrace-scout']) {
    assert.ok(!JSON.parse(list.body).plugins.some(plugin => plugin.id === id))
    assert.equal((await call('POST', `/__redtrace/plugins/${id}/start`)).status, 400)
  }
  assert.equal(JSON.parse(list.body).plugins.find(plugin => plugin.id === 'redtrace-file-references').status, 'stopped')

  for (const id of ['redtrace-knowledge', 'redtrace-critical-events']) {
    assert.equal(JSON.parse(list.body).plugins.find(plugin => plugin.id === id).status, 'running')
    const started = await call('POST', `/__redtrace/plugins/${id}/start`)
    assert.equal(JSON.parse(started.body).plugin.status, 'running')
    const stopped = await call('POST', `/__redtrace/plugins/${id}/stop`)
    assert.equal(JSON.parse(stopped.body).plugin.status, 'stopped')
  }
  const optInStart = await call('POST', '/__redtrace/plugins/redtrace-file-references/start')
  assert.equal(JSON.parse(optInStart.body).plugin.status, 'running')
  const optInStop = await call('POST', '/__redtrace/plugins/redtrace-file-references/stop')
  assert.equal(JSON.parse(optInStop.body).plugin.status, 'stopped')

  const added = await call('POST', '/__redtrace/plugins', {
    id: 'my-plug', module: 'plugins/my-plug/index.js', description: '介绍一下',
  })
  assert.equal(added.status, 201)
  assert.equal(JSON.parse(added.body).plugin.id, 'my-plug')

  const stop = await call('POST', '/__redtrace/plugins/my-plug/stop')
  assert.equal(stop.status, 200)
  assert.equal(JSON.parse(stop.body).plugin.status, 'stopped')

  const start = await call('POST', '/__redtrace/plugins/my-plug/start')
  assert.equal(start.status, 200)

  const removed = await call('DELETE', '/__redtrace/plugins/my-plug')
  assert.equal(removed.status, 204)
  assert.ok(!JSON.parse((await call('GET', '/__redtrace/plugins')).body).plugins.some(p => p.id === 'my-plug'))
  for (const id of ['sessions', 'redtrace-core']) {
    assert.equal((await call('DELETE', `/__redtrace/plugins/${id}`)).status, 400)
    assert.equal(manager.view(id).canUninstall, false)
  }

  const badId = await call('POST', '/__redtrace/plugins/nope/stop')
  assert.equal(badId.status, 400)
  assert.ok(JSON.parse(badId.body).detail.includes('unknown plugin'))

  const unknown = await call('GET', '/__redtrace/pluginsfoo')
  assert.equal(unknown.status, 404)

  const badAction = await call('POST', '/__redtrace/plugins/redtrace-resource/restart')
  assert.equal(badAction.status, 404)
})


test('reverse plugin is default-on, explicit stop persists and can be restarted', async t => {
  const root = scratch('reverse')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifest = path.join(root, 'plugins.json')
  const first = makeManager(root, manifest, async () => ({}))
  await first.manager.boot()
  assert.equal(first.manager.view('redtrace-reverse').status, 'running')
  await first.manager.start('redtrace-reverse')
  assert.equal(first.manager.view('redtrace-reverse').status, 'running')
  assert.ok(!JSON.parse(readFileSync(manifest)).disabled.includes('redtrace-reverse'))
  const second = makeManager(root, manifest, async () => ({}))
  await second.manager.boot()
  assert.equal(second.manager.view('redtrace-reverse').status, 'running')
  await second.manager.stop('redtrace-reverse')
  assert.equal(second.manager.view('redtrace-reverse').status, 'stopped')
  await second.manager.start('redtrace-reverse')
  assert.equal(second.manager.view('redtrace-reverse').status, 'running')
})

test('General/Soldier inherit retired preset settings and the retired Scout ID is removed from the manifest',async t=>{
 const root=scratch('general-presets'),manifest=path.join(root,'plugins.json')
 t.after(()=>rmSync(root,{recursive:true,force:true}))
 writeFileSync(manifest,JSON.stringify({version:1,disabled:['redtrace-leader','redtrace-operator','redtrace-scout']}))
 const {manager}=makeManager(root,manifest,async()=>({}))
 await manager.boot()
 try{
  assert.equal(manager.view('redtrace-soldier').status,'stopped')
  assert.throws(()=>manager.view('redtrace-scout'),/unknown plugin/)
  assert(!JSON.parse(readFileSync(manifest,'utf8')).disabled.includes('redtrace-scout'))
  assert.equal(manager.view('redtrace-general').status,'running')
  assert.throws(()=>manager.view('redtrace-leader'))
  assert.throws(()=>manager.view('redtrace-operator'))
 }finally{await manager.stop('redtrace-soldier')}
})

function uninstallFile(root, relative, text = 'fixture') {
  const target = path.join(root, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, text)
  return target
}

async function uninstallFixture(t, seed = {}, relative = 'plugins.json') {
  const root = scratch('uninstall-regression')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifest = uninstallFile(root, relative, JSON.stringify({ version: 1, ...seed }))
  const setup = makeManager(root, manifest, async () => ({ apply() {} }))
  await setup.manager.boot()
  return { root, manifest, ...setup }
}

function uninstallLink(t, target, link) {
  try { symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir'); return true }
  catch (error) {
    if (!['EPERM', 'EACCES', 'ENOSYS', 'ENOTSUP'].includes(error.code)) throw error
    t.skip(`directory links unavailable: ${error.code}`)
    return false
  }
}

test('installed views expose uninstall only for optional managed plugins', async t => {
  const { manager } = await uninstallFixture(t)
  const protectedIds = new Set(['redtrace-core', 'redtrace-domain', 'redtrace-attachment'])
  for (const view of manager.list()) {
    assert.equal(view.installed, true, view.id)
    assert.equal(view.canUninstall, view.source === 'builtin' && view.category !== 'preset' && !protectedIds.has(view.id), view.id)
  }
  assert.equal((await manager.add({ id: 'fixture', module: 'plugins/foo.js', enabled: false })).installed, true)
})

test('HTTP DELETE uninstalls an optional builtin and start reinstalls without deleting sources', async t => {
  const id = 'redtrace-lsp', user = [{ id: 'fixture', module: 'plugins/foo.js', enabled: false }]
  const { root, manifest, manager } = await uninstallFixture(t, {
    enabled: [id, 'redtrace-file-references'], disabled: [id, 'redtrace-web'], removed: ['redtrace-reverse'], user,
  })
  const source = uninstallFile(root, manager.view(id).module, 'vendor source')
  const routes = []
  registerPluginRoutes({ webServer: { register: route => routes.push(route) } }, manager)
  const call = (method, url) => new Promise(resolve => {
    const res = fakeResponse(), end = res.end
    res.end = body => { end(body); resolve(res) }
    routes[0].handler({ method, url }, res)
  })
  const count = manager.list().length
  assert.equal((await call('DELETE', `/__redtrace/plugins/${id}`)).status, 204)
  assert.equal(manager.list().length, count)
  assert.deepEqual([manager.view(id).installed, manager.view(id).status, manager.view(id).canStop, manager.view(id).canUninstall], [false, 'stopped', false, false])
  const saved = JSON.parse(readFileSync(manifest, 'utf8'))
  assert.deepEqual(saved.enabled, ['redtrace-file-references'])
  assert.deepEqual(saved.disabled, ['redtrace-web'])
  assert.deepEqual(new Set(saved.removed), new Set(['redtrace-reverse', id]))
  assert.deepEqual(saved.user, user)
  const response = await call('POST', `/__redtrace/plugins/${id}/start`)
  assert.equal(response.status, 200)
  const view = JSON.parse(response.body).plugin
  assert.deepEqual([view.installed, view.status, view.canStop, view.canUninstall], [true, 'running', true, true])
  const next = makeManager(root, manifest, async () => ({ apply() {} })).manager
  await next.boot()
  assert.equal(next.running(id), true)
  assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).removed, ['redtrace-reverse'])
  assert.equal(readFileSync(source, 'utf8'), 'vendor source')
})

for (const enabled of [undefined, ['redtrace-reverse', 'redtrace-credentials']]) {
  test(`removed ${enabled ? 'overrides enabled flags' : 'works in a removed-only manifest'} at boot`, async t => {
    const ids = ['redtrace-reverse', 'redtrace-credentials']
    const { root, manifest, ctx, manager } = await uninstallFixture(t, { removed: ids, ...(enabled ? { enabled } : {}) })
    assert.equal(manager.taskPluginAllowed('redtrace-reverse'), false)
    assert.equal(manager.availableForTask('redtrace-reverse'), false)
    for (const id of ids) {
      const view = manager.view(id)
      assert.deepEqual([view.installed, view.status, view.canStop, view.canUninstall], [false, 'stopped', false, false], id)
    }
    assert.ok(ctx.mounts.every(({ module }) => module.name !== 'redtrace-credentials'))
    assert.equal((await manager.start('redtrace-credentials')).installed, true)
    const next = makeManager(root, manifest, async () => ({ apply() {} })).manager
    await next.boot()
    assert.equal(next.running('redtrace-credentials'), true)
    assert.equal(next.taskPluginAllowed('redtrace-reverse'), false)
  })
}

test('builtin uninstall disposes its live fiber and stays removed after reboot', async t => {
  const { root, manifest, ctx, manager } = await uninstallFixture(t)
  await manager.start('redtrace-credentials')
  const mount = ctx.mounts.at(-1)
  await manager.uninstall('redtrace-credentials')
  assert.equal(mount.disposed, true)
  assert.equal(manager.running('redtrace-credentials'), false)
  const next = makeManager(root, manifest, async () => ({ apply() {} })).manager
  await next.boot()
  assert.equal(next.view('redtrace-credentials').installed, false)
  assert.equal(next.running('redtrace-credentials'), false)
})

test('removed ignores protected and unknown ids; kernel and presets cannot be uninstalled', async t => {
  const ids = ['sessions', 'redtrace-core', 'redtrace-domain', 'redtrace-attachment', 'redtrace-commander', 'redtrace-general', 'redtrace-soldier']
  const user = [{ id: 'fixture', module: 'plugins/foo.js' }]
  const { manager } = await uninstallFixture(t, { removed: [...ids, 'not-a-plugin', 'fixture'], user })
  for (const id of ids) {
    await assert.rejects(manager.uninstall(id), PluginError)
    assert.equal(manager.view(id).status, 'running', id)
    assert.equal(manager.view(id).canUninstall, false, id)
  }
  assert.equal(manager.running('fixture'), true, 'removed only applies to optional managed entries')
  assert.ok(!manager.list().some(view => view.id === 'not-a-plugin'))
})

for (const [name, module, owned] of [
  ['nested entry owns its top-level directory', 'plugins/foo/dist/index.js', 'plugins/foo'],
  ['top-level file owns only that file', 'plugins/foo.js', 'plugins/foo.js'],
  ['outside plugins only unregisters', 'vendor/foo/index.js', null],
]) {
  test(`custom uninstall: ${name}`, async t => {
    const { root, manifest, ctx, manager } = await uninstallFixture(t)
    const entry = uninstallFile(root, module), sibling = uninstallFile(root, 'plugins/keep.js')
    const asset = uninstallFile(root, 'plugins/foo/assets/data.txt')
    await manager.add({ id: 'fixture', module })
    const mount = ctx.mounts.at(-1)
    await manager.uninstall('fixture')
    assert.equal(mount.disposed, true)
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).user, [])
    assert.ok(!manager.list().some(view => view.id === 'fixture'))
    assert.equal(existsSync(owned ? path.join(root, owned) : entry), owned === null)
    assert.equal(existsSync(asset), owned !== 'plugins/foo')
    assert.ok(existsSync(sibling))
  })
}

for (const alias of [false, true]) {
  test(`custom uninstall preserves a directory shared by ${alias ? 'realpath aliases' : 'another registration'}`, async t => {
    const { root, manifest, manager } = await uninstallFixture(t)
    const entry = uninstallFile(root, 'plugins/foo/index.js')
    const other = uninstallFile(root, 'plugins/foo/other.js')
    if (alias && !uninstallLink(t, path.join(root, 'plugins/foo'), path.join(root, 'plugins/alias'))) return
    await manager.add({ id: 'fixture', module: 'plugins/foo/index.js' })
    await manager.add({ id: 'keeper', module: `plugins/${alias ? 'alias' : 'foo'}/other.js`, enabled: false })
    await manager.uninstall('fixture')
    assert.ok(existsSync(entry))
    assert.ok(existsSync(other))
    assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).user.map(user => user.id), ['keeper'])
  })
}

for (const unsafe of ['top-level junction', 'symlinked plugins root', 'manifest inside owned directory']) {
  test(`custom uninstall rejects ${unsafe} without dropping registration or files`, async t => {
    const { root, manifest, manager } = await uninstallFixture(t, {}, unsafe.startsWith('manifest') ? 'plugins/foo/settings/plugins.json' : 'plugins.json')
    const external = scratch('external-guard')
    t.after(() => rmSync(external, { recursive: true, force: true }))
    const sentinel = uninstallFile(external, 'sentinel.txt', 'external data')
    if (unsafe === 'top-level junction' && !uninstallLink(t, external, path.join(root, 'plugins/foo'))) return
    if (unsafe === 'symlinked plugins root') {
      rmSync(path.join(root, 'plugins'), { recursive: true })
      if (!uninstallLink(t, external, path.join(root, 'plugins'))) return
    }
    const entry = uninstallFile(root, 'plugins/foo/index.js')
    await manager.add({ id: 'fixture', module: 'plugins/foo/index.js' })
    await assert.rejects(manager.uninstall('fixture'))
    assert.equal(manager.view('fixture').module, 'plugins/foo/index.js')
    assert.ok(JSON.parse(readFileSync(manifest, 'utf8')).user.some(user => user.id === 'fixture'))
    assert.ok(existsSync(entry))
    assert.equal(readFileSync(sentinel, 'utf8'), 'external data')
  })
}

test('custom package cleanup removes nested links without touching their external targets', async t => {
  const { root, manager } = await uninstallFixture(t)
  const external = scratch('nested-link-target')
  t.after(() => rmSync(external, { recursive: true, force: true }))
  const sentinel = uninstallFile(external, 'sentinel.txt', 'external data')
  uninstallFile(root, 'plugins/foo/dist/index.js')
  if (!uninstallLink(t, external, path.join(root, 'plugins/foo/assets'))) return
  await manager.add({ id: 'fixture', module: 'plugins/foo/dist/index.js' })
  await manager.uninstall('fixture')
  assert.equal(existsSync(path.join(root, 'plugins/foo')), false)
  assert.equal(readFileSync(sentinel, 'utf8'), 'external data')
})

for (const action of ['stop', 'uninstall']) {
  test(`failed fiber dispose rejects ${action} and retains registration, files and mount`, async t => {
    const { root, manifest, ctx, manager } = await uninstallFixture(t)
    const entry = uninstallFile(root, 'plugins/foo/index.js'), plugin = ctx.plugin.bind(ctx)
    t.mock.method(ctx, 'plugin', (...args) => ({ ...plugin(...args), async dispose() { throw new Error('dispose blocked') } }))
    await manager.add({ id: 'fixture', module: 'plugins/foo/index.js' })
    const count = ctx.mounts.length
    await assert.rejects(manager[action]('fixture'), /dispose blocked/)
    assert.ok(manager.list().some(view => view.id === 'fixture'))
    assert.ok(JSON.parse(readFileSync(manifest, 'utf8')).user.some(user => user.id === 'fixture' && user.enabled !== false))
    assert.ok(existsSync(entry))
    await manager.start('fixture')
    assert.equal(ctx.mounts.length, count, 'failed disposal must not allow a duplicate fiber')
  })
}

test('cleanup failure persists a stopped disabled registration before rm and remains retryable', async t => {
  const { root, manifest, ctx, manager } = await uninstallFixture(t)
  const entry = uninstallFile(root, 'plugins/foo/index.js'), plugin = ctx.plugin.bind(ctx)
  let releaseDispose, enterDispose
  const entered = new Promise(resolve => { enterDispose = resolve })
  const disposed = new Promise(resolve => { releaseDispose = resolve })
  t.mock.method(ctx, 'plugin', (...args) => {
    const fiber = plugin(...args)
    return { ...fiber, async dispose() { enterDispose(); await disposed; await fiber.dispose() } }
  })
  t.after(() => releaseDispose())
  await manager.add({ id: 'fixture', module: 'plugins/foo/index.js' })
  const mount = ctx.mounts.at(-1)
  let observed
  const stub = t.mock.method(fs, 'rm', async () => {
    observed = { disposed: mount.disposed, user: JSON.parse(readFileSync(manifest, 'utf8')).user.find(user => user.id === 'fixture'), view: manager.list().find(view => view.id === 'fixture') }
    throw new Error('cleanup blocked')
  })
  syncBuiltinESMExports()
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports() })
  const removing = assert.rejects(manager.uninstall('fixture'), /cleanup blocked/)
  await entered
  assert.equal(stub.mock.calls.length, 0, 'rm must wait for successful disposal')
  assert.ok(JSON.parse(readFileSync(manifest, 'utf8')).user.some(user => user.id === 'fixture' && user.enabled !== false))
  releaseDispose()
  await removing
  assert.equal(observed.disposed, true)
  assert.equal(observed.user?.enabled, false, 'persist disabled before attempting rm')
  assert.equal(observed.view?.status, 'stopped')
  assert.equal(manager.statuses.get('fixture'), 'stopped', 'retain lifecycle maps until cleanup succeeds')
  assert.ok(existsSync(entry))
  stub.mock.restore()
  syncBuiltinESMExports()
  await manager.uninstall('fixture')
  assert.ok(!existsSync(path.join(root, 'plugins/foo')))
  assert.deepEqual(JSON.parse(readFileSync(manifest, 'utf8')).user, [])
  assert.equal(manager.statuses.has('fixture'), false)
  assert.equal(manager.errors.has('fixture'), false)
  assert.equal(manager.mounted.has('fixture'), false)
})

test('reinstall retries manifest persistence without mounting a duplicate fiber', async t => {
  const { manifest, ctx, manager } = await uninstallFixture(t)
  await manager.uninstall('redtrace-credentials')
  const stub = t.mock.method(fs, 'rename', async () => { throw new Error('manifest blocked') })
  syncBuiltinESMExports()
  t.after(() => { stub.mock.restore(); syncBuiltinESMExports() })
  await assert.rejects(manager.start('redtrace-credentials'), /manifest blocked/)
  const count = ctx.mounts.length
  stub.mock.restore()
  syncBuiltinESMExports()
  const view = await manager.start('redtrace-credentials')
  assert.equal(view.installed, true)
  assert.equal(view.status, 'running')
  assert.equal(ctx.mounts.length, count)
  assert.ok(!JSON.parse(readFileSync(manifest, 'utf8')).removed.includes('redtrace-credentials'))
})

test('late failed activation cannot recreate lifecycle state after custom uninstall', async t => {
  const { root, ctx, manager } = await uninstallFixture(t)
  uninstallFile(root, 'plugins/foo/index.js')
  const plugin = ctx.plugin.bind(ctx)
  let rejectActivation
  const activation = new Promise((resolve, reject) => { rejectActivation = reject })
  t.mock.method(ctx, 'plugin', (...args) => ({ ...plugin(...args), await: () => activation }))
  await manager.add({ id: 'fixture', module: 'plugins/foo/index.js' })
  assert.equal(manager.view('fixture').status, 'pending')
  await manager.uninstall('fixture')
  rejectActivation(new Error('late activation failure'))
  await tick()
  assert.equal(manager.statuses.has('fixture'), false)
  assert.equal(manager.errors.has('fixture'), false)
})
