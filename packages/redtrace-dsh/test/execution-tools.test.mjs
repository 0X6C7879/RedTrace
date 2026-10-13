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
import * as codeRuntime from '../lib/code-runtime.js'
import * as webshell from '../lib/webshell.js'
import * as spill from '../lib/spill.js'
import { reasonSpillGuard } from '../../redtrace-engine/compat/cordis.mjs'
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
    mountExecutionTools(scope.ctx, { task, cwd, skillsDir: path.join(cwd, 'skills'), available, onRefresh: value => { refresh = value } }),
    `${executionProfile} session mount`,
  )
  return { key, scope, cwd, refresh: () => refresh() }
}

test('capability stacks mount into concurrent Execute scopes and expose their tools', async (t) => {
  const host = await createHost()
  t.after(async () => { await host.fiber.dispose() })
  // redtrace-ptc is excluded: under DSH ≥0.2.1-alpha.2 a PTC scope collapses
  // to run_code alone, which the dedicated test below covers.
  const available = id => id !== 'redtrace-ptc'

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
    assert.equal(host.tools.get('run_code', session.key), undefined, `${session.cwd}: run_code must stay unmounted without redtrace-ptc`)
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

  for (const id of ['redtrace-web', 'redtrace-jobs', 'redtrace-fs-search', 'redtrace-terminal', 'redtrace-spill', 'redtrace-tool-timeout', 'redtrace-repeat-reminder', 'redtrace-lsp']) enabled.add(id)
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

test('PTC presentation collapses the session view to run_code alone', async (t) => {
  const host = await createHost()
  t.after(async () => { await host.fiber.dispose() })
  await withTimeout(host.plugin(codeRuntime).await(), 'code-runtime mount')
  const session = await mountSession(host, { executionProfile: 'direct', available: id => id === 'redtrace-ptc' })
  t.after(() => rmSync(session.cwd, { recursive: true, force: true }))
  t.after(async () => { await session.scope.dispose() })
  assert.ok(host.tools.get('run_code', session.key) !== undefined, 'run_code must be the visible presentation transport')
  // The collapse is a wire-level rule: the registry keeps every tool reachable
  // for in-program dispatch, while the prompt states only run_code is direct.
  const prompt = async () => (await host.systemPrompt.assemble({ scope: session.key })).sections.map(section => section.text).join('\n')
  assert.match(await prompt(), /`run_code` is the only tool you can call directly/)
})

test('PTC directly creates and reads files outside direct and isolated Step workspaces', async t => {
  const host = await createHost(), root = scratch('ptc-full-access')
  t.after(async () => { await host.fiber.dispose(); rmSync(root, { recursive: true, force: true }) })
  await withTimeout(host.plugin(codeRuntime).await(), 'code-runtime mount')
  const { createScope } = await load(`${VENDOR}/core/scope/lib/index.js`)
  for (const executionProfile of ['direct', 'isolated']) {
    const cwd = path.join(root, executionProfile); mkdirSync(cwd)
    const carrier = host.plugin({ inject: ['tools', 'systemPrompt'], apply() {} }); await carrier.await()
    const agent = { options: {}, session: host.sessions.create(undefined, { cwd }) }
    const scope = createScope(carrier.ctx, agent); agent.ctx = scope.ctx
    try {
      await mountExecutionTools(scope.ctx, { cwd, skillsDir: cwd, task: { type: 'explore', executionProfile }, available: id => id === 'redtrace-ptc', onRefresh() {} })
      const outside = path.join(root, `${executionProfile}-outside.txt`)
      const result = await host.tools.execute({ name: 'run_code', agent, callId: `ptc-${executionProfile}`, signal: new AbortController().signal,
        arguments: { description: 'Direct Node write/read outside workspace', code: `const fs = await import('node:fs/promises'); await fs.writeFile(${JSON.stringify(outside)}, 'full-access'); console.log(await fs.readFile(${JSON.stringify(outside)}, 'utf8'));` } })
      assert.equal(result.isError, false, JSON.stringify(result.content))
      assert.equal(readFileSync(outside, 'utf8'), 'full-access')
    } finally { await scope.dispose(); await carrier.dispose() }
  }
})

test('native spill retains canonical values for every Worker and scoped read recovers the full text', async t => {
  const host = await createHost(), root = scratch('spill')
  t.after(() => rmSync(root, { recursive: true, force: true }))
  t.after(() => host.fiber.dispose())
  const { createScope } = await load(`${VENDOR}/core/scope/lib/index.js`)
  const { sessionDir } = await load(`${VENDOR}/spill/spill-local/lib/index.js`)
  let fiber = host.plugin(spill, { sessionRoot: root })
  await fiber.await()
  await host.plugin(codeRuntime).await()
  const text = `HEAD\n${'tool output line\n'.repeat(20000)}TAIL\n`
  let callId = 0
  for (const worker of ['reason', 'explore', 'bootstrap']) {
    const carrier = host.plugin({ inject: ['tools', 'systemPrompt'], apply() {} })
    await carrier.await()
    const agent = { options: {}, session: host.sessions.create(undefined, { cwd: root }) }
    const scope = createScope(carrier.ctx, agent)
    agent.ctx = scope.ctx
    scope.ctx.tools.register({ name: 'fixture', description: 'Native retention fixture', parameters: {},
      output: { schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, render: (_args, value) => [{ type: 'text', text: value.text }] },
      execute: async () => ({ text }) })
    const directory = sessionDir(path.join(root, 'spill'), String(agent.session.header.id))
    if (worker === 'reason') {
      scope.ctx.tools.restrict({ allow: ['read'] })
      scope.ctx.tools.guard(reasonSpillGuard(directory, root))
    }
    const call = (name, args) => host.tools.execute({ name, arguments: args, agent, callId: `spill-${++callId}`, signal: new AbortController().signal })
    const result = await call('fixture', {})
    const visible = result.content.map(block => block.text ?? '').join('')
    assert.equal(result.value.text, text, `${worker}: canonical value must stay intact`)
    assert.ok(visible.startsWith('HEAD\n'))
    assert.match(visible, /TAIL/)
    assert.doesNotMatch(visible, /evidenceId|evidence_read/)
    const file = visible.match(/Full formatted result stored at: (.*?)\. Use read/s)?.[1]
    assert.ok(file, `${worker}: native recovery notice must be present`)
    assert.equal(readFileSync(file, 'utf8'), text)
    const read = await call('read', { file_path: file, offset: 20002, limit: 1 })
    assert.equal(read.isError, false)
    assert.match(read.content[0].text, /TAIL/)
    if (worker === 'explore') {
      const events = []
      const unlisten = host.on('session/event', (session, event) => { if (session === agent.session) events.push(event) })
      const presentation = await load(`${VENDOR}/core/agent-tool-presentation/lib/index.js`)
      const mode = scope.ctx.plugin(presentation, { mode: 'ptc' }); await mode.await()
      const program = await call('run_code', { description: 'Read the canonical tool value', code: 'const value = await tools.fixture({}); console.log(value.text.length); return value.text.length;' })
      // Full-access PTC must run; nested results still use native audit/spill.
      {
        assert.equal(program.isError, false, JSON.stringify(program.content))
        assert.match(program.content.map(block => block.text ?? '').join(''), new RegExp(String(text.length)))
        const dispatch = events.find(event => event.type === 'tool/ptc-dispatch')
        assert.ok(dispatch, 'DSH must emit the nested result event')
        assert.equal(dispatch.data.name, 'fixture')
        assert.match(dispatch.data.content[0].text, /Full formatted result stored at:/)
        assert.ok(events.some(event => event.type === 'tool/ptc-dispatch-start'))
      }
      unlisten(); await mode.dispose()
      const store = new Store(':memory:')
      try {
        const project = store.createProject({ title: 'Spill recovery', origin: 'Local fixture', goal: 'Read existing evidence' }).project
        const step = store.addStep(project.id, { description: 'Original plan', sourceIds: ['origin'] })
        const run = store.claim(project.id, 'execute', { name: 'fixture', backend: 'mock' }, step.id)
        const plan = createPlanGuard(store, run.id), ownSpillRead = reasonSpillGuard(directory, root)
        scope.ctx.tools.guard(exec => plan.check({ name: exec.name === 'read' && ownSpillRead(exec) === undefined ? 'evidence_read' : exec.name, rootCallId: String(exec.rootCallId) }))
        store.updateStep(project.id, step.id, { description: 'Amended plan', mode: 'amend', expectedVersion: store.node(project.id, step.id).version })
        assert.equal((await call('read', { file_path: file, offset: 20002, limit: 1 })).isError, false, 'existing spill recovery remains safe after a plan amendment')
        const other = path.join(root, 'other.txt'); writeFileSync(other, 'old plan')
        assert.equal((await call('read', { file_path: other })).isError, true, 'other reads still require contract synchronization')
      } finally { store.close() }
    }
    if (worker === 'bootstrap') {
      await fiber.dispose()
      assert.equal((await call('fixture', {})).content[0].text, text, 'disabled native policy returns the original content')
      fiber = host.plugin(spill, { sessionRoot: root }); await fiber.await()
      assert.match((await call('fixture', {})).content[0].text, /Full formatted result stored at:/)
      // A failed recovery write must keep successful output, as native DSH specifies.
      host.get('spillStore').saveText = async () => { throw new Error('fixture storage unavailable') }
      assert.equal((await call('fixture', {})).content[0].text, text)
    }
    await scope.dispose(); await carrier.dispose()
  }
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
      setup: scoped => mountExecutionTools(scoped, { cwd, skillsDir: cwd, task: { type: 'explore', executionProfile },
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
  for (const module of [credentials, attachment, fileReferences, codeRuntime]) {
    await withTimeout(host.plugin(module).await(), `${module.name} mount`)
  }

  assert.ok(host.get('credentials') !== undefined, 'credentials service')
  assert.ok(host.get('attachments') !== undefined, 'attachments service')
  assert.ok(host.get('fileReferences') !== undefined, 'fileReferences service')
  assert.ok(host.get('ptcRuntime') !== undefined, 'ptcRuntime service')
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
