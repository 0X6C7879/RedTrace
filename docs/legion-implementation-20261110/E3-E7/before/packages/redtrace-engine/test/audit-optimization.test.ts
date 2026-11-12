import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'

const root = process.env.REDTRACE_AUDIT_ROOT ?? path.resolve(import.meta.dirname, '../../..')
const source = (name: string) => readFileSync(path.join(root, name), 'utf8')
const { Store } = await import(pathToFileURL(path.join(root, 'packages/redtrace-engine/src/store.ts')).href)
const { legacyProject, legacySummary } = await import(pathToFileURL(path.join(root, 'packages/redtrace-engine/src/legacy.ts')).href)
const { graphRoutes } = await import(pathToFileURL(path.join(root, 'packages/redtrace-engine/src/graph-api.ts')).href)
const { auditRoutes } = await import(pathToFileURL(path.join(root, 'packages/redtrace-engine/src/audit-api.ts')).href)
const { configRoutes } = await import(pathToFileURL(path.join(root, 'packages/redtrace-engine/src/config-api.ts')).href)
const { Operations } = await import(pathToFileURL(path.join(root, 'packages/redtrace-engine/src/operations.ts')).href)
const routes = () => {
  const handlers = new Map<string, (context?: any) => any>()
  return { handlers, add(method: string, url: string, handle: (context: any) => any) { handlers.set(`${method} ${url}`, handle) } }
}
function app() {
  const context = vm.createContext({ window: {}, console })
  vm.runInContext(source('static/fgs-view.js'), context)
  const script = [...source('static/index.html').matchAll(/<script>([\s\S]*?)<\/script>/g)].find(item => item[1].includes('function redtraceApp()'))![1]
  vm.runInContext(script, context)
  return vm.runInContext('redtraceApp()', context)
}
function operationsPage() {
  const context = vm.createContext({ console, queueMicrotask })
  vm.runInContext(source('static/operations.js'), context)
  const page = vm.runInContext('operationsPage()', context)
  page.active = true
  page.isDedicatedLedgerPage = () => true
  return page
}
function fixture() {
  const store = new Store(':memory:')
  const { project } = store.createProject({ title: 'Audit regression', origin: 'Local synthetic input', goal: 'Regression only', bootstrap: false })
  return { store, project }
}
const body = (value: unknown) => Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]), { headers: { 'content-type': 'application/json' } })

test('retired manual lifecycle controls are removed; Fact deletion keeps version and reference checks', async () => {
  const html = source('static/index.html')
  assert.doesNotMatch(html, /sendHeartbeatForSelectedIntent|releaseSelectedIntent|releaseSelectedGraphNode|createIntent\(true\)|\/blackboard\/facts\//)
  const { store, project } = fixture()
  try {
    const page = app(), fact = store.addFact(project.id, 'Independent evidence', { creator: 'human' })
    page.project = page.nativeProject(store.graph(project.id)); page.selectedProjectId = project.id
    page.selectedNode = { type: 'fact', id: fact.id }; page.selectedFacts = [fact.id]
    page.requestDangerConfirm = async () => true; page.clearSelection = () => {}; page.loadProject = async () => {}; page.updateGraph = () => {}
    const messages: string[] = []; page.showToast = (message: string) => messages.push(message)
    const router = routes(); graphRoutes(router, store)
    const handler = router.handlers.get('POST /v2/projects/:project/evidence/manage')!
    page.api = async (method: string, url: string, value: any) => {
      assert.equal(method, 'POST'); assert.equal(url, `/v2/projects/${project.id}/evidence/manage`)
      assert.equal(value.expectedVersion, fact.version)
      return handler({ req: body(value), params: { project: project.id } })
    }
    await page.releaseSelectedFact()
    assert.throws(() => store.node(project.id, fact.id), /not found/i)
    assert.equal(messages.length, 1)
    const unversioned = store.addFact(project.id, 'Legacy unversioned evidence', { creator: 'human' })
    delete unversioned.version
    store.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify(unversioned), project.id, unversioned.id)
    page.project = page.nativeProject(store.graph(project.id)); page.selectedNode = { type: 'fact', id: unversioned.id }; page.selectedFacts = [unversioned.id]
    page.api = async (_method: string, _url: string, value: any) => { assert.equal(value.expectedVersion, 1); return handler({ req: body(value), params: { project: project.id } }) }
    await page.releaseSelectedFact()
    assert.throws(() => store.node(project.id, unversioned.id), /not found/i)
    const referenced = store.addFact(project.id, 'Referenced evidence', { creator: 'human' })
    store.addStep(project.id, { description: 'Still needs evidence', sourceIds: [referenced.id] })
    const c = (expectedVersion: number, id = referenced.id) => ({ req: body({ operation: 'delete', id, expectedVersion, reason: 'Local fixture' }), params: { project: project.id } })
    await assert.rejects(handler(c(999)), (error: any) => error.status === 409)
    await assert.rejects(handler(c(referenced.version)), (error: any) => error.status === 409 && /references/.test(error.message))
    await assert.rejects(handler(c(1, 'origin')), (error: any) => error.status === 422)
  } finally { store.close() }
})

test('container entry and healthcheck share a concrete IPv4 host', async () => {
  const { containerHost } = await import(pathToFileURL(path.join(root, 'scripts/container-host.mjs')).href)
  const interfaces = { lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }], eth0: [{ address: '172.18.0.2', family: 'IPv4', internal: false }] }
  assert.equal(containerHost(interfaces), '172.18.0.2')
  assert.throws(() => containerHost({ lo: interfaces.lo }), /IPv4/)
  assert.match(source('Dockerfile'), /container-host\.mjs/)
  assert.doesNotMatch(source('Dockerfile'), /0\.0\.0\.0/)
  assert.match(source('docker-compose.yaml'), /containerHost\(\)/)
})

test('background refresh is single-flight without a foreground spinner', async () => {
  const page = operationsPage(), waiting: Array<(value: any) => void> = []
  page.api = () => new Promise(resolve => waiting.push(resolve))
  const first = page.refresh(false)
  const second = page.refresh(false)
  try { assert.equal(waiting.length, 4); assert.equal(page.loading, false) }
  finally { for (const resolve of waiting) resolve({ resources: [], tasks: [], events: [] }); await Promise.all([first, second]) }
  const next = page.refresh(false)
  assert.equal(waiting.length, 8)
  for (const resolve of waiting.slice(4)) resolve({ resources: [], tasks: [], events: [] })
  await next
})

test('page changes discard old refresh results and retry the current page; errors unlock refresh', async () => {
  const page = operationsPage(), waiting: Array<(value: any) => void> = []
  let calls = 0
  page.api = () => ++calls <= 4 ? new Promise(resolve => waiting.push(resolve)) : Promise.resolve({ resources: [{ id: 'current' }], tasks: [], events: [] })
  const first = page.refresh(false)
  page.selectedProjectId = 'proj_002'; page.pageMode = 'c2-tasks'
  for (const resolve of waiting) resolve({ resources: [{ id: 'stale' }], tasks: [], events: [] })
  await first
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(page.resources[0].id, 'current'); assert.equal(calls, 8)
  page.api = async () => { throw new Error('Fixture transport failed') }
  await page.refresh(false)
  assert.match(page.error, /Fixture transport/)
  page.api = async () => ({ resources: [], tasks: [], events: [] })
  await page.refresh(false)
  assert.equal(page.error, ''); assert.equal(page.loading, false)
})

test('activation does not subscribe the page effect to refresh flags', async () => {
  const page = operationsPage()
  let insideEffect = true, calls = 0
  page.refresh = async () => { assert.equal(insideEffect, false); calls++ }
  page.setActive(true, '', 'webshell')
  assert.equal(calls, 0)
  insideEffect = false
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls, 1)
})

test('a failed batch retains single-flight until all remaining requests settle', async () => {
  const page = operationsPage(), waiting: Array<(value: any) => void> = []
  let calls = 0
  page.api = () => ++calls === 1 ? Promise.reject(new Error('One endpoint failed')) : new Promise(resolve => waiting.push(resolve))
  const first = page.refresh(false)
  await new Promise(resolve => setImmediate(resolve))
  const second = page.refresh(false)
  const observedCalls = calls
  for (const resolve of waiting) resolve({ resources: [], tasks: [], events: [] })
  await Promise.all([first, second])
  assert.equal(observedCalls, 4)
  assert.match(page.error, /One endpoint failed/)
  page.api = async () => ({ resources: [], tasks: [], events: [] })
  await page.refresh(false)
  assert.equal(page.error, '')
})

test('legacy summary avoids full graph/history reads and preserves all counts', () => {
  const { store, project } = fixture()
  try {
    for (const status of ['pending', 'paused', 'blocked', 'running', 'done', 'cancelled']) {
      const step = store.addStep(project.id, { description: status, sourceIds: ['origin'] })
      step.status = status
      store.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify(step), project.id, step.id)
    }
    store.addInput(project.id, 'hint', 'Synthetic hint'); store.addFact(project.id, 'Fact', { creator: 'human' })
    const detail = legacyProject(store, project.id)
    store.graph = () => { throw new Error('Full graph must not be read by summary') }
    store.runs = () => { throw new Error('Run history must not be read by summary') }
    const summary = legacySummary(store, project.id)
    assert.deepEqual(summary, { ...detail.project, fact_count: detail.facts.length, intent_count: detail.intents.length, working_intent_count: 1, unclaimed_intent_count: 2, hint_count: 1 })
  } finally { store.close() }
})

test('legacy project matches latest Runs with one history pass', () => {
  const { store, project } = fixture()
  try {
    for (let i = 0; i < 100; i++) store.addStep(project.id, { description: `Synthetic ${i}`, sourceIds: ['origin'] })
    let reads = 0
    store.runs = () => Array.from({ length: 100 }, () => new Proxy({ activity: 'execute', stepId: 'missing' }, { get(target, key) { if (key === 'stepId') reads++; return Reflect.get(target, key) } }))
    assert.equal(legacyProject(store, project.id).intents.length, 100)
    assert.ok(reads <= 200, `Expected one pass, saw ${reads} Run/Step comparisons`)
  } finally { store.close() }
})

test('FGS refresh reads one graph and preserves Decide; legacy fallback is lazy', async () => {
  const { store, project } = fixture()
  try {
    store.claim(project.id, 'decide', { name: 'planner', backend: 'mock' })
    const router = routes(); graphRoutes(router, store)
    const page = app(); page.selectedProjectId = project.id; page.showToast = () => {}
    const urls: string[] = [], nativeGraph = store.graph.bind(store)
    let reads = 0
    store.graph = (...args: any[]) => { reads++; return nativeGraph(...args) }
    page.api = async (_method: string, url: string) => {
      urls.push(url)
      if (url.endsWith('/usage')) return { total: 0 }
      return router.handlers.get(url.startsWith('/v2/') ? 'GET /v2/projects/:project/graph' : 'GET /projects/:project')!({ params: { project: project.id }, url: new URL(url, 'http://fixture') })
    }
    await page.loadProject(project.id)
    assert.equal(reads, 1); assert.equal(urls.length, 2)
    assert.equal(page.project.project.reason.worker, 'planner')
    urls.length = 0
    const api = page.api
    page.api = async (method: string, url: string) => { if (url.startsWith('/v2/')) { urls.push(url); throw new Error('FGS unavailable') }; return api(method, url) }
    await page.loadProject(project.id)
    assert.equal(urls.length, 3); assert.equal(page.project.project.reason.worker, 'planner')
  } finally { store.close() }
})

test('audit task list reuses each indexed project query and preserves Token totals', () => {
  const { store, project } = fixture()
  try {
    for (let i = 0; i < 19; i++) store.createProject({ title: `Project ${i}`, origin: 'Synthetic', goal: 'Audit', bootstrap: false })
    store.audit({ id: 'audit-1', project_id: project.id, task_type: 'explore', input_tokens: 10, output_tokens: 2, cache_read_tokens: 3, cache_write_tokens: 4, status: 'running', started_at: '2026-10-13' }, [])
    let queries = 0
    const tracked = { projects: () => store.projects(), db: { prepare(sql: string) { if (sql.startsWith('SELECT data FROM audit_runs WHERE project_id=')) queries++; return store.db.prepare(sql) } } }
    const router = routes(); auditRoutes(router, tracked, '/unused')
    const results = router.handlers.get('GET /audit/tasks')!()
    assert.equal(results.length, 20); assert.equal(queries, 20)
    assert.equal(results.find((row: any) => row.id === project.id).token_total, 19)
    const plan = store.db.prepare('EXPLAIN QUERY PLAN SELECT data FROM audit_runs WHERE project_id=?').all(project.id)
    assert.ok(plan.some((row: any) => /SEARCH audit_runs USING INDEX/.test(row.detail)))
  } finally { store.close() }
})

test('Worker probe and commit use one normalizer and retain the same defaults/explicit fields', async () => {
  assert.equal(source('packages/redtrace-engine/src/config-api.ts').match(/model: b\.model \?\? 'mock'/g)?.length, 1)
  const raw: any = { workers: [] }, revision = '0'.repeat(64), snapshots: any[] = []
  const configuration = {
    read: () => ({ raw, revision }), snapshot: () => ({ raw, revision }),
    resolve(value: any) { snapshots.push(structuredClone(value.workers[0])); return { workers: value.workers.map((worker: any) => ({ ...worker, backend: 'mock' })), providers: {} } },
    commit(_expected: string, update: (value: any) => void) { update(raw); return this.snapshot() },
  }
  const router = routes(); configRoutes(router, configuration)
  const value = { expected_revision: revision, name: 'mock', provider: 'mock', priority: 0, max_running: 2, enabled: false, bootstrap: false }
  await router.handlers.get('POST /worker-config/workers')!({ req: body(value), signal: new AbortController().signal, res: { writeHead() {}, end() {} } })
  assert.deepEqual(raw.workers[0], snapshots[0])
  assert.equal(raw.workers[0].enabled, false); assert.equal(raw.workers[0].bootstrap, false)
  assert.equal(raw.workers[0].reason, true); assert.equal(raw.workers[0].explore, true)
})

test('unused bindings are removed without dropping Run validation or project/adapter guards', () => {
  assert.doesNotMatch(source('packages/redtrace-engine/src/operations.ts'), /const at = now\(\)\s+this\.store\.transaction/)
  assert.doesNotMatch(source('packages/redtrace-dsh/src/webshell.ts').split('\n').find(line => line.startsWith('import {'))!, /\btext\b/)
  assert.doesNotMatch(source('packages/redtrace-engine/test/knowledge-offline.test.ts'), /\bcopyFileSync\b/)
  assert.doesNotMatch(source('packages/redtrace-engine/test/reason-notify.test.ts'), /agent, step, target/)
  const { store, project } = fixture()
  try {
    assert.throws(() => store.runEvent('nonexistent-run', 'fixture', {}), /Run not found/)
    const results: any[] = []
    const allowed = Operations.prototype.beforeDispatch.call({ isAdapterAvailable: () => true, available: () => {}, store: { project: () => ({ ...project, status: 'stopped' }) }, authorized: () => false, finish(_id: string, result: any) { results.push(result) } },
      { id: 'inert', actor_type: 'worker', project_id: project.id, action: 'command', approved_by: null }, { kind: 'webshell', status: 'available', project_id: project.id })
    assert.equal(allowed, false); assert.equal(results[0].error_code, 'AUTH_FAILED')
    const unattended = Operations.prototype.beforeDispatch.call({ isAdapterAvailable: () => true, available: () => {}, store: { project: () => project }, authorized: () => false, finish() { throw new Error('Unattended task unexpectedly rejected') } }, { id: 'unattended', actor_type: 'worker', project_id: project.id, action: 'command', approved_by: null }, { kind: 'webshell', status: 'available', project_id: project.id })
    assert.equal(unattended, true)
  } finally { store.close() }
})
