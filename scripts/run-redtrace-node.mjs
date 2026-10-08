import path from 'node:path'
import { mkdir, access, readFile, writeFile } from 'node:fs/promises'
import { parseArgs } from 'node:util'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Configuration } from '../packages/redtrace-engine/src/config.ts'

const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() }, host: { type: 'string', default: '0.0.0.0' }, port: { type: 'string', default: '8000' }, config: { type: 'string' }, 'copy-config': { type: 'string' }, compat: { type: 'boolean', default: false }, mock: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } })
const [major, minor] = process.versions.node.split('.').map(Number)
if (major !== 24 || minor < 15) throw new Error('Node 24.15+ required')
if (values.help) { console.log('RedTrace Node: --root DIR --host 0.0.0.0 --port 8000 --config SOURCE --copy-config SOURCE --mock [--compat]'); process.exit(0) }
if (!values.compat) { await import('../packages/redtrace-engine/src/cli.ts'); }
else {
  const root = path.resolve(values.root), managed = path.resolve(process.env.REDTRACE_DATA_ROOT || path.join(root, '.redtrace'))
  const config = new Configuration(root, path.join(managed, 'redtrace.yaml'))
  const runtimeRoot = path.resolve(fileURLToPath(new URL('../', import.meta.url)))
  const sourceRoot = path.resolve(process.env.REDTRACE_SOURCE_ROOT || runtimeRoot), codeRoot = path.resolve(process.env.REDTRACE_DSH_ROOT || runtimeRoot)
  const source = values['copy-config'] ?? values.config ?? path.join(root, 'redtrace.yaml')
  await mkdir(managed, { recursive: true }); config.initialize(path.resolve(root, source))
  try { await access(path.join(managed, 'capabilities-imported.json')) }
  catch { console.error('==> first run: importing Skills and MCP configuration') }
  if (process.env.BRAVE_API_KEY) config.commit(config.read().revision, raw => { raw.common_env = { ...raw.common_env, BRAVE_API_KEY: process.env.BRAVE_API_KEY } })
  if (values.mock) config.commit(config.read().revision, raw => { raw.workers = [{ name: 'mock', provider: 'mock', max_running: 4 }] })
  process.env.REDTRACE_DSH_WEB_HOST = values.host; process.env.REDTRACE_DSH_WEB_PORT = values.port
  process.env.REDTRACE_CODE_ROOT = codeRoot; process.env.REDTRACE_SOURCE_ROOT = sourceRoot
  process.env.DSH_SESSION_ROOT = path.join(managed, 'sessions')
  process.env.REDTRACE_NODE_OPTIONS = JSON.stringify({ root, database: path.join(managed, 'engine.db'), configuration: config.filename, server: `http://${values.host}:${values.port}` })
  const { boot, installFailLoud } = await import(pathToFileURL(path.join(codeRoot, 'vendor/deepseek-harness/packages/boot/app-boot/lib/index.js')).href)
  installFailLoud('redtrace-node')
  let profile = path.join(sourceRoot, 'profiles/redtrace/node.cordis.yml')
  if (codeRoot !== sourceRoot) {
    const portable = value => value.replaceAll('\\', '/')
    const content = (await readFile(profile, 'utf8'))
      .replaceAll('../../vendor/deepseek-harness', portable(path.join(codeRoot, 'vendor/deepseek-harness')))
      .replaceAll('../../packages/redtrace-engine', portable(path.join(runtimeRoot, 'packages/redtrace-engine')))
    profile = path.join(managed, 'node.cordis.yml'); await writeFile(profile, content)
  }
  const ctx = await boot('redtrace-node', profile)
  console.log(`RedTrace ready at http://${values.host}:${values.port}`)
  let closing = false
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { if (!closing) { closing = true; void ctx.fiber.dispose().then(() => process.exit(0)).catch(() => process.exit(1)) } })
}
