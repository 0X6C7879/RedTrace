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

test('shipped DSH host executes Planner/Worker identities, HELP reply, shared FGS acceptance and native Planner resume', { timeout: 90000 }, async () => {
  const result = await exec(process.execPath, [new URL('./legion-runtime.fixture.mjs', import.meta.url).pathname], { maxBuffer: 2 * 1024 * 1024 })
  assert.match(result.stdout, /MCP_CONFIG_WATCH=true/);assert.match(result.stdout, /commander_acceptance=true/); assert.match(result.stdout, /help_reply_admitted=true/); assert.match(result.stdout, /commander_native_resume=true/)
})

test('General Worker has no delegation or plan tools and messages never become Facts', async t => {
  const {store,legion,project}=fixture(t),step=legion.spawn(project.id,{role:'worker',taskKey:'a',description:'work',sourceIds:['origin']}),run=store.claim(project.id,'execute',worker,step.id)
  const tools=legionTools(store,run.id,project.id,null,()=>{})
  assert(!tools.some(t=>['legion_spawn','legion_step','TodoWrite','legion_todos','legion_accept'].includes(t.name)))
  const count=store.nodeCount(project.id,'fact')
  await tools.find(t=>t.name==='legion_message')!.execute('help',{receiver:'commander',type:'HELP',content:'verified blocker; Planner decision needed'})
  assert.equal(store.nodeCount(project.id,'fact'),count);assert.equal(legion.messages(project.id,'commander')[0].status,'pending')
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
  await legionTools(store,'commander',store.projects()[0].id, null, () => {}).find(tool => tool.name === 'legion_finish')!.execute('finish', { processed: {}, state: 'saved STATE' })
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


test('the first Commander board is compact and leaves FGS details on demand', async t => {
  const { store, legion, project } = fixture(t); legion.claimCommand()
  const tool = legionTools(store,'commander',store.projects()[0].id, null, () => {}).find(t => t.name === 'legion_board')!
  const board = (await tool.execute('board', {})).details as any
  assert.equal(board.projectId, project.id); assert.ok(board.lines.length<=100)
  assert.ok(!('projects' in board)); assert.ok(!JSON.stringify(board).includes('evidenceIds'))
})


test('Benchmark General squads inherit isolated execution and cannot weaken their parent profile', t => {
  const {store}=fixture(t),project=store.createProject({mode:'benchmark',title:'isolation',origin:'local',goal:'verify'}).project,legion=new LegionStore(store,project.id)
  store.createGraph(project.id,{taskKey:'isolated',title:'isolated',origin:'local',goal:'verify'})
  const step = legion.spawn(project.id, { role: 'general', taskKey: 'isolated', description: 'isolated parent', sourceIds: ['origin'], executionProfile: 'isolated' })
  const run = store.claim(project.id, 'execute', worker, step.id)
  const mission = { role: 'soldier' as const, taskKey: 'isolated', description: 'bounded squad', sourceIds: ['origin'], parentRunId: run.id }
  assert.equal(legion.spawn(project.id, mission).executionProfile, 'isolated')
  assert.throws(() => legion.spawn(project.id, { ...mission, executionProfile: 'direct' }), /weaken execution isolation/)
})

test('native current context meter triggers automatic compaction and a fresh Agent/Run with preserved summary', {timeout:90000},async()=>{const result=await exec(process.execPath,[new URL('./legion-context.fixture.mjs',import.meta.url).pathname],{maxBuffer:2*1024*1024});assert.match(result.stdout,/NATIVE_CONTEXT_ACCEPTANCE=true/);assert.match(result.stdout,/fresh_run_and_agent=true/);assert.match(result.stdout,/automatic_compaction=true/)})

test('Commander native automatic compaction rotates Session once and successor completes without recursive STATE growth',{timeout:90000},async()=>{const r=await exec(process.execPath,[new URL('./legion-commander-context.fixture.mjs',import.meta.url).pathname],{maxBuffer:2*1024*1024});assert.match(r.stdout,/COMMANDER_NATIVE_RELAY=true/);assert.match(r.stdout,/successor_finishes=true/);assert.match(r.stdout,/no_recursive_state_growth=true/)})

test('native ownership recovery resumes only confirmed stopped Sessions and never replays unknown calls',{timeout:90000},async()=>{const r=await exec(process.execPath,[new URL('./legion-recovery.fixture.mjs',import.meta.url).pathname]);assert.match(r.stdout,/NATIVE_RECOVERY=true/);assert.match(r.stdout,/active_owner_blocked=true/);assert.match(r.stdout,/unknown_tools_not_replayed=true/)})

test('Commander board details are lossless JSON at the native tool boundary',async t=>{const{store,legion,project}=fixture(t);legion.claimCommand();legion.spawn(project.id,{role:'worker',taskKey:'board',description:'scope',sourceIds:['origin']});const output=await legionTools(store,'commander',store.projects()[0].id,null,()=>{}).find(t=>t.name==='legion_board')!.execute('board',{});assert.deepEqual(output.details,JSON.parse(JSON.stringify(output.details)))})

test('Commander wait returns a finish instruction rather than deadlocking its shared route',async t=>{const{store,legion,project}=fixture(t),step=store.addStep(project.id,{description:'Worker',sourceIds:['origin']}),run=store.claim(project.id,'execute',worker,step.id);const c=legion.claimCommand();legion.saveCampaign({...c,workerName:'fixture'});const tools=legionTools(store,'commander',store.projects()[0].id,null,()=>{},{workers:[{...worker,roles:['planner','worker'],maxRunning:2}],maxWorkers:4} as any);const result=await tools.find(t=>t.name==='legion_wait')!.execute('capacity',{projectId:project.id,after:0});assert.equal((result.details as any).mustFinish,true);assert.equal(store.run(run.id).status,'running');assert.equal(legion.campaign().status,'running')})

test('disabled Commander preset does not acquire the campaign or bypass native plugin availability',async t=>{const{store,legion}=fixture(t),{createCommanderController}=await import(new URL('../compat/legion.mjs',import.meta.url).href);const controller=createCommanderController({get(){return undefined},logger:{warn(){}}},{store,legion,scheduler:{maintenance:false,wake(){}},configuration:{resolvedSnapshot(){throw Error('Disabled preset must not select a model')}}},()=>false);controller.start();await new Promise(r=>setTimeout(r,30));await controller.close();assert.equal(legion.campaign().status,'idle')})
