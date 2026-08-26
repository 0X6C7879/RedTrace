/**
 * RedTrace Scheduler plugin: the worker-centric dispatch loop. For every
 * Bootstrap / Reason / Explore demand it selects an eligible Worker
 * (enabled + task eligibility + per-worker maxRunning capacity, ordered by
 * priority then least-loaded fairness), claims the task under the Worker's
 * real name, and creates a dedicated DSH Agent + Session in the one
 * long-lived Cordis runtime using the Worker's provider/model route.
 * RedTrace owns worker selection; DSH owns the agent lifecycle.
 * @module redtrace-scheduler
 */

import { mkdir, rm } from 'node:fs/promises'
import path from 'node:path'
import type {
  Intent, ProjectDetail, ProjectSummary, ResourceSummary, RuntimeConfig, RuntimeContext,
  RuntimeOptions, RuntimeSnapshot, RuntimeTask, TaskLimits, TaskType, WorkerSpec,
} from './types.js'
import { api, Domain } from './domain.js'
import { state } from './state.js'
import { reportRun, cleanupSessionArtifacts } from './audit.js'
import { concludeInstruction } from './prompt.js'
import { hintMessage, isBootstrap, isInitial, schedulable, taskPrompt } from './context.js'
import * as bootstrapPreset from './bootstrap.js'
import * as reasonPreset from './reason.js'
import * as explorePreset from './explore.js'

export const name = 'redtrace-scheduler'
export const inject = ['agents', 'sessions', 'sessionPersistence']

const BOOTSTRAP_CREATOR = 'dispatcher.bootstrap'
const BOOTSTRAP_DESCRIPTION = 'bootstrap'
const PRESETS = {
  bootstrap: bootstrapPreset,
  reason: reasonPreset,
  explore: explorePreset,
} as const

function safeId(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 48)
  return clean || 'project'
}

function newSessionId(task: TaskType, projectId: string): string {
  return `rt-${safeId(projectId)}-${task}-${crypto.randomUUID().replaceAll('-', '')}`
}

function message(shared: { messages?: { createUserMessage(value: Record<string, unknown>): unknown } }, text: string): unknown {
  const factory = shared.messages?.createUserMessage
  if (factory === undefined) throw new Error('redtrace runtime: message helpers are not loaded')
  return factory({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function waitIdle(agent: import('./types.js').Agent, seconds: number): Promise<'idle' | 'timeout'> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), seconds * 1000) })
  const result = await Promise.race([agent.whenIdle().then(() => 'idle' as const), timeout])
  if (timer !== undefined) clearTimeout(timer)
  if (result === 'timeout') {
    agent.cancel({ kind: 'hook', reason: 'timeout' })
    await agent.whenIdle()
  }
  return result
}

class Scheduler {
  private readonly running = new Map<string, RuntimeTask>()
  private timer?: ReturnType<typeof setTimeout>
  private closing = false
  private cursor = 0
  private readonly domain: Domain

  constructor(
    private readonly ctx: RuntimeContext,
    private config: RuntimeOptions,
  ) {
    this.domain = new Domain(ctx, config)
  }

  start(): void { void this.tick() }

  async close(): Promise<void> {
    this.closing = true
    if (this.timer !== undefined) clearTimeout(this.timer)
    await Promise.all([...this.running.values()].map(async task => {
      task.cancelled = true
      task.handle?.agent.cancel({ kind: 'disposed' })
      await task.handle?.agent.whenIdle()
    }))
    await Promise.all([...this.running.values()].map(task => task.handle?.dispose()))
  }

  private get shared() { return state() }

  private get snapshot(): RuntimeSnapshot | undefined { return this.shared?.snapshot }

  /** Task presets disabled through the plugin manager never dispatch. */
  private presetEnabled(type: TaskType): boolean {
    return this.shared?.presets.has(type) ?? true
  }

  private limits(): { maxWorkers: number; maxRunningProjects: number; maxProjectWorkers: number; interval: number } {
    return resolveLimits(this.snapshot, this.config)
  }

  private schedule(): void {
    if (!this.closing) this.timer = setTimeout(
      () => { void this.tick() },
      Math.max(1, this.limits().interval) * 1000,
    )
  }

  private async tick(): Promise<void> {
    try {
      await this.domain.refresh().catch(error => { this.ctx.logger?.warn(error) })
      const summaries = await api<ProjectSummary[]>(this.config, '/projects')
      await this.cancelInactive(summaries)
      await this.injectHints()
      await this.cleanupDeleting(summaries)
      await this.dispatch(summaries)
    } catch (error) {
      this.ctx.logger?.warn(error)
    } finally {
      this.schedule()
    }
  }

  private async cancelInactive(summaries: ProjectSummary[]): Promise<void> {
    const states = new Map(summaries.map(summary => [summary.id, summary.status]))
    for (const task of this.running.values()) {
      if (states.get(task.projectId) === 'active') continue
      task.cancelled = true
      task.handle?.agent.cancel({ kind: 'hook', reason: `project ${states.get(task.projectId) ?? 'deleted'}` })
    }
  }

  private async resources(projectId: string, type: TaskType): Promise<ResourceSummary[]> {
    if (type !== 'explore') return []
    const payload = await api<{ resources: ResourceSummary[] }>(
      this.config, `/projects/${encodeURIComponent(projectId)}/resources?limit=50`,
    )
    return payload.resources ?? []
  }

  /** Runtime context updates push only newly added human Hints into running
   * workers; Fact/Intent/Resource changes stay pull-based (Reason re-reads
   * the graph on its next launch, Explore owns its Intent lineage). */
  private async injectHints(): Promise<void> {
    for (const task of this.running.values()) {
      if (task.cancelled || task.handle === undefined || task.deliveredHints === undefined) continue
      const project = await api<ProjectDetail>(this.config, `/projects/${encodeURIComponent(task.projectId)}`)
      if ((task.revision ?? 0) >= project.blackboard_revision) continue
      task.revision = project.blackboard_revision
      const fresh = project.hints.filter(hint => !task.deliveredHints!.has(hint.id))
      if (fresh.length === 0) continue
      for (const hint of fresh) task.deliveredHints!.add(hint.id)
      task.handle.agent.inject(message(this.shared!, hintMessage(fresh)))
    }
  }

  private async cleanupDeleting(summaries: ProjectSummary[]): Promise<void> {
    for (const summary of summaries.filter(item => item.status === 'deleting')) {
      if ([...this.running.values()].some(task => task.projectId === summary.id)) continue
      const runs = await api<Array<{ session_id?: string | null }>>(this.config, `/audit/tasks/${encodeURIComponent(summary.id)}/runs`)
      await cleanupSessionArtifacts(this.config.sessionRoot, runs, this.ctx.sessionPersistence)
      const root = path.resolve(this.config.workspacesDir)
      const target = path.resolve(root, safeId(summary.id))
      if (target !== root && target.startsWith(`${root}${path.sep}`)) await rm(target, { recursive: true, force: true })
      await api(this.config, `/projects/${encodeURIComponent(summary.id)}/deletion/runtime-cleaned`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"success":true,"error":""}',
      })
    }
  }

  private workerRunning(name: string): number {
    return [...this.running.values()].filter(task => task.worker === name).length
  }

  private projectCount(projectId: string): number {
    return [...this.running.values()].filter(task => task.projectId === projectId).length
  }

  private async dispatch(summaries: ProjectSummary[]): Promise<void> {
    const limits = this.limits()
    const { candidates, nextCursor } = planDispatch(summaries, [...this.running.values()], limits, this.cursor)
    this.cursor = nextCursor
    for (const summary of candidates) {
      // Re-check the live caps before every launch: dispatching one project
      // mutates the running set within this same round.
      if (this.running.size >= this.limits().maxWorkers) break
      if (this.projectCount(summary.id) >= this.limits().maxProjectWorkers) continue
      const runningProjects = new Set([...this.running.values()].map(task => task.projectId))
      if (!runningProjects.has(summary.id) && runningProjects.size >= this.limits().maxRunningProjects) continue
      await this.dispatchProject(summary)
    }
  }

  private async dispatchProject(summary: ProjectSummary): Promise<void> {
    if (summary.reason !== null) return
    const project = await api<ProjectDetail>(this.config, `/projects/${encodeURIComponent(summary.id)}`)
    if (project.project.status !== 'active') return
    if (isInitial(project) && project.project.bootstrap_enabled && this.presetEnabled('bootstrap')) {
      let intent = project.intents.find(isBootstrap)
      if (intent === undefined) {
        intent = await api<Intent>(this.config, `/projects/${encodeURIComponent(summary.id)}/intents`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            from: ['origin'], description: BOOTSTRAP_DESCRIPTION,
            creator: BOOTSTRAP_CREATOR, worker: null,
          }),
        })
      }
      if (schedulable(intent)) await this.claimAndRun('bootstrap', project, intent)
      return
    }
    if (summary.planning_revision > summary.reason_evaluated_revision) {
      if (!this.presetEnabled('reason')) return
      if (!reasonEligible(summary, Date.now())) return
      const worker = selectWorker(this.snapshot?.workers ?? [], name => this.workerRunning(name), 'reason')
      if (worker === undefined) return
      const claimed = await this.tryPost(`/projects/${encodeURIComponent(summary.id)}/reason/claim`, {
        worker: worker.name,
        trigger: `planning_revision:${summary.reason_evaluated_revision}->${summary.planning_revision}`,
      })
      if (claimed) this.launch({
        type: 'reason', projectId: summary.id, worker: worker.name, route: route(worker),
        maxIntents: this.taskLimits('reason')?.max_intents,
        limits: this.taskLimits('reason'),
        committed: false,
      }, project)
      return
    }
    const intent = project.intents
      .filter(item => schedulable(item) && !isBootstrap(item))
      .sort((a, b) => `${b.created_at}\0${b.id}`.localeCompare(`${a.created_at}\0${a.id}`))[0]
    if (intent !== undefined) await this.claimAndRun('explore', project, intent)
  }

  private taskLimits(type: TaskType): TaskLimits | undefined {
    return this.snapshot?.tasks?.[type] ?? this.config.tasks?.[type]
  }

  private async claimAndRun(type: 'bootstrap' | 'explore', project: ProjectDetail, intent: Intent): Promise<void> {
    if (!this.presetEnabled(type)) return
    const worker = selectWorker(this.snapshot?.workers ?? [], name => this.workerRunning(name), type)
    if (worker === undefined) return
    const claimed = await this.tryPost(
      `/projects/${encodeURIComponent(project.project.id)}/intents/${encodeURIComponent(intent.id)}/claim`,
      { worker: worker.name },
    )
    if (!claimed) return
    this.launch({
      type,
      projectId: project.project.id,
      intentId: intent.id,
      executionProfile: intent.execution_profile ?? 'direct',
      worker: worker.name,
      route: route(worker),
      limits: this.taskLimits(type),
      committed: false,
    }, project, intent)
  }

  private async tryPost(pathname: string, body: Record<string, unknown>): Promise<boolean> {
    return postWithRetry(`${this.config.server}${pathname}`, body, {
      onError: error => { this.ctx.logger?.warn(error) },
    })
  }

  private launch(task: RuntimeTask, project: ProjectDetail, intent?: Intent): void {
    const key = `${task.projectId}:${task.type}:${task.intentId ?? ''}`
    if (this.running.has(key)) return
    task.server = this.config.server
    task.revision = project.blackboard_revision
    task.deliveredHints = new Set(project.hints.map(hint => hint.id))
    task.startedAt = Date.now()
    task.sessionId = newSessionId(task.type, task.projectId)
    task.runId = `run-${crypto.randomUUID()}`
    this.running.set(key, task)
    void this.runTask(task, project, intent).finally(() => { this.running.delete(key) })
  }

  private async runTask(task: RuntimeTask, project: ProjectDetail, intent?: Intent): Promise<void> {
    const shared = this.shared
    if (shared === undefined || shared.messages === undefined || task.route === undefined) return
    let outcome = 'failure'
    let heartbeat: ReturnType<typeof setInterval> | undefined
    const limits = task.limits ?? { timeout: 300 }
    const cwd = path.join(this.config.workspacesDir, safeId(task.projectId))
    await mkdir(cwd, { recursive: true })
    try {
      task.handle = await this.ctx.agents.create({
        sessionId: shared.messages.SessionId(task.sessionId!),
        meta: { cwd },
        agentOptions: {
          provider: task.route.provider,
          model: task.route.model,
          ...(task.route.maxTokens === undefined ? {} : { maxTokens: task.route.maxTokens }),
        },
        setup: async (scoped: import('./types.js').ScopedContext) => {
          await scoped.plugin(PRESETS[task.type], { task, cwd, skillsDir: this.config.skillsDir }).await()
        },
      })
      shared.tasks.set(task.sessionId!, task)
      await reportRun(this.config, task, 'running')
      heartbeat = setInterval(() => {
        const endpoint = task.type === 'reason'
          ? `/projects/${encodeURIComponent(task.projectId)}/reason/heartbeat`
          : `/projects/${encodeURIComponent(task.projectId)}/intents/${encodeURIComponent(task.intentId!)}/heartbeat`
        void this.tryPost(endpoint, { worker: task.worker }).then(ok => {
          if (ok || task.cancelled) return
          task.cancelled = true
          task.handle?.agent.cancel({ kind: 'hook', reason: 'heartbeat lease lost' })
        })
      }, Math.max(1, this.limits().interval) * 1000)
      const resources = await this.resources(task.projectId, task.type).catch(() => [] as ResourceSummary[])
      task.handle.agent.followup(message(shared, taskPrompt(task, project, intent, resources)))
      let waited = await waitIdle(task.handle.agent, limits.timeout)
      if (!task.committed && !task.cancelled) {
        task.handle.agent.followup(message(shared, concludeInstruction(task.type)))
        waited = await waitIdle(task.handle.agent, limits.conclude_timeout ?? Math.min(60, limits.timeout))
      }
      outcome = task.committed ? 'success'
        : task.cancelled ? 'cancelled'
          : waited === 'timeout' ? 'timeout' : 'contract_error'
    } catch (error) {
      this.ctx.logger?.warn(error)
      process.stderr.write(`[redtrace-dsh] task ${task.type} failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
      outcome = task.cancelled ? 'cancelled' : 'runtime_error'
    } finally {
      if (heartbeat !== undefined) clearInterval(heartbeat)
      if (task.handle !== undefined) {
        await this.ctx.sessions.flush(task.handle.agent.session).catch(error => { this.ctx.logger?.warn(error) })
        await task.handle.dispose().catch(error => { this.ctx.logger?.warn(error) })
      }
      if (task.sessionId !== undefined) shared.tasks.delete(task.sessionId)
      await reportRun(this.config, task, outcome).catch(error => { this.ctx.logger?.warn(error) })
      const endpoint = task.type === 'reason'
        ? `/projects/${encodeURIComponent(task.projectId)}/reason/outcome`
        : `/projects/${encodeURIComponent(task.projectId)}/intents/${encodeURIComponent(task.intentId!)}/outcome`
      await this.tryPost(endpoint, {
        worker: task.worker,
        outcome,
        runtime_ms: Math.max(0, Date.now() - (task.startedAt ?? Date.now())),
        ...(task.type === 'reason' ? { base_planning_revision: project.project.planning_revision } : {}),
      })
    }
  }
}

function route(worker: WorkerSpec): { provider: string; model: string; maxTokens?: number } {
  return {
    provider: worker.provider === 'deepseek' ? 'deepseek-official' : worker.provider,
    model: worker.model,
    ...(worker.maxTokens === undefined ? {} : { maxTokens: worker.maxTokens }),
  }
}

/**
 * Select the Worker for one task: enabled, eligible for the task type, below
 * its per-worker concurrency cap; ordered by priority, then least-loaded
 * fairness, then name for determinism.
 */
export function selectWorker(
  workers: readonly WorkerSpec[],
  runningOf: (name: string) => number,
  type: TaskType,
): WorkerSpec | undefined {
  return workers
    .filter(worker => worker.enabled === true && worker[type] === true)
    .filter(worker => runningOf(worker.name) < Math.max(1, worker.maxRunning || 1))
    .sort((a, b) =>
      (a.priority - b.priority)
      || (runningOf(a.name) - runningOf(b.name))
      || a.name.localeCompare(b.name))[0]
}

/** Resolve the scheduling limits: hot-reloaded snapshot over config over
 * defaults. Every cap floors at 1; the tick interval defaults to 2s. */
export function resolveLimits(
  snapshot: RuntimeSnapshot | undefined,
  config: Pick<RuntimeConfig, 'maxWorkers' | 'maxRunningProjects' | 'maxProjectWorkers' | 'interval'>,
): { maxWorkers: number; maxRunningProjects: number; maxProjectWorkers: number; interval: number } {
  const fallback = snapshot?.limits
  return {
    maxWorkers: fallback?.maxWorkers ?? config.maxWorkers ?? 1,
    maxRunningProjects: fallback?.maxRunningProjects ?? config.maxRunningProjects ?? 1,
    maxProjectWorkers: fallback?.maxProjectWorkers ?? config.maxProjectWorkers ?? 1,
    interval: fallback?.interval ?? config.interval ?? 2,
  }
}

/** The project-level Reason cooldown: not eligible while the failure circuit
 * is open or the server-set retry deadline is still in the future. */
export function reasonEligible(summary: ProjectSummary, now: number): boolean {
  return !summary.reason_circuit_open && (summary.reason_retry_after ?? 0) <= now / 1000
}

/** Plan one dispatch round: rotate the active projects round-robin (cursor)
 * for cross-project fairness, then drop projects already at their per-project
 * cap or that would exceed the distinct-project cap. Caps are evaluated
 * against the passed running snapshot; the caller re-checks live state before
 * each launch because dispatching mutates the running set. */
export function planDispatch(
  summaries: readonly ProjectSummary[],
  running: readonly { projectId: string }[],
  limits: { maxWorkers: number; maxProjectWorkers: number; maxRunningProjects: number },
  cursor: number,
): { candidates: ProjectSummary[]; nextCursor: number } {
  if (running.length >= limits.maxWorkers) return { candidates: [], nextCursor: cursor }
  const active = summaries
    .filter(summary => summary.status === 'active')
    .sort((a, b) => a.id.localeCompare(b.id))
  if (active.length === 0) return { candidates: [], nextCursor: cursor }
  const offset = cursor % active.length
  const rotated = active.slice(offset).concat(active.slice(0, offset))
  const runningProjects = new Set(running.map(task => task.projectId))
  const candidates = rotated.filter(summary => {
    if (running.filter(task => task.projectId === summary.id).length >= limits.maxProjectWorkers) return false
    return runningProjects.has(summary.id) || runningProjects.size < limits.maxRunningProjects
  })
  return { candidates, nextCursor: cursor + 1 }
}

/** POST with up to 3 attempts and linear backoff (100/200/300ms). Retries
 * only network errors and HTTP >= 500; any 4xx answers immediately. */
export async function postWithRetry(
  url: string,
  body: Record<string, unknown>,
  options: {
    fetchFn?: typeof fetch
    sleep?: (ms: number) => Promise<void>
    onError?: (error: unknown) => void
  } = {},
): Promise<boolean> {
  const doFetch = options.fetchFn ?? fetch
  const sleep = options.sleep ?? (ms => new Promise<void>(resolve => { setTimeout(resolve, ms) }))
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await doFetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      })
      if (response.ok || response.status < 500) return response.ok
    } catch (error) {
      if (attempt === 2) options.onError?.(error)
    }
    await sleep(100 * (attempt + 1))
  }
  return false
}

export async function apply(ctx: RuntimeContext, config: RuntimeConfig = {}): Promise<void> {
  if (config.runtime !== true) return
  for (const key of ['server', 'root', 'sessionRoot', 'skillsDir', 'workspacesDir'] as const) {
    if (typeof config[key] !== 'string' || config[key]?.trim() === '') throw new Error(`redtrace runtime: ${key} is required`)
  }
  const scheduler = new Scheduler(ctx, config as RuntimeOptions)
  ctx.effect(() => {
    scheduler.start()
    return () => scheduler.close()
  }, 'redtrace runtime scheduler')
}
