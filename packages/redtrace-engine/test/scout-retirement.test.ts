import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { FIXED_ROLES, executionRole } from '../../redtrace-dsh/src/roles.ts'
import { toolAllowed } from '../src/console-api.ts'
import { Configuration } from '../src/config.ts'
import { serveEngine } from '../src/index.ts'
import { Scheduler } from '../src/scheduler.ts'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import type { EngineConfig, Step } from '../src/types.ts'

test('retired Scout is rejected in Worker configuration and cannot return via the tool page', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'redtrace-scout-settings-'))
  const file = path.join(root, '.redtrace/redtrace.yaml')
  mkdirSync(path.dirname(file))
  try {
    writeFileSync(file, 'role_version: 3\nworkers: [{name: retired, provider: mock, roles: [scout]}]\n')
    assert.throws(() => new Configuration(root).resolvedSnapshot(), /Invalid Legion roles/)
  } finally {
    writeFileSync(file, `role_version: 3
workers:
  - {name: shared, provider: mock, roles: [soldier, worker]}
tool_settings:
  read: {enabled: true, roles: [soldier]}
  fgs_publish:
    enabled: true
    actions:
      fact: {enabled: true, roles: []}
`)
  }
  const roles = ['general', 'soldier']
  const engine = await serveEngine({ root, autoStart: false, port: 0, runtimeCatalog: () => ({
    tools: roles.map(role => ({ name: 'read', role, description: 'Read a fixture', parameters: {}, source: 'DSH', scope: 'catalog', status: 'available' })),
    mcp: [],
  }) })
  try {
    assert.deepEqual(FIXED_ROLES, ['commander','general','soldier'])
    assert.throws(() => executionRole('benchmark', 'scout'), /Invalid benchmark role/)
    assert.deepEqual(engine.configuration.snapshot().workers.map(w => w.roles), [['soldier']])
    const settings = engine.configuration.read().raw.tool_settings
    assert.deepEqual(settings?.fgs_publish.actions?.fact.roles, [], 'an explicit empty allowlist remains deny-all')
    assert(toolAllowed(settings, 'read', 'soldier'))
    assert(!toolAllowed(settings, 'read', 'general'))
    assert(!toolAllowed(settings, 'read', 'scout'))
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\bscout\b/i)

    const base = 'http://127.0.0.1:' + (engine.server.address() as {port: number}).port
    const context = vm.createContext({ window: {}, capabilityRequest: async (method: string, route: string, body?: unknown) => {
      const response = await fetch(base + route, { method, ...(body ? { headers: {'content-type':'application/json'}, body: JSON.stringify(body) } : {}) })
      assert.equal(response.status, 200)
      return response.json()
    } })
    vm.runInContext(readFileSync(new URL('../../../static/console.js', import.meta.url), 'utf8'), context)
    const page = context.window.toolsPage()
    page.$refs = { toolDialog: { showModal() {} } }
    await page.load()
    page.open(page.data.tools[0])
    assert.deepEqual(Array.from(page.roles), FIXED_ROLES)
    assert.deepEqual(Array.from(page.detail.roles), roles)
    assert.deepEqual(Array.from(page.draft.roles), ['soldier'])
    await page.toggle(page.detail, {target:{checked:false}})
    assert.equal(page.detail.enabled, false)
    page.draft = {enabled:true, roles:['soldier'], actions:{}}
    await page.save()
    assert.equal(page.error, '')
    await page.load()
    assert.deepEqual(page.data.tools[0].roleBindings, ['soldier'])
    assert.doesNotMatch(readFileSync(file, 'utf8'), /\bscout\b/i)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})

test('stored Scout Steps remain readable, cannot run or get reassigned, and do not bypass Benchmark admission', async () => {
  const store = new Store(':memory:')
  const p = store.createProject({mode:'benchmark',title:'Retired role fixture',origin:'offline fixture',goal:'Verify retirement'}).project
  const graph = store.createGraph(p.id,{taskKey:'fixture',title:'Fixture',origin:'offline fixture',goal:'Verify retirement'})
  const legion = new LegionStore(store,p.id)
  const mission = {taskKey:'fixture',graphId:graph.id,description:'Fixture',sourceIds:[graph.originId]}
  const step = store.forGraph(p.id,graph.id).addStep(p.id,{...mission,role:'soldier'})
  store.saveNode({...step,role:'scout' as never})
  const scheduler = new Scheduler(store,{
    workers:[{name:'route',roles:['soldier'],enabled:true,backend:'mock',provider:'mock',model:'mock',priority:0,maxRunning:1}],
    maxProjectWorkers:1,maxRunningProjects:1,maxSteps:null,
  } as EngineConfig,async()=>{assert.fail('A retired Step must not start on the Soldier route')})
  try {
    assert.throws(()=>legion.spawn(p.id,{...mission,role:'scout' as never}),/Scout is retired/)
    assert.throws(()=>store.forGraph(p.id,graph.id).addStep(p.id,{
      ...mission,role:'scout' as never,specialist:{name:'Retired',responsibilities:'Fixture',scope:'Offline',capabilities:[]},
    }),/Invalid benchmark role/)
    assert.throws(()=>store.claim(p.id,'execute',{name:'route',backend:'mock'},step.id),/not claimable/)
    scheduler.start()
    await new Promise<void>(resolve=>setImmediate(resolve))
    assert.equal(store.runs(p.id).length,0)
    assert.equal(store.node<Step>(p.id,step.id,'step').role,'scout')
  } finally { await scheduler.close(); store.close() }
})
