import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, readlink, writeFile, rm, symlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
import { serveEngine } from '../src/index.ts'

test('runtime source copying preserves portable relative symlinks', async () => {
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/update-dsh.mjs')).href
  const { prepareRuntime } = await import(url)
  const root = await mkdtemp(path.join(os.tmpdir(), 'redtrace-dsh-links-'))
  const source = path.join(root, 'source'), destination = path.join(root, 'destination')
  try {
    for (const name of ['packages', 'vendor', 'native', 'patches']) await mkdir(path.join(source, name), { recursive: true })
    await writeFile(path.join(source, 'packages/AGENTS.md'), 'fixture')
    await symlink('AGENTS.md', path.join(source, 'packages/CLAUDE.md'), 'file')
    // The sparse source stops at scripts/types after the runtime directories have been copied.
    await assert.rejects(prepareRuntime(source, destination), { code: 'ENOENT' })
    assert.equal(await readlink(path.join(destination, 'packages/CLAUDE.md')), 'AGENTS.md')
    assert.equal(await readFile(path.join(destination, 'packages/CLAUDE.md'), 'utf8'), 'fixture')
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('runtime preparation retains Vite required by upstream host build configurations', async () => {
  const { prepareRuntime } = await import(pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/update-dsh.mjs')).href)
  const root = await mkdtemp(path.join(os.tmpdir(), 'redtrace-dsh-build-deps-'))
  const source = path.join(root, 'source'), destination = path.join(root, 'destination')
  try {
    for (const name of ['packages/bundle/web-app', 'vendor', 'native', 'patches', 'scripts/types', 'apps/cli/config']) await mkdir(path.join(source, name), { recursive: true })
    for (const name of ['scripts/client-build-environment.ts', 'scripts/bundle-input-isolation.ts', 'LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.base.client.json', 'tsconfig.json', 'tsconfig.client.json', 'tsdown.config.ts']) await writeFile(path.join(source, name), '')
    // Stop after writing the staged package, before local patches and dependency installation.
    await writeFile(path.join(source, 'tsconfig.host.json'), '{')
    await writeFile(path.join(source, 'apps/cli/package.json'), '{}')
    await writeFile(path.join(source, 'packages/bundle/web-app/package.json'), JSON.stringify({ dependencies: { '@deepseek-ai/dsh-web-frontend': 'workspace:*' } }))
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ workspaces: ['packages/*/*', 'website'], devDependencies: { vite: '8.0.16', tsdown: '^0.22.2', typescript: '^6.0.3', vitest: '^4.0.0' } }))
    await assert.rejects(prepareRuntime(source, destination), /Invalid upstream tsconfig.host.json/)
    const staged = JSON.parse(await readFile(path.join(destination, 'package.json'), 'utf8'))
    assert.equal(staged.devDependencies.vite, '8.0.16')
    assert.equal(staged.devDependencies.tsdown, '^0.22.2')
    assert.equal(staged.devDependencies.vitest, undefined)
    assert.deepEqual(staged.workspaces, ['packages/*/*'])
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('DSH update API protects active runs, rejects cross-origin calls and keeps scheduling paused until restart', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'redtrace-dsh-update-'))
  await mkdir(path.join(root, 'vendor/deepseek-harness'), { recursive: true })
  await mkdir(path.join(root, 'scripts'))
  const pkg = path.join(root, 'vendor/deepseek-harness/package.json')
  await writeFile(pkg, JSON.stringify({ version: '0.1.0' }))
  await writeFile(path.join(root, 'scripts/update-dsh.mjs'), `
import { readFile, writeFile } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
await delay(200)
const mode = await readFile('scripts/mode', 'utf8')
if (mode === 'fail') {
  console.error("Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'vite' imported from fixture\\n" + '    at fixture (node:internal/modules/esm/resolve:1:1)\\n'.repeat(80) + 'fixture build failed')
  process.exit(1)
}
const changed = mode === 'success'
if (changed) await writeFile('vendor/deepseek-harness/package.json', JSON.stringify({version:'0.2.0'}))
console.log('DSH_UPDATE_RESULT ' + JSON.stringify({changed, version: changed ? '0.2.0' : '0.1.0'}))
`)
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const get = async () => (await fetch(url + '/runtime/dsh')).json()
  const update = (headers = {}) => fetch(url + '/runtime/dsh/update', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: '{}' })
  const settled = async () => { for (let i = 0; i < 100; i++) { const value = await get(); if (value.state && value.state !== 'running') return value; await delay(20) }; throw new Error('Update did not settle') }
  try {
    assert.equal((await get()).runningVersion, '0.1.0')
    assert.equal((await update({ Origin: 'https://other.test' })).status, 403)
    assert.equal((await update({ Origin: 'null' })).status, 403)
    assert.equal((await fetch(url + '/runtime/dsh/update', { method: 'POST' })).status, 422)
    const { project } = engine.store.createProject({ title: 'fixture', origin: 'fixture', goal: 'fixture', bootstrap: false })
    const run = engine.store.claim(project.id, 'decide', { name: 'mock', backend: 'mock' })
    assert.equal((await update()).status, 409)
    engine.store.finishRun(run.id, 'cancelled')
    await writeFile(path.join(root, 'scripts/mode'), 'fail')
    assert.equal((await update()).status, 202); assert.equal(engine.scheduler.maintenance, true)
    assert.equal((await update()).status, 409)
    const failed = await settled()
    assert.equal(failed.state, 'failed'); assert.match(failed.message, /fixture build failed/)
    assert.match(failed.message, /Cannot find package 'vite'/)
    assert.doesNotMatch(failed.message, /at fixture/)
    assert.equal(engine.scheduler.maintenance, false)
    assert.equal(JSON.parse(await readFile(pkg, 'utf8')).version, '0.1.0')
    await writeFile(path.join(root, 'scripts/mode'), 'noop')
    assert.equal((await update()).status, 202)
    assert.equal((await settled()).restartRequired, false); assert.equal(engine.scheduler.maintenance, false)
    await writeFile(path.join(root, 'scripts/mode'), 'success')
    assert.equal((await update()).status, 202)
    const success = await settled()
    assert.equal(success.state, 'succeeded'); assert.equal(success.restartRequired, true)
    assert.equal(success.installedVersion, '0.2.0'); assert.equal(success.runningVersion, '0.1.0')
    assert.equal(engine.scheduler.maintenance, true)
    assert.equal((await update()).status, 409)
  } finally { await engine.close(); await rm(root, { recursive: true, force: true }) }
})

test('updater includes RC releases, detects source edits and leaves the runtime intact on failure', async () => {
  const url = pathToFileURL(path.resolve(import.meta.dirname, '../../../scripts/update-dsh.mjs')).href
  const { latestRelease, sourceDigest, updateDsh } = await import(url)
  const root = await mkdtemp(path.join(os.tmpdir(), 'redtrace-dsh-source-'))
  const vendor = path.join(root, 'vendor/deepseek-harness')
  await mkdir(vendor, { recursive: true }); await mkdir(path.join(vendor, 'lib'))
  await writeFile(path.join(vendor, 'package.json'), JSON.stringify({ version: '0.1.0' }))
  const originalFetch = globalThis.fetch
  try {
    globalThis.fetch = async () => new Response(JSON.stringify([
      { draft: true, tag_name: 'dsh-v0.3.0', html_url: 'draft' },
      { draft: false, tag_name: 'desktop-v1', html_url: 'desktop' },
      { draft: false, prerelease: true, tag_name: 'dsh-v0.2.0-rc.2', html_url: 'release' },
    ]))
    assert.equal((await latestRelease()).version, '0.2.0-rc.2')
    const digest = await sourceDigest(vendor)
    await writeFile(path.join(vendor, 'upstream.json'), JSON.stringify({ digest }))
    await writeFile(path.join(vendor, 'lib/index.js'), 'generated')
    assert.equal(await sourceDigest(vendor), digest)
    await writeFile(path.join(vendor, 'local.ts'), 'local edit')
    assert.notEqual(await sourceDigest(vendor), digest)
    await assert.rejects(updateDsh({ root, release: { version: '0.2.0', tag: 'dsh-v0.2.0' } }), /local changes/)
    assert.equal(JSON.parse(await readFile(path.join(vendor, 'package.json'), 'utf8')).version, '0.1.0')
    await rm(path.join(vendor, 'local.ts'))
    const source = path.join(root, 'source'); await mkdir(source)
    await writeFile(path.join(source, 'package.json'), JSON.stringify({ version: 'wrong' }))
    await assert.rejects(updateDsh({ root, source, release: { version: '0.2.0', tag: 'dsh-v0.2.0' } }), /does not match/)
    assert.equal(JSON.parse(await readFile(path.join(vendor, 'package.json'), 'utf8')).version, '0.1.0')
  } finally { globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }) }
})
