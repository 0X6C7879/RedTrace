import { executionRole, isReportStep } from '../../redtrace-dsh/src/roles.ts'
import { RECOVERABLE_MODEL_FAILURES, recoverableModelFailure, modelRecoveryDelay, recoveryWorker } from './model-recovery.ts'
import { chatSlots } from './chat.ts'
import { LegionStore } from './legion-store.ts'
import { Store, ACTIVE_NODE_SQL } from './store.ts'
import path from 'node:path'
import { HttpError } from './types.ts'
import type { EngineConfig, Goal, Run, RunStatus, Worker, Step, TaskAssignment, GraphPlanner } from './types.ts'
import type { Operations } from './operations.ts'

export interface ExploreNotice { stepId: string; message: string; sourceIds?: string[] }
export interface ExploreNoticeResult { ok: boolean; status: 'queued' | 'duplicate' | 'rejected' | 'failed'; reason?: string; notificationId?: string; stepId?: string; runId?: string; sessionId?: string }
export interface TaskContext { store: Store; run: Run; worker: Worker; config: EngineConfig; signal: AbortSignal; operations?: Operations; currentMaxSteps?: () => number | null; featureAvailable?: (id: string) => boolean; taskPluginAllowed?: (id: string) => boolean; notifyExplore?: (notice: ExploreNotice) => ExploreNoticeResult }
export type RunTask = (context: TaskContext) => Promise<void>
export type SelectWorker = (worker: Worker, activity: Run['activity'], step?: TaskAssignment) => Worker | undefined
type Active = { run: Run; abort: AbortController; completion: Promise<void> }

export function capacityFull(config:EngineConfig,worker:Pick<Worker,'name'|'maxRunning'>|undefined,projectId:string|undefined,runs:Pick<Run,'worker'|'projectId'>[],commands:{workerName?:string;projectId:string}[]):'worker'|'project'|'projects'|null {
  if(worker&&runs.filter(r=>r.worker===worker.name).length+commands.filter(c=>c.workerName===worker.name).length>=worker.maxRunning)return 'worker'
  if(projectId!==undefined) {
    if(runs.filter(r=>r.projectId===projectId).length+commands.filter(c=>c.projectId===projectId).length>=config.maxProjectWorkers)return 'project'
    const projects=new Set([...runs.map(r=>r.projectId),...commands.filter(c=>c.projectId).map(c=>c.projectId)])
    if(!projects.has(projectId)&&projects.size>=config.maxRunningProjects)return 'projects'
  }
  return null
}

export class Scheduler {
  maintenance = false
  private readonly legion: LegionStore
  private readonly store: Store
  private readonly execute: RunTask
  private config: EngineConfig
  private running = new Map<string, Active>()
  private plannerTimer?: ReturnType<typeof setTimeout>
  private scheduled = false
  private closed = true
  private cursor = 0
  private readonly changed = () => this.wake()
  private readonly selectWorker: SelectWorker
  constructor(store: Store, config: EngineConfig, execute: RunTask, selectWorker: SelectWorker = worker => worker, _criticalEnabled: () => boolean = () => true) { this.store = store; this.legion = new LegionStore(store); this.config = config; this.execute = execute; this.selectWorker = selectWorker; this.store.stepLimit = () => this.config.maxSteps }
  start() { if (!this.closed) return; this.closed = false; this.store.recover(); this.store.changes.on('change', this.changed); this.wake() }
  update(config: EngineConfig) { this.config = config; this.wake() }
  get activeRuns() { return this.store.runsByStatus('running') }
  get commanderRunning() { return this.legion.campaigns().some(c=>c.status==='running') }
  wake() { if (this.closed || this.scheduled) return; this.scheduled = true; queueMicrotask(() => { this.scheduled = false; if (!this.closed) this.dispatch() }) }
  private select(resume: Run | undefined, step: TaskAssignment, active: Run[], commands: ReturnType<typeof chatSlots>) {
    const count = (name: string) => active.filter(r => r.worker === name).length+commands.filter(c=>c.workerName===name).length
    const previous=step.role==='general'?this.store.forGraph(step.projectId,step.graphId!).runs(step.projectId,{activity:'plan',limit:1})[0]:undefined
    const preferred=previous?.worker
    return this.config.workers.map(w => this.selectWorker(w, step.role==='general'?'plan':'execute', step)).map(w => !w ? w : resume?.provider && this.config.providers?.[resume.provider]?.models.some(m=>m.id===resume.model) ? {...w, provider:resume.provider, model:resume.model} : previous?.status==='failed' && recoverableModelFailure(previous.failureCode) ? recoveryWorker(this.config,w,previous) : w).filter((w): w is Worker => !!w && w.enabled && (!step.nextWorker || w.name===step.nextWorker) && !!w.roles?.includes(executionRole(this.store.project(step.projectId).mode, step.role)) && (!resume || w.name === resume.worker && w.backend === resume.backend) && !capacityFull(this.config,w,undefined,active,commands))
      .sort((a,b) => a.priority-b.priority || Number(b.name===preferred)-Number(a.name===preferred) || count(a.name)-count(b.name) || a.name.localeCompare(b.name))[0]
  }
  private dispatch() {
    if (this.maintenance) return
    for (const task of this.running.values()) {
      try {
        const project = this.store.project(task.run.projectId), step = this.store.assignment(task.run)!
        const goal=this.store.node<Goal>(project.id,step.goalId,'goal'),accepted=step.status==='done'&&goal.status==='achieved'
        // An accepting owner still holds its Run slot until the final tool result is recorded.
        if (this.store.run(task.run.id).status !== 'running' || !(isReportStep(step)||accepted ? ['active','completed'].includes(project.status) : project.status === 'active') || ['cancelled','parked'].includes(step.status) || !isReportStep(step)&&!accepted&&goal.status!=='open') task.abort.abort('Project or Step stopped')
      } catch (error) { if (error instanceof HttpError && error.status===404) task.abort.abort('Project deleted'); else throw error }
    }
    const commands=[...this.legion.campaigns().filter(c=>c.status==='running'),...chatSlots(this.store)], active = this.activeRuns, projects = this.store.projects().filter(p=>['active','completed'].includes(p.status))
    let progress = true, nextWakeAt = Infinity
    while(progress) {
      progress = false
      for(let i=0;i<projects.length;i++) {
        const project=projects[(this.cursor+i)%projects.length]
        if(capacityFull(this.config,undefined,project.id,active,commands))continue
        const openGoals=new Set(this.store.db.prepare(`SELECT id FROM nodes WHERE project_id=? AND kind='goal' AND status='open' AND ${ACTIVE_NODE_SQL}`).all(project.id).map(r=>String(r.id)))
        const questionLimit = this.config.maxBenchmarkTasks ?? null
        const activeQuestions = new Set(project.mode==='benchmark' && questionLimit!==null ? [...active.filter(r=>r.projectId===project.id), ...this.store.runsByStatus('unknown',project.id)].map(r=>r.graphId) : [])
        const steps=this.store.nodes<Step>(project.id,['step'],{statuses:['pending','paused']}).filter(s=>!s.deleted&&!s.replacementPending&&(isReportStep(s)||project.status==='active'&&openGoals.has(s.goalId))).sort((a,b)=>(project.mode==='benchmark' && questionLimit!==null && activeQuestions.size<questionLimit ? Number(activeQuestions.has(a.graphId))-Number(activeQuestions.has(b.graphId)) : 0)||b.priority-a.priority||a.createdAt.localeCompare(b.createdAt)||a.id.localeCompare(b.id))
        const planners=this.store.projectGraphs(project.id).map(g=>g.planner).filter((p):p is GraphPlanner=>!!p&&['pending','paused'].includes(p.status)&&openGoals.has(p.goalId))
        const queue:TaskAssignment[]=[...planners,...steps]
        const runs=this.store.runs(project.id,{statuses:['paused']})
        const capacities=new Map<Step['graphId'],ReturnType<Store['planningCapacity']>>()
        for(const step of queue) {
          if(project.mode==='benchmark' && questionLimit!==null && !activeQuestions.has(step.graphId) && activeQuestions.size>=questionLimit)continue
          if(step.role!=='general'&&!this.store.stepReady(step as Step))continue
          const reserved=runs.some(r=>r.stepId===step.id&&r.activity==='execute')
          if(step.role!=='general'&&!reserved) {
            if(!capacities.has(step.graphId))capacities.set(step.graphId,this.store.planningCapacity(project.id,this.config.maxSteps,step.graphId??undefined))
            if(capacities.get(step.graphId)!.remainingSteps===0)continue
          }
          const readyAt=step.role==='general'?this.store.plannerWakeAt(step as GraphPlanner):step.retryAfter??0
          if(readyAt>Date.now()){nextWakeAt=Math.min(nextWakeAt,readyAt);continue}
          const resume=step.status==='paused'?runs.find(r=>step.role==='general'?r.activity==='plan'&&r.graphId===step.graphId:r.stepId===step.id):undefined
          const worker=this.select(resume,step,active,commands);if(!worker)continue
          const run=step.role==='general'?this.store.forGraph(project.id,step.graphId!).claim(project.id,'plan',worker):this.store.claim(project.id,'execute',worker,step.id);active.push(run);this.launch(run,worker);progress=true;break
        }
      }
      if(projects.length)this.cursor=(this.cursor+1)%projects.length
    }
    clearTimeout(this.plannerTimer)
    if (Number.isFinite(nextWakeAt)) { this.plannerTimer = setTimeout(() => this.wake(), Math.max(0,nextWakeAt-Date.now())); this.plannerTimer.unref() }
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
      try { await this.execute({ store: run.graphId ? this.store.forGraph(run.projectId,run.graphId) : this.store.forProject(run.projectId), run, worker: structuredClone(worker), config, signal: abort.signal, currentMaxSteps: () => this.config.maxSteps }) }
      catch (reason) { status = 'failed'; error = reason instanceof Error ? reason.message : String(reason) }
      finally {
        try {
          if (abort.signal.aborted) {
            const project = this.store.project(run.projectId)
            status = error ? 'unknown' : (this.closed || project.status === 'stopped') && ['execute','plan'].includes(run.activity) ? 'paused' : 'cancelled'
          }
          if (this.store.run(run.id).pendingTools.length) { status = 'unknown'; error = 'Activity stopped with an unconfirmed tool result; verify before retrying' }
          this.store.finishRun(run.id, status, error)
          const step = this.store.assignment(run) as Step
          if(run.activity==='plan'){if(this.store.project(run.projectId).mode==='benchmark')this.legion.completeBenchmark(run.projectId);return}
          if (step.handoffPending && status==='cancelled' && this.store.project(run.projectId).status==='active') this.resumeHandoff(run.projectId,step)
          if(this.store.project(run.projectId).mode==='benchmark')this.legion.completeBenchmark(run.projectId)
          // Deleting a project mid-abort cascades its runs away; there is nothing left to finish.
        } catch (reason) { if (!(reason instanceof HttpError && reason.status === 404)) throw reason }
        finally { this.running.delete(run.id); this.wake() }
      }
    })()
  }
  private resumeHandoff(projectId: string, step: Step) {
    const old=step.predecessorRunId?this.store.run(step.predecessorRunId):undefined
    if(old&&!['running','unknown'].includes(old.status)&&!old.pendingTools.length)this.legion.completeHandoff(projectId,step.id)
  }
  /** Sapper's dead-worker recovery, bounded per native Session; strategy stays with Commander. */
  watchdog() {
    if(this.closed||this.maintenance)return
    const projects=this.store.projects().filter(p=>p.status==='active')
    for(const project of projects)for(const row of this.store.db.prepare(`SELECT data FROM nodes WHERE project_id=? AND kind='step' AND status='parked' AND json_extract(data,'$.handoffPending')=1 AND ${ACTIVE_NODE_SQL} ORDER BY rowid`).all(project.id))this.resumeHandoff(project.id,{version:1,...JSON.parse(String(row.data))})
    const active=this.activeRuns
    // The existing five-minute tactical threshold wakes a task Planner only once per idle interval.
    for(const project of projects.filter(p=>p.mode==='benchmark')) {
      const graphs=this.store.projectGraphs(project.id).filter(g=>g.planner?.status==='pending'),graphIds=new Set(graphs.map(g=>g.id))
      const runs=active.filter(r=>r.projectId===project.id&&r.activity==='execute'&&!r.pendingTools.length&&graphIds.has(r.graphId!))
      if(!runs.length)continue
      const activity=new Map(this.store.db.prepare("SELECT value AS run_id,(SELECT json_extract(data,'$.timestamp') FROM audit_events WHERE run_id=ids.value AND kind IN ('tool.started','tool.completed','command.completed') ORDER BY id DESC LIMIT 1) AS at FROM json_each(?) ids").all(JSON.stringify(runs.map(r=>r.id))).map(row=>[String(row.run_id),row.at]))
      for(const graph of graphs) {
        for(const run of runs.filter(r=>r.graphId===graph.id)) {
          const last=String(activity.get(run.id)??run.startedAt)
          if(Date.now()-Date.parse(last)<5*60_000||this.store.db.prepare("SELECT 1 FROM events WHERE project_id=? AND graph_id=? AND type='planner.stalled' AND json_extract(data,'$.runId')=? AND created_at>=? LIMIT 1").get(project.id,graph.id,run.id,last))continue
          this.store.transaction(()=>this.store.forGraph(project.id,graph.id).event(project.id,'planner.stalled',null,{runId:run.id,reason:'No tool activity for the existing tactical interval'}))
        }
      }
    }
    const failed=this.store.db.prepare("SELECT r.data FROM runs r JOIN projects p ON p.id=r.project_id WHERE r.status='failed' AND r.step_id<>'' AND json_array_length(r.data,'$.pendingTools')=0 AND json_extract(p.data,'$.status')='active' AND json_extract(r.data,'$.failureCode') IN (SELECT value FROM json_each(?)) AND r.id NOT IN (SELECT value FROM json_each(?)) ORDER BY r.rowid").all(JSON.stringify(RECOVERABLE_MODEL_FAILURES),JSON.stringify([...this.running.keys()]))
    for(const row of failed) {
      const run=JSON.parse(String(row.data)) as Run
      const step=this.store.node<Step>(run.projectId,run.stepId!,'step')
      if(this.store.planningCapacity(run.projectId,this.config.maxSteps,step.graphId??undefined).remainingSteps===0||step.status!=='blocked'||this.store.latestRun(run.projectId,step.id)?.id!==run.id||this.legion.budget(Date.now(),run.projectId).phase==='ended')continue
      this.store.transaction(()=>{
        const worker=this.config.workers.find(w=>w.name===run.worker)
        if(worker){const next=recoveryWorker(this.config,worker,run);run.provider=next.provider;run.model=next.model}
        step.failureCount=(step.failureCount??0)+1;run.status='paused';run.endedAt=null;run.error=null;delete run.failureCode
        step.status='paused';step.failure=null;step.endedAt=null;step.retryAfter=Date.now()+modelRecoveryDelay(step.failureCount)
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
    clearTimeout(this.plannerTimer)
    this.store.changes.off('change', this.changed)
    for (const task of this.running.values()) task.abort.abort('Engine shutting down')
    await Promise.all([...this.running.values()].map(t => t.completion))
  }
}
