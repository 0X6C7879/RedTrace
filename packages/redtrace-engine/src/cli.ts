import path from 'node:path'
import { parseArgs } from 'node:util'
import { serveEngine, Configuration } from './index.ts'

const { values } = parseArgs({ options: { root: { type: 'string', default: process.cwd() }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8000' }, config: { type: 'string' }, 'copy-config': { type: 'string' }, mock: { type: 'boolean', default: false }, help: { type: 'boolean', default: false } } })
if (values.help) { console.log('RedTrace Node engine: --root DIR --host 127.0.0.1 --port 8000 --config SOURCE --copy-config SOURCE --mock'); process.exit(0) }
const port = Number(values.port)
if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('Invalid port')
const root = path.resolve(values.root), configuration = new Configuration(root)
configuration.initialize(path.resolve(root, values['copy-config'] ?? values.config ?? 'redtrace.yaml'))
if (values.mock) {
  const { revision } = configuration.read()
  configuration.commit(revision, raw => { raw.workers = [{ name: 'mock', provider: 'mock', model: 'mock', max_running: 4 }] })
}
const engine = await serveEngine({ root, configuration: configuration.filename, host: values.host, port })
const address = engine.server.address()
console.log(`RedTrace FGS listening at http://${values.host}:${typeof address === 'object' ? address?.port : port}`)
let closing = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!closing) { closing = true; void engine.close().then(() => process.exit(0)).catch(() => process.exit(1)) } })
