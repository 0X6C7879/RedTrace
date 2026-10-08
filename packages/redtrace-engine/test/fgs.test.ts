import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import { projectFgs, liveSteps } from '../src/fgs.ts'
import type { EngineConfig } from '../src/types.ts'

const worker = { name: 'test', backend: 'mock' as const, provider: 'mock', model: '', enabled: true, reason: true, explore: true, bootstrap: true, maxRunning: 4, priority: 0 }
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
const create = (s: Store) => s.createProject({ title: 'FGS', origin: 'Scope', goal: 'Verified result' }).project.id

test('FGS keeps every output, typed relationship and cancelled-step provenance', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), goal = s.addGoal(id, 'Subgoal'), child = s.addGoal(id, 'Child', goal.id)
    const step = s.addStep(id, { description: 'Collect', sourceIds: ['origin'], goalId: child.id })
    const run = s.claim(id, 'execute', worker, step.id)
    const a = s.addFact(id, 'A', { runId: run.id }), b = s.addFact(id, 'B', { runId: run.id })
    const revision = s.project(id).planningRevision
    const finding = s.addFinding(id, { title: 'AB', description: 'Combined', factIds: [a.id, b.id], runId: run.id })
    assert.equal(s.project(id).planningRevision, revision, 'Finding must not trigger Decide')
    s.updateStep(id, step.id, { status: 'cancelled' }); s.finishRun(run.id, 'cancelled')
    const next = s.addStep(id, { description: 'Verify', sourceIds: [finding.id, a.id], goalId: goal.id })
    const nextRun = s.claim(id, 'execute', worker, next.id), c = s.addFact(id, 'Confirmed', { runId: nextRun.id })
    s.finishRun(nextRun.id, 'succeeded')
    s.updateGoal(id, child.id, { status: 'achieved', evidenceIds: [finding.id] })
    s.updateGoal(id, goal.id, { status: 'achieved', evidenceIds: [c.id] })
    const graph = s.graph(id), view = projectFgs(graph)
    assert.deepEqual(new Set(view.nodes.map(n => n.nodeType)), new Set(['scope', 'fact', 'finding', 'subgoal', 'goal']))
    assert.equal(view.nodes.length, 8)
    assert.equal(view.missingReferences.length, 0)
    const has = (source: string, target: string, relation: string) => view.edges.some(e => e.source === source && e.target === target && e.relation === relation)
    for (const output of [a.id, b.id]) { assert.ok(has('origin', output, 'derived')); assert.ok(has(output, child.id, 'pursues')); assert.ok(has(output, finding.id, 'supports')) }
    assert.ok(has(finding.id, c.id, 'derived')); assert.ok(has(finding.id, child.id, 'evidence')); assert.ok(has(child.id, goal.id, 'subgoal'))
    assert.equal(graph.findings[0].stepId, step.id)
    assert.ok(view.edges.filter(e => e.relation === 'derived').every(e => e.stepIds.length))
    const reachable = new Set(['origin'])
    for (const id of reachable) for (const e of view.edges) if (e.source === id) reachable.add(e.target)
    assert.equal(reachable.size, view.nodes.length)
    assert.equal(s.graphAt(id, s.project(id).revision).steps[0].status, 'cancelled')
    assert.deepEqual(projectFgs(s.graphAt(id, s.project(id).revision)), view)
  } finally { s.close() }
})

test('closing a goal cascades to descendants: no orphan open branches survive', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), fact = s.addFact(id, 'Evidence', { evidence: [{ description: 'proof' }] })
    const sg1 = s.addGoal(id, 'SG1'), sg1_1 = s.addGoal(id, 'SG1.1', sg1.id), sg1_1_1 = s.addGoal(id, 'SG1.1.1', sg1_1.id)
    const closedChild = s.addGoal(id, 'Closed child', sg1.id)
    s.updateGoal(id, closedChild.id, { status: 'achieved', evidenceIds: [fact.id] })
    const direct = s.addStep(id, { description: 'Under SG1', sourceIds: ['origin'], goalId: sg1.id })
    const deep = s.addStep(id, { description: 'Under SG1.1.1', sourceIds: ['origin'], goalId: sg1_1_1.id })
    const deepRun = s.claim(id, 'execute', worker, deep.id)
    s.updateGoal(id, sg1.id, { status: 'achieved', evidenceIds: [fact.id] })
    const graph = s.graph(id)
    assert.equal(graph.goals.find(g => g.id === sg1_1.id)!.status, 'cancelled')
    assert.equal(graph.goals.find(g => g.id === sg1_1_1.id)!.status, 'cancelled')
    assert.equal(graph.goals.find(g => g.id === closedChild.id)!.status, 'achieved', 'already-closed descendants stay untouched')
    assert.equal(graph.steps.find(st => st.id === direct.id)!.status, 'cancelled')
    assert.equal(graph.steps.find(st => st.id === deep.id)!.status, 'cancelled')
    assert.throws(() => s.claim(id, 'execute', worker, deep.id), /Step is not claimable/)
    s.finishRun(deepRun.id, 'cancelled')
    assert.throws(() => s.updateGoal(id, sg1_1.id, { status: 'open' }), /Parent goal is closed/)
    s.updateGoal(id, sg1.id, { status: 'open' })
    s.updateGoal(id, sg1_1.id, { status: 'open' })
    assert.equal(s.graph(id).goals.find(g => g.id === sg1_1.id)!.status, 'open')
  } finally { s.close() }
})

test('reference boundaries, atomic failure, and historical states never use future evidence', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), first = s.project(id).revision, other = create(s)
    const foreign = s.addFact(other, 'Foreign'), hint = s.addInput(id, 'hint', 'Unverified')
    assert.ok(projectFgs(s.graph(other)).edges.some(e => e.source === 'origin' && e.target === foreign.id && e.relation === 'scope' && e.stepIds.length === 0))
    for (const source of ['missing', hint.id, 'goal']) assert.throws(() => s.addStep(id, { description: 'Invalid', sourceIds: [source] }))
    assert.throws(() => s.updateGoal(id, 'goal', { status: 'achieved', evidenceIds: ['origin'] }))
    assert.throws(() => s.addFinding(id, { title: 'Invalid', description: 'Scope is not evidence', factIds: ['origin'] }))
    assert.throws(() => s.addStep(id, { description: 'Foreign', sourceIds: [foreign.id] }))
    const step = s.addStep(id, { description: 'Work', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    const f = s.addFact(id, 'Evidence', { runId: run.id }), factRevision = s.project(id).revision
    const finding = s.addFinding(id, { title: 'Deliverable', description: 'Result', factIds: [f.id], runId: run.id })
    s.finishRun(run.id, 'succeeded'); s.updateGoal(id, 'goal', { status: 'achieved', evidenceIds: [finding.id] })
    assert.throws(() => s.addFinding(other, { title: 'Bad', description: 'Bad', factIds: [foreign.id], runId: run.id }))
    const initial = s.graphAt(id, first), middle = s.graphAt(id, factRevision)
    assert.equal(initial.goals[0].description, 'Verified result'); assert.equal(initial.goals[0].status, 'open')
    assert.equal(initial.facts.length, 1); assert.equal(initial.steps.length, 0); assert.equal(initial.findings.length, 0)
    assert.equal(middle.findings.length, 0); assert.deepEqual(middle.goals[0].evidenceIds, []); assert.equal(middle.steps[0].status, 'running')
    assert.throws(() => s.graphAt(id, s.project(id).revision + 1))
  } finally { s.close() }
})

test('paired planning events wait at capacity and survive unrelated graph writes', async () => {
  const s = new Store(':memory:'), id = create(s)
  const reason = { ...worker, explore: false }
  const config: EngineConfig = { workers: [reason], providers: {}, maxWorkers: 4, maxProjectWorkers: 4, maxRunningProjects: 2, maxSteps: 1, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: '.' }
  const initial = s.claim(id, 'decide', worker); s.finishRun(initial.id, 'succeeded')
  const step = s.addStep(id, { description: 'At capacity', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
  const fact = s.addFact(id, 'Ready to evaluate', { runId: run.id }); s.finishRun(run.id, 'succeeded')
  const pending = s.addStep(id, { description: 'Keeps capacity full', sourceIds: ['origin'] })
  const revision = s.project(id).planningRevision
  s.addFinding(id, { title: 'F', description: 'F', factIds: [fact.id] })
  s.addInput(id, 'hint', 'hint'); s.addInput(id, 'observation', 'observation'); s.addGoal(id, 'Another result'); s.rename(id, 'Renamed')
  assert.equal(s.project(id).planningRevision, revision)
  assert.throws(() => s.addStep(id, { description: 'Overflow', sourceIds: ['origin'] }, config.maxSteps))
  let decisions = 0
  const scheduler = new Scheduler(s, config, async ({ run }) => { if (run.activity === 'decide') decisions++ })
  try {
    scheduler.start(); for (let i = 0; i < 20; i++) await turn(); assert.equal(decisions, 0)
    s.updateStep(id, pending.id, { status: 'cancelled' })
    for (let i = 0; i < 20 && !decisions; i++) await turn()
    assert.equal(decisions, 1)
  } finally { await scheduler.close(); s.close() }
})

test('legacy planning revision tracks its allowlist independently of paired wake eligibility', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s); assert.equal(s.project(id).planningRevision, 1)
    const step = s.addStep(id, { description: 'Work', sourceIds: ['origin'] }); let run = s.claim(id, 'execute', worker, step.id)
    assert.equal(s.project(id).planningRevision, 1)
    const fact = s.addFact(id, 'Fact', { runId: run.id }); assert.equal(s.project(id).planningRevision, 2)
    s.finishRun(run.id, 'failed'); assert.equal(s.project(id).planningRevision, 3)
    s.updateStep(id, step.id, { status: 'pending' }); run = s.claim(id, 'execute', worker, step.id)
    s.finishRun(run.id, 'succeeded'); assert.equal(s.project(id).planningRevision, 4)
    s.setStatus(id, 'stopped'); assert.equal(s.project(id).planningRevision, 4)
    s.setStatus(id, 'active'); assert.equal(s.project(id).planningRevision, 5)
    s.addFinding(id, { title: 'Finding', description: 'Finding', factIds: [fact.id] })
    const goal = s.addGoal(id, 'Goal'); s.updateGoal(id, goal.id, { status: 'achieved', evidenceIds: [fact.id] })
    assert.equal(s.project(id).planningRevision, 5)
  } finally { s.close() }
})

test('native canvas projection renders active Steps as virtual nodes, then swaps them for fact edges on completion', () => {
  const context = vm.createContext({ window: {} })
  vm.runInContext(readFileSync(new URL('../../../static/fgs-view.js', import.meta.url), 'utf8'), context)
  const s = new Store(':memory:')
  try {
    const id = create(s), goal = s.addGoal(id, 'Goal'), step = s.addStep(id, { description: 'Work', sourceIds: ['origin'], goalId: goal.id })
    const run = s.claim(id, 'execute', worker, step.id), fact = s.addFact(id, 'A', { runId: run.id })
    const hint = s.addInput(id, 'hint', 'Context')
    const canvas = (g: ReturnType<Store['graph']>) => { const view = projectFgs(g), live = liveSteps(g); return { g, view, app: { ...context.window.redtraceFgsView, fgs: { ...g, ...view, nodes: [...view.nodes, ...live.nodes], edges: [...view.edges, ...live.edges] }, factDisplayId: (id: string) => id } } }
    const running = canvas(s.graph(id))
    running.app.fgsFocusGoal = goal.id
    const nodes = running.app.fgsBuildElements().nodes, stepNode = nodes.find((n: any) => n.data.nodeType === 'step')
    assert.ok(stepNode, 'running Step renders as a canvas node')
    assert.equal(stepNode.data.status, 'running')
    assert.equal(nodes.length, 5)
    assert.equal(new Set(nodes.map((n: any) => n.data.id)).size, nodes.length)
    assert.ok(running.app.fgs.edges.some((e: any) => e.source === 'origin' && e.target === step.id && e.relation === 'executes' && e.stepIds.length === 1))
    assert.ok(running.app.fgs.edges.some((e: any) => e.source === step.id && e.target === goal.id && e.relation === 'pursues'))
    assert.ok(running.view.nodes.every(n => n.nodeType !== 'step'), 'pure projection stays free of virtual Step nodes for exports and tools')
    assert.ok(running.view.edges.every(e => e.relation !== 'executes'))
    s.finishRun(run.id, 'succeeded')
    const done = canvas(s.graph(id))
    assert.ok(done.app.fgsBuildElements().nodes.every((n: any) => n.data.nodeType !== 'step'), 'completed Step node disappears from the canvas')
    assert.ok(done.view.edges.some(e => e.source === 'origin' && e.target === fact.id && e.relation === 'derived' && e.stepIds.length === 1))
    const project = done.app.nativeProject(done.g)
    assert.equal(project.hints[0].created_at, hint.createdAt)
    assert.ok([project.project.created_at, ...project.intents.map((i: any) => i.created_at)].every(t => typeof t === 'string'))
  } finally { s.close() }
})
