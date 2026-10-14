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
export async function apply(ctx: any, config: { cwd: string }): Promise<void> {
  const cliCall = process.platform === 'win32' ? 'node $env:DSH_REA_CLI' : 'node "$DSH_REA_CLI"'
  const cli = path.join(repoRoot, 'node_modules/rea-agents/scripts/rea.mjs')
  await mount(ctx, `${VENDOR}/skill/skill-filesystem/lib/index.js`, {
    providerName: 'redtrace-reverse', includeDefaultRoots: false,
    customSkillDirs: [path.join(repoRoot, 'plugins/reverse/skills')], watch: false,
  })
  ctx.shellEnv.register({ name: 'redtrace-reverse', variables: {
    DSH_REA_CLI: { description: `Pinned REA CLI; invoke ${cliCall} through the native shell.` },
  }, resolve: () => ({ DSH_REA_CLI: cli }) })

  let stopped = false, starting: Promise<void> | undefined, mcp: CordisFiber | undefined
  let temp: string | undefined, evidence: string | undefined
  let privateScope: { ctx: any; dispose(): Promise<void> } | undefined
  let nativeReady = false
  const running = new Set<AbortController>()
  const exposed = new Set<string>()
  const definitions = new Map<string, any>()
  const categories = new Map<string, string>()
  const groups: Record<string, string[]> = {
    native: ['official-proxy', 'enhanced', 'native-provider'],
    android: ['android-provider', 'apktool-provider', 'jeb-provider', 'adb-provider'],
    javascript: ['browser-provider', 'electron-provider', 'runtime-provider'],
    managed: ['managed-provider'], artifact: ['artifact-provider'], firmware: ['firmware-provider'],
    evidence: ['session', 'application'], all: [],
  }
  const expose = (names: string[]) => {
    for (const raw of names) {
      if (exposed.has(raw)) continue
      const definition = definitions.get(raw)
      if (!definition) continue
      ctx.tools.register(definition)
      exposed.add(raw)
    }
  }
  const expand = (group: string) => {
    if (!Object.hasOwn(groups, group)) throw new Error('unknown REA tool group')
    expose([...definitions.keys()].filter(raw => group === 'all' || groups[group].includes(categories.get(raw) ?? '')))
  }
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
    const { scopeOf } = await load(`${VENDOR}/core/scope/lib/index.js`)
    const key = scopeOf(privateScope!.ctx)
    for (const schema of ctx.tools.schemas(key)) {
      if (schema.name.startsWith(REA_PREFIX)) definitions.set(schema.name.slice(REA_PREFIX.length), ctx.tools.get(schema.name, key))
    }
    expose(['open_binary', 'close_binary', 'binary_session', 'inspect_analysis_view', 'export_evidence_bundle',
      'analyze_javascript_application', 'inspect_android_package', 'inspect_managed_artifact', 'inspect_firmware_regions',
      'inspect_evm_interface', 'inspect_binary_layout', 'inspect_artifact', 'list_browser_targets', 'list_electron_targets'])
    ctx.tools.register({ name: 'reverse_tools', description: 'Expand this Run’s REA native tool schemas by capability group. Stable additive sets; all makes every official tool accessible. No analysis forwarding.',
      parameters: { type: 'object', additionalProperties: false, properties: { group: { type: 'string', enum: Object.keys(groups) } }, required: ['group'] },
      output: { schema: { type: 'object', additionalProperties: true }, render: (_: unknown, value: any) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args: any) {
        if (stopped) throw new Error('redtrace-reverse is stopped')
        expand(args.group)
        return { group: args.group, visible: exposed.size, tools: [...exposed] }
      },
    })
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
  const entryGroups: Record<string, string> = {
    open_binary: 'native', analyze_javascript_application: 'javascript', inspect_android_package: 'android',
    inspect_managed_artifact: 'managed', inspect_firmware_regions: 'firmware', inspect_evm_interface: 'artifact',
    inspect_binary_layout: 'native', inspect_artifact: 'artifact', list_browser_targets: 'javascript', list_electron_targets: 'javascript',
  }
  ctx.on('tools/pre-execute', async (exec: any, next: () => Promise<any>) => {
    if (exec.name.startsWith(REA_PREFIX) && !stopped) {
      const group = entryGroups[exec.name.slice(REA_PREFIX.length)]
      if (group) expand(group)
    }
    return next()
  })
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
        notice = `REA MCP connected for this Run. Use native mcp__rea__ tools directly; reverse_tools expands capability groups (all exposes the complete catalog). Target entry tools automatically expand their group. Prefer detail: summary, inspect_analysis_view and Evidence IDs. CLI: ${cliCall}. Export evidence before finishing; validate observations before submitting FGS Fact/Finding. On provider failure try supported alternatives once, then record the blocker. CTF fallback knowledge remains in ctf-reverse; legacy engines are retained where replacement is unverified.`
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
