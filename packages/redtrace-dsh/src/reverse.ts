/** REA lifecycle only; Skill discovery and every analysis call remain DSH-native. */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { load, mount, repoRoot } from './loader.js'
import type { CordisFiber } from './types.js'

export const name = 'redtrace-reverse-session'
export const inject = ['tools', 'skills', 'shellEnv', 'systemPrompt']
export const REA_VERSION = '6.4.0'
export const REA_PREFIX = 'mcp__rea__'
const VENDOR = 'vendor/deepseek-harness/packages'
const INLINE_BYTES = 8192

export async function retainedReverseContracts(): Promise<any[]> {
  const base = pathToFileURL(path.join(repoRoot, 'node_modules/rea-agents/dist/'))
  const { TOOL_CONTRACTS } = await import(new URL('contracts/toolContracts.js', base).href)
  const { MCP_TOOLS_WITHOUT_DEDICATED_CLI } = await import(new URL('cliCommandNames.js', base).href)
  // Path-based analysis uses CLI; these operations require the live Program,
  // Hopper navigation/annotations, or this server's retained Evidence context.
  const stateful = new Set(['open_binary','close_binary','binary_session',
    'list_documents','goto_address','next_address','prev_address','list_bookmarks',
    'set_address_name','set_addresses_names','set_bookmark','unset_bookmark','set_comment','set_inline_comment',
    'get_navigation_context','inspect_address_context',
    'export_evidence_bundle','import_evidence_bundle','get_evidence_bundle',
    'compare_artifacts','compare_functions','find_changed_behavior','build_call_path',
    'correlate_static_and_runtime','verify_reconstruction','list_unknowns','record_unknown',
    'update_unknown','verify_unknown_resolution'])
  return TOOL_CONTRACTS.filter((tool: any) => stateful.has(tool.name) && MCP_TOOLS_WITHOUT_DEDICATED_CLI.includes(tool.name))
}

/** Use REA's own wire-schema projection without starting an MCP or analysis process. */
export async function reverseToolSchemas(): Promise<any[]> {
  const base = pathToFileURL(path.join(repoRoot, 'node_modules/rea-agents/dist/'))
  const { toolInputSchemaWithMetadata } = await import(new URL('contracts/toolSchemaMetadata.js', base).href)
  const { compactAdvertisedInputSchema } = await import(new URL('contracts/compactInputSchema.js', base).href)
  const { COMPACT_INPUT_SCHEMA_BUDGET_BYTES } = await import(new URL('config/mcpInputSchemaProfile.js', base).href)
  return (await retainedReverseContracts()).map(tool => {
    const schema = toolInputSchemaWithMetadata(tool)['~standard'].jsonSchema.input({ target: 'draft-2020-12' })
    return { name: REA_PREFIX + tool.name, description: tool.description, redtrace: true,
      parameters: reverseEnvironment().REA_MCP_INPUT_SCHEMA_PROFILE === 'compact'
        ? compactAdvertisedInputSchema(schema, COMPACT_INPUT_SCHEMA_BUDGET_BYTES).schema : schema }
  })
}

/** Preserve configured engines; detect an installed Homebrew engine without installing at run time. */
export function reverseEnvironment(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const result: Record<string, string> = { REA_MCP_INPUT_SCHEMA_PROFILE: 'compact' }
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && /^(REA_|GHIDRA_INSTALL_DIR$|JAVA_HOME$|HOPPER_)/.test(key)) result[key] = value
  }
  if (!result.GHIDRA_INSTALL_DIR) {
    const root = [env.GHIDRA_HOME, '/opt/homebrew/opt/ghidra/libexec', '/usr/local/opt/ghidra/libexec']
      .find(dir => dir && existsSync(path.join(dir, 'support/analyzeHeadless')))
    if (root) result.GHIDRA_INSTALL_DIR = root
  }
  if (!result.JAVA_HOME) {
    const root = ['/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home', '/usr/local/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home']
      .find(dir => existsSync(path.join(dir, 'bin/java')))
    if (root) result.JAVA_HOME = root
  }
  return result
}

/** Context carries native DSH services loaded dynamically by the adapter. */
export async function apply(ctx: any, config: { cwd: string; toolEnabled?: (name: string) => boolean }): Promise<void> {
  const bin = path.join(repoRoot, 'node_modules/.bin')
  if (!(process.env.PATH ?? '').split(path.delimiter).includes(bin)) process.env.PATH = bin + path.delimiter + (process.env.PATH ?? '')
  const cliCall = 'rea'
  const cli = path.join(repoRoot, 'node_modules/rea-agents/scripts/rea.mjs')
  await mount(ctx, `${VENDOR}/skill/skill-filesystem/lib/index.js`, {
    providerName: 'redtrace-reverse', includeDefaultRoots: false,
    customSkillDirs: [path.join(repoRoot, 'plugins/reverse/skills')], watch: false,
  })
  ctx.shellEnv.register({ name: 'redtrace-reverse', variables: {
    DSH_REA_CLI: { description: `Pinned REA CLI; invoke ${cliCall} through the native shell.` },
  }, resolve: () => ({ DSH_REA_CLI: cli }) })

  ctx.systemPrompt.section({ name: 'redtrace:rea-cli', order: 3, interpolate: false,
    text: `REA: prefer ${cliCall} --help and path-based CLI commands. Loading the reverse-engineer-anything Skill retains only fixed stateful MCP operations for a shared native Program. No CLI script is a Tool Schema.` })

  let stopped = false, starting: Promise<void> | undefined, mcp: CordisFiber | undefined
  let temp: string | undefined, evidence: string | undefined
  let privateScope: { ctx: any; dispose(): Promise<void> } | undefined
  let nativeReady = false
  const running = new Set<AbortController>()
  const categories = new Map<string, string>()
  const env = reverseEnvironment()
  const startup = Number(env.REA_GHIDRA_STARTUP_TIMEOUT_MS ?? 330000)
  const openTimeout = Number.isSafeInteger(startup) && startup > 0 ? Math.min(startup + 90000, 2147483647) : 420000
  const start = async () => {
    if (stopped) throw new Error('redtrace-reverse is stopped')
    if (!existsSync(cli)) throw new Error('rea_unavailable: run npm ci during deployment (no runtime install)')
    const { default: pkg } = await import(pathToFileURL(cli.replace(/scripts[\\/]rea.mjs$/, 'package.json')).href, { with: { type: 'json' } })
    if (pkg.version !== REA_VERSION) throw new Error(`rea_version_mismatch: expected ${REA_VERSION}, found ${pkg.version}`)
    const root = path.join(config.cwd, '.rea')
    await mkdir(root, { recursive: true, mode: 0o700 })
    evidence = await mkdtemp(path.join(root, 'run-'))
    temp = await mkdtemp(path.join(root, 'tmp-'))
    // Native MCP owns the transport, registrations, cancellation and REA EOF shutdown.
    const { createScope } = await load(`${VENDOR}/core/scope/lib/index.js`)
    privateScope = createScope(ctx, {})
    mcp = await mount(privateScope!.ctx, `${VENDOR}/mcp/mcp-client/lib/index.js`, {
      transport: 'stdio', serverName: 'rea', command: process.execPath, args: [cli, 'mcp'], cwd: config.cwd,
      env: { ...env, TMPDIR: temp, TMP: temp, TEMP: temp }, toolCallTimeoutMs: openTimeout,
      failOnStartupError: true, reconnect: { enabled: false },
    })
    const { TOOL_CONTRACTS } = await import(pathToFileURL(path.join(repoRoot, 'node_modules/rea-agents/dist/contracts/toolContracts.js')).href)
    for (const contract of TOOL_CONTRACTS) categories.set(contract.name, contract.kind)
    const retained = new Set((await retainedReverseContracts()).map(tool => tool.name))
    const { scopeOf } = await load(`${VENDOR}/core/scope/lib/index.js`)
    const key = scopeOf(privateScope!.ctx)
    for (const schema of ctx.tools.schemas(key)) {
      if (!schema.name.startsWith(REA_PREFIX) || !retained.has(schema.name.slice(REA_PREFIX.length))) continue
      ctx.tools.register({ ...ctx.tools.get(schema.name, key), redtrace: true },
        config.toolEnabled ? { when: () => config.toolEnabled!(schema.name) } : undefined)
    }
    if (stopped) { await mcp?.dispose(); mcp = undefined; throw new Error('redtrace-reverse stopped during startup') }
  }
  const ensure = () => starting ??= start().catch(async error => {
    starting = undefined
    await privateScope?.dispose()
    privateScope = undefined
    if (temp) await rm(temp, { recursive: true, force: true })
    throw error
  })

  ctx.tools.guard((exec: any) => stopped && exec.name.startsWith(REA_PREFIX) ? 'redtrace-reverse is stopped' : undefined)
  ctx.on('tools/execute', async (exec: any, next: () => Promise<any>) => {
    if (!exec.name.startsWith(REA_PREFIX)) return next()
    const controller = new AbortController()
    running.add(controller)
    const raw = exec.name.slice(REA_PREFIX.length)
    const native = ['official-proxy', 'enhanced'].includes(categories.get(raw) ?? '')
    const requested = exec.arguments?.analysis_timeout_ms ?? exec.arguments?.timeout_ms
    const budget = Number.isSafeInteger(requested) && requested > 0 ? Math.min(requested + 90000, 2147483647)
      : native && !nativeReady || raw === 'open_binary' || raw === 'analyze_javascript_application' ? openTimeout : 120000
    exec.signal = AbortSignal.any([exec.signal, controller.signal, AbortSignal.timeout(budget)])
    try {
      const result = await next()
      if (!result.isError) {
        if (raw === 'open_binary' || raw === 'close_binary') nativeReady = false
        else if (native) nativeReady = true
      }
      return result
    } finally { running.delete(controller) }
  })
  ctx.on('tools/post-execute', async (exec: any, result: any, next: () => Promise<any>) => {
    const decision = await next()
    if (decision.kind !== 'accept' || result.isError) return decision
    if (exec.name === 'skill' && exec.arguments?.name === 'reverse-engineer-anything') {
      let notice: string
      try {
        await ensure()
        notice = `Prefer the pinned REA CLI through Shell for path-based analysis; use --help for exact commands. Only fixed stateful MCP operations remain registered for this Run; there is no tool-group selector. Use bounded output, CLI inspect-analysis-view and Evidence IDs. CLI: ${cliCall}. Export evidence before finishing; validate observations before submitting FGS Fact/Finding. On provider failure try supported alternatives once, then record the blocker. CTF fallback knowledge remains in ctf-reverse; legacy engines are retained where replacement is unverified.`
      } catch (error) {
        notice = JSON.stringify({ status: 'unavailable', component: 'rea_mcp', reason: String(error), fallback: 'Use the pinned CLI or retained CTF tools; do not install interactively or retry without resolving the blocker.' })
      }
      return { ...decision, content: [...decision.content ?? result.content, { type: 'text', text: notice }] }
    }
    if (!exec.name.startsWith(REA_PREFIX) || !evidence || Object.hasOwn(decision, 'value')) return decision
    const content = decision.content ?? result.content
    const text = content.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
    if (Buffer.byteLength(text) <= INLINE_BYTES) return decision
    // Only oversized projections are retained; identical results share one content-addressed file.
    const sha = createHash('sha256').update(text).digest('hex')
    const file = path.join(evidence, `${sha}.txt`)
    await writeFile(file, text, { mode: 0o600, flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
    return { ...decision, content: [{ type: 'text', text: `${text.slice(0, 1500)}\n[Incomplete preview; ${Buffer.byteLength(text)} bytes retained at ${file}; SHA256=${sha}. Read locally or use inspect_analysis_view with the returned Evidence ID. Do not repeat the producer.]` }, ...content.filter((block: any) => block.type !== 'text')] }
  })

  ctx.effect(() => async () => {
    stopped = true
    for (const controller of running) controller.abort(new Error('redtrace-reverse stopped'))
    if (starting) await starting.catch(() => {})
    try { await privateScope?.dispose() } finally { if (temp) await rm(temp, { recursive: true, force: true }) }
  }, 'redtrace-reverse cleanup')
}
