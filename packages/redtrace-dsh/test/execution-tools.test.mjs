// Real-fiber mounting of the execution toolchain: the DSH native capability
// stacks must mount into concurrent Execute-agent scopes without service
// collisions, and the host-plane capability modules must publish their
// services. DSH_HOME is pinned to a scratch directory so nothing touches the
// real harness home.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { load } from '../lib/loader.js'
import { mountExecutionTools, toolsSectionText } from '../lib/execution-tools.js'
import * as credentials from '../lib/credentials.js'
import * as attachment from '../lib/attachment.js'
import * as fileReferences from '../lib/file-references.js'
import * as webshell from '../lib/webshell.js'
import { executionEvidenceReadGuard, mountReasonTools } from '../../redtrace-engine/compat/cordis.mjs'
import { Store } from '../../redtrace-engine/src/store.ts'
import { createPlanGuard } from '../../redtrace-engine/src/plan-guard.ts'

const VENDOR = 'vendor/deepseek-harness/packages'
const MOUNT_TIMEOUT_MS = 30_000

// The adapter mounts the platform shell tool (bash on unix, pwsh on Windows);
// tests must assert the tool that actually mounts on the current host.
const shellName = process.platform === 'win32' ? 'pwsh' : 'bash'

function scratch(name) {
  return mkdtempSync(path.join(tmpdir(), `redtrace-exec-tools-${name}-`))
}

function withTimeout(promise, label) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${MOUNT_TIMEOUT_MS}ms`)), MOUNT_TIMEOUT_MS)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** A minimal host mirroring the Cordis profile: core services, the subprocess
 * substrate, and the projection registry the agent loop and terminal need. */
async function createHost() {
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
  const core = await load('packages/redtrace-dsh/lib/core.js')
  const subprocess = await load(`${VENDOR}/subprocess/subprocess-local/lib/index.js`)
  const projections = await load(`${VENDOR}/session/session-projection/lib/index.js`)
  const ctx = new Context()
  for (const module of [projections, subprocess, core]) {
    await withTimeout(ctx.plugin(module.default ?? module).await(), `host ${module.name ?? 'core'} mount`)
  }
  for (let i = 0; i < 500 && (ctx.get('tools') === undefined || ctx.get('agents') === undefined); i++) {
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  assert.ok(ctx.get('tools') !== undefined, 'tools service must activate')
  assert.ok(ctx.get('agents') !== undefined, 'agents service must activate')
  return ctx
}

/** One Execute-agent session scope. The real setup context extends the
 * agent-loop fiber, whose inject declaration licenses service property
 * access; the carrier mirrors that for this harness. */
async function mountSession(host, { executionProfile, available }) {
  const { createScope } = await load(`${VENDOR}/core/scope/lib/index.js`)
  const cwd = scratch(executionProfile)
  mkdirSync(path.join(cwd, 'skills'), { recursive: true })
  const carrier = host.plugin({ inject: ['tools', 'systemPrompt'], apply() {} })
  await carrier.await()
  const key = { session: cwd }
  const scope = createScope(carrier.ctx, key)
  const task = { type: 'explore', projectId: 'p1', worker: 'w', committed: false, executionProfile }
  let refresh
  await withTimeout(
    mountExecutionTools(scope.ctx, { task, cwd, sessionRoot: cwd, skillsDir: path.join(cwd, 'skills'), available, onRefresh: value => { refresh = value } }),
    `${executionProfile} session mount`,
  )
  return { key, scope, cwd, refresh: () => refresh() }
}

test('capability stacks mount into concurrent Execute scopes and expose their tools', async (t) => {
  const host = await createHost()
  t.after(async () => { await host.fiber.dispose() })
  const available = () => true

  // A direct and an isolated session alive at once: every per-session service
  // must live in its own isolate, or the second mount collides in the store.
  const direct = await mountSession(host, { executionProfile: 'direct', available })
  const isolated = await mountSession(host, { executionProfile: 'isolated', available })
  t.after(() => rmSync(direct.cwd, { recursive: true, force: true }))
  t.after(() => rmSync(isolated.cwd, { recursive: true, force: true }))

  // The gates compose with the plugin manager: nothing extra mounts.
  const bare = await mountSession(host, { executionProfile: 'direct', available: () => false })
  t.after(() => rmSync(bare.cwd, { recursive: true, force: true }))

  const baseline = [shellName, 'skill']
  const stacks = ['job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch',
    'glob', 'grep', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_signal', 'terminal_close', 'terminal_list']
  for (const session of [direct, isolated]) {
    for (const name of [...baseline, ...stacks]) {
      assert.ok(host.tools.get(name, session.key) !== undefined, `${session.cwd}: ${name} must be visible`)
    }
    assert.equal(host.tools.get('run_code', session.key), undefined, `${session.cwd}: run_code must stay unmounted even with every capability enabled`)
  }
  for (const name of stacks) {
    assert.equal(host.tools.get(name, bare.key), undefined, `${name} must stay unmounted when gated off`)
  }
  assert.equal(host.tools.get('run_code', bare.key), undefined, 'run_code must stay unmounted when gated off')
  assert.ok(host.tools.get(shellName, bare.key) !== undefined, 'baseline shell stays mounted')

  // The LSP tool appears only when a default language server is installed;
  // a host with none skips the whole stack instead of failing the session.
  const { execSync } = await import('node:child_process')
  let hasServer = false
  for (const command of ['typescript-language-server', 'pyright-langserver', 'clangd']) {
    try { execSync(`${process.platform === 'win32' ? 'where' : 'command -v'} ${command}`, { stdio: 'ignore' }); hasServer = true } catch { /* not installed */ }
  }
  assert.equal(host.tools.get('lsp', direct.key) !== undefined, hasServer)

  await Promise.all([direct.scope.dispose(), isolated.scope.dispose(), bare.scope.dispose()])
})

test('running Execute session gains and loses plugin tools without restarting', async (t) => {
  const host = await createHost()
  t.after(async () => { await host.fiber.dispose() })
  const enabled = new Set()
  const session = await mountSession(host, { executionProfile: 'direct', available: id => enabled.has(id) })
  t.after(() => rmSync(session.cwd, { recursive: true, force: true }))
  t.after(async () => { await session.scope.dispose() })
  const visible = name => host.tools.get(name, session.key) !== undefined
  const bash = () => host.tools.get(shellName, session.key)
  const prompt = async () => (await host.systemPrompt.assemble({ scope: session.key })).sections.map(section => section.text).join('\n')
  assert.equal(visible('web_search'), false)
  assert.equal(visible('job_output'), false)
  assert.doesNotMatch(await prompt(), /web_search/)
  assert.equal(JSON.stringify(bash().parameters).includes('run_in_background'), false)
  const originalBash = bash()
  await session.refresh()
  assert.equal(bash(), originalBash, 'unchanged plugin state must not remount tools')

  for (const id of ['redtrace-web', 'redtrace-jobs', 'redtrace-fs-search', 'redtrace-terminal', 'redtrace-spill', 'redtrace-tool-timeout', 'redtrace-lsp']) enabled.add(id)
  await withTimeout(session.refresh(), 'hot enable')
  for (const name of ['web_search', 'web_fetch', 'job_output', 'glob', 'grep', 'terminal_open']) assert.equal(visible(name), true, name)
  assert.equal(JSON.stringify(bash().parameters).includes('run_in_background'), true)
  assert.match(await prompt(), /web_search/)
  const enabledBash = bash(), enabledWeb = host.tools.get('web_search', session.key)
  await session.refresh()
  assert.equal(bash(), enabledBash)
  assert.equal(host.tools.get('web_search', session.key), enabledWeb)

  enabled.clear()
  await withTimeout(session.refresh(), 'hot disable')
  for (const name of ['web_search', 'web_fetch', 'job_output', 'glob', 'grep', 'terminal_open']) assert.equal(visible(name), false, name)
  assert.equal(JSON.stringify(bash().parameters).includes('run_in_background'), false)
  assert.doesNotMatch(await prompt(), /web_search/)
  assert.equal(visible(shellName), true)
  enabled.add('redtrace-web')
  await withTimeout(session.refresh(), 'hot re-enable')
  assert.equal(visible('web_search'), true)
})

test('Spill is Execute-only, session-isolated, hot-reloadable and preserves evidence recovery', async t => {
  const host = await createHost(), root = scratch('spill')
  t.after(async () => { await host.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  const { createScope } = await load(`${VENDOR}/core/scope/lib/index.js`)
  const { sessionDir } = await load(`${VENDOR}/spill/spill-local/lib/index.js`)
  const { PluginManager } = await import('../lib/plugins.js')
  const manager = new PluginManager(host, { sessionRoot: root, pluginsManifest: path.join(root, 'plugins.json') }, root)
  await manager.start('redtrace-spill')
  assert.equal(host.get('spillStore'), undefined, 'no global Spill service')
  const text = `HEAD\n${'tool output line\n'.repeat(20000)}TAIL\n`
  const sessions = []
  let callId = 0
  for (const type of ['reason', 'explore', 'bootstrap']) {
    const carrier = host.plugin({ inject: ['tools', 'systemPrompt'], apply() {} }); await carrier.await()
    const agent = { options: {}, session: host.sessions.create(undefined, { meta: { cwd: root } }) }
    const scope = createScope(carrier.ctx, agent)
    let scoped = scope.ctx, refresh = async () => {}
    agent.ctx = scoped
    if (type === 'reason') await mountReasonTools(scoped)
    else scoped = await mountExecutionTools(scoped, { task: { type, executionProfile: 'direct' }, cwd: root,
      sessionRoot: root, skillsDir: root, available: id => manager.availableForTask(id), onRefresh: value => { refresh = value } })
    agent.ctx = scoped
    scoped.tools.register({ name: 'fixture', description: 'Native retention fixture', parameters: {},
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async () => ({ text }) })
    const call = (name, args) => host.tools.execute({ name, arguments: args, agent, callId: `spill-${++callId}`, signal: new AbortController().signal })
    const result = await call('fixture', {}), visible = result.content.map(block => block.text ?? '').join('')
    assert.equal(result.value.text, text)
    if (type === 'reason') {
      assert.equal(visible, text)
      assert.equal(scoped.get('spillStore'), undefined)
      assert.equal(existsSync(path.join(root, 'spill')), false)
    } else {
      assert.ok(visible.startsWith('HEAD\n')); assert.match(visible, /TAIL/)
      assert.doesNotMatch(visible, /evidenceId|evidence_read/)
      const file = visible.match(/Full formatted result stored at: (.*?)\. Use read/s)?.[1]
      assert.ok(file); assert.equal(readFileSync(file, 'utf8'), text)
      assert.ok(file.startsWith(sessionDir(path.join(root, 'spill'), String(agent.session.header.id))))
      const read = await call('read', { file_path: file, offset: 20002, limit: 1 })
      assert.equal(read.isError, false); assert.match(read.content[0].text, /TAIL/)
      if (type === 'explore') {
        const store = new Store(':memory:')
        try {
          const project = store.createProject({ title: 'Spill recovery', origin: 'Local fixture', goal: 'Read existing evidence' }).project
          const step = store.addStep(project.id, { description: 'Original plan', sourceIds: ['origin'] })
          const run = store.claim(project.id, 'execute', { name: 'fixture', backend: 'mock' }, step.id)
          const plan = createPlanGuard(store, run.id), recoveryRead = executionEvidenceReadGuard(sessionDir(path.join(root, 'spill'), run.id), root)
          const releaseGuard = scoped.tools.guard(exec => plan.check({ name: exec.name === 'read' && recoveryRead(exec) === undefined ? 'evidence_read' : exec.name, rootCallId: String(exec.rootCallId) }))
          store.updateStep(project.id, step.id, { description: 'Amended plan', mode: 'amend', expectedVersion: store.node(project.id, step.id).version })
          assert.equal((await call('read', { file_path: file, offset: 20002, limit: 1 })).isError, false)
          const other = path.join(root, 'other.txt'); writeFileSync(other, 'old plan')
          assert.equal((await call('read', { file_path: other })).isError, false)
          releaseGuard()
        } finally { store.close() }
      }
    }
    sessions.push({ type, scoped, call, refresh })
  }
  const [reason, explore, bootstrap] = sessions
  assert.notEqual(explore.scoped.get('spillStore'), bootstrap.scoped.get('spillStore'))
  await manager.stop('redtrace-spill'); await Promise.all(sessions.map(s => s.refresh()))
  for (const s of sessions) {
    assert.equal(s.scoped.get('spillStore'), undefined)
    assert.equal((await s.call('fixture', {})).content[0].text, text)
  }
  await manager.start('redtrace-spill'); await Promise.all(sessions.map(s => s.refresh()))
  assert.equal((await reason.call('fixture', {})).content[0].text, text)
  for (const s of [explore, bootstrap]) assert.match((await s.call('fixture', {})).content[0].text, /Full formatted result stored at:/)
  bootstrap.scoped.get('spillStore').saveText = async () => { throw new Error('fixture storage unavailable') }
  assert.equal((await bootstrap.call('fixture', {})).content[0].text, text)
  assert.match((await explore.call('fixture', {})).content[0].text, /Full formatted result stored at:/)
})

test('host plugin tools disappear from an already mounted Execute session', async (t) => {
  const host = await createHost()
  t.after(async () => { await host.fiber.dispose() })
  const session = await mountSession(host, { executionProfile: 'direct', available: () => false })
  t.after(() => rmSync(session.cwd, { recursive: true, force: true }))
  t.after(async () => { await session.scope.dispose() })
  const fiber = host.plugin(webshell)
  await fiber.await()
  assert.ok(host.tools.get('webshell_test', session.key))
  await fiber.dispose()
  assert.equal(host.tools.get('webshell_test', session.key), undefined)
})

test('native Terminal retains state, isolates real Agents, and cleans up on close, disable and disposal', { timeout: 120000 }, async t => {
  if (process.platform === 'win32' && process.env.REDTRACE_TERMINAL_TEST_CHILD !== '1') {
    // node-pty's Windows ConPTY helper can retain a MessagePort after shell teardown; isolate that native thread in the fixture.
    const env = { ...process.env, REDTRACE_TERMINAL_TEST_CHILD: '1' }; delete env.NODE_TEST_CONTEXT
    const { stdout } = await promisify(execFile)(process.execPath, ['--test', '--test-force-exit', '--test-name-pattern=native Terminal', import.meta.filename], {
      env, timeout: 100000,
    })
    assert.match(stdout, /pass 1/)
    t.diagnostic(stdout.trim())
    return
  }
  const host = await createHost(), cwd = scratch('native-terminal')
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(cwd, 'home')
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    rmSync(cwd, { recursive: true, force: true })
  })
  t.after(() => host.fiber.dispose())
  const { SessionId } = await load(`${VENDOR}/core/session/lib/index.js`)
  const enabled = new Set(['redtrace-terminal'])
  async function worker(executionProfile = 'direct') {
    let refresh
    const handle = await host.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd },
      setup: scoped => mountExecutionTools(scoped, { cwd, sessionRoot: cwd, skillsDir: cwd, task: { type: 'explore', executionProfile },
        available: id => enabled.has(id), onRefresh: value => { refresh = value } }).then(() => {}) })
    t.after(() => handle.dispose())
    let callId = 0
    return { ...handle, refresh: () => refresh(),
      call: (name, args = {}) => host.tools.execute({ name, arguments: args, agent: handle.agent, callId: `terminal-${++callId}`, signal: new AbortController().signal }) }
  }
  const a = await worker(), b = await worker()
  const open = await a.call('terminal_open', { type: 'shell' })
  assert.equal(open.isError, false, JSON.stringify(open.content))
  const { sessionId } = open.value
  assert.ok(sessionId)
  const work = path.join(cwd, 'work'); mkdirSync(work)
  const set = process.platform === 'win32'
    ? `$env:RT_TERMINAL_FIXTURE = 'RT_NATIVE_' + 'STATE_OK'; Set-Location '${work.replaceAll("'", "''")}'`
    : `export RT_TERMINAL_FIXTURE=RT_NATIVE_\"STATE_OK\"; cd '${work.replaceAll("'", "'\\''")}'`
  assert.equal((await a.call('terminal_send', { sessionId, text: set })).isError, false)
  const state = await a.call('terminal_send', { sessionId, text: process.platform === 'win32'
    ? 'Write-Output $env:RT_TERMINAL_FIXTURE; Set-Content -LiteralPath cwd-fixture.txt -Value cwd-fixture; $PID'
    : 'printf cwd-fixture > cwd-fixture.txt; printf "%s\\n" "$RT_TERMINAL_FIXTURE" "$PWD" "$$"' })
  assert.equal(state.isError, false, JSON.stringify(state.content))
  assert.match(state.value.viewport, /RT_NATIVE_STATE_OK/)
  // Relative I/O proves cwd even when Windows expands 8.3 path aliases.
  assert.equal(readFileSync(path.join(work, 'cwd-fixture.txt'), 'utf8').trim(), 'cwd-fixture')
  const pid = Number(state.value.viewport.match(/^\s*(\d+)\s*$/m)?.[1])
  assert.ok(pid > 0, state.value.viewport)
  assert.deepEqual((await b.call('terminal_list')).value, [])
  const dead = pid => assert.throws(() => process.kill(pid, 0), e => e.code === 'ESRCH')
  const shellPid = async (worker, sessionId) => {
    const result = await worker.call('terminal_send', { sessionId, text: process.platform === 'win32' ? '$PID' : 'echo $$' })
    assert.equal(result.isError, false, JSON.stringify(result.content))
    const pid = Number(result.value.viewport.match(/^\s*(\d+)\s*$/m)?.[1])
    assert.ok(pid > 0, result.value.viewport)
    return pid
  }
  assert.equal((await a.call('terminal_close', { sessionId })).isError, false)
  dead(pid)
  const active = await a.call('terminal_open', { type: 'shell' })
  assert.equal(active.isError, false)
  const activePid = await shellPid(a, active.value.sessionId)
  enabled.clear(); await a.refresh(); await b.refresh()
  assert.equal(host.tools.get('terminal_open', a.agent), undefined)
  dead(activePid)
  enabled.add('redtrace-terminal'); await a.refresh()
  const fresh = await a.call('terminal_open', { type: 'shell' })
  assert.equal(fresh.isError, false)
  const freshPid = await shellPid(a, fresh.value.sessionId)
  await a.dispose(); dead(freshPid)
  assert.equal(host.agents.get(a.agent.id), undefined)
})

test('host capability modules publish their DSH services', async (t) => {
  const home = scratch('home')
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  })

  const host = await createHost()
  t.after(async () => { await host.fiber.dispose() })
  for (const module of [credentials, attachment, fileReferences]) {
    await withTimeout(host.plugin(module).await(), `${module.name} mount`)
  }

  assert.ok(host.get('credentials') !== undefined, 'credentials service')
  assert.ok(host.get('attachments') !== undefined, 'attachments service')
  assert.ok(host.get('fileReferences') !== undefined, 'fileReferences service')
  assert.equal(host.get('ptcRuntime'), undefined, 'PTC runtime must not mount')
})

test('offline assets report existing environment overrides and never expose unrelated environment', () => {
 const cwd=scratch('assets'), previous=process.env.REDTRACE_WORDLISTS_DIR
 try {
  const override=path.join(cwd,'{{literal}} 中文');mkdirSync(override)
  process.env.REDTRACE_WORDLISTS_DIR=override
  const text=toolsSectionText(cwd)
  assert.ok(text.includes(`$REDTRACE_WORDLISTS_DIR（${override}`))
  assert.ok(!text.includes('REDTRACE_PAYLOADS_DIR'))
  assert.ok(!text.includes('API_KEY'))
  process.env.REDTRACE_WORDLISTS_DIR=path.join(cwd,'absent')
  assert.ok(!toolsSectionText(cwd).includes('REDTRACE_WORDLISTS_DIR'))
 } finally {if(previous===undefined)delete process.env.REDTRACE_WORDLISTS_DIR;else process.env.REDTRACE_WORDLISTS_DIR=previous;rmSync(cwd,{recursive:true,force:true})}
})


test('native conclude submits a Fact and finishes directly while keeping external tools blocked', async t => {
  const host = await createHost(), root = scratch('native-conclude')
  t.after(async () => { await host.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  const { createScope } = await load(`${VENDOR}/core/scope/lib/index.js`)
  const carrier = host.plugin({ inject: ['tools', 'systemPrompt'], apply() {} }); await carrier.await()
  const agent = { options: {}, session: host.sessions.create(undefined, { cwd: root }) }
  const scope = createScope(carrier.ctx, agent); agent.ctx = scope.ctx
  let refresh, closing = false, facts = 0, completed = false, externalCalls = 0
  await mountExecutionTools(scope.ctx, { cwd: root, sessionRoot: root, skillsDir: root, task: { type: 'explore', executionProfile: 'direct' }, available: id => id === 'redtrace-ptc', onRefresh: value => { refresh = value } })
  const jsonOutput = { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] }
  scope.ctx.tools.register({ name: 'submit_fact', parameters: { type: 'object', additionalProperties: false }, output: jsonOutput, execute: () => ({ facts: ++facts }) })
  scope.ctx.tools.register({ name: 'finish_step', parameters: { type: 'object', additionalProperties: false }, output: jsonOutput, execute: () => { if (!facts) throw new Error('Explore must submit at least one Fact'); completed = true; return { saved: true } } })
  scope.ctx.tools.register({ name: 'external_effect', parameters: { type: 'object', additionalProperties: false }, output: jsonOutput, execute: () => ({ calls: ++externalCalls }) })
  scope.ctx.tools.guard(exec => closing && !['submit_fact', 'finish_step'].includes(exec.name) ? 'Execution timed out; only summarize and submit existing evidence' : undefined)
  const execute = (name, args = {}) => host.tools.execute({ name, arguments: args, agent, callId: `conclude-${name}-${randomUUID()}`, signal: new AbortController().signal })
  closing = true
  await refresh()
  assert.equal(host.tools.get('run_code', agent), undefined)
  assert.ok(host.tools.get('submit_fact', agent))
  assert.equal((await execute('finish_step')).isError, true)
  assert.equal(completed, false)
  assert.equal((await execute('submit_fact')).isError, false)
  assert.equal((await execute('finish_step')).isError, false)
  assert.equal(facts, 1); assert.equal(completed, true)
  assert.equal((await execute('external_effect')).isError, true)
  assert.equal(externalCalls, 0)
  const other = await mountSession(host, { executionProfile: 'direct', available: id => id === 'redtrace-ptc' })
  assert.equal(host.tools.get('run_code', other.key), undefined, 'stale PTC availability cannot expose run_code')
  await other.scope.dispose(); rmSync(other.cwd, { recursive: true, force: true })
  await scope.dispose(); await carrier.dispose()
})

test('offline assets advertise skill resources only when present without inlining content', () => {
  const cwd = scratch('skill-resources')
  const resources = path.join(cwd, 'skill-resources')
  try {
    assert.ok(!toolsSectionText(cwd).includes(resources))
    mkdirSync(path.join(resources, 'example'), { recursive: true })
    writeFileSync(path.join(resources, 'example', 'SKILL.md'), 'DO_NOT_INLINE_RESOURCE_BODY')
    const text = toolsSectionText(cwd)
    assert.ok(text.includes(`补充 Skill 参考资料（按需读取）：${resources}`))
    assert.ok(!text.includes('DO_NOT_INLINE_RESOURCE_BODY'))
    rmSync(resources, { recursive: true })
    assert.ok(!toolsSectionText(cwd).includes(resources))
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})
