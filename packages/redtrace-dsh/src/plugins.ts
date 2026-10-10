/**
 * RedTrace Plugin Manager plugin: the "everything is a plugin" control plane.
 * Owns the plugin catalog (kernel infra entries from the Cordis profile, the
 * RedTrace feature plugins, the task presets, and user-added plugins), the
 * persistent manifest, the runtime lifecycle — fibers are mounted and disposed
 * live, no process restart — and the /__redtrace/plugins HTTP API behind the
 * Web UI plugins page.
 *
 * Kernel entries are mounted by the Cordis profile and shown read-only; the
 * manager itself mounts every RedTrace plugin, so start/stop survives restart
 * through the manifest.
 * @module redtrace-plugins
 */

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { CordisFiber, RuntimeConfig, RuntimeContext, TaskType } from './types.js'
import { load, repoRoot } from './loader.js'
import { state } from './state.js'
import * as core from './core.js'
import * as domain from './domain.js'
import * as scheduler from './scheduler.js'
import * as webshell from './webshell.js'
import * as c2 from './c2.js'
import * as credentials from './credentials.js'
import * as attachment from './attachment.js'
import * as fileReferences from './file-references.js'
import * as codeRuntime from './code-runtime.js'

export const name = 'redtrace-plugins'
export const inject = ['webServer']

export type PluginCategory = 'kernel' | 'core' | 'feature' | 'preset' | 'user'
export type PluginStatus = 'running' | 'pending' | 'stopped' | 'error'
export type PluginSource = 'kernel' | 'builtin' | 'user'

/** A plugin the manager knows about but never mounts itself (profile-owned). */
interface KernelEntry {
  id: string
  label: string
  description: string
  intro: string
}

/** A RedTrace plugin the manager mounts as a child fiber, or a session-scoped
 * DSH native capability the execution toolchain mounts into each Execute
 * agent while its catalog entry runs (no host-plane module of its own). */
interface ManagedEntry {
  id: string
  label: string
  description: string
  intro: string
  category: 'core' | 'feature'
  /** Host-plane Cordis plugin module; omitted for session-scoped capabilities. */
  module?: unknown
  /** Module path shown in the UI. */
  modulePath: string
  /** Receive the full RuntimeConfig (domain and scheduler need it). */
  needsRuntimeConfig?: boolean
  /** Stopping this plugin removes the management plane itself. */
  protectStop?: boolean
  /** Boots stopped unless the manifest's enabled list names it. */
  defaultOff?: boolean
}

/** A task preset: enabled/disabled gates dispatch, the scheduler mounts it per agent. */
interface PresetEntry {
  id: string
  label: string
  description: string
  intro: string
  category: 'preset'
  preset: TaskType
}

/** A plugin added at runtime through the API; module path is repo-relative. */
export interface UserEntry {
  id: string
  label?: string
  description?: string
  module: string
  config?: Record<string, unknown>
  enabled?: boolean
}

export interface PluginManifest {
  version: 1
  /** Ids of catalog plugins that must stay unmounted at boot. */
  disabled?: string[]
  /** Ids of default-off catalog plugins the user opted into. */
  enabled?: string[]
  user?: UserEntry[]
}

export interface PluginView {
  id: string
  label: string
  description: string
  /** The longer introduction shown in the detail popover. */
  intro: string | null
  category: PluginCategory
  source: PluginSource
  status: PluginStatus
  module: string | null
  config: Record<string, unknown> | null
  canStop: boolean
  canUninstall: boolean
  error: string | null
}

const KERNEL: readonly KernelEntry[] = [
  {
    id: 'web-server', label: 'Web Server', description: 'HTTP 服务与 API 反代入口',
    intro: '内置 HTTP 服务,托管 Web UI 的静态资源,并把未匹配的请求反代给后端 API。插件管理接口也注册在这台服务上。',
  },
  {
    id: 'llm-deepseek', label: 'LLM DeepSeek', description: 'DeepSeek 模型适配器',
    intro: 'DeepSeek 官方 API 的模型适配层,为 DeepSeek 系列模型提供统一调用入口。',
  },
  {
    id: 'llm-pi-ai', label: 'LLM pi-ai', description: '多 Provider 模型适配层',
    intro: '多 Provider 模型适配层。Worker 的 provider/model 路由在这里解析,Provider 配置变更实时生效。',
  },
  {
    id: 'token-meter', label: 'Token Meter', description: 'Token 计量',
    intro: 'Token 计量服务,统计各会话与任务的模型调用消耗。',
  },
  {
    id: 'compaction-basic', label: 'Compaction Basic', description: '基础上下文压缩',
    intro: '基础上下文压缩。长会话超出预算时归纳早期消息,让上下文保持在可用范围内。',
  },
  {
    id: 'compaction-tool-result-pruner', label: 'Compaction Tool Result Pruner', description: '工具结果裁剪压缩',
    intro: '工具结果压缩。裁剪过大的工具输出,避免单次调用占满上下文窗口。',
  },
  {
    id: 'subprocess', label: 'Subprocess', description: '本地子进程执行',
    intro: '本地子进程执行服务,为 agent 提供受控的命令执行能力。',
  },
  {
    id: 'sessions', label: 'Sessions', description: 'JSONL 会话持久化',
    intro: 'JSONL 会话持久化。把每个会话的消息与事件落盘,支持回放与审计。',
  },
  {
    id: 'session-checkpoints', label: 'Session Checkpoints', description: '会话检查点策略',
    intro: '会话检查点策略,在关键节点保存会话快照,用于恢复与对比。',
  },
]

const MANAGED: readonly ManagedEntry[] = [
  { id: 'redtrace-critical-events', label: '关键事件调度', category: 'feature', modulePath: 'packages/redtrace-engine/src/scheduler.ts', description: '运行时验证的关键事件提前规划', intro: '只消费平台确认或运行时验证的能力、路由及失效信号；停用后保留原 Fact＋Step 结束契约，不删除证据。' },
  { id: 'redtrace-knowledge', label: '离线知识检索', category: 'feature', modulePath: 'packages/redtrace-engine/src/knowledge.ts', description: '本地 FTS5 搜索与有界读取', intro: '只检索本地知识源；命中不是漏洞证据，不自动执行 PoC。' },
  { id: 'redtrace-browser-http', label: 'Browser + HTTP', category: 'feature', modulePath: 'packages/redtrace-engine/src/web.ts', description: '隔离持久浏览器与轻量 HTTP 批量验证', intro: '按 Project、Challenge、身份和 Session 隔离，默认串行；完整请求响应保存在权限受限的证据文件。' },
  { id: 'redtrace-trace-search', label: 'Trace 检索', category: 'feature', modulePath: 'packages/redtrace-engine/src/store.ts', description: '项目内工具证据检索', intro: '按需搜索项目内工具记录；不广播完整历史，停用不删除原始证据。' },

  {
    id: 'redtrace-core', label: 'RedTrace Core', category: 'core', module: core, protectStop: true,
    modulePath: 'packages/redtrace-dsh/lib/core.js',
    description: '最小运行内核',
    intro: '整个运行时的最小内核:装配 agent 循环、会话、模型调用、工具注册与系统提示词。其余全部能力都以插件形式叠加在这层之上。',
  },
  {
    id: 'redtrace-webshell', label: 'WebShell', category: 'feature', module: webshell,
    modulePath: 'packages/redtrace-dsh/lib/webshell.js',
    description: 'WebShell 通道族',
    intro: 'WebShell 能力插件:提供通道连通性探测工具;停用后 remote.command / remote.file.* 动词不再复用 WebShell 通道。',
  },
  {
    id: 'redtrace-c2', label: 'C2', category: 'feature', module: c2,
    modulePath: 'packages/redtrace-dsh/lib/c2.js',
    description: 'C2 通道族',
    intro: 'C2 能力插件:提供 listener 创建、payload 生成与会话查询工具;停用后 remote.command / remote.file.* 动词不再复用 C2 会话通道。',
  },
  {
    id: 'redtrace-web', label: 'Web', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/web/tool-web/lib/index.js',
    description: '网页搜索与抓取',
    intro: 'DSH 原生 Web 能力:web_search 走 dsh-web-search-free 免费多引擎检索(TinyFish/AnySearch/Exa/Tavily 等,按顺序自动 fallback,引擎 Key 经 common_env 环境变量提供,如 TINYFISH_API_KEY),web_fetch 抓取公开 HTTP(S) 页面。插件开关对运行中的 Execute 会话生效。',
  },
  {
    id: 'redtrace-jobs', label: '后台任务', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/jobs/tool-jobs/lib/index.js',
    description: '后台任务管理与完成通知',
    intro: 'DSH 原生后台任务:bash 的 run_in_background 把长耗时命令(nmap、nuclei、ffuf 等)登记为任务,模型用 job_output / job_list / job_kill 跟进,完成后自动收到通知,不必 sleep 轮询。任务随所属会话结束自动清理。',
  },
  {
    id: 'redtrace-terminal', label: '持久终端', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/terminal/tool-terminal/lib/index.js',
    description: '交互式 PTY 终端',
    intro: 'DSH 原生持久终端:terminal_open / send / read / signal / close / list 在多次工具调用间保留交互式 shell 状态,适合 gdb、REPL、交互式探测等持续交互进程。一次性命令仍走 bash,长命令走后台任务。隔离档案下终端被限制在工作区内。',
  },
  {
    id: 'redtrace-remote-terminal', label: '远程持久终端（待验收）', category: 'feature', defaultOff: true,
    modulePath: 'packages/redtrace-engine/src/remote-terminal.ts',
    description: '跨 Step 的 Resource 托管 SSH PTY',
    intro: '基于已验证 SSH Resource 建立远程 PTY,提供游标读取、expect、输入、信号与尺寸控制。写操作受租约 fencing token 保护,与 Agent 私有的本地 terminal_* 完全分离。',
  },
  {
    id: 'redtrace-session-probe', label: '会话能力探测', category: 'feature',
    modulePath: 'packages/redtrace-engine/src/operation-execution.ts',
    description: '按需验证会话真实能力与基础主机信息',
    intro: '仅在 Step 声明 remote.session.probe 时执行最小信息探测；自报能力与 Runtime 验证能力分开保存，重连后需重新验证。',
  },
  {
    id: 'redtrace-pivot', label: '受管网络路径（待验收）', category: 'feature', defaultOff: true,
    modulePath: 'packages/redtrace-engine/src/pivot-runtime.ts',
    description: 'SSH Forward、Chisel 与 Ligolo 生命周期管理',
    intro: '建立方向明确的 TCP/UDP Route Resource,管理隧道进程、依赖、实际端点验证与清理。Worker 建路必须命中可信项目预授权；停止插件后工具与派发入口同步消失。',
  },
  {
    id: 'redtrace-fs-search', label: '工作区搜索', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/fs/tool-fs-search/lib/index.js',
    description: 'glob 与 grep 工具',
    intro: 'DSH 原生文件搜索:glob / grep 直接搜索当前工作区,内置结果上限、超时与大结果 spill,不需要在 shell 里拼 find / rg 命令。',
  },
  {
    id: 'redtrace-spill', label: '大结果落盘', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/spill/spill-policy/lib/index.js',
    description: '超大工具结果落盘预览',
    intro: 'DSH 原生 Spill:超过 8 KiB 的纯文本工具结果完整写入会话文件,模型只看到头尾预览与取回指引,需要时再用 read / grep 按需读取;与工具结果裁剪互补而非替代。',
  },
  {
    id: 'redtrace-tool-timeout', label: '工具超时', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/guard/timeout-policy/lib/index.js',
    description: '工具调用统一超时控制',
    intro: 'DSH 原生工具超时策略:为声明了超时预算的工具(web、文件搜索等)统一武装截止时间,超时以结构化错误返回而不是悬挂到任务级超时。',
  },
  {
    id: 'redtrace-repeat-reminder', label: '重复调用提醒', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/guard/repeat-tool-reminder/lib/index.js',
    description: '连续重复调用同一工具时提醒',
    intro: 'FGS 会话使用版本化尝试账本:完整输入、题目、身份、认证与通道状态一致时，第 3 次提醒一次；其他 DSH 会话保留原生重复提醒,打断死循环式的重复调用,适合长时间自主运行的 Worker。',
  },
  {
    id: 'redtrace-jev', label: 'Jev 语义辅助', category: 'feature', modulePath: 'packages/redtrace-engine/src/jev.ts', defaultOff: true,
    description: '可热切换的 Explore 候选选择与证据就绪度建议',
    intro: '启用后，Explore 可对已存在的扫描器、PoC、字典和搜索来源请求 Jev 排序，并评估已确认事实对攻击前置条件的支持程度。建议不自动执行。旧过滤场景默认关闭，可在 Worker 设置中单独开启。需配置 TYPESAFE_API_KEY。',
  },
  {
    id: 'redtrace-credentials', label: 'Credentials', category: 'feature', module: credentials,
    modulePath: 'packages/redtrace-dsh/lib/credentials.js', defaultOff: true,
    description: '凭据文档服务',
    intro: 'DSH 原生凭据服务:从 $DSH_HOME/.credentials.yaml 与项目 / 用户 .env 解析凭据引用(如 Web 搜索的 DEEPSEEK_API_KEY),不回写进程环境。RedTrace 自身的 Provider 密钥仍由配置文件管理,二者互不影响。',
  },
  {
    id: 'redtrace-attachment', label: 'Attachment', category: 'feature', module: attachment,
    modulePath: 'packages/redtrace-dsh/lib/attachment.js', defaultOff: true,
    description: '二进制附件持久化服务',
    intro: 'DSH 原生附件服务:为 APK / PCAP / ELF 等二进制样本提供内容寻址的持久存储,消息中只保留引用。当前 RedTrace 管线不提交附件,服务为后续通道与自定义插件预留。',
  },
  {
    id: 'redtrace-file-references', label: 'File References', category: 'feature', module: fileReferences,
    modulePath: 'packages/redtrace-dsh/lib/file-references.js', defaultOff: true,
    description: '@ 文件引用发现服务',
    intro: 'DSH 原生文件引用服务:为交互界面提供 @ 路径补全候选,让消息按路径引用工作区文件而不是内联内容。无头 Worker 不输入 @,仅在接入交互前端或自定义插件时有用。',
  },
  {
    id: 'redtrace-lsp', label: 'LSP', category: 'feature',
    modulePath: 'vendor/deepseek-harness/packages/lsp/tool-lsp/lib/index.js', defaultOff: true,
    description: '语言服务器代码导航',
    intro: 'DSH 原生 LSP:lsp 工具提供 goToDefinition / findReferences / goToImplementation / hover 精确导航,预置 typescript-language-server、pyright-langserver、clangd 三个服务端,只挂载本机已安装的部分,一个都没有时该工具不出现。适合代码审计任务,按需开启。',
  },
  {
    id: 'redtrace-ptc', label: 'PTC', category: 'feature', module: codeRuntime,
    modulePath: 'packages/redtrace-dsh/lib/code-runtime.js', defaultOff: true,
    description: 'run_code 程序化工具调用',
    intro: 'DSH 原生代码运行时与 PTC 呈现:宿主挂载 worker-thread TypeScript 运行时(限时限量),每个 Execute 会话以 both 模式在原生工具之外追加 run_code,供模型把多步工具调用编排为一段程序。实验性能力,默认关闭。',
  },
  {
    id: 'redtrace-domain', label: 'Domain', category: 'feature', module: domain, protectStop: true,
    needsRuntimeConfig: true, modulePath: 'packages/redtrace-dsh/lib/domain.js',
    description: '后端 API 桥接与热加载',
    intro: '连接后端 API 的桥:拉取热加载的运行时配置(Worker、任务限额、Provider),挂载并热重载 MCP 客户端,并把 Provider 配置同步给模型层。',
  },
  {
    id: 'redtrace-scheduler', label: 'Scheduler', category: 'feature', module: scheduler,
    needsRuntimeConfig: true, modulePath: 'packages/redtrace-dsh/lib/scheduler.js',
    description: 'FGS 引擎调度器',
    intro: '托管 FGS 引擎的调度循环:按 Worker 的资格、优先级与并发上限认领 Decide/Execute 活动,派发给对应的 Agent 会话并跟踪其生命周期。停止后运行中的活动进入暂停,且不再认领新任务。',
  },
]

const PRESETS: readonly PresetEntry[] = [
  {
    id: 'redtrace-bootstrap', label: 'Bootstrap 预设', category: 'preset', preset: 'bootstrap',
    description: '初始图谱构建任务',
    intro: '新项目的首次任务:梳理给定目标,产出初始知识图谱与第一批意图,为后续调度建立基线。',
  },
  {
    id: 'redtrace-reason', label: 'Reason 预设', category: 'preset', preset: 'reason',
    description: '意图规划与评估任务',
    intro: '规划类任务:评估黑板修订,规划意图的拆分与排序,决定执行顺序。',
  },
  {
    id: 'redtrace-explore', label: 'Explore 预设', category: 'preset', preset: 'explore',
    description: '意图执行任务',
    intro: '执行类任务:领取具体意图,调用工具完成侦察或分析,并通过契约工具提交结果与事实。',
  },
]

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,47}$/
const SETTLE_TIMEOUT_SECONDS = 10
const BODY_LIMIT = 1024 * 1024

export class PluginError extends Error {}

function delay(seconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, seconds * 1000))
}

/** A mounted plugin: its fiber plus the promise tracking activation. */
interface Mounted {
  fiber: CordisFiber
  settled: Promise<void>
}

export class PluginManager {
  private manifest: PluginManifest = { version: 1 }
  private readonly mounted = new Map<string, Mounted>()
  private readonly statuses = new Map<string, PluginStatus>()
  private readonly errors = new Map<string, string>()

  private readonly root: string
  private readonly loadModule: (relative: string) => Promise<unknown>

  constructor(
    private readonly ctx: RuntimeContext,
    private readonly config: RuntimeConfig,
    /** Repo root for module resolution and the user plugins/ directory; tests inject a tmp root. */
    root: string = repoRoot,
    loadModule: (relative: string) => Promise<unknown> = load,
    /** Native engine modules use the same real Cordis fibers and management contracts. */
    private readonly replacements: Readonly<Record<string, unknown>> = {},
    private readonly onChange: () => void | Promise<void> = () => {},
  ) {
    // The loader's repoRoot URL carries a trailing slash; normalize so prefix
    // checks (inside-repo, inside plugins/) compare cleanly.
    this.root = path.resolve(root)
    this.loadModule = loadModule
  }

  get manifestPath(): string {
    const configured = this.config.pluginsManifest
      ?? (process.env.REDTRACE_DSH_SETTINGS !== undefined
        ? path.join(path.dirname(process.env.REDTRACE_DSH_SETTINGS), 'plugins.json')
        : undefined)
    return configured ?? path.join(this.config.sessionRoot ?? this.root, 'plugins.json')
  }

  get userPluginsDir(): string {
    return path.join(this.root, 'plugins')
  }

  /** Mount the enabled catalog plugins in dependency order; a plugin that
   * never activates (missing service) settles as 'pending' instead of
   * blocking boot. */
  async boot(): Promise<void> {
    await this.readManifest()
    const disabled = new Set(this.manifest.disabled ?? [])
    const enabled = new Set(this.manifest.enabled ?? [])
    // Preset gates are computed before any plugin mounts: the scheduler
    // replacement dispatches during boot and must not bypass a disabled
    // preset in the window before the post-loop sync.
    for (const entry of PRESETS) {
      this.statuses.set(entry.id, disabled.has(entry.id) ? 'stopped' : 'running')
    }
    for (const entry of MANAGED) {
      if (entry.protectStop !== true && (disabled.has(entry.id) || (entry.defaultOff === true && !enabled.has(entry.id)))) {
        this.statuses.set(entry.id, 'stopped')
        continue
      }
      await this.mountManaged(entry, true)
      // redtrace-domain initializes the shared state the presets live in;
      // gate them before the scheduler replacement mounts and dispatches.
      if (entry.id === 'redtrace-domain') await this.syncPresets()
    }
    await this.syncPresets()
    for (const user of this.manifest.user ?? []) {
      this.statuses.set(user.id, user.enabled === false ? 'stopped' : 'pending')
      if (user.enabled !== false) await this.mountUser(user, false)
    }
  }

  private async syncPresets(): Promise<void> {
    const shared = state()
    if (shared) for (const entry of PRESETS) {
      if (this.statuses.get(entry.id) === 'stopped') shared.presets.delete(entry.preset)
      else shared.presets.add(entry.preset)
    }
    await this.onChange()
  }

  private async readManifest(): Promise<void> {
    try {
      const raw = await readFile(this.manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as PluginManifest
      const hasList = parsed !== null && typeof parsed === 'object'
        && (Array.isArray(parsed.disabled) || Array.isArray(parsed.enabled) || Array.isArray(parsed.user))
      if (hasList) {
        this.manifest = {
          version: 1,
          disabled: Array.isArray(parsed.disabled) ? [...new Set(parsed.disabled.filter(v => typeof v === 'string'))] : [],
          enabled: Array.isArray(parsed.enabled) ? [...new Set(parsed.enabled.filter(v => typeof v === 'string'))] : [],
          user: Array.isArray(parsed.user) ? parsed.user : [],
        }
        return
      }
    } catch {
      // missing or corrupt manifest: fall through to defaults
    }
    this.manifest = { version: 1 }
  }

  private async writeManifest(): Promise<void> {
    const target = this.manifestPath
    const tmp = `${target}.tmp`
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(this.manifest, null, 2)}\n`, 'utf8')
    await rename(tmp, target)
  }

  private async mountManaged(entry: ManagedEntry, awaitSettle: boolean): Promise<void> {
    if (this.mounted.has(entry.id)) return
    // Session-scoped capabilities have no host-plane fiber: the execution
    // toolchain mounts their stack per Execute agent while this entry runs.
    if (entry.module === undefined) {
      this.statuses.set(entry.id, 'running')
      return
    }
    const config = entry.needsRuntimeConfig === true ? this.config : undefined
    try {
      const mounted = this.mount(entry.id, this.replacements[entry.id] ?? entry.module, config)
      if (awaitSettle) {
        await Promise.race([mounted.settled, delay(SETTLE_TIMEOUT_SECONDS)])
      }
    } catch (error) {
      this.statuses.set(entry.id, 'error')
      this.errors.set(entry.id, message(error))
    }
  }

  private mount(id: string, module: unknown, config: unknown): Mounted {
    this.statuses.set(id, 'pending')
    this.errors.delete(id)
    const fiber = this.ctx.plugin(module, config)
    const settled = Promise.resolve(fiber.await()).then(
      () => {
        if (this.statuses.get(id) === 'pending') this.statuses.set(id, 'running')
      },
      error => {
        this.statuses.set(id, 'error')
        this.errors.set(id, message(error))
      },
    )
    const mounted: Mounted = { fiber, settled }
    this.mounted.set(id, mounted)
    return mounted
  }

  private async mountUser(user: UserEntry, awaitSettle: boolean): Promise<void> {
    if (this.mounted.has(user.id)) return
    try {
      const module = await this.loadModule(user.module)
      const mounted = this.mount(user.id, module, user.config ?? undefined)
      if (awaitSettle) {
        await Promise.race([mounted.settled, delay(SETTLE_TIMEOUT_SECONDS)])
      }
    } catch (error) {
      this.statuses.set(user.id, 'error')
      this.errors.set(user.id, message(error))
    }
  }

  list(): PluginView[] {
    const views: PluginView[] = KERNEL.map(entry => ({
      id: entry.id,
      label: entry.label,
      description: entry.description,
      intro: entry.intro,
      category: 'kernel',
      source: 'kernel',
      status: 'running',
      module: null,
      config: null,
      canStop: false,
      canUninstall: false,
      error: null,
    }))
    for (const entry of MANAGED) {
      views.push({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        intro: entry.intro,
        category: entry.category,
        source: 'builtin',
        status: this.statuses.get(entry.id) ?? 'stopped',
        module: entry.modulePath,
        config: null,
        canStop: entry.protectStop !== true,
        canUninstall: false,
        error: this.errors.get(entry.id) ?? null,
      })
    }
    for (const entry of PRESETS) {
      views.push({
        id: entry.id,
        label: entry.label,
        description: entry.description,
        intro: entry.intro,
        category: 'preset',
        source: 'builtin',
        status: this.statuses.get(entry.id) ?? 'running',
        module: `packages/redtrace-dsh/lib/${entry.preset}.js`,
        config: null,
        canStop: true,
        canUninstall: false,
        error: this.errors.get(entry.id) ?? null,
      })
    }
    for (const user of this.manifest.user ?? []) {
      views.push({
        id: user.id,
        label: user.label ?? user.id,
        description: user.description ?? '',
        intro: user.description ?? null,
        category: 'user',
        source: 'user',
        status: this.statuses.get(user.id) ?? 'stopped',
        module: user.module,
        config: user.config ?? null,
        canStop: true,
        canUninstall: true,
        error: this.errors.get(user.id) ?? null,
      })
    }
    return views
  }

  view(id: string): PluginView {
    const view = this.list().find(item => item.id === id)
    if (view === undefined) throw new PluginError(`unknown plugin: ${id}`)
    return view
  }

  /** Live running check for capability gating; pending boots count as down. */
  running(id: string): boolean {
    return this.statuses.get(id) === 'running'
  }

  async start(id: string): Promise<PluginView> {
    const managed = MANAGED.find(entry => entry.id === id)
    if (managed !== undefined) {
      if (this.mounted.has(id)) return this.view(id)
      this.manifest.disabled = (this.manifest.disabled ?? []).filter(item => item !== id)
      if (managed.defaultOff === true) {
        this.manifest.enabled = [...new Set([...(this.manifest.enabled ?? []), id])]
      }
      await this.mountManaged(managed, true)
      await this.writeManifest()
      await this.syncPresets()
      return this.view(id)
    }
    const preset = PRESETS.find(entry => entry.id === id)
    if (preset !== undefined) {
      this.statuses.set(id, 'running')
      this.manifest.disabled = (this.manifest.disabled ?? []).filter(item => item !== id)
      await this.writeManifest()
      await this.syncPresets()
      return this.view(id)
    }
    const user = this.manifest.user?.find(entry => entry.id === id)
    if (user === undefined) throw new PluginError(`unknown plugin: ${id}`)
    if (!this.mounted.has(id)) {
      user.enabled = true
      await this.mountUser(user, false)
      await this.writeManifest()
    }
    return this.view(id)
  }

  async stop(id: string): Promise<PluginView> {
    const managed = MANAGED.find(entry => entry.id === id)
    if (managed?.protectStop === true) throw new PluginError('受保护插件:关闭会失去 Web 管理入口')
    if (managed !== undefined) {
      await this.dispose(id)
      this.manifest.disabled = [...new Set([...(this.manifest.disabled ?? []), id])]
      this.manifest.enabled = (this.manifest.enabled ?? []).filter(item => item !== id)
      await this.writeManifest()
      await this.syncPresets()
      return this.view(id)
    }
    const preset = PRESETS.find(entry => entry.id === id)
    if (preset !== undefined) {
      this.statuses.set(id, 'stopped')
      this.manifest.disabled = [...new Set([...(this.manifest.disabled ?? []), id])]
      await this.writeManifest()
      await this.syncPresets()
      return this.view(id)
    }
    const user = this.manifest.user?.find(entry => entry.id === id)
    if (user === undefined) throw new PluginError(`unknown plugin: ${id}`)
    await this.dispose(id)
    user.enabled = false
    await this.writeManifest()
    return this.view(id)
  }

  private async dispose(id: string): Promise<void> {
    const mounted = this.mounted.get(id)
    if (mounted === undefined) {
      this.statuses.set(id, 'stopped')
      return
    }
    this.mounted.delete(id)
    try {
      await mounted.fiber.dispose()
      this.statuses.set(id, 'stopped')
    } catch (error) {
      this.statuses.set(id, 'error')
      this.errors.set(id, message(error))
    }
  }

  /** Register a user plugin: validate, mount when enabled, persist. */
  async add(input: {
    id?: unknown
    label?: unknown
    description?: unknown
    module?: unknown
    config?: unknown
    enabled?: unknown
  }): Promise<PluginView> {
    const id = typeof input.id === 'string' ? input.id.trim() : ''
    if (!ID_PATTERN.test(id)) throw new PluginError('插件 ID 需为小写字母、数字与连字符(2-48 位)')
    const known = new Set([
      ...KERNEL.map(entry => entry.id),
      ...MANAGED.map(entry => entry.id),
      ...PRESETS.map(entry => entry.id),
      ...(this.manifest.user ?? []).map(entry => entry.id),
    ])
    if (known.has(id)) throw new PluginError(`插件 ID 已存在:${id}`)
    const modulePath = typeof input.module === 'string' ? input.module.trim() : ''
    if (modulePath === '') throw new PluginError('模块路径不能为空')
    const relative = this.resolveModule(modulePath)
    let module: unknown
    try {
      module = await this.loadModule(relative)
    } catch (error) {
      throw new PluginError(`模块加载失败:${message(error)}`)
    }
    if (!isPluginModule(module)) throw new PluginError('模块未导出 Cordis 插件(apply 函数或插件对象)')
    let config: Record<string, unknown> | undefined
    if (input.config !== undefined && input.config !== null) {
      if (typeof input.config !== 'object' || Array.isArray(input.config)) throw new PluginError('config 需为 JSON 对象')
      config = input.config as Record<string, unknown>
    }
    const description = typeof input.description === 'string' ? input.description.trim() : ''
    if (description.length > 500) throw new PluginError('简介不能超过 500 字')
    const enabled = input.enabled === false ? false : true
    const entry: UserEntry = {
      id,
      label: typeof input.label === 'string' && input.label.trim() !== '' ? input.label.trim() : undefined,
      ...(description === '' ? {} : { description }),
      module: relative,
      ...(config === undefined ? {} : { config }),
      ...(enabled ? {} : { enabled: false }),
    }
    this.manifest.user = [...(this.manifest.user ?? []), entry]
    if (enabled) {
      this.statuses.set(id, 'pending')
      try {
        await this.mountUser(entry, false)
      } catch (error) {
        this.manifest.user = this.manifest.user.filter(item => item.id !== id)
        throw new PluginError(`插件挂载失败:${message(error)}`)
      }
    } else {
      this.statuses.set(id, 'stopped')
    }
    await this.writeManifest()
    return this.view(id)
  }

  /** Uninstall a user plugin: dispose, drop from the manifest, delete files
   * that live inside the managed plugins/ directory. */
  async uninstall(id: string): Promise<void> {
    const user = this.manifest.user?.find(entry => entry.id === id)
    if (user === undefined) throw new PluginError('仅自定义插件可卸载')
    await this.dispose(id)
    this.manifest.user = (this.manifest.user ?? []).filter(entry => entry.id !== id)
    this.statuses.delete(id)
    this.errors.delete(id)
    await this.writeManifest()
    await this.removeUserFiles(user.module)
  }

  private async removeUserFiles(relative: string): Promise<void> {
    const target = path.resolve(this.root, relative)
    if (!target.startsWith(`${this.userPluginsDir}${path.sep}`)) return
    // plugins/<id>/index.js removes the whole plugin directory; a file
    // directly under plugins/ removes itself.
    const parent = path.dirname(target)
    const victim = parent !== this.userPluginsDir
      && path.dirname(parent) === this.userPluginsDir ? parent : target
    await rm(victim, { recursive: true, force: true })
  }

  /** Resolve a module path to a repo-relative one; absolute paths and `..`
   * traversal that escape the repository root are rejected. */
  resolveModule(modulePath: string): string {
    const absolute = path.isAbsolute(modulePath)
      ? path.resolve(modulePath)
      : path.resolve(this.root, modulePath)
    if (absolute !== this.root && !absolute.startsWith(`${this.root}${path.sep}`)) {
      throw new PluginError('模块路径必须位于仓库内')
    }
    // Normalize to forward slashes so manifest entries stay portable
    // across platforms (path.relative uses '\' on Windows).
    return path.relative(this.root, absolute).split(path.sep).join('/')
  }
}

function isPluginModule(module: unknown): boolean {
  if (typeof module === 'function') return true
  const candidate = module as { default?: unknown; apply?: unknown } | null
  if (candidate !== null && typeof candidate === 'object') {
    if (typeof candidate.apply === 'function') return true
    if (typeof candidate.default === 'function') return true
    const def = candidate.default as { apply?: unknown } | null
    return def !== null && typeof def === 'object' && typeof def.apply === 'function'
  }
  return false
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// ─── HTTP API ────────────────────────────────────────────────────────────────
// GET    /__redtrace/plugins            list
// POST   /__redtrace/plugins            add      {id, label?, module, config?, enabled?}
// POST   /__redtrace/plugins/:id/start  start (hot)
// POST   /__redtrace/plugins/:id/stop   stop  (hot)
// DELETE /__redtrace/plugins/:id        uninstall

function send(res: any, status: number, payload?: unknown): void {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    ...(body === '' ? {} : { 'content-length': Buffer.byteLength(body) }),
  })
  res.end(body)
}

async function readBody(req: any): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > BODY_LIMIT) throw new PluginError('请求体过大')
    chunks.push(chunk as Buffer)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new PluginError('请求体不是合法 JSON')
  }
}

async function handle(manager: PluginManager, req: any, res: any): Promise<void> {
  const url = new URL(String(req.url ?? '/'), 'http://redtrace.local')
  const segments = url.pathname.replace(/^\/+|\/+$/g, '').split('/')
  if (segments[0] !== '__redtrace' || segments[1] !== 'plugins') {
    send(res, 404, { detail: 'not found' })
    return
  }
  const rest = segments.slice(2)
  const method = String(req.method ?? 'GET').toUpperCase()
  try {
    if (method === 'GET' && rest.length === 0) {
      send(res, 200, { plugins: manager.list() })
      return
    }
    if (method === 'POST' && rest.length === 0) {
      send(res, 201, { plugin: await manager.add(await readBody(req) as Record<string, unknown>) })
      return
    }
    if (method === 'POST' && rest.length === 2 && (rest[1] === 'start' || rest[1] === 'stop')) {
      const id = decodeURIComponent(rest[0])
      const view = rest[1] === 'start' ? await manager.start(id) : await manager.stop(id)
      send(res, 200, { plugin: view })
      return
    }
    if (method === 'DELETE' && rest.length === 1) {
      await manager.uninstall(decodeURIComponent(rest[0]))
      send(res, 204)
      return
    }
    send(res, 404, { detail: 'not found' })
  } catch (error) {
    if (error instanceof PluginError) {
      send(res, 400, { detail: error.message })
      return
    }
    send(res, 500, { detail: message(error) })
  }
}

export function registerPluginRoutes(ctx: RuntimeContext, manager: PluginManager): void {
  const webServer = ctx.webServer ?? ctx.get('webServer') as RuntimeContext['webServer'] | undefined
  if (webServer === undefined) return
  webServer.register({
    kind: 'prefix',
    path: '/__redtrace/plugins',
    handler: (req, res) => {
      void handle(manager, req, res).catch(error => {
        try {
          send(res, 500, { detail: message(error) })
        } catch {
          // response already started: nothing more we can do
        }
      })
    },
  })
}

export async function apply(ctx: RuntimeContext, config: RuntimeConfig = {}): Promise<void> {
  if (config.runtime !== true) return
  if (typeof config.sessionRoot !== 'string' || config.sessionRoot.trim() === '') {
    throw new Error('redtrace plugins: sessionRoot is required')
  }
  const manager = new PluginManager(ctx, config)
  await manager.boot()
  registerPluginRoutes(ctx, manager)
}
