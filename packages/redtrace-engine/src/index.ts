import { HttpError } from './types.ts'
import { Type } from 'typebox'
import { LegionExperience } from './legion-experience.ts'
import { createServer } from 'node:http'
import { readFile, realpath, stat } from 'node:fs/promises'
import { watch } from 'node:fs'
import path from 'node:path'
import { Store } from './store.ts'
import { LegionStore } from './legion-store.ts'
import { ProjectEvidence } from './project-evidence.ts'
import { Configuration } from './config.ts'
import { Scheduler } from './scheduler.ts'
import type { RunTask, SelectWorker } from './scheduler.ts'
import type { EngineConfig, Worker } from './types.ts'
export type ProbeModel = (config: EngineConfig, worker: Worker, signal: AbortSignal) => Promise<void>
import { Router, send, queryNumber, body } from './http.ts'
import { graphRoutes } from './graph-api.ts'
import { configRoutes } from './config-api.ts'
import { auditRoutes } from './audit-api.ts'
import { Capabilities, capabilityRoutes } from './capabilities.ts'
import { Operations, operationRoutes } from './operations.ts'
import { verbRoutes } from './capability-verbs.ts'
import { ProjectDeletion, deletionRoutes } from './deletion.ts'
import { dshUpdateRoutes } from './dsh-update.ts'

export { Store, Scheduler, Configuration, Router, LegionStore, ProjectEvidence }
export type * from './types.ts'
export type { EvidenceChange, StepUpdate } from './store.ts'
export type { TaskContext, RunTask } from './scheduler.ts'

export async function createEngine(options: { root: string; database?: string; configuration?: string; runTask?: RunTask; selectWorker?: SelectWorker; autoStart?: boolean; probeModel?: ProbeModel; adapterAvailability?: () => (adapter: string) => boolean }) {
  const [major, minor] = process.versions.node.split('.').map(Number)
  if (major !== 24 || minor < 15) throw new Error('RedTrace requires Node 24.15 or newer in the Node 24 LTS line')
  const root = path.resolve(options.root), configuration = new Configuration(root, options.configuration)
  const managed = path.dirname(configuration.filename), staticRoot = path.resolve(import.meta.dirname, '../../../static')
  configuration.initialize()
  // Reject an invalid configuration before the scheduler starts.
  const config = configuration.resolvedSnapshot().config
  const store = new Store(options.database ?? path.join(root, '.redtrace/engine.db'))
  const legion = new LegionStore(store), evidence = new ProjectEvidence(store, configuration.workspaceRoot)
  const adapterGate = options.adapterAvailability?.()
  const runTask: RunTask = async context => {
    try {
      const task = { ...context, operations, currentMaxSteps: () => configuration.resolvedSnapshot().config.maxSteps }
      if (options.runTask) return await options.runTask(task)
      const runner = await import('./runner.ts')
      if (task.run.backend === 'mock') return runner.runMock(task)
      throw new Error('DSH execution requires the DSH host; no alternate Agent executor is available')
    } finally { operations.releaseRunLeases(context.run.id) }
  }
  const scheduler = new Scheduler(store,config,runTask,options.selectWorker,()=>!adapterGate || adapterGate('redtrace-critical-events')), router = new Router()
  const experience = new LegionExperience(store,configuration.workspaceRoot)
  router.add('GET', '/v2/legion', c => {const id=c.url.searchParams.get('projectId');return id?{...new LegionStore(store,id).board(),transfers:experience.transfers(id)}:{projects:store.projects().map(p=>({id:p.id,title:p.title,mode:p.mode,status:p.status}))}})
  router.add('GET','/v2/projects/:project/commander',c=>({...new LegionStore(store,c.params.project).board(),transfers:experience.transfers(c.params.project)}))
  const text=Type.String({minLength:1}),refs=Type.Array(text,{minItems:1})
  router.add('POST','/v2/legion/message',async c=>{const b=await body(c.req,Type.Object({projectId:text,receiver:Type.Literal('commander'),type:Type.Union(['HELP','REPORT','MESSAGE'].map(v=>Type.Literal(v))),content:text}));return legion.message(b.projectId,'commander',b.receiver,b.type,b.content)})
  router.add('POST','/v2/projects/:project/legion/park',async c=>{const b=await body(c.req,Type.Object({taskKey:text,reason:text,resumeCondition:text}));return legion.park(c.params.project,b.taskKey,b.reason,b.resumeCondition)})
  router.add('POST','/v2/projects/:project/legion/reactivate',async c=>{const b=await body(c.req,Type.Object({taskKey:text,reason:text}));return legion.reactivate(c.params.project,b.taskKey,b.reason)})
  router.add('POST','/v2/legion/experience',async c=>{const b=await body(c.req,Type.Object({projectId:text,family:text,title:text,body:text,factIds:refs}));return experience.capture(b.projectId,b)})
  router.add('POST','/v2/legion/transfer',async c=>{const b=await body(c.req,Type.Object({sourceId:Type.Integer({minimum:1}),targetProject:text,taskKey:text,brief:text}));return experience.transfer(b.sourceId,b.targetProject,b.taskKey,b.brief)})
  router.add('POST','/v2/legion/transfer/:id/confirm',async c=>{const b=await body(c.req,Type.Object({projectId:text,factIds:refs}));return experience.confirm(c.params.id,b.projectId,b.factIds)})
  router.add('POST','/v2/legion/reassign',async c=>{const b=await body(c.req,Type.Object({projectId:text,runId:text,nextWorker:text,summary:text})),run=store.run(b.runId);if(run.projectId!==b.projectId||!run.stepId)throw new HttpError(403,'Run does not belong to Project');const step=store.node<import('./types.ts').Step>(b.projectId,run.stepId,'step');if(!configuration.resolvedSnapshot().config.workers.some(w=>w.name===b.nextWorker&&w.enabled&&w.roles?.includes(step.role??'soldier')))throw new HttpError(422,'Model route does not support the same role');return legion.requestHandoff(run.id,b.summary,b.nextWorker)})
  router.add('GET','/v2/legion/experience',c=>experience.search(c.url.searchParams.get('query')??'',c.url.searchParams.get('family')??undefined))
  graphRoutes(router, store, () => configuration.resolvedSnapshot().config.maxSteps, (projectId, graphId) => legion.planningTodos(projectId).list(graphId), configuration.workspaceRoot)
  router.add('GET', '/v2/projects/:project/evidence/:artifact', c => new ProjectEvidence(c.url.searchParams.has('graphId')?store.forGraph(c.params.project,c.url.searchParams.get('graphId')!):store.forProject(c.params.project),configuration.workspaceRoot).read(c.params.project, c.params.artifact, queryNumber(c.url, 'offset', 0), queryNumber(c.url, 'length', 7600, 1, 7600)))
  router.add('GET', '/health', () => ({ status: 'ok', engine: 'fgs', node: process.versions.node, schema: 2 }))
  configRoutes(router, configuration, options.probeModel)
  const dshUpdate = await dshUpdateRoutes(router, path.resolve(process.env.REDTRACE_SOURCE_ROOT || root), scheduler)
  auditRoutes(router, store, configuration.workspaceRoot)
  const capabilities = new Capabilities(managed)
  capabilities.initialize(root)
  capabilityRoutes(router, capabilities)
  const operations = new Operations(store, root, adapterGate)
  operationRoutes(router, operations)
  verbRoutes(router, operations, adapterGate)
  const deletion = new ProjectDeletion(store, operations, root, configuration.workspaceRoot)
  deletion.stopRuntime=id=>scheduler.stopProject(id)
  deletionRoutes(router, deletion)
  const watcher = watch(path.dirname(configuration.filename), (_event, filename) => {
    if (filename && String(filename) !== path.basename(configuration.filename)) return
    try { scheduler.update(configuration.resolvedSnapshot().config) } catch { console.error('Configuration reload failed; keeping the last valid configuration') }
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
  return { store, legion, evidence, scheduler, configuration, capabilities, operations, deletion, router, handler, async close() { watcher.close(); await dshUpdate.close(); await scheduler.close(); await import('./http-tools.ts').then(({ closeHttpSessions }) => closeHttpSessions(store)); await operations.close(); store.close() } }
}
export async function serveEngine(options: Parameters<typeof createEngine>[0] & { host?: string; port?: number }) {
  const engine = await createEngine(options)
  const server = createServer((req, res) => { void engine.handler(req, res).catch(() => { if (!res.headersSent) send(res, { detail: 'Internal server error' }, 500); else res.destroy() }) })
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port ?? 8000, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve() }) }) }
  catch (error) { await engine.close(); throw error }
  return { ...engine, server, async close() { const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); server.closeAllConnections(); await closed; await engine.close() } }
}
