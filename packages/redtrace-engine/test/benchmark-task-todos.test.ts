import {spawnTask} from './task-fixture.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { taskTodoOwner } from '../src/legion-todos.ts'
import { legionTools } from '../src/legion-tools.ts'
import { launchContext } from '../src/runner.ts'
import { Scheduler } from '../src/scheduler.ts'
import type { Step, EngineConfig, TaskAssignment } from '../src/types.ts'

const worker = { name: 'fixture', backend: 'mock' as const }
const progress = [{ content: 'verified entry', status: 'in_progress' as const }, { content: 'verify result', status: 'pending' as const }]
const specialist = { name: 'Audit', responsibilities: 'Inspect code', capabilities: ['audit'], scope: 'assigned task' }

test('resolving a confirmed-stopped Unknown retires its blocked Step and transfers planning to the live successor',()=>{
 const store=new Store(':memory:');try{
  const p=store.createProject({mode:'benchmark',title:'Unknown owner',origin:'fixture',goal:'verify'}).project,g=store.createGraph(p.id,{taskKey:'T',title:'T',origin:'fixture',goal:'verify'}),scoped=store.forGraph(p.id,g.id)
  const first=scoped.addStep(p.id,{role:'soldier',taskKey:'T',description:'old owner',sourceIds:[g.originId]}),old=store.claim(p.id,'execute',worker,first.id)
  store.finishRun(old.id,'unknown','native flush failure')
  const next=scoped.addStep(p.id,{role:'soldier',taskKey:'T',description:'successor',sourceIds:[g.originId]})
  assert(taskTodoOwner(first,store),'an unconfirmed Unknown must retain ownership')
  store.resolveUnknown(old.id,'native session exclusively opened, every tool and job settled; cancellation confirmed')
  assert.equal(store.node<Step>(p.id,first.id,'step').status,'cancelled')
  assert(taskTodoOwner(next,store));assert.equal(store.run(old.id).status,'cancelled')
 }finally{store.close()}
})
function fixture(t: any, filename = ':memory:') {
  const store = new Store(filename), legion = new LegionStore(store)
  const p = store.createProject({ mode: 'benchmark', title: 'fixture', origin: 'local', goal: 'verify' }).project
  const graph = store.createGraph(p.id, { taskKey: 'A', title: 'A', origin: 'local', goal: 'verify A' })
  t.after(() => store.close())
  const add = (role: 'general' | 'soldier' | 'scout', extra: Pick<Step, 'specialist'> = {}) => spawnTask(legion,p.id, { graphId: graph.id, taskKey: 'A', role:role as never, description: role + ' ' + store.nodes(p.id, ['step']).length, sourceIds: [graph.originId], ...extra })
  const tools = (step: TaskAssignment) => { const run = step.role==='general'?store.forGraph(p.id,graph.id).claim(p.id,'plan',worker):store.claim(p.id, 'execute', worker, step.id); return { run, tools: legionTools(store, run.id, p.id, null, () => {}) } }
  const todos = () => legion.planningTodos(p.id).list(graph.id)
  const owners = () => [...store.projectGraphs(p.id).flatMap(g=>g.planner?[g.planner]:[]),...store.nodes<Step>(p.id, ['step'])].filter(s => taskTodoOwner(s, store))
  const row = () => store.db.prepare('SELECT data FROM commander_todos WHERE project_id=? AND graph_id=?').get(p.id, graph.id)
  return { store, legion, p, graph, add, tools, todos, owners, row }
}

for (const roles of [['general', 'soldier'], ['soldier', 'soldier'], ['soldier', 'soldier', 'general'], ['general', 'specialist']] as const) {
  test('task lifecycle creates exactly one TodoList and owner before execution: ' + roles.join('+'), async t => {
    const f = fixture(t), steps = roles.map(role => role === 'specialist' ? f.add('soldier', { specialist }) : f.add(role))
    assert(f.row(), 'TodoList must exist before any Agent is claimed')
    assert(f.todos().length > 0, 'initial task plan must not depend on model TodoWrite')
    const owner = f.owners(); assert.equal(owner.length, 1)
    assert.equal(owner[0].role, steps.some(s => s.role === 'general') ? 'general' : 'soldier')
    for (const step of steps) {
      const { run, tools } = f.tools(step), planner = step.id === owner[0].id
      assert.equal(tools.some(t => t.name === 'TodoWrite'), planner)
      if (planner) { assert.deepEqual(launchContext(f.store, run.id).planningTodos, f.todos()); await tools.find(t => t.name === 'TodoWrite')!.execute('progress', { todos: progress }) }
      else { assert(!('planningTodos' in launchContext(f.store, run.id))); assert(!tools.some(t => t.name === 'legion_accept')) }
    }
    assert.deepEqual(f.todos(), progress)
  })
}

test('Scout is rejected without a TodoList; direct Soldier creation initializes planning', t => {
  const f = fixture(t); assert.throws(()=>f.add('scout'),/Scout is retired/); assert.equal(f.row(), undefined); assert.deepEqual(f.owners(), [])
  const step = f.store.forGraph(f.p.id, f.graph.id).addStep(f.p.id, { taskKey: 'A', role: 'soldier', description: 'direct API', sourceIds: [f.graph.originId] })
  assert(f.row()); assert.deepEqual(f.owners().map(s => s.id), [step.id])
})

test('General joins and inherits progress; stale Soldier writes fail, even while General is parked or recovering', async t => {
  const f = fixture(t), soldier = f.add('soldier'), first = f.tools(soldier)
  const write = first.tools.find(t => t.name === 'TodoWrite')!; await write.execute('initial', { todos: progress })
  const general = f.add('general'); assert.deepEqual(f.todos(), progress); assert.deepEqual(f.owners().map(s => s.id), [general.id])
  await assert.rejects(write.execute('stale', { todos: [] }), /ownership transferred/)
  for (const status of ['blocked', 'parked', 'paused'] as const) {
    general.status = status; f.store.savePlanner(general as import('../src/types.ts').GraphPlanner)
    assert.deepEqual(f.owners().map(s => s.id), [general.id]); await assert.rejects(write.execute('stale', { todos: [] }), /ownership transferred/)
  }
  assert.deepEqual(f.todos(), progress)
})

test('parallel questions, database reopen, native handoff and replacement preserve task plans and one maintainer', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-todos-')); t.after(() => rmSync(root, { recursive: true, force: true }))
  const f = fixture(t, root + '/engine.db'), soldier = f.add('soldier'), first = f.tools(soldier)
  await first.tools.find(t => t.name === 'TodoWrite')!.execute('progress', { todos: progress })
  const b = f.store.createGraph(f.p.id, { taskKey: 'B', title: 'B', origin: 'local', goal: 'verify B' })
  spawnTask(f.legion,f.p.id, { graphId: b.id, taskKey: 'B', role: 'soldier', description: 'B task', sourceIds: [b.originId] })
  assert.notDeepEqual(f.legion.planningTodos(f.p.id).list(b.id), progress)
  f.legion.requestHandoff(first.run.id, 'verified entry; continue result'); f.store.finishRun(first.run.id, 'cancelled'); f.legion.completeHandoff(f.p.id, soldier.id)
  const next = f.tools(f.store.node<Step>(f.p.id, soldier.id, 'step'))
  assert.equal(next.run.predecessorRunId, first.run.id); assert.deepEqual(launchContext(f.store, next.run.id).planningTodos, progress)
  const reopened = new Store(root + '/engine.db')
  try {
    reopened.recover(); const resumed = new LegionStore(reopened)
    assert.deepEqual(resumed.planningTodos(f.p.id).list(f.graph.id), progress)
    assert(taskTodoOwner(reopened.node<Step>(f.p.id, soldier.id, 'step'), reopened), 'unknown-result recovery must retain owner')
  } finally { reopened.close() }
  const replacement = f.store.updateStep(f.p.id, soldier.id, { description: 'replacement strategy', mode: 'replace', expectedVersion: f.store.node<Step>(f.p.id, soldier.id, 'step').version })
  assert.throws(() => f.store.claim(f.p.id, 'execute', worker, replacement.id), /not claimable/)
  f.store.resolveUnknown(next.run.id, 'fixture confirmed the old execution stopped without outstanding tools')
  const replaced = f.tools(f.store.node<Step>(f.p.id, replacement.id, 'step'))
  assert(replaced.tools.some(t => t.name === 'TodoWrite')); assert.deepEqual(launchContext(f.store, replaced.run.id).planningTodos, progress)
  assert(taskTodoOwner(replacement, f.store)); assert.deepEqual(f.todos(), progress)
})

test('Scheduler repairs legacy missing lists before executing concurrent questions and never reinitializes an existing empty list', async t => {
  const f = fixture(t), a = f.add('soldier')
  const b = f.store.createGraph(f.p.id, { taskKey: 'B', title: 'B', origin: 'local', goal: 'verify B' })
  spawnTask(f.legion,f.p.id, { graphId: b.id, taskKey: 'B', role: 'soldier', description: 'B', sourceIds: [b.originId] })
  f.legion.planningTodos(f.p.id).replace(b.id, [])
  f.store.db.prepare('DELETE FROM commander_todos WHERE project_id=? AND graph_id=?').run(f.p.id, f.graph.id)
  const launched: string[] = [], scheduler = new Scheduler(f.store, { workers: [{ ...worker, enabled: true, roles: ['soldier'], maxRunning: 2, priority: 0 }], maxWorkers: 2, maxProjectWorkers: 2, maxRunningProjects: 1, maxSteps: null, workspaceRoot: '/tmp/task-todos' } as EngineConfig, async ({ run, signal }) => {
    assert(f.store.db.prepare('SELECT 1 FROM commander_todos WHERE project_id=? AND graph_id=?').get(run.projectId, run.graphId!))
    launched.push(run.graphId!); await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  try {
    scheduler.start(); for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve))
    assert.equal(launched.length, 2); assert(f.todos().length); assert(taskTodoOwner(a, f.store)); assert.deepEqual(f.legion.planningTodos(f.p.id).list(b.id), [])
  } finally { await scheduler.close() }
})

test('specialist-only task receives a Soldier planner; specialist never owns maintenance', t => {
  const f = fixture(t), expert = f.add('soldier', { specialist })
  assert(f.row()); assert.equal(f.owners().length, 1); assert.notEqual(f.owners()[0].id, expert.id); assert(!('specialist' in f.owners()[0]))
})

test('Commander change event with finite question capacity does not throw LegionStore ReferenceError', async t => {
  const f = fixture(t), { createCommanderController } = await import(new URL('../compat/legion.mjs', import.meta.url).href)
  const engine = { store: f.store, legion: f.legion, configuration: { resolvedSnapshot: () => ({ config: { maxBenchmarkTasks: 2, workers: [] } }) }, scheduler: { maintenance: false, wake() {} } }
  const controller = createCommanderController({ logger: { warn() {} }, get() { throw Error('No native session required') } }, engine, () => false)
  try { controller.start(); assert.doesNotThrow(() => f.store.changes.emit('change', f.p.id)) }
  finally { await controller.close() }
})


test('running Agent registrations gain and lose planning tools as maintenance transfers; reports never mark Todos done', async t => {
  const f = fixture(t), first = f.add('soldier'), second = f.add('soldier')
  const a = f.tools(first), b = f.tools(second)
  const { refreshTaskPlanningTools, mountActivityPrompt } = await import(new URL('../compat/cordis.mjs', import.meta.url).href)
  const active = new Map<string, any>(), register = (tool: any) => { active.set(tool.name, tool); return () => active.delete(tool.name) }
  const refresh = refreshTaskPlanningTools(f.store, second, () => legionTools(f.store, b.run.id, f.p.id, null, () => {}), register)
  let prompt!: () => string
  mountActivityPrompt({ systemPrompt: { section(section: any) { prompt = section.text } } }, f.store, b.run, second)
  refresh(); assert(!active.has('TodoWrite')); assert.match(prompt(), /仅指定 Planner 维护 Todo/)
  await a.tools.find(t => t.name === 'TodoWrite')!.execute('progress', { todos: progress })
  f.store.addFact(f.p.id, 'confirmed assigned result', { runId: a.run.id }); f.store.finishRun(a.run.id, 'succeeded')
  refresh(); assert(active.has('TodoWrite')); assert.match(prompt(), /仅任务 Planner/)
  assert.deepEqual(f.todos(), progress, 'Step completion and reports never auto-complete Todo items')
  const general = f.add('general'); refresh(); assert(!active.has('TodoWrite')); assert.match(prompt(), /仅指定 Planner 维护 Todo/)
  assert.equal(launchContext(f.store, b.run.id).taskPlanner?.stepId, general.id)
  f.store.savePlanner({...f.store.projectGraph(f.p.id,f.graph.id).planner!,status:'cancelled'}); refresh(); assert(!active.has('TodoWrite')); assert.deepEqual(f.todos(), progress)
})


test('General delegated Soldier Executors execute and report but never maintain the task list', t => {
  const f = fixture(t), general = f.add('general'), parent = f.tools(general)
  for (const role of ['soldier', 'soldier'] as const) {
    const child = spawnTask(f.legion,f.p.id, { graphId: f.graph.id, taskKey: 'A', role:role as never, description: 'delegated ' + role, sourceIds: [f.graph.originId], parentRunId: parent.run.id })
    assert(!f.tools(child).tools.some(t => t.name === 'TodoWrite'))
  }
  assert.deepEqual(f.owners().map(s => s.id), [general.id])
})


test('retiring General never silently returns task planning authority to a Specialist or Soldier', async t => {
  const f = fixture(t), general = f.add('general'), parent = f.tools(general)
  await parent.tools.find(t => t.name === 'TodoWrite')!.execute('progress', { todos: progress })
  const expert = f.add('soldier', { specialist }); const executor=f.tools(expert)
  f.store.savePlanner({...f.store.projectGraph(f.p.id,f.graph.id).planner!,status:'cancelled'})
  assert(!executor.tools.some(t => t.name === 'TodoWrite'));assert.deepEqual(f.todos(),progress)
  assert.equal(f.store.nodes<Step>(f.p.id, ['step']).filter(s => s.role==='soldier'&&!s.specialist).length,0)
  f.store.finishRun(parent.run.id,'cancelled');const replacement=f.add('general');assert.equal(replacement.id,general.id);assert.deepEqual(f.owners().map(s=>s.id),[replacement.id]);assert.deepEqual(f.todos(),progress)
})


test('completed planning round retains the same General owner and never transfers the plan to a Worker', async t => {
  const f = fixture(t), general = f.add('general'), soldier = f.add('soldier'), leader = f.tools(general), executor = f.tools(soldier)
  await leader.tools.find(t => t.name === 'TodoWrite')!.execute('progress', { todos: progress })
  f.store.finishRun(leader.run.id, 'succeeded')
  assert.deepEqual(f.owners().map(s => s.id), [general.id]); assert(!('planningTodos' in launchContext(f.store, executor.run.id)))
  assert(!legionTools(f.store, executor.run.id, f.p.id, null, () => {}).some(t => t.name === 'TodoWrite')); assert.deepEqual(f.todos(), progress)
})
