import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { load, repoRoot } from '../lib/loader.js'
import { mountExecutionTools } from '../lib/execution-tools.js'
import { reverseEnvironment } from '../lib/reverse.js'
import { PluginManager } from '../lib/plugins.js'

const VENDOR = 'vendor/deepseek-harness/packages'
const rea = schemas => schemas.filter(t => t.name.startsWith('mcp__rea__'))

export async function host() {
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
  const ctx = new Context()
  for (const module of [`${VENDOR}/session/session-projection/lib/index.js`, `${VENDOR}/subprocess/subprocess-local/lib/index.js`, 'packages/redtrace-dsh/lib/core.js']) {
    const p = await load(module)
    await ctx.plugin(p.default ?? p).await()
  }
  return ctx
}

export async function session(ctx, available) {
  const cwd = mkdtempSync(path.join(tmpdir(), 'redtrace-rea-test-'))
  mkdirSync(path.join(cwd, 'skills'))
  const carrier = ctx.plugin({ inject: ['tools', 'systemPrompt'], apply() {} })
  await carrier.await()
  const { createScope } = await load(`${VENDOR}/core/scope/lib/index.js`)
  const agent = { options: {} }
  const scope = createScope(carrier.ctx, agent)
  agent.ctx = scope.ctx
  agent.session = ctx.get('sessions').create(undefined, { cwd })
  let refresh
  const scoped = await mountExecutionTools(scope.ctx, { cwd, skillsDir: path.join(cwd, 'skills'),
    task: { type: 'explore', executionProfile: 'direct' }, available,
    onRefresh: fn => { refresh = fn } })
  let id = 0
  return { cwd, agent, scope, scoped, refresh: () => refresh(), schemas: () => ctx.tools.schemas(agent),
    call: (name, args, signal = new AbortController().signal) => ctx.tools.execute({ name, arguments: args, agent, callId: `test-${++id}`, signal }),
    dispose: async () => { await scope.dispose(); await carrier.dispose() },
  }
}

test('Reason-created Step grants only its claimant native REA; management veto revokes live scopes', { timeout: 90000 }, async t => {
  const root = mkdtempSync(path.join(tmpdir(), 'redtrace-step-rea-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const { Store } = await import(pathToFileURL(path.join(repoRoot, 'packages/redtrace-engine/src/store.ts')))
  const { graphTools } = await import(pathToFileURL(path.join(repoRoot, 'packages/redtrace-engine/src/runner.ts')))
  const store = new Store(':memory:')
  t.after(() => store.close())
  const sessions = []
  const fake = { plugin() { return { async await() {}, async dispose() {} } } }
  const manager = new PluginManager(fake, { pluginsManifest: path.join(root, 'plugins.json') }, root, async () => ({}), {},
    () => Promise.all(sessions.map(s => s.refresh())))
  await manager.boot()
  const id = store.createProject({ title: 'Fixture', origin: 'Authorized fixture', goal: 'Analyze', bootstrap: false }).project.id
  const worker = { name: 'Reason', backend: 'mock' }
  const reason = store.claim(id, 'decide', worker)
  const tools = graphTools({ store, run: reason, worker, config: { workspaceRoot: root, maxSteps: null }, signal: new AbortController().signal,
    taskPluginAllowed: name => manager.taskPluginAllowed(name) }, () => {})
  const result = await tools.find(t => t.name === 'add_step').execute('reason-create', { description: 'Reverse fixture', sourceIds: ['origin'], plugins: ['redtrace-reverse'] })
  const step = result.details
  const claimed = store.claim(id, 'execute', { name: 'Explore', backend: 'dsh' }, step.id)
  assert.equal(claimed.stepId, step.id)
  assert.equal(manager.running('redtrace-reverse'), false, 'Reason never changes the global switch')
  const ctx = await host()
  t.after(() => ctx.fiber.dispose())
  const selected = await session(ctx, name => manager.availableForTask(name, step.plugins))
  const unrelated = await session(ctx, name => manager.availableForTask(name, []))
  sessions.push(selected, unrelated)
  for (const s of sessions) t.after(async () => { await s.dispose(); rmSync(s.cwd, { recursive: true, force: true }) })
  const hasSkill = async s => (await s.scoped.get('skills').list({ cwd: s.cwd, scope: s.agent })).some(skill => skill.name === 'reverse-engineer-anything')
  assert.equal(await hasSkill(selected), true)
  assert.equal(await hasSkill(unrelated), false)
  assert.equal(rea(selected.schemas()).length, 0)
  assert.equal(rea(unrelated.schemas()).length, 0)
  assert.equal((await selected.call('skill', { name: 'reverse-engineer-anything' })).isError, false)
  assert.equal(rea(selected.schemas()).length, 14)
  assert.equal(rea(unrelated.schemas()).length, 0)
  const original = ctx.tools.get('mcp__rea__binary_session', selected.agent)
  await manager.start('redtrace-reverse')
  assert.equal(ctx.tools.get('mcp__rea__binary_session', selected.agent), original, 'stable selected scope is not remounted')
  assert.equal(await hasSkill(unrelated), false)
  await manager.stop('redtrace-reverse')
  assert.equal(rea(selected.schemas()).length, 0)
  assert.equal(await hasSkill(selected), false)
  assert.equal((await selected.call('mcp__rea__binary_session', {})).isError, true)
  await assert.rejects(tools.find(t => t.name === 'add_step').execute('vetoed', { description: 'Reverse again', sourceIds: ['origin'], plugins: ['redtrace-reverse'] }), /Task plugin is disabled/)
  await manager.start('redtrace-reverse')
  assert.equal(await hasSkill(selected), true)
  assert.equal(rea(selected.schemas()).length, 0, 'fresh connection stays lazy')
  assert.equal(await hasSkill(unrelated), false)
  assert.ok(ctx.tools.get(process.platform === 'win32' ? 'pwsh' : 'bash', selected.agent), 'unrelated native shell is retained')
  assert.equal(tools.some(t => t.name.startsWith('mcp__rea__')), false, 'Reason never receives analysis schemas')
})

test('official Skill is byte-identical to the pinned package, with complete local references', () => {
  const root = path.join(repoRoot, 'plugins/reverse')
  const lock = JSON.parse(readFileSync(path.join(root, 'upstream.json')))
  assert.equal(lock.version, '6.4.0')
  for (const [relative, digest] of Object.entries(lock.skillFiles)) {
    const file = readFileSync(path.join(root, 'skills', relative))
    assert.equal(createHash('sha256').update(file).digest('hex'), digest)
    assert.deepEqual(file, readFileSync(path.join(repoRoot, 'node_modules/rea-agents/skills', relative)))
  }
  const content = readFileSync(path.join(root, 'skills/reverse-engineer-anything/SKILL.md'), 'utf8')
  for (const match of content.matchAll(/\]\((references\/[^)]+)\)/g)) {
    assert.ok(readFileSync(path.join(root, 'skills/reverse-engineer-anything', match[1])).length)
  }
})

test('reverse env defaults compact, preserves overrides and does not copy model credentials', () => {
  const env = reverseEnvironment({ OPENAI_API_KEY: 'secret', REA_ANALYSIS_PROVIDER: 'auto' })
  assert.equal(env.REA_MCP_INPUT_SCHEMA_PROFILE, 'compact')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(reverseEnvironment({ REA_MCP_INPUT_SCHEMA_PROFILE: 'full' }).REA_MCP_INPUT_SCHEMA_PROFILE, 'full')
})

test('native Skill loads real REA MCP only on demand, isolates Runs, bounds results and revokes live tools', { timeout: 90000 }, async t => {
  const ctx = await host()
  t.after(() => ctx.fiber.dispose())
  let enabled = false
  const s = await session(ctx, id => id === 'redtrace-reverse' && enabled)
  const unrelated = await session(ctx, () => false)
  t.after(() => rmSync(s.cwd, { recursive: true, force: true }))
  t.after(() => rmSync(unrelated.cwd, { recursive: true, force: true }))
  t.after(() => unrelated.dispose())
  t.after(() => s.dispose())
  const list = () => s.scoped.get('skills').list({ cwd: s.cwd, scope: s.agent })
  assert.equal((await list()).some(s => s.name === 'reverse-engineer-anything'), false)
  assert.equal(rea(s.schemas()).length, 0)
  enabled = true
  await s.refresh()
  assert.ok((await list()).some(s => s.name === 'reverse-engineer-anything'))
  assert.equal(rea(s.schemas()).length, 0, 'enabled-but-unused exposes no REA schemas')
  const loaded = await s.call('skill', { name: 'reverse-engineer-anything' })
  assert.equal(loaded.isError, false, JSON.stringify(loaded))
  assert.equal(rea(s.schemas()).length, 14, JSON.stringify(loaded.content).slice(-1800))
  assert.equal(ctx.tools.get('mcp__rea__analyze_function', s.agent), undefined, 'unused native schemas really disappear')
  assert.equal(rea(unrelated.schemas()).length, 0)
  const initial = { tools: rea(s.schemas()).length, schemaBytes: Buffer.byteLength(JSON.stringify(rea(s.schemas()))) }
  const generation = ctx.tools.get('mcp__rea__binary_session', s.agent)
  await s.call('skill', { name: 'reverse-engineer-anything' })
  assert.equal(ctx.tools.get('mcp__rea__binary_session', s.agent), generation)
  await s.call('reverse_tools', { group: 'all' })
  assert.equal(rea(s.schemas()).length, 170)
  const status = await s.call('mcp__rea__binary_session', {})
  assert.equal(status.isError, false, JSON.stringify(status))
  assert.ok(Buffer.byteLength(JSON.stringify(status.content)) < 8192)
  const dirs = readdirSync(path.join(s.cwd, '.rea'))
  const evidence = dirs.find(d => d.startsWith('run-'))
  assert.ok(evidence)
  const retained = readdirSync(path.join(s.cwd, '.rea', evidence)).filter(n => n.endsWith('.txt'))
  assert.ok(retained.length, 'large native status output is retained outside model context')
  await s.call('mcp__rea__binary_session', {})
  assert.equal(readdirSync(path.join(s.cwd, '.rea', evidence)).filter(n => n.endsWith('.txt')).length, retained.length)
  t.diagnostic(JSON.stringify({ initial, activeTools: rea(s.schemas()).length, compactSchemaBytes: Buffer.byteLength(JSON.stringify(rea(s.schemas()))), statusPreviewBytes: Buffer.byteLength(JSON.stringify(status.content)) }))
  const exported = await s.call('mcp__rea__export_evidence_bundle', { path: path.join(s.cwd, '.rea', evidence, 'bundle.json') })
  assert.equal(exported.isError, false, JSON.stringify(exported))
  enabled = false
  await s.refresh()
  assert.equal(rea(s.schemas()).length, 0)
  assert.equal((await list()).some(s => s.name === 'reverse-engineer-anything'), false)
  assert.equal((await s.call('mcp__rea__binary_session', {})).isError, true)
  assert.equal(readdirSync(path.join(s.cwd, '.rea')).some(n => n.startsWith('tmp-')), false)
  assert.ok(readFileSync(path.join(s.cwd, '.rea', evidence, 'bundle.json')).length)
  assert.ok(ctx.tools.get(process.platform === 'win32' ? 'pwsh' : 'bash', s.agent), 'other tools remain visible')
  enabled = true
  await s.refresh()
  assert.equal(rea(s.schemas()).length, 0)
  assert.ok((await list()).some(s => s.name === 'reverse-engineer-anything'))
})

test('compact and full native MCP input schemas retain identical validation semantics', { timeout: 90000 }, async t => {
  const ctx = await host()
  t.after(() => ctx.fiber.dispose())
  const compact = await session(ctx, id => id === 'redtrace-reverse')
  const previous = process.env.REA_MCP_INPUT_SCHEMA_PROFILE
  process.env.REA_MCP_INPUT_SCHEMA_PROFILE = 'full'
  let full
  try { full = await session(ctx, id => id === 'redtrace-reverse') }
  finally { if (previous === undefined) delete process.env.REA_MCP_INPUT_SCHEMA_PROFILE; else process.env.REA_MCP_INPUT_SCHEMA_PROFILE = previous }
  for (const s of [compact, full]) {
    t.after(async () => { await s.dispose(); rmSync(s.cwd, { recursive: true, force: true }) })
    await s.call('skill', { name: 'reverse-engineer-anything' })
    await s.call('reverse_tools', { group: 'all' })
  }
  const { default: Ajv } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/ajv/dist/2020.js')).href)
  const { TOOL_CONTRACTS } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/rea-agents/dist/contracts/toolContracts.js')).href)
  const a = new Ajv({ strict: false, validateFormats: false }), b = new Ajv({ strict: false, validateFormats: false })
  const fullSchemas = new Map(rea(full.schemas()).map(t => [t.name, t.parameters]))
  let checked = 0
  for (const schema of rea(compact.schemas())) {
    const compactValidator = a.compile(schema.parameters), fullValidator = b.compile(fullSchemas.get(schema.name))
    const contract = TOOL_CONTRACTS.find(t => `mcp__rea__${t.name}` === schema.name)
    for (const example of contract.examples) {
      for (const input of [example.input, { ...example.input, __invalid_extra: true }, {}, null]) {
        assert.equal(compactValidator(input), fullValidator(input), `${schema.name}: ${JSON.stringify(input)}`)
        checked++
      }
    }
  }
  assert.ok(checked >= 170)
  t.diagnostic(JSON.stringify({ checked, fullBytes: Buffer.byteLength(JSON.stringify(rea(full.schemas()))), compactBytes: Buffer.byteLength(JSON.stringify(rea(compact.schemas()))), maxCompactParametersBytes: Math.max(...rea(compact.schemas()).map(t => Buffer.byteLength(JSON.stringify(t.parameters)))) }))
})

test('real JavaScript/managed evidence and CLI, with structured EVM/optional-provider boundaries', { timeout: 90000 }, async t => {
  const ctx = await host()
  t.after(() => ctx.fiber.dispose())
  const s = await session(ctx, id => id === 'redtrace-reverse')
  t.after(async () => { await s.dispose(); rmSync(s.cwd, { recursive: true, force: true }) })
  await s.call('skill', { name: 'reverse-engineer-anything' })
  const source = path.join(s.cwd, 'app')
  mkdirSync(source)
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'oracle', main: 'index.js' }))
  writeFileSync(path.join(source, 'index.js'), 'exports.answer = value => value + 42;\n')
  const js = await s.call('mcp__rea__analyze_javascript_application', { input_path: source, format: 'auto', integrity_policy: 'fail', detail: 'summary' })
  assert.equal(js.isError, false, JSON.stringify(js))
  assert.match(JSON.stringify(js.value), /parent_evidence_id/)
  assert.ok(rea(s.schemas()).length > 14, 'native entry call expands its scene without a selector model')
  const bytecode = path.join(s.cwd, 'contract.hex')
  writeFileSync(bytecode, '600160005260206000f3')
  const evm = await s.call('mcp__rea__inspect_evm_interface', { path: bytecode, encoding: 'hex' })
  if (process.platform === 'linux' && process.arch === 'x64') {
    assert.equal(evm.isError, false, JSON.stringify(evm))
    assert.match(JSON.stringify(evm.value), /sha256/)
  } else {
    assert.equal(evm.isError, true)
    assert.match(JSON.stringify(evm), /capability_unavailable/)
  }
  const cli = execFileSync(process.execPath, [path.join(repoRoot, 'node_modules/rea-agents/scripts/rea.mjs'), 'capabilities', '--format', 'json'], { encoding: 'utf8', env: { ...process.env, ...reverseEnvironment() } })
  assert.ok(JSON.parse(cli).capabilities)
  const managed = await s.call('mcp__rea__inspect_managed_artifact', { path: path.join(repoRoot, 'packages/redtrace-dsh/test/fixtures/rea-managed.bin') })
  assert.equal(managed.isError, false, JSON.stringify(managed))
  assert.match(JSON.stringify(managed.value), /rea-dotnet-static/)
  assert.match(JSON.stringify(managed.value), /il-only/)
  const members = await s.call('mcp__rea__inspect_managed_members', {})
  assert.equal(members.isError, false, JSON.stringify(members))
  assert.match(JSON.stringify(members.value), /Oracle|Answer/)
  await s.call('reverse_tools', { group: 'android' })
  const missing = await s.call('mcp__rea__inspect_jeb_client', {})
  assert.match(JSON.stringify(missing), /unavailable|not_available|not found|missing|not configured|dependency/i)
})

function writePortableTargets(cwd) {
  const pe = Buffer.alloc(1024)
  pe.write('MZ'); pe.writeUInt32LE(0x80, 0x3c); pe.write('PE\0\0', 0x80)
  pe.writeUInt16LE(0x8664, 0x84); pe.writeUInt16LE(1, 0x86); pe.writeUInt16LE(240, 0x94); pe.writeUInt16LE(0x22, 0x96)
  const o = 0x98
  pe.writeUInt16LE(0x20b, o); pe.writeUInt32LE(512, o + 4); pe.writeUInt32LE(0x1000, o + 16); pe.writeUInt32LE(0x1000, o + 20)
  pe.writeBigUInt64LE(0x140000000n, o + 24); pe.writeUInt32LE(0x1000, o + 32); pe.writeUInt32LE(512, o + 36)
  pe.writeUInt16LE(6, o + 40); pe.writeUInt16LE(6, o + 48); pe.writeUInt32LE(0x2000, o + 56); pe.writeUInt32LE(512, o + 60)
  pe.writeUInt16LE(3, o + 68); pe.writeUInt16LE(0x160, o + 70); pe.writeBigUInt64LE(0x100000n, o + 72); pe.writeBigUInt64LE(0x1000n, o + 80)
  pe.writeBigUInt64LE(0x100000n, o + 88); pe.writeBigUInt64LE(0x1000n, o + 96); pe.writeUInt32LE(16, o + 108)
  const h = o + 240
  pe.write('.text', h); pe.writeUInt32LE(6, h + 8); pe.writeUInt32LE(0x1000, h + 12); pe.writeUInt32LE(512, h + 16); pe.writeUInt32LE(512, h + 20); pe.writeUInt32LE(0x60000020, h + 36)
  pe.set([0xb8, 42, 0, 0, 0, 0xc3], 512)
  const elf = Buffer.alloc(512)
  elf.set([0x7f, 69, 76, 70, 2, 1, 1]); elf.writeUInt16LE(2, 16); elf.writeUInt16LE(62, 18); elf.writeUInt32LE(1, 20)
  elf.writeBigUInt64LE(0x400080n, 24); elf.writeBigUInt64LE(64n, 32); elf.writeUInt16LE(64, 52); elf.writeUInt16LE(56, 54); elf.writeUInt16LE(1, 56)
  elf.writeUInt32LE(1, 64); elf.writeUInt32LE(5, 68); elf.writeBigUInt64LE(0x400000n, 80); elf.writeBigUInt64LE(0x400000n, 88)
  elf.writeBigUInt64LE(512n, 96); elf.writeBigUInt64LE(512n, 104); elf.writeBigUInt64LE(4096n, 112); elf.set([0xb8, 42, 0, 0, 0, 0xc3], 128)
  const paths = [path.join(cwd, 'answer.exe'), path.join(cwd, 'answer.elf')]
  writeFileSync(paths[0], pe); writeFileSync(paths[1], elf)
  return paths
}

test('real Ghidra ELF/PE decompilation, same-Run reuse, cancellation and process cleanup', {
  timeout: 300000, skip: process.env.REDTRACE_REA_REAL_TESTS !== '1' || process.platform === 'win32',
}, async t => {
  assert.ok(existsSync(path.join(reverseEnvironment().GHIDRA_INSTALL_DIR ?? '', 'support/analyzeHeadless')), 'Ghidra must be deployed before real acceptance')
  const ctx = await host()
  t.after(() => ctx.fiber.dispose())
  let enabled = true
  const s = await session(ctx, id => id === 'redtrace-reverse' && enabled)
  t.after(async () => { await s.dispose(); rmSync(s.cwd, { recursive: true, force: true }) })
  const seen = new Map()
  const owned = () => {
    const rows = execFileSync('ps', ['-axo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n')
      .map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    const descendants = new Set([String(process.pid)])
    let changed = true
    while (changed) {
      changed = false
      for (const row of rows) if (descendants.has(row[2]) && !descendants.has(row[1])) { descendants.add(row[1]); changed = true }
    }
    const matches = rows.filter(row => /java|rea\.mjs/.test(row[3]) && (descendants.has(row[1]) || seen.get(row[1]) === row[3]))
    for (const row of matches) seen.set(row[1], row[3])
    return matches.map(row => `${row[1]} ${row[3]}`)
  }
  assert.equal(owned().length, 0, 'enabling does not launch an engine or MCP')
  await s.call('skill', { name: 'reverse-engineer-anything' })
  assert.equal(owned().filter(line => /java/.test(line)).length, 0)
  const targets = writePortableTargets(s.cwd)
  for (const target of targets) {
    const before = Date.now()
    const opened = await s.call('mcp__rea__open_binary', { path: target, provider_id: 'ghidra' })
    assert.equal(opened.isError, false, JSON.stringify(opened))
    assert.doesNotMatch(JSON.stringify(opened.value), /"status":"error"/)
    let processes = owned().filter(line => /java/.test(line)).map(line => line.trim().split(/\s/)[0])
    const procedure = target.endsWith('.exe') ? '0x140001000' : '0x400080'
    for (let i = 0; i < 2; i++) {
      const analyzed = await s.call('mcp__rea__procedure_pseudo_code', { procedure })
      assert.equal(analyzed.isError, false, JSON.stringify(analyzed))
      assert.match(JSON.stringify(analyzed.value), /42|0x2a/)
      const active = owned().filter(line => /java/.test(line)).map(line => line.trim().split(/\s/)[0])
      if (i === 0) processes = active
      assert.equal(active.length, 1, execFileSync('ps', ['-axo', 'pid,ppid,args'], { encoding: 'utf8' }).split('\n').filter(line => /java|rea.mjs/.test(line)).join('\n'))
      assert.deepEqual(active, processes)
    }
    t.diagnostic(JSON.stringify({ target: path.basename(target), startupAndTwoQueriesMs: Date.now() - before, ghidraProcesses: processes.length }))
    await s.call('mcp__rea__close_binary', {})
    assert.equal(owned().filter(line => /java/.test(line)).length, 0)
  }
  const abort = new AbortController()
  await s.call('mcp__rea__open_binary', { path: targets[0], provider_id: 'ghidra' })
  const pending = s.call('mcp__rea__procedure_pseudo_code', { procedure: '0x140001000' }, abort.signal)
  setTimeout(() => abort.abort(), 150)
  assert.equal((await pending).isError, true)
  enabled = false
  await s.refresh()
  for (let i = 0; owned().length && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(owned().length, 0, owned().join('\n'))
  assert.equal(readdirSync(path.join(s.cwd, '.rea')).some(n => n.startsWith('tmp-')), false)

  // Exercise the provider's own cold-start deadline, not a simulated timeout.
  const previous = process.env.REA_GHIDRA_STARTUP_TIMEOUT_MS
  process.env.REA_GHIDRA_STARTUP_TIMEOUT_MS = '1'
  enabled = true
  try { await s.refresh() }
  finally { if (previous === undefined) delete process.env.REA_GHIDRA_STARTUP_TIMEOUT_MS; else process.env.REA_GHIDRA_STARTUP_TIMEOUT_MS = previous }
  await s.call('skill', { name: 'reverse-engineer-anything' })
  await s.call('mcp__rea__open_binary', { path: targets[0], provider_id: 'ghidra' })
  const timedOut = await s.call('mcp__rea__procedure_pseudo_code', { procedure: '0x140001000' })
  assert.equal(timedOut.isError, true)
  assert.match(JSON.stringify(timedOut), /timeout|deadline/i)
  enabled = false
  await s.refresh()
  assert.equal(owned().length, 0)

  // Stopping the feature while a native request is running must cancel it and its engine.
  enabled = true
  await s.refresh()
  await s.call('skill', { name: 'reverse-engineer-anything' })
  await s.call('mcp__rea__open_binary', { path: targets[0], provider_id: 'ghidra' })
  const busy = s.call('mcp__rea__procedure_pseudo_code', { procedure: '0x140001000' })
  await new Promise(resolve => setTimeout(resolve, 200))
  owned()
  enabled = false
  await s.refresh()
  assert.equal((await busy).isError, true)
  for (let i = 0; owned().length && i < 30; i++) await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(owned().length, 0, owned().join('\n'))
  assert.equal(rea(s.schemas()).length, 0)
})
