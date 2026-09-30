import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const root = fileURLToPath(new URL('../', import.meta.url)), candidate = path.resolve(process.argv[2] || root)
await mkdir(path.join(root, '.redtrace/dsh-smoke'), { recursive: true })
const work = await mkdtemp(path.join(root, '.redtrace/dsh-smoke/check-'))
await symlink(path.join(root, 'static'), path.join(work, 'static'), 'dir')
await mkdir(path.join(candidate, 'profiles/redtrace'), { recursive: true })
if (candidate !== root) await writeFile(path.join(candidate, 'profiles/redtrace/node.cordis.yml'), await readFile(path.join(root, 'profiles/redtrace/node.cordis.yml')))
const listener = createServer()
await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
const port = listener.address().port
await new Promise(resolve => listener.close(resolve))
const child = spawn(process.execPath, [path.join(root, 'scripts/run-redtrace-node.mjs'), '--compat', '--mock', '--root', work, '--port', String(port)], {
  cwd: root,
  env: { ...process.env, DSH_HOME: path.join(work, '.dsh'), REDTRACE_SOURCE_ROOT: candidate, REDTRACE_DSH_ROOT: candidate, REDTRACE_DATA_ROOT: path.join(work, '.redtrace') },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let logs = '', exited = false
const closed = new Promise(resolve => child.once('close', () => { exited = true; resolve() }))
child.once('error', error => { logs += error.message })
for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs = (logs + chunk).slice(-30000) })
try {
  let healthy = false
  for (let attempt = 0; attempt < 100 && !exited; attempt++) {
    try { healthy = (await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(500) })).ok } catch { /* Host is still starting. */ }
    if (healthy) break
    await delay(200)
  }
  assert.ok(healthy, 'DSH compatibility host did not start\n' + logs)
  const plugins = await (await fetch(`http://127.0.0.1:${port}/__redtrace/plugins`)).json()
  const entries = Array.isArray(plugins) ? plugins : plugins.plugins
  assert.ok(Array.isArray(entries), 'Plugin list was not returned')
  const failed = entries.filter(plugin => plugin.status === 'failed' || plugin.error)
  assert.deepEqual(failed, [], 'DSH plugins failed to mount')
  assert.ok(entries.some(plugin => plugin.id === 'redtrace-core' && plugin.status === 'running'), 'Core plugin did not start: ' + JSON.stringify(entries))
  assert.equal((await fetch(`http://127.0.0.1:${port}/worker-config`)).status, 200)
  const config = await (await fetch(`http://127.0.0.1:${port}/worker-config`)).json()
  const provider = { expected_revision: config.revision, name: 'dsh-smoke', api: 'openai-completions', base_url: 'http://127.0.0.1:1/v1', models: [{ id: 'fixture', reasoning: 'off' }] }
  assert.equal((await fetch(`http://127.0.0.1:${port}/worker-config/providers`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(provider) })).status, 201)
  const refreshed = await (await fetch(`http://127.0.0.1:${port}/runtime/config`)).json()
  assert.equal(refreshed.providers['dsh-smoke'].baseURL, provider.base_url)
  assert.equal((await fetch(`http://127.0.0.1:${port}/`)).status, 200)
  console.log('DSH compatibility host, core plugins, Provider hot reload and Web UI passed')
} finally {
  if (!exited) child.kill('SIGTERM')
  await Promise.race([closed, delay(5000)])
  if (!exited) { child.kill('SIGKILL'); await closed }
}
