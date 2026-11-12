import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Store } from '../src/store.ts'
import { LegionStore } from '../src/legion-store.ts'
import { legionTools } from '../src/legion-tools.ts'
import { legionMission } from '../src/legion-missions.ts'
import { Configuration } from '../src/config.ts'
const exec = promisify(execFile)
const worker = { name: 'fixture', backend: 'mock' as const, provider: 'mock', model: 'mock', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 4, priority: 0 }
function fixture(t: any) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'legion-tools-')), store = new Store(path.join(root, 'engine.db')), legion = new LegionStore(store)
  const project = store.createProject({ title: 'fixture', origin: 'local fixtures', goal: 'verified result' }).project
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }) })
  return { root, store, legion, project }
}

test('shipped DSH host executes four Legion roles, HELP reply, shared FGS acceptance and native Commander resume', { timeout: 90000 }, async () => {
  const result = await exec(process.execPath, [new URL('./legion-runtime.fixture.mjs', import.meta.url).pathname], { maxBuffer: 2 * 1024 * 1024 })
  assert.match(result.stdout, /commander_acceptance=true/); assert.match(result.stdout, /help_reply_admitted=true/); assert.match(result.stdout, /commander_native_resume=true/)
})

test('role tools retain General delegation boundaries and cannot turn messages into Facts', async t => {
  const { store, legion, project } = fixture(t)
  const general = legion.spawn(project.id, { role: 'general', taskKey: 'a', description: 'main line', sourceIds: ['origin'] })
  const run = store.claim(project.id, 'execute', worker, general.id), tools = legionTools(store, run.id, project.id, null, () => {})
  const spawn = tools.find(tool => tool.name === 'legion_spawn')!
  const mission = { role: 'soldier', taskKey: 'a', description: 'specialist', sourceIds: ['origin'] }
  await spawn.execute('a', mission); await spawn.execute('b', mission)
  await assert.rejects(spawn.execute('third', mission), /two active squads/)
  await assert.rejects(spawn.execute('foreign-task', { ...mission, taskKey: 'b' }), /same-task/)
  const count = store.nodeCount(project.id, 'fact')
  await tools.find(tool => tool.name === 'legion_message')!.execute('help', { receiver: 'commander', type: 'HELP', content: 'blocked: need tactical decision' })
  assert.equal(store.nodeCount(project.id, 'fact'), count)
  assert.equal(legion.messages(project.id, 'commander')[0].status, 'pending')
})

test('event wait wakes for durable messages and abort removes its listeners', async t => {
  const { store, legion, project } = fixture(t)
  const after = Number(store.db.prepare('SELECT MAX(id) AS n FROM events').get()!.n)
  const ready = legion.wait(project.id, 'commander', after)
  const message = legion.message(project.id, 'commander', 'commander', 'MESSAGE', 'local fixture signal')
  assert.deepEqual((await ready).messages, [message.id])
  legion.delivery(project.id, 'commander', message.id, 'queued')
  assert.deepEqual((await legion.wait(project.id, 'commander', after)).messages, [message.id])
  legion.delivery(project.id, 'commander', message.id, 'admitted')
  const abort = new AbortController(), pending = legion.wait(project.id, 'commander', after, abort.signal)
  abort.abort(new Error('fixture cancellation'))
  await assert.rejects(pending, /fixture cancellation/)
  assert.equal(store.changes.listenerCount('legion-message'), 0)
  legion.delivery(project.id, 'commander', message.id, 'admitted')
  assert.equal(legion.delivery(project.id, 'commander', message.id, 'queued').status, 'admitted')
  assert.throws(() => legion.delivery(project.id, 'foreign', message.id, 'admitted'), /receiver/)
})

test('native mailbox steers idle, injects running, and records admission separately from queueing', async t => {
  const { store, legion, project } = fixture(t)
  const modulePath = new URL('../compat/legion.mjs', import.meta.url).href
  const { attachLegionMailbox } = await import(modulePath)
  let onEvent: any, injected = 0, steered = 0, native: any
  const ctx = { on(_name: string, listener: any) { onEvent = listener; return () => { onEvent = undefined } } }
  const agent = { status: 'idle', steer(message: any) { steered++; native = message }, inject(message: any) { injected++; native = message } }
  const detach = attachLegionMailbox(ctx, legion, { actor: 'commander', sessionId: 'command-fixture', agent, message: (content: string, source: any) => ({ content, source }) })
  const first = legion.message(project.id, 'commander', 'commander', 'MESSAGE', 'idle wake')
  assert.equal(steered, 1); assert.equal(legion.messages(project.id, 'commander')[0].status, 'queued')
  onEvent({ id: 'command-fixture' }, { type: 'user/message', data: native })
  assert.equal(legion.messages(project.id, 'commander')[0].status, 'admitted')
  agent.status = 'running'; legion.message(project.id, 'commander', 'commander', 'MESSAGE', 'running supplemental input')
  assert.equal(injected, 1); detach(); assert.equal(store.changes.listenerCount('legion-message'), 0)
})

test('Commander completion holds the existing campaign claim until native flush/disposal', async t => {
  const { store, legion } = fixture(t)
  legion.claimCommand()
  await legionTools(store, 'commander', undefined, null, () => {}).find(tool => tool.name === 'legion_finish')!.execute('finish', { processed: {}, state: 'saved STATE' })
  assert.equal(legion.campaign().status, 'running'); assert.throws(() => legion.claimCommand(), /not idle/)
})

test('role/model routes survive configuration snapshots and reject unknown roles', t => {
  const { root } = fixture(t), config = new Configuration(root); config.initialize()
  config.commit(config.read().revision, raw => { raw.workers = [{ ...worker, roles: ['scout','soldier'] }] })
  assert.deepEqual(config.resolvedSnapshot().config.workers[0].roles, ['scout','soldier'])
  assert.deepEqual(config.snapshot().workers[0].roles, ['scout','soldier'])
  assert.throws(() => config.commit(config.read().revision, raw => { raw.workers[0].roles = ['reason' as any] }), /Invalid Legion roles/)
  for (const role of ['commander','general','soldier','scout'] as const) assert.ok(legionMission(role).includes(role.toUpperCase()))
})


test('a message queued while legion_wait is active wakes the tool even when mailbox runs first', async t => {
  const { store, legion, project } = fixture(t)
  store.changes.on('legion-message', (id, receiver) => {
    for (const m of legion.messages(id, receiver).filter(m => m.status === 'pending')) legion.delivery(id, receiver, m.id, 'queued')
  })
  const after = Number(store.db.prepare('SELECT MAX(id) AS n FROM events').get()!.n)
  const waiting = legion.wait(project.id, 'commander', after)
  const message = legion.message(project.id, 'commander', 'commander', 'MESSAGE', 'queued before waiter callback')
  assert.deepEqual((await waiting).messages, [message.id])
})

test('uncertain native enqueue is retained and never automatically delivered twice', async t => {
  const { store, legion, project } = fixture(t)
  const modulePath = new URL('../compat/legion.mjs', import.meta.url).href
  const { attachLegionMailbox } = await import(modulePath)
  let attempts = 0
  const ctx = { on() { return () => {} } }, agent = { status: 'idle', steer() { attempts++; throw new Error('uncertain native queue result') } }
  const detach = attachLegionMailbox(ctx, legion, { actor: 'commander', sessionId: 'cmd', agent, message: () => ({}) })
  assert.throws(() => legion.message(project.id, 'commander', 'commander', 'MESSAGE', 'fixture'), /uncertain/)
  assert.equal(legion.messages(project.id, 'commander')[0].status, 'uncertain')
  store.changes.emit('legion-message', project.id, 'commander')
  assert.equal(attempts, 1); detach()
})


test('the first Commander board exposes existing Scope and Goal IDs even when creation delta has no node body', async t => {
  const { store, legion, project } = fixture(t); legion.claimCommand()
  const tool = legionTools(store, 'commander', undefined, null, () => {}).find(t => t.name === 'legion_board')!
  const board = (await tool.execute('board', {})).details as any
  assert.equal(board.projects[0].scopeId, 'origin'); assert.equal(board.projects[0].goals[0].id, 'goal')
  assert.equal(board.projects[0].goals[0].status, 'open'); assert.ok(board.projects[0].goals[0].description)
})


test('General squads inherit isolated execution and cannot weaken their parent profile', t => {
  const { store, legion, project } = fixture(t)
  const step = legion.spawn(project.id, { role: 'general', taskKey: 'isolated', description: 'isolated parent', sourceIds: ['origin'], executionProfile: 'isolated' })
  const run = store.claim(project.id, 'execute', worker, step.id)
  const mission = { role: 'soldier' as const, taskKey: 'isolated', description: 'bounded squad', sourceIds: ['origin'], parentRunId: run.id }
  assert.equal(legion.spawn(project.id, mission).executionProfile, 'isolated')
  assert.throws(() => legion.spawn(project.id, { ...mission, executionProfile: 'direct' }), /weaken execution isolation/)
})
