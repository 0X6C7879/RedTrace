import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Scheduler } from '../src/scheduler.ts'
import type { EngineConfig } from '../src/types.ts'

const worker = { name: 'mock', backend: 'mock' as const, provider: 'mock', model: '', enabled: true, reason: true, explore: true, bootstrap: true, maxRunning: 8, priority: 0 }
const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 8, maxProjectWorkers: 8, maxRunningProjects: 2, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: os.tmpdir() }
const create = (s: Store) => s.createProject({ title: 'Task', origin: 'Known input', goal: 'Write verified output' }).project.id
const turn = () => new Promise<void>(resolve => setImmediate(resolve))
async function until(predicate: () => boolean) { for (let i = 0; i < 200; i++) { if (predicate()) return; await turn() } assert.fail('Condition did not settle') }

test('single graph, atomic rollback, references and unique claims', async () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), before = s.graph(id)
    assert.throws(() => s.transaction(() => { s.addGoal(id, 'Sub goal'); s.addStep(id, { description: 'bad', sourceIds: ['missing'] }) }))
    assert.deepEqual(s.graph(id), before)
    const step = s.addStep(id, { description: 'Do work', sourceIds: ['origin'] })
    const claims = await Promise.allSettled(Array.from({ length: 8 }, () => Promise.resolve().then(() => s.claim(id, 'execute', worker, step.id))))
    assert.equal(claims.filter(r => r.status === 'fulfilled').length, 1)
    const run = s.runs(id)[0]
    const fact = s.addFact(id, 'Output checked', { runId: run.id, evidence: [{ description: 'read returned expected bytes' }] })
    s.addFinding(id, { title: 'Result', description: 'Verified', factIds: [fact.id] })
    s.finishRun(run.id, 'succeeded')
    assert.equal(s.graph(id).steps[0].status, 'done')
    assert.throws(() => s.addFact(id, 'late stale write', { runId: run.id }))
    assert.throws(() => s.deleteStep(id, step.id))
    assert.equal(s.graph(id).facts.filter(f => f.id === 'goal').length, 0)
  } finally { s.close() }
})

test('Fact plus Step completion wakes one serial decision while slower execution continues', async () => {
  const s = new Store(':memory:'), id = create(s)
  let decideActive = 0, peak = 0, decisions = 0, release!: () => void
  const slow = new Promise<void>(resolve => { release = resolve })
  const scheduler = new Scheduler(s, config, async ({ run }) => {
    if (run.activity === 'decide') {
      peak = Math.max(peak, ++decideActive); decisions++
      if (!s.graph(id).steps.length) {
        s.addStep(id, { description: 'fast', sourceIds: ['origin'] })
        s.addStep(id, { description: 'slow', sourceIds: ['origin'] })
      }
      await turn(); decideActive--
    } else if (s.node(id, run.stepId!).id === 'i001') s.addFact(id, 'new evidence', { runId: run.id })
    else await slow
  })
  try {
    scheduler.start()
    await until(() => decisions >= 2)
    assert.equal(peak, 1)
    assert.ok(scheduler.activeRuns.some(r => r.stepId === 'i002'))
    const count = decisions
    for (let i = 0; i < 8; i++) await turn()
    assert.equal(decisions, count, 'Decide must not trigger itself')
  } finally { release(); await scheduler.close(); s.close() }
})

test('hints and findings stay out of planning revisions and do not start another Decide', async () => {
  const s = new Store(':memory:'), id = create(s)
  const fact = s.addFact(id, 'Verified evidence')
  let decisions = 0
  const scheduler = new Scheduler(s, config, async ({ run }) => { if (run.activity === 'decide') decisions++ })
  try {
    scheduler.start(); await until(() => decisions === 1)
    const planning = s.project(id).planningRevision, hint = s.addInput(id, 'hint', 'Human context')
    s.deleteInput(id, hint.id)
    const finding = s.addFinding(id, { title: 'Deliverable', description: 'Verified output', factIds: [fact.id] })
    assert.equal(finding.factIds[0], fact.id)
    assert.equal(s.graph(id).findings.length, 1)
    assert.equal(s.project(id).planningRevision, planning)
    for (let i = 0; i < 8; i++) await turn()
    assert.equal(decisions, 1)
  } finally { await scheduler.close(); s.close() }
})

test('finding and fact deletion are graph changes without a planning trigger', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), fact = s.addFact(id, 'Temporary evidence'), retained = s.addFact(id, 'Retained evidence')
    const planning = s.project(id).planningRevision
    s.releaseFact(id, fact.id)
    s.addFinding(id, { title: 'Deliverable', description: 'Verified output', factIds: [retained.id] })
    assert.equal(s.project(id).planningRevision, planning)
  } finally { s.close() }
})

test('cancelled Execute does not trigger planning', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), step = s.addStep(id, { description: 'Cancelled work', sourceIds: ['origin'] })
    const run = s.claim(id, 'execute', worker, step.id), planning = s.project(id).planningRevision
    s.finishRun(run.id, 'cancelled')
    assert.equal(s.project(id).planningRevision, planning)
  } finally { s.close() }
})

test('unavailable planner does not block execution; pause resumes the same run', async () => {
  const s = new Store(':memory:'), id = create(s)
  s.addStep(id, { description: 'work', sourceIds: ['origin'] })
  const ids: string[] = []
  const scheduler = new Scheduler(s, { ...config, workers: [{ ...worker, reason: false }] }, async ({ run, signal }) => {
    ids.push(run.id)
    if (ids.length === 1) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
  })
  try {
    scheduler.start(); await until(() => ids.length === 1)
    s.setStatus(id, 'stopped'); await until(() => s.runs(id)[0].status === 'paused')
    s.setStatus(id, 'active'); await until(() => s.runs(id)[0].status === 'succeeded')
    assert.equal(ids.length, 2); assert.equal(ids[0], ids[1])
  } finally { await scheduler.close(); s.close() }
})

test('restart retains evidence and blocks unconfirmed external side effects', () => {
  const filename = path.join(mkdtempSync(path.join(os.tmpdir(), 'redtrace-recovery-')), 'engine.db')
  let s = new Store(filename)
  const id = create(s), step = s.addStep(id, { description: 'External operation', sourceIds: ['origin'] })
  const run = s.claim(id, 'execute', worker, step.id)
  s.addFact(id, 'already committed', { runId: run.id })
  s.toolStarted(run.id, 'external-1', { command: 'external operation' })
  s.close(); s = new Store(filename)
  try {
    s.recover()
    assert.equal(s.graph(id).facts.length, 2)
    assert.equal(s.node(id, step.id).kind, 'step')
    assert.equal(s.graph(id).steps[0].status, 'blocked')
    assert.equal(s.run(run.id).status, 'unknown')
    assert.throws(() => s.claim(id, 'execute', worker, step.id))
  } finally { s.close() }
})

test('native audit keeps the conversation and drops lifecycle noise', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), run = s.claim(id, 'decide', worker)
    s.runEvent(run.id, 'system.prompt', { content: 'Decide prompt' })
    s.runEvent(run.id, 'message_start', { type: 'message_start' })
    s.runEvent(run.id, 'message_end', { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Do the task' }] } })
    s.runEvent(run.id, 'message_end', { type: 'message_end', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'Plan first' }, { type: 'text', text: 'Done' }] } })
    s.toolStarted(run.id, 'call-1', { id: 'call-1', name: 'read_skill', arguments: { name: 'api-security' } })
    s.toolEnded(run.id, 'call-1', { ok: true })
    s.runEvent(run.id, 'tool_execution_end', { toolCallId: 'call-1', toolName: 'read_skill', result: { ok: true } })
    const events = s.db.prepare('SELECT data FROM audit_events ORDER BY id').all().map(row => JSON.parse(String(row.data)))
    assert.deepEqual(events.map(event => event.kind), ['system.prompt', 'user.message', 'thinking.message', 'assistant.message', 'tool.started', 'tool.completed'])
    assert.equal(events[2].content, 'Plan first')
    assert.equal(events[4].arguments.name, 'api-security')
  } finally { s.close() }
})

test('tool tracking can skip the audit mirror for externally projected sessions', () => {
  const s = new Store(':memory:')
  try {
    const id = create(s), step = s.addStep(id, { description: 'Run an external command', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    s.toolStarted(run.id, 'call-1', { turn: 1, step: 1, callId: 'call-1', name: 'bash', arguments: '{}' }, false)
    assert.deepEqual(s.db.prepare('SELECT data FROM audit_events ORDER BY id').all().map(row => JSON.parse(String(row.data))), [])
    assert.deepEqual(s.run(run.id).pendingTools, ['call-1'])
  } finally { s.close() }
})
