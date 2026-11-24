import assert from 'node:assert/strict'
import test from 'node:test'
import { chromium } from 'playwright'

// Explicit opt-in: ordinary test runs must never modify a user's running app.
const base = process.env.REDTRACE_PLUGIN_E2E_URL

test('plugin page confirms uninstall, persists removal on reload and reinstalls an optional builtin', { skip: !base, timeout: 60000 }, async t => {
  const endpoint = `${base}/__redtrace/plugins`
  const plugins = async () => {
    const response = await fetch(endpoint)
    assert.equal(response.status, 200)
    return (await response.json()).plugins
  }
  const original = (await plugins()).find(plugin => plugin.id === 'redtrace-lsp')
  if (!original?.installed || original.status !== 'stopped') return t.skip('Requires an installed, stopped LSP plugin on an idle local app')
  const browser = await chromium.launch({ headless: true, channel: 'msedge' })
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  const set = async action => {
    const response = await fetch(`${endpoint}/redtrace-lsp/${action}`, { method: 'POST' })
    assert.equal(response.status, 200)
  }
  try {
    await page.goto(base)
    await page.getByRole('button', { name: '插件', exact: true }).click()
    assert.equal(await page.getByRole('button', { name: '卸载 Domain', exact: true }).count(), 0)
    const remove = page.getByRole('button', { name: '卸载 LSP', exact: true })
    await remove.click()
    let dialog = page.getByRole('dialog', { name: '卸载 LSP？', exact: true })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    assert.equal((await plugins()).find(plugin => plugin.id === original.id).installed, true)
    await remove.click()
    await dialog.getByRole('button', { name: '确认卸载', exact: true }).click()
    await remove.waitFor({ state: 'detached' })
    assert.equal((await plugins()).find(plugin => plugin.id === original.id).installed, false)
    await page.reload()
    await page.getByRole('button', { name: '插件', exact: true }).click()
    await page.getByRole('button', { name: '安装插件', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '安装插件', exact: true })
    const install = dialog.getByRole('button', { name: '安装 LSP', exact: true })
    await install.click()
    await install.waitFor({ state: 'detached' })
    await dialog.getByRole('button', { name: '完成', exact: true }).click()
    await remove.waitFor({ state: 'visible' })
    assert.equal((await plugins()).find(plugin => plugin.id === original.id).installed, true)
    await page.getByRole('switch', { name: '停止 LSP', exact: true }).click()
    await page.getByRole('switch', { name: '启动 LSP', exact: true }).waitFor({ state: 'visible' })
    assert.equal((await plugins()).find(plugin => plugin.id === original.id).status, 'stopped')
    assert.deepEqual(errors, [])
  } finally {
    try {
      const current = (await plugins()).find(plugin => plugin.id === original.id)
      if (!current.installed) await set('start')
      if (current.status !== 'stopped' || !current.installed) await set('stop')
    } finally {
      await browser.close()
    }
  }
})
