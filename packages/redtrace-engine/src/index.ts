import { createServer } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import path from 'node:path'
import { Store } from './store.ts'
import { Configuration } from './config.ts'
import { Scheduler } from './scheduler.ts'
import type { RunTask, SelectWorker } from './scheduler.ts'
import { Router, send } from './http.ts'
import { graphRoutes } from './graph-api.ts'
import { configRoutes } from './config-api.ts'
import { auditRoutes } from './audit-api.ts'
import { Capabilities, capabilityRoutes } from './capabilities.ts'
import { Operations, operationRoutes } from './operations.ts'
import { verbRoutes } from './capability-verbs.ts'
import { ProjectDeletion, deletionRoutes } from './deletion.ts'

export { Store, Scheduler, Configuration, Router }
export type * from './types.ts'
export type { TaskContext, RunTask } from './scheduler.ts'

export async function createEngine(options: { root: string; database?: string; configuration?: string; runTask?: RunTask; selectWorker?: SelectWorker; autoStart?: boolean; adapterAvailability?: () => (adapter: string) => boolean }) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major !== 24 || minor < 15) throw new Error('RedTrace requires Node 24.15 or newer in the Node 24 LTS line')
  const root = path.resolve(options.root), configuration = new Configuration(root, options.configuration)
  const managed = path.dirname(configuration.filename), staticRoot = path.join(root, 'static')
  configuration.initialize()
  const config = configuration.resolve(configuration.read().raw)
  const store = new Store(options.database ?? path.join(root, '.redtrace/engine.db'))
  const adapterGate = options.adapterAvailability?.()
  const runTask: RunTask = options.runTask ?? (async context => {
    const runner = await import('./runner.ts')
    if (context.run.backend === 'mock') return runner.runMock(context)
    if (context.run.backend === 'pi') return runner.runPi(context, capabilities, { operations, isAdapterAvailable: adapterGate })
    throw new Error('DSH execution requires the Cordis compatibility host')
  })
  const scheduler = new Scheduler(store, config, runTask, options.selectWorker), router = new Router()
  graphRoutes(router, store, () => configuration.resolve(configuration.read().raw).maxSteps)
  router.add('GET', '/health', () => ({ status: 'ok', engine: 'fgs', node: process.versions.node, schema: 1 }))
  router.add('GET', '/settings', () => { const c = configuration.resolve(configuration.read().raw); return { intent_timeout: c.executeTimeout, reason_timeout: c.decideTimeout } })
  configRoutes(router, configuration)
  auditRoutes(router, store, configuration.workspaceRoot)
  const capabilities = new Capabilities(managed)
  capabilities.initialize(root)
  capabilityRoutes(router, capabilities)
  const operations = new Operations(store, root)
  operationRoutes(router, operations)
  verbRoutes(router, operations, adapterGate)
  const deletion = new ProjectDeletion(store, operations, root, configuration.workspaceRoot)
  deletionRoutes(router, deletion)
  const watcher = watch(path.dirname(configuration.filename), (_event, filename) => {
    if (filename && String(filename) !== path.basename(configuration.filename)) return
    try { scheduler.update(configuration.resolve(configuration.read().raw)) } catch { console.error('Configuration reload failed; keeping the last valid configuration') }
  })
  const handler = async (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    if (await router.handle(req, res)) return
    let pathname: string
    try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname) } catch { send(res, { detail: 'Invalid path' }, 400); return }
    if (req.method === 'GET' && (pathname === '/' || pathname.startsWith('/static/'))) {
      try {
        const filename = await realpath(path.join(staticRoot, pathname === '/' ? 'index.html' : pathname.slice('/static/'.length)))
        const relative = path.relative(await realpath(staticRoot), filename)
        if (relative.startsWith('..') || path.isAbsolute(relative) || !(await stat(filename)).isFile()) throw new Error()
        const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' }
        res.writeHead(200, { 'Content-Type': `${mime[path.extname(filename)] ?? 'application/octet-stream'}; charset=utf-8` }); res.end(await readFile(filename)); return
      } catch { send(res, { detail: 'Not Found' }, 404); return }
    }
    send(res, { detail: 'Not Found' }, 404)
  }
  if (options.autoStart !== false) scheduler.start()
  return { store, scheduler, configuration, capabilities, operations, deletion, router, handler, async close() { watcher.close(); await scheduler.close(); await operations.close(); store.close() } }
}
export async function serveEngine(options: Parameters<typeof createEngine>[0] & { host?: string; port?: number }) {
  const engine = await createEngine(options)
  const server = createServer((req, res) => { void engine.handler(req, res).catch(() => { if (!res.headersSent) send(res, { detail: 'Internal server error' }, 500); else res.destroy() }) })
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8000, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() }) }) }
  catch (error) { await engine.close(); throw error }
  return { ...engine, server, async close() { const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closed; await engine.close() } }
}
