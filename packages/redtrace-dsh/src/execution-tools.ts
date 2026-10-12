/**
 * The execution toolchain mounted into every Execute agent's scoped context:
 * shell, filesystem, skills, and (for the isolated execution profile) the
 * sandbox stack — restricted to the assigned workspace — plus the DSH
 * native capability stacks (web, background jobs, terminal, file search,
 * spill, guards, LSP, PTC presentation) gated by the plugin manager.
 * Shared by every Execute vocabulary the engine host dispatches.
 * @module redtrace-execution-tools
 */

import { accessSync, constants, existsSync } from 'node:fs'
import path from 'node:path'
import type { CordisFiber, RuntimeTask, ScopedContext } from './types.js'
import { mount } from './loader.js'
import { TASK_PLUGINS } from './task-plugins.js'

const VENDOR = 'vendor/deepseek-harness/packages'

/** Engine API-key fields of the free web-search plugin, mapped to the
 * environment names RedTrace serves them under (redtrace.yaml common_env,
 * hot-reloaded into the process environment). Read at every session mount so
 * key changes reach new sessions without a restart. */
const WEB_SEARCH_FREE_KEYS: Record<string, string> = {
  tinyfishApiKey: 'TINYFISH_API_KEY',
  anysearchApiKey: 'ANYSEARCH_API_KEY',
  exaApiKey: 'EXA_API_KEY',
  tavilyApiKey: 'TAVILY_API_KEY',
  firecrawlApiKey: 'FIRECRAWL_API_KEY',
  braveApiKey: 'BRAVE_API_KEY',
  serpapiApiKey: 'SERPAPI_API_KEY',
  jinaApiKey: 'JINA_API_KEY',
}

/** The free web-search plugin's mount config: every engine key currently in
 * the environment. With none set the provider reports its structured
 * "no providers configured" error at call time. */
function webSearchFreeConfig(): Record<string, string> {
  const config: Record<string, string> = {}
  for (const [field, envName] of Object.entries(WEB_SEARCH_FREE_KEYS)) {
    const value = process.env[envName]
    if (typeof value === 'string' && value.trim() !== '') config[field] = value
  }
  return config
}

export interface ExecutionToolsConfig {
  task: RuntimeTask
  cwd: string
  skillsDir: string
  /** Repo-local security-asset root (`tools/`); when populated its map is
   * injected as a system-prompt section so agents use the local wordlists,
   * payload libraries, and target-upload tunnel binaries instead of
   * re-downloading from the network. */
  toolsDir?: string
  /** Whether a plugin-manager catalog entry is running; gates the DSH native
   * capability stacks mounted below the shell/fs/skill baseline. */
  available?: (id: string) => boolean
  contextualAttempts?: boolean
  onRefresh?: (refresh: () => Promise<void>) => void
}

/** Default language servers for the LSP stack: the languages security work
 * most often audits. Missing binaries filter the server out at mount time. */
const LSP_SERVERS: Record<string, { command: string; args: string[]; extensionToLanguage: Record<string, string> }> = {
  typescript: {
    command: 'typescript-language-server',
    args: ['--stdio'],
    extensionToLanguage: { ts: 'typescript', tsx: 'typescriptreact', js: 'javascript', jsx: 'javascriptreact' },
  },
  python: {
    command: 'pyright-langserver',
    args: ['--stdio'],
    extensionToLanguage: { py: 'python', pyi: 'python' },
  },
  clangd: {
    command: 'clangd',
    args: [],
    extensionToLanguage: { c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', cxx: 'cpp', hpp: 'cpp' },
  },
}

/** Whether a bare command resolves on this process's PATH. The LSP backend
 * resolves every server executable at mount time, so a missing binary must
 * filter out here instead of failing the whole session setup. */
function commandOnPath(command: string): boolean {
  // Windows PATH lookups resolve PATHEXT suffixes (.CMD/.EXE/...); probe each
  // candidate exactly like shell resolution does.
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')]
    : ['']
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir === '') continue
    for (const ext of extensions) {
      try {
        accessSync(path.join(dir, command + ext), constants.X_OK)
        return true
      } catch {
        // keep scanning
      }
    }
  }
  return false
}

/** The language servers actually installed on this host: the LSP stack mounts
 * only when at least one of the defaults resolves. */
function availableLspServers(): Record<string, { command: string; args: string[]; extensionToLanguage: Record<string, string> }> {
  const servers: Record<string, { command: string; args: string[]; extensionToLanguage: Record<string, string> }> = {}
  for (const [id, server] of Object.entries(LSP_SERVERS)) {
    if (commandOnPath(server.command)) servers[id] = server
  }
  return servers
}

/** The local security-asset map: wordlists, payload libraries, PoC references,
 * and tunnel binaries meant to be uploaded to target machines (not local PATH
 * tools). Only asset groups present on disk are listed; an empty tools
 * directory yields no section at all. */
export function toolsSectionText(toolsDir: string): string {
  const lines: string[] = []
  const group = (sub: string, variable: string, text: string) => {
    const directory = process.env[variable] ?? path.join(toolsDir, sub)
    if (existsSync(directory)) lines.push(`${text}：$${variable}（${directory}）`)
  }
  group('wordlists', 'REDTRACE_WORDLISTS_DIR', '字典 SecLists')
  group('payloads', 'REDTRACE_PAYLOADS_DIR', 'Payload 库 PayloadsAllTheThings')
  group('poc', 'REDTRACE_POC_DIR', 'PoC 参考 Vulhub')
  group('bin', 'REDTRACE_TOOLS_BIN', '靶机隧道文件（按目标 OS/arch 选择上传，非本机工具）')
  if (!lines.length) return ''
  return `离线安全资产，优先复用：\n${lines.join('\n')}`
}

/** The existing filesystem, shell, Skill and isolation stack, shared by every
 * Execute agent regardless of its declared capabilities, followed by the
 * plugin-gated DSH native capability stacks. Services mounted per session
 * are isolated first: two concurrent Execute agents each publishing e.g.
 * `jobs` would otherwise collide in the process-global service store. */
export async function mountExecutionTools(scoped: ScopedContext, config: ExecutionToolsConfig): Promise<ScopedContext> {
  const available = config.available ?? (() => false)
  const active = new Map<string, CordisFiber[]>()
  const jobs = available('redtrace-jobs')
  const services = ['shell', 'shellEnv', 'fs', 'skills', 'sandbox', 'sandboxPolicy', 'approval', 'jobs']
  for (const service of services) {
    scoped = scoped.isolate(service)
  }
  scoped.systemPrompt.section({
    name: 'redtrace:workspace',
    order: 1,
    interpolate: false,
    text: `任务产物统一保存至 ${config.cwd}，不随交互 Shell 或工作目录切换改变。`,
  })
  if (config.toolsDir) {
    const toolsText = toolsSectionText(config.toolsDir)
    if (toolsText) scoped.systemPrompt.section({ name: 'redtrace:tools', order: 2, interpolate: false, text: toolsText })
  }
  if (config.task.executionProfile === 'isolated') {
    await mount(scoped, `${VENDOR}/sandbox/sandbox-local/lib/index.js`)
    await mount(scoped, `${VENDOR}/sandbox/sandbox-policy/lib/index.js`, { mode: 'workspace-write', workspaceRoot: config.cwd })
    await mount(scoped, process.platform === 'win32'
      ? `${VENDOR}/shell/pwsh-sandbox/lib/index.js`
      : `${VENDOR}/shell/bash-sandbox/lib/index.js`)
    await mount(scoped, `${VENDOR}/interaction/user-approval/lib/index.js`, { policy: 'never' })
    await mount(scoped, `${VENDOR}/fs/fs-sandbox/lib/index.js`)
  } else {
    await mount(scoped, `${VENDOR}/sandbox/sandbox-policy/lib/index.js`, { mode: 'danger-full-access', workspaceRoot: config.cwd })
    await mount(scoped, process.platform === 'win32'
      ? `${VENDOR}/shell/pwsh-local/lib/index.js`
      : `${VENDOR}/shell/bash-local/lib/index.js`, { cwd: config.cwd })
    await mount(scoped, `${VENDOR}/fs/fs-local/lib/index.js`, { cwd: config.cwd })
  }
  if (jobs) active.set('redtrace-jobs', [await mount(scoped, `${VENDOR}/jobs/jobs-local/lib/index.js`)])
  await mount(scoped, `${VENDOR}/shell/shell-env/lib/index.js`)
  const shellTool = process.platform === 'win32'
    ? `${VENDOR}/shell/tool-pwsh/lib/index.js`
    : `${VENDOR}/shell/tool-bash/lib/index.js`
  let shellFiber = await mount(scoped, shellTool, { enableRunInBackground: jobs })
  let background = jobs
  await mount(scoped, `${VENDOR}/fs/fs-observation-policy/lib/index.js`)
  await mount(scoped, `${VENDOR}/fs/tool-fs/lib/index.js`)
  await mount(scoped, `${VENDOR}/skill/skill/lib/index.js`)
  await mount(scoped, `${VENDOR}/skill/skill-filesystem/lib/index.js`, {
    includeDefaultRoots: false,
    customSkillDirs: [config.skillsDir],
  })
  await mount(scoped, `${VENDOR}/skill/tool-skill/lib/index.js`)
  if (jobs) active.get('redtrace-jobs')!.push(await mount(scoped, `${VENDOR}/jobs/tool-jobs/lib/index.js`))

  // Optional fibers belong to this Agent scope and can be changed mid-session.
  type Use = (scope: ScopedContext, module: string, options?: Record<string, any>) => Promise<void>
  const install = async (id: string, add: (use: Use) => Promise<void>) => {
    if (active.has(id)) return
    const fibers: CordisFiber[] = []
    const use: Use = async (scope, module, options) => { fibers.push(await mount(scope, module, options)) }
    try { await add(use); active.set(id, fibers) }
    catch (error) { for (const fiber of fibers.reverse()) await fiber.dispose(); throw error }
  }
  const remove = async (id: string) => {
    const fibers = active.get(id)
    if (!fibers) return
    active.delete(id)
    for (const fiber of fibers.reverse()) await fiber.dispose()
  }
  const setBackground = async (enabled: boolean) => {
    if (background === enabled) return
    await shellFiber.dispose()
    try { shellFiber = await mount(scoped, shellTool, { enableRunInBackground: enabled }); background = enabled }
    catch (error) { shellFiber = await mount(scoped, shellTool, { enableRunInBackground: background }); throw error }
  }
  const stacks: Array<[string, (use: Use) => Promise<void>]> = [
    ...TASK_PLUGINS.map(entry => [entry.id, (use: Use) => use(scoped, entry.modulePath, { cwd: config.cwd })] as [string, (use: Use) => Promise<void>]),
    ['redtrace-web', async use => {
      const scope = scoped.isolate('web').isolate('settings')
      await use(scope, `${VENDOR}/web/web/lib/index.js`, { searchProvider: 'web-search-free', fetchProvider: 'http' })
      await use(scope, 'packages/redtrace-engine/node_modules/dsh-web-search-free/dist/index.js', webSearchFreeConfig())
      await use(scope, `${VENDOR}/web/web-fetch-http/lib/index.js`)
      await use(scope, `${VENDOR}/web/tool-web/lib/index.js`, { fetch: true, searchTimeoutMs: 60000 })
    }],
    ['redtrace-fs-search', use => use(scoped, `${VENDOR}/fs/tool-fs-search/lib/index.js`, { sampleOverCapGlobResults: false })],
    ['redtrace-terminal', async use => {
      const scope = scoped.isolate('terminals')
      await use(scope, `${VENDOR}/terminal/terminal/lib/index.js`)
      await use(scope, `${VENDOR}/terminal/terminal-bash/lib/index.js`)
      // DSH 0.2.1-alpha.2 moved the interactive terminal tool under experimental/.
      await use(scope, `${VENDOR}/experimental/tool-terminal/lib/index.js`)
    }],
    ['redtrace-spill', async use => {
      const scope = scoped.isolate('spillStore')
      await use(scope, `${VENDOR}/spill/spill-local/lib/index.js`)
      await use(scope, `${VENDOR}/spill/spill-policy/lib/index.js`, { maxInlineBytes: 8192 })
    }],
    ['redtrace-tool-timeout', use => use(scoped, `${VENDOR}/guard/timeout-policy/lib/index.js`)],
    ['redtrace-repeat-reminder', use => config.contextualAttempts ? Promise.resolve() : use(scoped, `${VENDOR}/guard/repeat-tool-reminder/lib/index.js`, { thresholds: [3, 5, 8], argumentsPreviewChars: 500 })],
    ['redtrace-lsp', async use => {
      const servers = availableLspServers()
      if (!Object.keys(servers).length) return
      const scope = scoped.isolate('lsp')
      await use(scope, `${VENDOR}/lsp/lsp/lib/index.js`)
      await use(scope, `${VENDOR}/lsp/lsp-stdio/lib/index.js`, { servers })
      await use(scope, `${VENDOR}/lsp/tool-lsp/lib/index.js`)
    }],
    // DSH 0.2.1-alpha.2 removed the `both` presentation: a PTC session's
    // direct view is `run_code` only, and the program dispatches every other
    // mounted tool from inside the code (native scopes never see run_code).
    ['redtrace-ptc', use => use(scoped, `${VENDOR}/core/agent-tool-presentation/lib/index.js`, { mode: 'ptc' })],
  ]
  let last = Promise.resolve()
  const refresh = () => {
    const next = last.catch(() => {}).then(async () => {
      if (available('redtrace-jobs')) {
        await install('redtrace-jobs', async use => {
          await use(scoped, `${VENDOR}/jobs/jobs-local/lib/index.js`)
          await use(scoped, `${VENDOR}/jobs/tool-jobs/lib/index.js`)
        })
        await setBackground(true)
      } else {
        await setBackground(false)
        await remove('redtrace-jobs')
      }
      for (const [id, add] of stacks) {
        if (available(id)) await install(id, add)
        else await remove(id)
      }
    })
    last = next
    return next
  }
  config.onRefresh?.(refresh)
  await refresh()
  return scoped
}
