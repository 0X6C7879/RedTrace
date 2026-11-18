import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { load, repoRoot } from '../lib/loader.js'
import { mountExecutionTools } from '../lib/execution-tools.js'
import { reverseEnvironment } from '../lib/reverse.js'

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

export async function session(ctx, available, type = 'soldier') {
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
  const scoped = await mountExecutionTools(scope.ctx, { cwd, sessionRoot: cwd, skillsDir: path.join(cwd, 'skills'),
    task: { type, executionProfile: 'direct' }, available,
    onRefresh: fn => { refresh = fn } })
  let id = 0
  return { cwd, agent, scope, scoped, refresh: () => refresh(), schemas: () => ctx.tools.schemas(agent),
    call: (name, args, signal = new AbortController().signal) => ctx.tools.execute({ calls: [{ type: 'tool-call', name, arguments: JSON.stringify(args), id: `test-${++id}` }], agent, signal }).then(batch => batch.results[0].result),
    dispose: async () => { await scope.dispose(); await carrier.dispose() },
  }
}

test('CLI-first Skill adaptation is hash-recorded and pinned references remain byte-identical', () => {
  const root = path.join(repoRoot, 'plugins/reverse')
  const lock = JSON.parse(readFileSync(path.join(root, 'upstream.json')))
  assert.equal(lock.version, '6.4.0')
  for (const [relative, digest] of Object.entries(lock.skillFiles)) {
    const file = readFileSync(path.join(root, 'skills', relative))
    assert.equal(createHash('sha256').update(file).digest('hex'), lock.redtraceOverrides?.[relative] ?? digest)
    assert.equal(createHash('sha256').update(readFileSync(path.join(repoRoot, 'node_modules/rea-agents/skills', relative))).digest('hex'),digest)
    if(!lock.redtraceOverrides?.[relative])assert.deepEqual(file, readFileSync(path.join(repoRoot, 'node_modules/rea-agents/skills', relative)))
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

test('REA Skill is CLI-only before/after loading; disabling revokes Skill without affecting native tools', {timeout:30000}, async t => {
 const ctx=await host();t.after(()=>ctx.fiber.dispose());let enabled=true
 const s=await session(ctx,id=>id==='redtrace-reverse'&&enabled)
 t.after(async()=>{await s.dispose();rmSync(s.cwd,{recursive:true,force:true})})
 for(let i=0;i<2;i++){assert.equal((await s.call('skill',{name:'reverse-engineer-anything'})).isError,false);assert.equal(rea(s.schemas()).length,0);assert(!existsSync(path.join(s.cwd,'.rea')))}
 assert.equal((await s.call('mcp__rea__binary_session',{})).isError,true)
 enabled=false;await s.refresh();assert(!(await s.scoped.get('skills').list({cwd:s.cwd,scope:s.agent})).some(x=>x.name==='reverse-engineer-anything'))
 assert(ctx.tools.get(process.platform==='win32'?'pwsh':'bash',s.agent));assert.equal(rea(s.schemas()).length,0)
 enabled=true;await s.refresh();assert.equal((await s.call('skill',{name:'reverse-engineer-anything'})).isError,false);assert.equal(rea(s.schemas()).length,0)
})

test('real REA CLI covers JavaScript, managed members and optional-provider boundaries without extra Schemas', { timeout: 90000 }, async t => {
  const ctx = await host(); t.after(() => ctx.fiber.dispose())
  const s = await session(ctx, id => id === 'redtrace-reverse')
  t.after(async () => { await s.dispose(); rmSync(s.cwd, { recursive: true, force: true }) })
  const source = path.join(s.cwd, 'app'); mkdirSync(source)
  writeFileSync(path.join(source, 'package.json'), JSON.stringify({ name: 'oracle', main: 'index.js' }))
  writeFileSync(path.join(source, 'index.js'), 'exports.answer = value => value + 42;\n')
  const cli = (...args) => execFileSync(process.execPath, [path.join(repoRoot, 'node_modules/rea-agents/scripts/rea.mjs'), ...args, '--format', 'json'], { encoding: 'utf8', env: { ...process.env, ...reverseEnvironment() }, cwd:s.cwd })
  assert.ok(JSON.parse(cli('capabilities')).capabilities)
  assert.match(cli('analyze-javascript-application', source), /evidence_id/)
  const target = path.join(repoRoot, 'packages/redtrace-dsh/test/fixtures/rea-managed.bin')
  const shell=await s.call(process.platform==='win32'?'pwsh':'bash',{description:'Inspect managed REA fixture',command:'rea inspect-managed-artifact "'+target+'" --format json'})
  assert.equal(shell.isError,false,JSON.stringify(shell));assert.match(JSON.stringify(shell),/rea-dotnet-static/)

  assert.match(cli('inspect-managed-artifact', target), /rea-dotnet-static/)
  assert.match(cli('inspect-managed-members', target), /Oracle|Answer/)
  const bytecode=path.join(s.cwd,'contract.hex');writeFileSync(bytecode,'600160005260206000f3')
  const optional=(...args)=>spawnSync(process.execPath,[path.join(repoRoot,'node_modules/rea-agents/scripts/rea.mjs'),...args,'--format','json'],{encoding:'utf8',env:{...process.env,...reverseEnvironment()},cwd:s.cwd})
  const evm=optional('inspect-evm-interface',bytecode,'hex')
  assert.match(evm.stdout,process.platform==='linux'&&process.arch==='x64'?/sha256/:/capability_unavailable/)
  const jeb=optional('inspect-jeb-client');assert.match(jeb.stdout,/unavailable|not_available|not found|missing|not configured|dependency/i)
  t.diagnostic(JSON.stringify({evmExit:evm.status,jebExit:jeb.status}))
  assert.equal(rea(s.schemas()).length, 0, 'CLI analysis never loads MCP Schemas')
  await s.call('skill', {name:'reverse-engineer-anything'})
  assert.equal(rea(s.schemas()).length, 0)
  assert.equal(ctx.tools.get('mcp__rea__inspect_managed_members', s.agent), undefined)
})
