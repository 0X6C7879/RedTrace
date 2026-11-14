import { LegionStore } from './legion-store.ts'
import { Store, ACTIVE_NODE_SQL } from './store.ts'
import path from 'node:path'
import { HttpError } from './types.ts'
import type { EngineConfig, Goal, Run, RunStatus, Worker, Step } from './types.ts'
import type { Operations } from './operations.ts'

export interface ExploreNotice { stepId: string; message: string; sourceIds?: string[] }
export interface ExploreNoticeResult { ok: boolean; status: 'queued' | 'duplicate' | 'rejected' | 'failed'; reason?: string; notificationId?: string; stepId?: string; runId?: string; sessionId?: string }
export interface TaskContext { store: Store; run: Run; worker: Worker; config: EngineConfig; signal: AbortSignal; operations?: Operations; currentMaxSteps?: () => number | null; featureAvailable?: (id: string) => boolean; taskPluginAllowed?: (id: string) => boolean; notifyExplore?: (notice: ExploreNotice) => ExploreNoticeResult }
export type RunTask = (context: TaskContext) => Promise<void>
export type SelectWorker = (worker: Worker, activity: Run['activity'], step?: Step) => Worker | undefined
type Active = { run: Run; abort: AbortController; completion: Promise<void> }

export class Scheduler {
  maintenance = false
  private readonly legion: LegionStore
  private readonly store: Store
  private readonly execute: RunTask
  private config: EngineConfig
  private running = new Map<string, Active>()
  private scheduled = false
  private closed = true
  private cursor = 0
  private readonly changed = () => this.wake()
  private readonly selectWorker: SelectWorker
  constructor(store: Store, config: EngineConfig, execute: RunTask, selectWorker: SelectWorker = worker => worker, _criticalEnabled: () => boolean = () => true) { this.store = store; this.legion = new LegionStore(store); this.config = config; this.execute = execute; this.selectWorker = selectWorker }
  start() { if (!this.closed) return; this.closed = false; this.store.recover(); this.store.changes.on('change', this.changed); this.wake() }
  update(config: EngineConfig) { this.config = config; this.wake() }
  get activeRuns() { return this.store.runsByStatus('running') }
  get commanderRunning() { return this.legion.campaigns().some(c=>c.status==='running') }
  wake() { if (this.closed || this.scheduled) return; this.scheduled = true; queueMicrotask(() => { this.scheduled = false; if (!this.closed) this.dispatch() }) }
  private select(resume: Run | undefined, step: Step, active: Run[]) {
    const commands=this.legion.campaigns().filter(c=>c.status==='running')
    const count = (name: string) => active.filter(r => r.worker === name).length+commands.filter(c=>c.workerName===name).length
    return this.config.workers.map(w => this.selectWorker(w, 'execute', step)).filter((w): w is Worker => !!w && w.enabled && (!step.nextWorker || w.name===step.nextWorker) && !!w.roles?.includes(step.role === 'reporter' ? 'soldier' : step.role ?? 'soldier') && (!resume || w.name === resume.worker && w.backend === resume.backend) && count(w.name) < w.maxRunning)
      .sort((a,b) => a.priority-b.priority || count(a.name)-count(b.name) || a.name.localeCompare(b.name))[0]
  }
  private dispatch() {
    if (this.maintenance) return
    for (const task of this.running.values()) {
      try {
        const project = this.store.project(task.run.projectId), step = this.store.node<Step>(project.id, task.run.stepId!, 'step')
        if (this.store.run(task.run.id).status !== 'running' || !(step.role === 'reporter' ? ['active','completed'].includes(project.status) : project.status === 'active') || ['cancelled','parked'].includes(step.status) || step.role !== 'reporter' && this.store.node<Goal>(project.id,step.goalId,'goal').status !== 'open') task.abort.abort('Project or Step stopped')
      } catch (error) { if (error instanceof HttpError && error.status===404) task.abort.abort('Project deleted'); else throw error }
    }
    const commands=this.legion.campaigns().filter(c=>c.status==='running'), commandSlots=commands.length, active = this.activeRuns, projects = this.store.projects().filter(p=>['active','completed'].includes(p.status))
    let progress = true
    while(progress && active.length+commandSlots < this.config.maxWorkers) {
      progress = false
      for(let i=0;i<projects.length && active.length+commandSlots<this.config.maxWorkers;i++) {
        const project=projects[(this.cursor+i)%projects.length]
        if(active.filter(r=>r.projectId===project.id).length+commands.filter(c=>c.projectId===project.id).length>=this.config.maxProjectWorkers)continue
        if(!active.some(r=>r.projectId===project.id)&&!commands.some(c=>c.projectId===project.id)&&new Set([...active.map(r=>r.projectId),...commands.map(c=>c.projectId)]).size>=this.config.maxRunningProjects)continue
        const steps=this.store.nodes<Step>(project.id,['step']).filter(s=>!s.deleted&&!s.replacementPending&&['pending','paused'].includes(s.status)&&(s.role==='reporter'||project.status==='active'&&this.store.node<Goal>(project.id,s.goalId,'goal').status==='open')).sort((a,b)=>b.priority-a.priority||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))
        for(const step of steps) {
          const resume=step.status==='paused'?this.store.runsByStatus('paused',project.id).find(r=>r.stepId===step.id):undefined
          const worker=this.select(resume,step,active);if(!worker)continue
          const run=this.store.claim(project.id,'execute',worker,step.id);active.push(run);this.launch(run,worker);progress=true;break
        }
      }
      if(projects.length)this.cursor=(this.cursor+1)%projects.length
    }
  }
  private launch(run: Run, worker: Worker) {
    const abort = new AbortController(), config = structuredClone(this.config)
    run.provider = worker.provider; run.model = worker.model
    if (run.workspaceRoot == null) {
      const title = run.graphId ? this.store.projectGraph(run.projectId, run.graphId).title : this.store.project(run.projectId).title
      const directory = title.replace(/[<>:"\/\\|?*\u0000-\u001f]/g, '_').replace(/^\.+$|[. ]+$/g, '_')
      run.workspaceRoot = path.join(config.workspaceRoot, run.projectId, 'agents', directory, run.id)
    }
    this.store.transaction(() => this.store.saveRun(run))
    const task: Active = { run, abort, completion: Promise.resolve() }
    this.running.set(run.id, task)
    task.completion = (async () => {
      let status: RunStatus = 'succeeded', error: string | null = null
      try { await this.execute({ store: run.graphId ? this.store.forGraph(run.projectId,run.graphId) : this.store.forProject(run.projectId), run, worker: structuredClone(worker), config, signal: abort.signal }) }
      catch (reason) { status = 'failed'; error = reason instanceof Error ? reason.message : String(reason) }
      finally {
        try {
          if (abort.signal.aborted) {
            const project = this.store.project(run.projectId)
            status = error ? 'unknown' : (this.closed || project.status === 'stopped') && run.activity === 'execute' ? 'paused' : 'cancelled'
            if (this.store.run(run.id).pendingTools.length) { status = 'unknown'; error = 'Activity stopped with an unconfirmed tool result; verify before retrying' }
          }
          const completed=this.store.finishRun(run.id, status, error)
          const step = this.store.node<Step>(run.projectId, run.stepId!, 'step')
          if(completed.status==='succeeded'&&step.role==='scout'&&step.scoutVerdict)this.legion.classify(run.projectId,step.taskKey!,step.scoutVerdict.difficulty,step.factIds,step.scoutVerdict.family)
          if (step.handoffPending && status==='cancelled' && this.store.project(run.projectId).status==='active') new LegionStore(this.store).completeHandoff(run.projectId,step.id)
          if(this.store.project(run.projectId).mode==='benchmark')this.legion.completeBenchmark(run.projectId)
          // Deleting a project mid-abort cascades its runs away; there is nothing left to finish.
        } catch (reason) { if (!(reason instanceof HttpError && reason.status === 404)) throw reason }
        finally { this.running.delete(run.id); this.wake() }
      }
    })()
  }
  /** Sapper's dead-worker recovery, bounded per native Session; strategy stays with Commander. */
  watchdog() {
    if(this.closed||this.maintenance)return
    for(const run of this.store.runsByStatus('failed')) {
      if(this.running.has(run.id)||!run.stepId||run.pendingTools.length||this.store.project(run.projectId).mode!=='benchmark'||this.store.project(run.projectId).status!=='active')continue
      if(!['PROCESS_EXIT','UNKNOWN','SERVER','TIMEOUT','TRANSPORT','STREAM_CLOSED','EMPTY_RESPONSE','RATE_LIMIT'].includes(run.failureCode??''))continue
      const step=this.store.node<Step>(run.projectId,run.stepId,'step')
      if((step.failureCount??0)>=3||step.status!=='blocked'||this.store.latestRun(run.projectId,step.id)?.id!==run.id||this.legion.budget(Date.now(),run.projectId).phase==='ended')continue
      this.store.transaction(()=>{
        step.failureCount=(step.failureCount??0)+1;run.status='paused';run.endedAt=null;run.error=null;delete run.failureCode
        step.status='paused';step.failure=null;step.endedAt=null
        this.store.saveRun(run);this.store.saveNode(step)
        this.store.event(run.projectId,'legion.worker_restarted',step,{runId:run.id,restarts:step.failureCount})
      })
    }
    this.wake()
  }
  async stopProject(projectId:string) {
    const tasks=[...this.running.values()].filter(t=>t.run.projectId===projectId)
    for(const task of tasks)task.abort.abort('Project stopped or deleted')
    await Promise.all(tasks.map(t=>t.completion))
  }
  async close() {
    this.closed = true
    this.store.changes.off('change', this.changed)
    for (const task of this.running.values()) task.abort.abort('Engine shutting down')
    await Promise.all([...this.running.values()].map(t => t.completion))
  }
}
