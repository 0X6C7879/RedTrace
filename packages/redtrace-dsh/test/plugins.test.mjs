import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
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

test('boot mounts enabled plugins in order; kernel entries are locked', async (t) => {
  const root = scratch('boot')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { ctx, manager } = makeManager(root, path.join(root, 'plugins.json'), async () => ({}))

  await manager.boot()
  const views = manager.list()

  const kernel = views.filter((view) => view.source === 'kernel')
  assert.equal(kernel.length, 9)
  assert.equal(kernel.some(view => view.id === 'settings'), false)
  assert.ok(kernel.every((view) => view.status === 'running' && !view.canStop && !view.canUninstall))
  assert.equal(manager.view('redtrace-core').canStop, false)
  assert.equal(manager.view('redtrace-domain').canStop, false)

  // Every catalog entry carries a non-empty one-liner and a longer intro;
  // neither may leak external project names.
  for (const view of views.filter((item) => item.source !== 'user')) {
    assert.ok(view.description.trim().length > 0, `${view.id} description`)
    assert.ok(typeof view.intro === 'string' && view.intro.trim().length > 0, `${view.id} intro`)
    assert.ok(!/Cairn|FastAPI/i.test(`${view.description}${view.intro}`), `${view.id} leaks an external project name`)
  }

  // Dependency order: core first, scheduler last. Session-scoped capabilities
  // mount no host fiber, so the host count is unchanged.
  assert.equal(ctx.mounts[0].module, core)
  assert.equal(ctx.mounts.at(-1).module.name, 'redtrace-scheduler')
  assert.equal(ctx.mounts.length, 5)

  // Every builtin entry boots running unless it is explicitly opt-in (defaultOff).
  const optIn = new Set([
    'redtrace-credentials', 'redtrace-attachment', 'redtrace-file-references',
    'redtrace-lsp', 'redtrace-ptc', 'redtrace-jev',
  ])
  for (const view of views.filter((item) => item.source === 'builtin')) {
    assert.ok(view.status === 'running' || optIn.has(view.id), `${view.id} boots ${view.status}`)
  }
})

test('efficiency features boot enabled by default and remain explicitly switchable', async (t) => {
  const root = scratch('optin')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const manifestPath = path.join(root, 'plugins.json')

  // A fresh manifest enables the efficiency features; unrelated opt-ins stay stopped.
  const first = makeManager(root, manifestPath, async () => ({ apply() {} }))
  await first.manager.boot()
  assert.equal(first.manager.view('redtrace-lsp').status, 'stopped')
  assert.equal(first.manager.view('redtrace-ptc').status, 'stopped')
  assert.equal(first.manager.view('redtrace-jev').status, 'stopped')
  assert.equal(first.manager.view('redtrace-remote-terminal').status, 'running')
  for (const id of ['redtrace-knowledge', 'redtrace-browser-http', 'redtrace-trace-search', 'redtrace-critical-events']) {
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
    disabled: ['redtrace-webshell', 'redtrace-reason'],
  }))

  initState({
    server: 'http://127.0.0.1:9', root, sessionRoot: root, skillsDir: root, workspacesDir: root,
  })
  t.after(() => disposeState())
  const { ctx, manager } = makeManager(root, manifestPath, async () => ({}))

  await manager.boot()
  const views = manager.list()

  assert.equal(views.find((view) => view.id === 'redtrace-webshell').status, 'stopped')
  assert.equal(views.find((view) => view.id === 'redtrace-reason').status, 'stopped')
  assert.ok(ctx.mounts.every(({ module }) => module.name !== 'redtrace-webshell'))

  // The scheduler consults this set: reason must not be dispatchable.
  const shared = (await import('../lib/state.js')).state()
  assert.equal(shared.presets.has('reason'), false)
  assert.equal(shared.presets.has('bootstrap'), true)
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
  assert.equal(webshell.disposed, true)
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
  await manager.uninstall('plain')

  // Uninstall disposes, clears the manifest, and deletes plugins/<id>/.
  mkdirSync(path.join(root, 'plugins', 'good'), { recursive: true })
  writeFileSync(path.join(root, 'plugins', 'good', 'index.js'), 'export default { apply() {} }\n')
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
  assert.equal(JSON.parse(list.body).plugins.length, 37)
  assert.equal(JSON.parse(list.body).plugins.find(plugin => plugin.id === 'redtrace-jev').status, 'stopped')

  for (const id of ['redtrace-knowledge', 'redtrace-browser-http', 'redtrace-trace-search', 'redtrace-critical-events']) {
    assert.equal(JSON.parse(list.body).plugins.find(plugin => plugin.id === id).status, 'running')
    const started = await call('POST', `/__redtrace/plugins/${id}/start`)
    assert.equal(JSON.parse(started.body).plugin.status, 'running')
    const stopped = await call('POST', `/__redtrace/plugins/${id}/stop`)
    assert.equal(JSON.parse(stopped.body).plugin.status, 'stopped')
  }
  const jevStart = await call('POST', '/__redtrace/plugins/redtrace-jev/start')
  assert.equal(JSON.parse(jevStart.body).plugin.status, 'running')
  const jevStop = await call('POST', '/__redtrace/plugins/redtrace-jev/stop')
  assert.equal(JSON.parse(jevStop.body).plugin.status, 'stopped')

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

  const badId = await call('POST', '/__redtrace/plugins/nope/stop')
  assert.equal(badId.status, 400)
  assert.ok(JSON.parse(badId.body).detail.includes('unknown plugin'))

  const unknown = await call('GET', '/__redtrace/pluginsfoo')
  assert.equal(unknown.status, 404)

  const badAction = await call('POST', '/__redtrace/plugins/redtrace-resource/restart')
  assert.equal(badAction.status, 404)
})
