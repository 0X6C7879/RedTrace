import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = ['capabilities.js', 'plugins.js'].map(file => readFileSync(new URL(`../../../static/${file}`, import.meta.url), 'utf8')).join('\n')
const optional = { id: 'redtrace-lsp', label: 'LSP', source: 'builtin', category: 'feature', installed: true, status: 'stopped', canStop: true, canUninstall: true }
const removed = { ...optional, installed: false, canStop: false, canUninstall: false }

function pageWith(plugins = [], request = async () => ({ status: 200, ok: true, json: async () => ({ plugins }) })) {
  const window = {}
  vm.runInNewContext(source, { window, fetch: request, setTimeout: () => 1, clearTimeout() {}, setInterval: () => 1, clearInterval() {} })
  const page = window.pluginsPage()
  page.plugins = plugins
  return page
}

test('installed plugin list and counts exclude removed builtins but installation catalog keeps them', () => {
  const page = pageWith([removed, { ...optional, id: 'active', label: 'Active', status: 'running' }, { id: 'preset', category: 'preset', status: 'running', installed: true }])
  assert.equal(page.filtered.map(plugin => plugin.id).join(','), 'active,preset')
  assert.equal(page.pluginCount, 1)
  assert.equal(page.runningCount, 1)
  assert.equal(page.available.map(plugin => plugin.id).join(','), optional.id)
  page.query = 'lsp'
  assert.equal(page.groups.length, 0)
})

test('installer defaults to available builtins and retains the custom module form', () => {
  const page = pageWith([removed])
  page.openAdd()
  assert.equal(page.addOpen, true)
  assert.equal(page.addMode, 'builtin')
  page.closeAdd()
  page.plugins = [optional]
  page.openAdd()
  assert.equal(page.addMode, 'custom')
  assert.equal(page.addForm.module, '')
})

test('opening and cancelling uninstall confirmation never sends DELETE', () => {
  let calls = 0
  const page = pageWith([optional], async () => { calls++; throw new Error('unexpected request') })
  page.openUninstall(optional)
  assert.equal(page.uninstallOpen, true)
  assert.equal(page.uninstallTarget.id, optional.id)
  page.closeUninstall()
  assert.equal(page.uninstallOpen, false)
  assert.equal(calls, 0)
  page.openUninstall({ ...optional, canUninstall: false })
  assert.equal(page.uninstallOpen, false)
})

test('builtin uninstall refreshes catalog and closes confirmation only after success', async () => {
  const calls = []
  const page = pageWith([optional], async (url, options) => {
    calls.push([url, options.method])
    if (options.method === 'DELETE') return { status: 204, ok: true }
    return { status: 200, ok: true, json: async () => ({ plugins: [removed] }) }
  })
  page.openUninstall(optional)
  await page.uninstall()
  assert.equal(calls[0][0], `/__redtrace/plugins/${optional.id}`)
  assert.equal(calls[0][1], 'DELETE')
  assert.equal(page.uninstallOpen, false)
  assert.equal(page.filtered.length, 0)
  assert.equal(page.available.length, 1)
  assert.equal(page.busyId, '')
})

test('uninstall failure keeps the confirmation and registration visible', async () => {
  const page = pageWith([optional], async () => ({ status: 400, ok: false, json: async () => ({ detail: '清理失败，请重试' }) }))
  page.openUninstall(optional)
  await page.uninstall()
  assert.equal(page.uninstallOpen, true)
  assert.equal(page.uninstallTarget.id, optional.id)
  assert.equal(page.messageType, 'error')
  assert.match(page.message, /清理失败/)
  assert.equal(page.busyId, '')
})

test('reinstall uses the existing start endpoint and restores the installed list', async () => {
  const calls = []
  const page = pageWith([removed], async (url, options) => {
    calls.push([url, options.method])
    return { status: 200, ok: true, json: async () => options.method === 'GET' ? { plugins: [optional] } : { plugin: optional } }
  })
  await page.install(removed)
  assert.equal(calls[0][0], `/__redtrace/plugins/${optional.id}/start`)
  assert.equal(calls[0][1], 'POST')
  assert.equal(page.available.length, 0)
  assert.equal(page.filtered.length, 1)
  assert.equal(page.busyId, '')
})

test('custom install retains local module configuration and surfaces invalid JSON without sending requests', async () => {
  let calls = 0
  const page = pageWith([], async () => { calls++; throw new Error('unexpected request') })
  page.openAdd()
  page.addForm = { id: 'fixture', module: 'plugins/fixture/index.js', label: '', description: '', config: '{invalid' }
  await page.add()
  assert.equal(calls, 0)
  assert.equal(page.addOpen, true)
  assert.equal(page.messageType, 'error')
  assert.equal(page.addBusy, false)
})
