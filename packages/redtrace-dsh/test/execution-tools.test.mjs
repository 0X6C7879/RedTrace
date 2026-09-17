// Real-fiber mounting of the execution toolchain: the DSH native capability
// stacks must mount into concurrent Execute-agent scopes without service
// collisions, and the host-plane capability modules must publish their
// services. DSH_HOME is pinned to a scratch directory so nothing touches the
// real harness home.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { load } from '../lib/loader.js'
import { mountExecutionTools } from '../lib/execution-tools.js'
import * as credentials from '../lib/credentials.js'
import * as attachment from '../lib/attachment.js'
import * as fileReferences from '../lib/file-references.js'
import * as codeRuntime from '../lib/code-runtime.js'

const VENDOR = 'vendor/deepseek-harness/packages'
const MOUNT_TIMEOUT_MS = 30_000

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
  await withTimeout(
    mountExecutionTools(scope.ctx, { task, cwd, skillsDir: path.join(cwd, 'skills'), available }),
    `${executionProfile} session mount`,
  )
  return { key, scope, cwd }
}

test('capability stacks mount into concurrent Execute scopes and expose their tools', async (t) => {
  const host = await createHost()
  t.after(async () => { await host.fiber.dispose() })
  // The redtrace-ptc plugin's host module in production: run_code needs the
  // host-plane codeRuntime before a session can present it.
  await withTimeout(host.plugin(codeRuntime).await(), 'code-runtime mount')
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

  const baseline = ['bash', 'skill']
  const stacks = ['job_output', 'job_list', 'job_kill', 'web_search', 'web_fetch',
    'glob', 'grep', 'terminal_open', 'terminal_send', 'terminal_read', 'terminal_list']
  for (const session of [direct, isolated]) {
    for (const name of [...baseline, ...stacks, 'run_code']) {
      assert.ok(host.tools.get(name, session.key) !== undefined, `${session.cwd}: ${name} must be visible`)
    }
  }
  for (const name of stacks) {
    assert.equal(host.tools.get(name, bare.key), undefined, `${name} must stay unmounted when gated off`)
  }
  assert.equal(host.tools.get('run_code', bare.key), undefined, 'run_code must stay unmounted when gated off')
  assert.ok(host.tools.get('bash', bare.key) !== undefined, 'baseline shell stays mounted')

  // The LSP tool appears only when a default language server is installed;
  // a host with none skips the whole stack instead of failing the session.
  const { execSync } = await import('node:child_process')
  let hasServer = false
  for (const command of ['typescript-language-server', 'pyright-langserver', 'clangd']) {
    try { execSync(`command -v ${command}`, { stdio: 'ignore' }); hasServer = true } catch { /* not installed */ }
  }
  assert.equal(host.tools.get('lsp', direct.key) !== undefined, hasServer)

  await Promise.all([direct.scope.dispose(), isolated.scope.dispose(), bare.scope.dispose()])
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
  assert.ok(host.get('codeRuntime') !== undefined, 'codeRuntime service')
})
