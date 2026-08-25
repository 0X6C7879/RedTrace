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
import * as prompt from './prompt.js'
import * as context from './context.js'
import * as contracts from './contracts.js'
import * as resource from './resource.js'
import * as domain from './domain.js'
import * as audit from './audit.js'
import * as web from './web.js'
import * as scheduler from './scheduler.js'
import * as bootstrapPreset from './bootstrap.js'
import * as reasonPreset from './reason.js'
import * as explorePreset from './explore.js'

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

/** A RedTrace plugin the manager mounts as a child fiber. */
interface ManagedEntry {
  id: string
  label: string
  description: string
  intro: string
  category: 'core' | 'feature'
  module: unknown
  /** Receive the full RuntimeConfig (domain and scheduler need it). */
  needsRuntimeConfig?: boolean
  /** Stopping this plugin removes the management plane itself. */
  protectStop?: boolean
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
    id: 'settings', label: 'Settings', description: '配置读写与热更新',
    intro: '配置读写服务。负责 settings.yaml 的读取、原子写入与文件监听,是各项配置免重启热加载的通道。',
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
  {
    id: 'redtrace-core', label: 'RedTrace Core', category: 'core', module: core,
    description: '最小运行内核',
    intro: '整个运行时的最小内核:装配 agent 循环、会话、模型调用、工具注册与系统提示词。其余全部能力都以插件形式叠加在这层之上。',
  },
  {
    id: 'redtrace-prompt', label: 'Persona', category: 'feature', module: prompt,
    description: '中文人格与任务规则',
    intro: '定义 agent 的中文人格与行为规则,涵盖任务收尾、输出格式与安全边界,是所有任务共享的提示词基座。',
  },
  {
    id: 'redtrace-context', label: 'Context', category: 'feature', module: context,
    description: '图谱与资源的上下文注入',
    intro: '把项目知识图谱、资源与黑板修订序列化为上下文消息,在任务启动和图谱变更时注入 agent 会话。',
  },
  {
    id: 'redtrace-contracts', label: 'Contracts', category: 'feature', module: contracts,
    description: '契约工具',
    intro: '注册契约类工具并按任务类型分配。agent 必须通过这些工具提交结果、创建意图与事实,保证产出可追踪。',
  },
  {
    id: 'redtrace-resource', label: 'Resource', category: 'feature', module: resource,
    description: '共享资源工具',
    intro: '共享资源读写工具。agent 通过它登记与查询项目资源,资源经后台关联进入图谱。',
  },
  {
    id: 'redtrace-domain', label: 'Domain', category: 'feature', module: domain,
    needsRuntimeConfig: true, description: '后端 API 桥接与热加载',
    intro: '连接后端 API 的桥:拉取热加载的运行时配置(Worker、任务限额、Provider),挂载 MCP 客户端,并把 Provider 配置同步给模型层。',
  },
  {
    id: 'redtrace-audit', label: 'Audit', category: 'feature', module: audit,
    description: '运行审计与事件投影',
    intro: '把每个任务的运行记录上报审计,并把会话事件投影为可检索的时间线,日志页展示的数据来源于此。',
  },
  {
    id: 'redtrace-web', label: 'Web UI', category: 'feature', module: web, protectStop: true,
    description: 'Web UI 静态服务与 API 反代(受保护)',
    intro: '在内核 HTTP 服务上托管 Web UI 静态资源,并把 API 请求反代到后端。关闭它将失去 Web 管理入口,因此受保护不可停用。',
  },
  {
    id: 'redtrace-scheduler', label: 'Scheduler', category: 'feature', module: scheduler,
    needsRuntimeConfig: true, description: 'Worker 中心调度与编排',
    intro: '调度循环:按 Worker 的资格、优先级与并发上限认领任务,为每个任务创建独立 agent 会话,并跟踪其生命周期直至上报结果。',
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
    for (const entry of MANAGED) {
      if (disabled.has(entry.id)) {
        this.statuses.set(entry.id, 'stopped')
        continue
      }
      await this.mountManaged(entry, true)
    }
    for (const entry of PRESETS) {
      this.statuses.set(entry.id, disabled.has(entry.id) ? 'stopped' : 'running')
    }
    this.syncPresets()
    for (const user of this.manifest.user ?? []) {
      this.statuses.set(user.id, user.enabled === false ? 'stopped' : 'pending')
      if (user.enabled !== false) await this.mountUser(user, false)
    }
  }

  private syncPresets(): void {
    const shared = state()
    if (shared === undefined) return
    for (const entry of PRESETS) {
      if (this.statuses.get(entry.id) === 'stopped') shared.presets.delete(entry.preset)
      else shared.presets.add(entry.preset)
    }
  }

  private async readManifest(): Promise<void> {
    try {
      const raw = await readFile(this.manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as PluginManifest
      if (parsed !== null && typeof parsed === 'object' && Array.isArray(parsed.user ?? parsed.disabled)) {
        this.manifest = {
          version: 1,
          disabled: Array.isArray(parsed.disabled) ? [...new Set(parsed.disabled.filter(v => typeof v === 'string'))] : [],
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
    const config = entry.needsRuntimeConfig === true ? this.config : undefined
    try {
      const mounted = this.mount(entry.id, entry.module, config)
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
        module: `packages/redtrace-dsh/lib/${entry.id.replace('redtrace-', '')}.js`,
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

  async start(id: string): Promise<PluginView> {
    const managed = MANAGED.find(entry => entry.id === id)
    if (managed !== undefined) {
      if (this.mounted.has(id)) return this.view(id)
      this.manifest.disabled = (this.manifest.disabled ?? []).filter(item => item !== id)
      await this.mountManaged(managed, false)
      await this.writeManifest()
      this.syncPresets()
      return this.view(id)
    }
    const preset = PRESETS.find(entry => entry.id === id)
    if (preset !== undefined) {
      this.statuses.set(id, 'running')
      this.manifest.disabled = (this.manifest.disabled ?? []).filter(item => item !== id)
      await this.writeManifest()
      this.syncPresets()
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
      await this.writeManifest()
      this.syncPresets()
      return this.view(id)
    }
    const preset = PRESETS.find(entry => entry.id === id)
    if (preset !== undefined) {
      this.statuses.set(id, 'stopped')
      this.manifest.disabled = [...new Set([...(this.manifest.disabled ?? []), id])]
      await this.writeManifest()
      this.syncPresets()
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
    return path.relative(this.root, absolute)
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
