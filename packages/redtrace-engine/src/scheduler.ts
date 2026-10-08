import { Store } from './store.ts'
import path from 'node:path'
import { HttpError } from './types.ts'
import type { EngineConfig, Goal, Run, RunStatus, Worker, Step } from './types.ts'
import type { JevService } from './jev.ts'

export interface TaskContext { store: Store; run: Run; worker: Worker; config: EngineConfig; signal: AbortSignal; jev?: JevService }
export type RunTask = (context: TaskContext) => Promise<void>
export type SelectWorker = (worker: Worker, activity: Run['activity'], step?: Step) => Worker | undefined
type Active = { run: Run; abort: AbortController; completion: Promise<void> }

export class Scheduler {
  maintenance = false
  private readonly store: Store
  private readonly execute: RunTask
  private config: EngineConfig
  private running = new Map<string, Active>()
  private scheduled = false
  private closed = true
  private retryTimer?: ReturnType<typeof setTimeout>
  private cursor = 0
  private readonly changed = () => this.wake()
  private readonly selectWorker: SelectWorker
  constructor(store: Store, config: EngineConfig, execute: RunTask, selectWorker: SelectWorker = worker => worker) { this.store = store; this.config = config; this.execute = execute; this.selectWorker = selectWorker }
  start() {
    if (!this.closed) return
    this.closed = false; this.store.recover(); this.store.changes.on('change', this.changed); this.wake()
  }
  update(config: EngineConfig) { this.config = config; this.wake() }
  get activeRuns() { return this.store.runs().filter(r => r.status === 'running') }
  wake() {
    if (this.closed || this.scheduled) return
    this.scheduled = true
    queueMicrotask(() => { this.scheduled = false; if (!this.closed) this.dispatch() })
  }
  private select(activity: Run['activity'], resume?: Run, step?: Step): Worker | undefined {
    const count = (name: string) => this.activeRuns.filter(r => r.worker === name).length
    return this.config.workers.map(w => this.selectWorker(w, activity, step)).filter((w): w is Worker => !!w && w.enabled && this.eligible(w, activity, step) && (!resume || (w.name === resume.worker && w.backend === resume.backend)) && count(w.name) < w.maxRunning)
      .sort((a, b) => a.priority - b.priority || count(a.name) - count(b.name) || a.name.localeCompare(b.name))[0]
  }
  /** Decide needs a `reason` worker; an Execute run carries the Step it claims,
   * so a bootstrap Step only ever reaches a `bootstrap` worker and an ordinary
   * Step only ever reaches an `explore` worker. */
  private eligible(worker: Worker, activity: Run['activity'], step?: Step): boolean {
    if (activity === 'decide') return worker.reason
    return step?.bootstrap ? worker.bootstrap : worker.explore
  }
  private dispatch() {
    if (this.maintenance) return
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = undefined }
    for (const task of this.running.values()) {
      try {
        const project = this.store.project(task.run.projectId)
        const step = task.run.stepId ? this.store.node<Step>(task.run.projectId, task.run.stepId, 'step') : undefined
        const goalOpen = !step || this.store.node<Goal>(task.run.projectId, step.goalId, 'goal').status === 'open'
        if (this.store.run(task.run.id).status !== 'running' || (project.status !== 'active' && !(project.status === 'completed' && task.run.activity === 'decide')) || step?.status === 'cancelled' || !goalOpen) task.abort.abort('Project or Step stopped')
      } catch (reason) { if (reason instanceof HttpError && reason.status === 404) task.abort.abort('Project deleted'); else throw reason }
    }
    const projects = this.store.projects().filter(p => p.status === 'active')
    if (!projects.length) return
    let retryAt = Infinity, madeProgress = true
    while (madeProgress && this.activeRuns.length < this.config.maxWorkers) {
      madeProgress = false
      for (let i = 0; i < projects.length && this.activeRuns.length < this.config.maxWorkers; i++) {
        const project = projects[(this.cursor + i) % projects.length]
        const active = this.activeRuns
        if (active.filter(r => r.projectId === project.id).length >= this.config.maxProjectWorkers) continue
        if (!active.some(r => r.projectId === project.id) && new Set(active.map(r => r.projectId)).size >= this.config.maxRunningProjects) continue
        const p = this.store.project(project.id)
        if (p.status !== 'active') continue
        const nodes = this.store.nodes<Step | Goal>(p.id, ['step', 'goal'])
        const steps = nodes.filter((node): node is Step => node.kind === 'step')
        const goals = new Map(nodes.filter(node => node.kind === 'goal').map(goal => [goal.id, goal]))
        // Bootstrap is a strict project gate, not merely the first runnable
        // Step. Reason may start only after that Step succeeded with a Fact.
        // A failed/cancelled/empty Bootstrap remains visible for diagnosis and
        // can be retried explicitly without planning from an uninitialized graph.
        const bootstrap = steps.find(s => s.bootstrap)
        const bootstrapComplete = !p.bootstrap || !!bootstrap && bootstrap.status === 'done' && bootstrap.factIds.length > 0
        const occupied = steps.filter(step => ['pending', 'running', 'paused'].includes(step.status)).length
        const hasCapacity = this.config.maxSteps === null || occupied < this.config.maxSteps
        const pendingPair = p.factSeq > p.acknowledgedFactSeq && p.endedSeq > p.acknowledgedEndedSeq
        const needsDecide = bootstrapComplete && hasCapacity && (p.initialPlanningPending || p.planningRetryPending || pendingPair)
          && !active.some(r => r.projectId === p.id && r.activity === 'decide')
        if (needsDecide) {
          if (p.retryAfter > Date.now()) retryAt = Math.min(retryAt, p.retryAfter)
          else {
            const worker = this.select('decide')
            if (worker) { this.launch(this.store.claim(p.id, 'decide', worker), worker); madeProgress = true; continue }
          }
        }
        // An unavailable Decide never prevents existing execution work from starting.
        const runnable = steps.filter(s => ['pending', 'paused'].includes(s.status) && goals.get(s.goalId)?.status === 'open')
          .sort((a, b) => b.priority - a.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        for (const step of runnable) {
          const paused = step.status === 'paused' ? this.store.runs(p.id).find(r => r.stepId === step.id && r.status === 'paused') : undefined
          const worker = this.select('execute', paused, step)
          if (!worker) continue
          this.launch(this.store.claim(p.id, 'execute', worker, step.id), worker); madeProgress = true; break
        }
      }
      this.cursor = (this.cursor + 1) % projects.length
    }
    if (Number.isFinite(retryAt)) this.retryTimer = setTimeout(() => this.wake(), Math.max(1, retryAt - Date.now()))
  }
  private launch(run: Run, worker: Worker) {
    const abort = new AbortController(), config = structuredClone(this.config)
    run.provider = worker.provider; run.model = worker.model; run.workspaceRoot = path.join(config.workspaceRoot, run.projectId)
    this.store.transaction(() => this.store.saveRun(run))
    const task: Active = { run, abort, completion: Promise.resolve() }
    this.running.set(run.id, task)
    task.completion = (async () => {
      let status: RunStatus = 'succeeded', error: string | null = null
      try { await this.execute({ store: this.store, run, worker: structuredClone(worker), config, signal: abort.signal }) }
      catch (reason) { status = 'failed'; error = reason instanceof Error ? reason.message : String(reason) }
      finally {
        try {
          if (abort.signal.aborted) {
            const project = this.store.project(run.projectId)
            status = (this.closed || project.status === 'stopped') && run.activity === 'execute' ? 'paused' : 'cancelled'
            error = null
            if (this.store.run(run.id).pendingTools.length) { status = 'unknown'; error = 'Activity stopped with an unconfirmed tool result; verify before retrying' }
          }
          this.store.finishRun(run.id, status, error)
          // Deleting a project mid-abort cascades its runs away; there is nothing left to finish.
        } catch (reason) { if (!(reason instanceof HttpError && reason.status === 404)) throw reason }
        finally { this.running.delete(run.id); this.wake() }
      }
    })()
  }
  async close() {
    this.closed = true
    this.store.changes.off('change', this.changed)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    for (const task of this.running.values()) task.abort.abort('Engine shutting down')
    await Promise.all([...this.running.values()].map(t => t.completion))
  }
}
