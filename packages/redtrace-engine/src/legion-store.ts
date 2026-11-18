import { executorRole, coordinatorRole } from '../../redtrace-dsh/src/roles.ts'
import { randomUUID } from 'node:crypto'
import { CommanderTodos } from './legion-todos.ts'
import { benchmarkPlatformView } from './benchmark-metadata.ts'
import { Store } from './store.ts'
import { HttpError, now, requiredText } from './types.ts'
import type { Step, Goal, LegionRole } from './types.ts'

export interface CommandCursor { delivered: number; acknowledged: number }
export interface Campaign {
  projectId: string; sessionId: string; status: 'idle' | 'running' | 'stopped'; state: string
  stateScope?: 'scheduling'
  nextInspectionAt?: number; restarts?: number; failureCode?: string; nativeCompactionSummary?: string; hasSession?: boolean; workerName?: string; usage?: {inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number}; error?: string; endgame?: string; startedAt?: number; deadline?: number; pendingTools?: string[]; nextWorker?: string; reasoning?: string; previousSessionId?: string
  sessionHistory?: string[]
  cursors: Record<string, CommandCursor>
}
export interface SpawnMission {
  specialist?: Step['specialist']; escalationReason?: string; role: LegionRole; taskKey: string; description: string; sourceIds: string[]
  dependsOn?: string[]; reportFindingId?: string; graphId?: string; goalId?: string; parentRunId?: string; priority?: number; executionProfile?: Step['executionProfile']
}

/** Union actual execution intervals; wall-clock pauses/offline gaps are not attack stagnation. */
export function executionTime(runs: import('./types.ts').Run[], at: number, after=0) {
  const spans=runs.map(r=>[Math.max(after,Date.parse(r.startedAt)),r.endedAt?Date.parse(r.endedAt):r.status==='running'?at:Date.parse(r.startedAt)]).filter(([a,b])=>b>a).sort((a,b)=>a[0]-b[0])
  let total=0,end=after
  for(const [a,b]of spans){total+=Math.max(0,b-Math.max(a,end));end=Math.max(end,b)}
  return total
}

/** Durable organization state; execution still belongs to Store and Scheduler. */
export class LegionStore {
  readonly store: Store
  readonly projectId?: string
  // The engine-owned LegionStore outlives individual Commander DSH activations.
  private readonly todos = new Map<string, CommanderTodos>()
  planningTodos(projectId: string): CommanderTodos {
    const id = this.owner(projectId)
    let todos = this.todos.get(id)
    if (!todos) { todos = new CommanderTodos(this.store, id); this.todos.set(id, todos) }
    return todos
  }
  constructor(store: Store, projectId?: string) {
    this.projectId = projectId ?? store.projectScope
    this.store = this.projectId ? store.forProject(this.projectId) : store
    store.db.exec(
      'CREATE TABLE IF NOT EXISTS legion_messages(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
      'sender TEXT NOT NULL, receiver TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS legion_tasks(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,task_key));' +
      'CREATE TABLE IF NOT EXISTS legion_platform_events(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_key TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);')
  }
  private owner(projectId = this.projectId): string {
    const id = projectId ?? (this.store.projects().length===1 ? this.store.projects()[0].id : undefined)
    if (!id) throw new HttpError(422,'Select a Project Commander')
    this.store.project(id); return id
  }
  campaign(projectId?: string): Campaign {
    const id=this.owner(projectId), row=this.store.db.prepare('SELECT data FROM project_campaigns WHERE project_id=?').get(id)
    if(!row) throw new HttpError(404,'Project Commander not initialized')
    return JSON.parse(String(row.data))
  }
  campaigns(): Campaign[] { return this.store.projects().map(p=>this.campaign(p.id)) }
  commanderState(projectId?:string) {
    const c=this.campaign(projectId)
    return this.store.project(c.projectId).mode==='benchmark'&&c.stateScope!=='scheduling'?'Legacy tactical STATE is archived, not scheduling authority. Rebuild allocation from current Board, live owners and unfinished user instructions.':c.state
  }
  saveCampaign(campaign: Campaign) {
    const id=this.owner(campaign.projectId)
    this.store.db.prepare('UPDATE project_campaigns SET data=? WHERE project_id=?').run(JSON.stringify(campaign),id)
  }

  budget(at=Date.now(),projectId?:string) {
    const c=this.campaign(projectId), left=c.deadline===undefined?null:Math.max(0,c.deadline-at), total=c.deadline===undefined?null:c.deadline-(c.startedAt??at)
    return { remainingMs:left,phase:left===null?'open':left===0?'ended':left<=20*60000?'submission':total!==null&&left<=total/4?'endgame':'campaign' }
  }
  setDeadline(deadline:number,projectId?:string) {
    if(!Number.isFinite(deadline)||deadline<=Date.now())throw new HttpError(422,'Deadline must be a future epoch in milliseconds')
    const c=this.campaign(projectId);c.startedAt=Date.now();c.deadline=deadline;this.saveCampaign(c);this.store.changes.emit('legion-budget',c.projectId);return this.budget(Date.now(),c.projectId)
  }
  tactics(projectId:string,at=Date.now()) {
    const tasks=new Set([...this.store.projectGraphs(projectId).filter(g=>g.taskKey).map(g=>g.taskKey!),...this.store.nodes<Step>(projectId,['step']).filter(s=>!s.deleted).map(s=>s.taskKey??s.goalId)])
    if(this.store.project(projectId).mode==='general') return []
    const senior='general'
    const runs=this.store.runs(projectId)
    const observed=new Map(this.store.db.prepare("SELECT run_id,MAX(json_extract(data,'$.timestamp')) AS at FROM audit_events WHERE project_id=? AND json_extract(data,'$.kind') IN ('assistant.message','thinking.message','tool.completed','command.completed') GROUP BY run_id").all(projectId).map(row=>[String(row.run_id),String(row.at)]))
    const confirmedEnd=(run:import('./types.ts').Run,time:string)=>run.error?.startsWith('Process stopped')?new Date(Math.min(Date.parse(time),Date.parse(observed.get(run.id)??run.startedAt))).toISOString():time
    const intervals=new Map<string,import('./types.ts').Run[]>(),open=new Map<string,string>(),byRunId=new Map(runs.map(r=>[r.id,r]))
    for(const row of this.store.db.prepare("SELECT type,created_at,json_extract(data,'$.runId') AS run_id FROM events WHERE project_id=? AND type IN ('execute.started','execute.paused','execute.succeeded','execute.failed','execute.unknown','execute.cancelled','planner.started','planner.paused','planner.succeeded','planner.failed','planner.unknown','planner.cancelled') ORDER BY id").all(projectId)) {
      const id=String(row.run_id),time=String(row.created_at)
      if(String(row.type).endsWith('.started'))open.set(id,time)
      else if(open.has(id)){const run=byRunId.get(id);if(run){const list=intervals.get(id)??[];list.push({...run,startedAt:open.get(id)!,endedAt:confirmedEnd(run,time)});intervals.set(id,list)}open.delete(id)}
    }
    for(const [id,time]of open){const run=byRunId.get(id);if(run?.status==='running')intervals.set(id,[...(intervals.get(id)??[]),{...run,startedAt:time}])}
    const evidence=new Map<string,string>(this.store.db.prepare("SELECT graph_id,MAX(created_at) AS at FROM events WHERE project_id=? AND type IN ('fact.added','finding.added') GROUP BY graph_id").all(projectId).map(r=>[String(r.graph_id),String(r.at)]))
    return [...tasks].map(taskKey=>{
      const steps=this.steps(projectId,taskKey),ids=new Set(steps.map(s=>s.id))
      const taskRuns=runs.filter(r=>ids.has(r.stepId??'')),timedRuns=taskRuns.flatMap(r=>intervals.get(r.id)??[{...r,endedAt:r.endedAt?confirmedEnd(r,r.endedAt):r.endedAt}]),elapsedMs=executionTime(timedRuns,at)
      const row=this.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey),classification=row?JSON.parse(String(row.data)):null
      const graph=this.store.projectGraphs(projectId).find(g=>g.taskKey===taskKey),lastEvidenceAt=evidence.get(graph?.id??steps[0]?.graphId??'')
      const running=taskRuns.filter(r=>r.status==='running'),stalledMinutes=running.length?executionTime(timedRuns,at,Date.parse(lastEvidenceAt??'1970-01-01'))/60000:0
      const goalStatus=graph&&this.store.node<Goal>(projectId,graph.goalId,'goal').status,achieved=goalStatus==='achieved'
      const live=steps.filter(s=>['pending','running','paused'].includes(s.status)),general=graph?.planner,hasGeneral=!!general&&['pending','running','paused'].includes(general.status)
      const generalRuns=runs.filter(r=>r.activity==='plan'&&r.graphId===graph?.id),generalMinutes=executionTime(generalRuns.flatMap(r=>intervals.get(r.id)??[{...r,endedAt:r.endedAt?confirmedEnd(r,r.endedAt):r.endedAt}]),at)/60000
      const recommendation=classification?.platformCompleted===true||achieved?'achieved':goalStatus==='cancelled'?'exhausted':steps.some(s=>s.status==='parked')?'parked':!running.length?'dispatch':hasGeneral&&stalledMinutes>=30&&(generalMinutes>=25||stalledMinutes>=45)?'park':hasGeneral?'working':stalledMinutes>=20?'general':stalledMinutes>=10?'second-angle':stalledMinutes>=5?'tactical':'working'
      return{taskKey,elapsedMs,stalledMinutes,lastEvidenceAt,classification,recommendation:recommendation==='general'?senior:recommendation,stepIds:steps.map(s=>s.id),facts:steps.flatMap(s=>s.factIds),generals:Number(hasGeneral)}
    })
  }
  /** Refresh durable handover data without replacing Commander-authored notes or copying FGS. */
  checkpointState(projectId:string,reason:string) {
    const c=this.campaign(projectId)
    let notes=c.state
    if(notes.startsWith('{')){try{const saved=JSON.parse(notes);if(saved.source==='commander-checkpoint')notes=saved.notes}catch{ /* Commander STATE may be plain text. */ }}
    c.state=JSON.stringify({source:'commander-checkpoint',reason,notes,cursors:c.cursors,board:'legion_inspect(action=board)'})
    this.saveCampaign(c)
    return c.state
  }
  assertInstanceClose(projectId:string,taskKey:string,exceptRun?:string) {
    this.store.project(projectId);const ids=new Set(this.steps(projectId,taskKey).map(s=>s.id))
    const graph=this.store.projectGraphs(projectId).find(g=>g.taskKey===taskKey)
    if(this.store.runs(projectId).some(r=>r.id!==exceptRun&&(ids.has(r.stepId??'')||r.activity==='plan'&&r.graphId===graph?.id)&&(['running','paused','unknown'].includes(r.status)||r.pendingTools.length)))throw new HttpError(409,'Confirm every task execution stopped and resolve unknown outcomes before closing its instance')
    if(this.steps(projectId,taskKey).some(s=>s.status==='pending'))throw new HttpError(409,'Park pending task missions before closing its instance')
  }
  platformEvent(projectId:string,taskKey:string,action:string,response:unknown) {
    this.store.db.prepare('INSERT INTO legion_platform_events(project_id,task_key,action,data,created_at) VALUES (?,?,?,?,?)').run(projectId,taskKey,action,JSON.stringify(response),now())
  }

  board() {
    const store = this.store
    return { campaign: this.projectId || store.projects().length===1 ? { ...this.campaign(), ...this.budget() } : null, messages:this.store.db.prepare('SELECT data FROM legion_messages'+(this.projectId?' WHERE project_id=?':'')+' ORDER BY created_at DESC LIMIT 100').all(...(this.projectId?[this.projectId]:[])).map(r=>JSON.parse(String(r.data))), projects: store.projects().map(p => ({ id:p.id,title:p.title,mode:p.mode,objective:p.objective,status:p.status,revision:p.revision,campaign:this.campaign(p.id),graphs:store.projectGraphs(p.id),decisions:store.db.prepare("SELECT e.id,e.type,e.node_id,e.graph_id,e.created_at,json_extract(n.data,'$.description') AS description FROM events e LEFT JOIN nodes n ON n.project_id=e.project_id AND n.id=e.node_id WHERE e.project_id=? AND (e.type LIKE 'legion.%' OR e.type IN ('step.added','step.parked','step.reactivated','step.handoff_requested','step.handoff_ready','goal.updated','execute.started')) ORDER BY e.id DESC LIMIT 20").all(p.id).map(e=>({id:Number(e.id),type:String(e.type),nodeId:e.node_id,graphId:e.graph_id,createdAt:String(e.created_at),description:e.description})),runs:(['running','paused','unknown'] as const).flatMap(status=>store.runsByStatus(status,p.id)).map(r=>({id:r.id,graphId:r.graphId,stepId:r.stepId,status:r.status,worker:r.worker,provider:r.provider,model:r.model,contextPressure:r.contextPressure,inputTokens:r.inputTokens,outputTokens:r.outputTokens,cacheReadTokens:r.cacheReadTokens,cacheWriteTokens:r.cacheWriteTokens,pendingTools:r.pendingTools.length})),tactics:this.tactics(p.id),instances:p.benchmarkHosts??{},platform:benchmarkPlatformView(store,p.id),scopeId:'origin', goals:store.nodes<Goal>(p.id,['goal']).map(g=>({id:g.id,graphId:g.graphId,description:g.description,status:g.status,version:g.version,evidenceIds:g.evidenceIds})), steps:store.nodes<Step>(p.id,['step']).map(s=>({id:s.id,graphId:s.graphId,description:s.description,taskKey:s.taskKey,role:s.role,specialist:s.specialist,status:s.status,parentStepId:s.parentStepId,parkReason:s.parkReason,resumeCondition:s.resumeCondition,handoffPending:s.handoffPending,predecessorRunId:s.predecessorRunId,goalId:s.goalId,factIds:s.factIds,initialMission:s.bootstrap})) })) }
  }
  inspectionDelay(projectId:string,interval={active:60,idle:90}) {
    return this.tactics(projectId).some(task=>!['achieved','parked'].includes(task.recommendation))?interval.active*1000:interval.idle*1000
  }
  /** All task outcomes, not a Commander Goal mutation, decide the campaign result. */
  completeBenchmark(projectId:string) {
    if(this.store.project(projectId).mode!=='benchmark'||this.store.project(projectId).status!=='active')return false
    const graphs=this.store.projectGraphs(projectId).filter(g=>g.type==='benchmark_task')
    const records=new Map<string,any>(this.store.db.prepare('SELECT task_key,data FROM legion_tasks WHERE project_id=?').all(projectId).map(r=>[String(r.task_key),JSON.parse(String(r.data))]))
    const keys=new Set([...graphs.map(g=>g.taskKey!),...[...records].filter(([,v])=>v.eligible!==false).map(([key])=>key)])
    if(!keys.size||[...keys].some(key=>{
      const record=records.get(key),graph=graphs.find(g=>g.taskKey===key)
      return record?.platformCompleted!==true&&(!graph||record?.platformCompleted===false||this.store.node<Goal>(projectId,graph.goalId,'goal').status!=='achieved')
    }))return false
    this.store.transaction(()=>{
      this.checkpointState(projectId,'all-tasks-completed')
      const p=this.store.project(projectId);p.status='completed';this.store.db.prepare('UPDATE projects SET data=? WHERE id=?').run(JSON.stringify(p),projectId)
      const c=this.campaign(projectId);c.status='stopped';c.endgame='all tasks completed';delete c.nextInspectionAt;this.saveCampaign(c)
      this.store.event(projectId,'project.completed',null,{reason:'all Benchmark tasks completed'})
    })
    return true
  }
  /** Scheduling metadata only: no FGS node bodies enter Commander context. */
  readCommandChanges(projectId:string,after?:number,limit=100) {
    return this.store.transaction(()=>{
      const c=this.campaign(projectId),cursor=c.cursors[projectId]??{delivered:0,acknowledged:0},start=after??cursor.acknowledged
      if(!Number.isSafeInteger(start)||start<0||start>cursor.delivered)throw new HttpError(422,'Cannot skip undelivered project events')
      const events=this.store.events(projectId,start,limit),through=events.at(-1)?.id??start,graphs=this.store.projectGraphs(projectId),runs=new Map(this.store.runs(projectId).map(r=>[r.id,r]))
      cursor.delivered=Math.max(cursor.delivered,through);c.cursors[projectId]=cursor;this.saveCampaign(c)
      return{events:events.map(e=>{const payload=e.payload as Record<string,unknown>,runId=typeof payload.runId==='string'?payload.runId:undefined,graphId=e.graphId??(runId?runs.get(runId)?.graphId:undefined);return{id:e.id,type:e.type,taskKey:graphs.find(g=>g.id===graphId)?.taskKey??payload.taskKey??null,...(runId?{runId}:{}),...(e.nodeId?{nodeId:e.nodeId}:{}),createdAt:e.createdAt}}),cursor:through,hasMore:this.store.events(projectId,through,1).length>0}
    })
  }
  boardSummary(taskKey?:string) {
    const id=this.owner(),project=this.store.project(id),campaign=this.campaign(id),budget=this.budget(Date.now(),id)
    const graphs=this.store.projectGraphs(id).filter(g=>(project.mode==='general'||g.type==='benchmark_task')&&(!taskKey||g.taskKey===taskKey))
    const steps=this.store.nodes<Step>(id,['step']).filter(s=>!s.deleted),runs=this.store.runs(id).filter(r=>['running','paused','unknown'].includes(r.status))
    if(project.mode==='general') return {projectId:id,sessionId:campaign.sessionId,cursors:campaign.cursors,lines:[
      `Project ${id} ${project.status}; cursor=${campaign.cursors[id]?.acknowledged??0}`,
      ...graphs.map(g=>`graph=${g.id} origin=${g.originId} goal=${g.goalId}`),
      ...steps.map(s=>`${s.id} ${s.status} goal=${s.goalId} dependsOn=${(s.dependsOn??[]).join(',')||'-'}; ${s.description.slice(0,160)}`),
      ...runs.map(r=>`run=${r.id} step=${r.stepId} ${r.status}; pendingTools=${r.pendingTools.length}`),
    ].slice(0,100)}
    const goals=this.store.nodes<Goal>(id,['goal']),tactics=this.tactics(id)
    const messages=this.messages(id,'commander').filter(m=>m.status!=='admitted').sort((a,b)=>(a.type==='HELP'?0:1)-(b.type==='HELP'?0:1))
    const lines=[`Project ${id} ${project.status}; budget=${budget.phase} ${budget.remainingMs??'open'}ms; cursor=${campaign.cursors[id]?.acknowledged??0}`]
    for(const m of messages.slice(0,8))lines.push(`${m.type} ${m.id} from ${m.sender}: ${String(m.content).replace(/\s+/g,' ').slice(0,120)}`)
    const tasks=graphs.map(g=>{
      const own=steps.filter(s=>s.graphId===g.id),live=runs.filter(r=>r.graphId===g.id),goal=goals.find(x=>x.id===g.goalId),tactic=tactics.find(x=>x.taskKey===g.taskKey)
      const priority=messages.some(m=>m.type==='HELP'&&live.some(r=>r.id===m.sender))?0:live.some(r=>r.status==='unknown'||r.pendingTools.length)?1:live.length?2:goal?.status==='achieved'?3:own.some(s=>s.status==='parked')?4:5
      return{g,own,live,goal,tactic,priority}
    }).sort((a,b)=>a.priority-b.priority||(a.g.taskKey??a.g.id).localeCompare(b.g.taskKey??b.g.id))
    const untouched=tasks.filter(t=>!t.own.length&&!t.g.planner&&t.tactic?.classification?.platformCompleted!==true)
    lines.push(`Tasks=${tasks.length}; platformCompleted=${tasks.filter(t=>t.tactic?.classification?.platformCompleted===true).length}; internalAchieved=${tasks.filter(t=>t.goal?.status==='achieved').length}; untouched=${untouched.length}`)
    const instances=this.store.db.prepare("SELECT task_key,json_extract(data,'$.platformInstance.status') AS status,json_extract(data,'$.platformCompleted') AS completed,json_extract(data,'$.platformObservedAt') AS observed FROM legion_tasks WHERE project_id=? AND json_extract(data,'$.platformInstance.status')!='stopped' ORDER BY task_key").all(id)
    if(instances.length)lines.push('Platform instances (last refresh; non-stopped means occupied, including completed tasks): '+instances.map(t=>`${t.task_key}=${t.status}${t.completed?'(completed)':''}@${t.observed}`).join(', '))
    if(!taskKey&&untouched.length)lines.push('Classification required: '+untouched.map(t=>t.g.taskKey).join(', '))
    const selected=taskKey?tasks:tasks.filter(t=>!untouched.includes(t)&&t.tactic?.classification?.platformCompleted!==true)
    const capacity=Math.max(0,99-lines.length)
    for(const task of selected.slice(0,capacity))lines.push(`${task.g.taskKey} ${task.tactic?.classification?.platformCompleted===true?'platform-completed':task.goal?.status==='achieved'?'goal-achieved':task.goal?.status==='cancelled'?'exhausted':task.own.some(s=>s.status==='parked')?'parked':task.live.length?'active':'pending'}; submitted=${!!task.tactic?.classification?.submissionAttemptedAt}; runs=${task.live.map(r=>r.id+':'+r.status+':'+(r.activity==='plan'?'general':steps.find(s=>s.id===r.stepId)?.role)).join(',')||'-'}; difficulty=${task.tactic?.classification?.difficulty??'unknown'}; stalled=${Math.floor(task.tactic?.stalledMinutes??0)}m; next=${task.tactic?.recommendation??'classification-required'}`)
    if(selected.length>capacity)lines.push(`omitted=${selected.length-capacity}; query Board by taskKey`)
    return{projectId:id,sessionId:campaign.sessionId,cursors:campaign.cursors,budget,lines:lines.slice(0,100)}
  }
  questionCapacity(maxTasks: number | null = null) {
    const id = this.owner(), steps = this.store.nodes<Step>(id, ['step']).filter(s => !s.deleted)
    const graphs = this.store.projectGraphs(id).filter(g => g.type === 'benchmark_task')
    const active = new Set(steps.filter(s => ['pending','running','paused'].includes(s.status)).map(s => s.taskKey!))
    for(const graph of graphs)if(graph.planner&&['pending','running','paused'].includes(graph.planner.status))active.add(graph.taskKey!)
    for (const run of this.store.runsByStatus('unknown', id)) {
      const step = steps.find(s => s.id === run.stepId)
      if (step?.taskKey) active.add(step.taskKey)
      else if(run.activity==='plan'&&run.graphId)active.add(this.store.projectGraph(id,run.graphId).taskKey!)
    }
    const goals = new Map(this.store.nodes<Goal>(id, ['goal']).map(g => [g.id, g.status]))
    const parked = new Set(steps.filter(s => s.status === 'parked').map(s => s.taskKey))
    const records = new Map(this.store.db.prepare('SELECT task_key,data FROM legion_tasks WHERE project_id=?').all(id).map(r => [String(r.task_key), JSON.parse(String(r.data))]))
    const unassignedTaskKeys = graphs.filter(g => !active.has(g.taskKey!) && records.get(g.taskKey!)?.eligible !== false && records.get(g.taskKey!)?.platformCompleted !== true
      && goals.get(g.goalId) === 'open' && !parked.has(g.taskKey!)).map(g => g.taskKey!)
    const targetTasks = maxTasks === null ? null : Math.min(maxTasks, active.size + unassignedTaskKeys.length)
    return { maxTasks, activeTasks: active.size, targetTasks, taskSlots: targetTasks === null ? null : Math.max(0, targetTasks - active.size), activeTaskKeys: [...active], unassignedTaskKeys }
  }
  claimCommand(projectId?:string) {
    return this.store.transaction(() => {
      const campaign = this.campaign(projectId)
      if (campaign.status !== 'idle') throw new HttpError(409, 'Commander is not idle')
      campaign.status = 'running'; this.saveCampaign(campaign); return campaign
    })
  }
  readChanges(projectId: string, after?: number, limit = 100) {
    return this.store.transaction(() => {
      this.store.project(projectId)
      const campaign = this.campaign(projectId), cursor = campaign.cursors[projectId] ?? { delivered: 0, acknowledged: 0 }
      const start = after ?? cursor.acknowledged
      if (!Number.isSafeInteger(start) || start < 0 || start > cursor.delivered) throw new HttpError(422, 'Cannot skip undelivered project events')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(422, 'limit must be between 1 and 100')
      const result = this.store.graphDelta(projectId, start, limit)
      cursor.delivered = Math.max(cursor.delivered, result.cursor)
      campaign.cursors[projectId] = cursor; this.saveCampaign(campaign)
      return { ...result, acknowledgementBoundary: { ...cursor } }
    })
  }
  finishCommand(processed: Record<string, number>, state: string | undefined, release = true, projectId?:string) {
    return this.store.transaction(() => {
      const campaign = this.campaign()
      if (campaign.status !== 'running') throw new HttpError(409, 'Commander is not running')
      for (const [projectId, through] of Object.entries(processed)) {
        if(projectId!==campaign.projectId) throw new HttpError(403,'Cannot acknowledge another Project')
        this.store.project(projectId)
        const cursor = campaign.cursors[projectId]??{delivered:0,acknowledged:0}
        if (!Number.isSafeInteger(through) || through < cursor.acknowledged || through > cursor.delivered) throw new HttpError(422, 'Acknowledgement exceeds delivered project events')
        cursor.acknowledged = through;campaign.cursors[projectId]=cursor
      }
      if(state!==undefined)campaign.state = requiredText(state, 'state'); campaign.status = release ? 'idle' : 'running'; this.saveCampaign(campaign)
      return campaign
    })
  }
  private active(projectId: string) {
    if (this.store.project(projectId).status !== 'active') throw new HttpError(409, 'Project is not active')
  }
  private steps(projectId: string, taskKey: string) {
    return this.store.nodes(projectId, ['step']).filter((node): node is Step => node.kind === 'step' && node.taskKey === taskKey && !node.deleted)
  }
  spawn(projectId: string, mission: SpawnMission, maxBenchmarkTasks: number | null = null) {
    if (String(mission.role) === 'scout') throw new HttpError(422, 'Scout is retired')
    return this.store.transaction(() => {
      this.active(projectId)
      if (['submission','ended'].includes(this.budget(Date.now(),projectId).phase)) throw new HttpError(409, 'Campaign is in submission-only or ended phase; no new Missions')
      if (this.store.project(projectId).mode === 'general') {
        if (mission.role !== 'soldier' || mission.parentRunId || mission.escalationReason) throw new HttpError(422, 'General mode uses General-assigned Soldier or custom Executor Steps')
      }
      if (mission.specialist) mission = { ...mission, role: executorRole(this.store.project(projectId).mode) }
      requiredText(mission.taskKey, 'taskKey')
      const graphs=this.store.projectGraphs(projectId), graph=mission.graphId ? this.store.projectGraph(projectId,mission.graphId) : graphs.find(g=>g.taskKey===mission.taskKey) ?? (this.store.project(projectId).mode==='general'?graphs[0]:undefined)
      if(!graph) throw new HttpError(422,'Initialize the task Graph before creating a Mission')
      const mode = this.store.project(projectId).mode
      if (mode === 'benchmark' && maxBenchmarkTasks !== null) {
        const capacity = new LegionStore(this.store, projectId).questionCapacity(maxBenchmarkTasks)
        if (!capacity.activeTaskKeys.includes(mission.taskKey) && capacity.activeTasks >= maxBenchmarkTasks) throw new HttpError(409, 'Question concurrency limit reached', { code: 'QUESTION_LIMIT_REACHED', capacity })
      }
      if (mode === 'benchmark') {
        const record=this.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,mission.taskKey)
        const task=record?JSON.parse(String(record.data)):undefined
        if(task?.platformCompleted===true&&!mission.parentRunId)throw new HttpError(409,'Task is already platform-completed')
        if(!mission.parentRunId&&!graph.planner) {
          const upgrade=mission.role==='general'&&this.steps(projectId,mission.taskKey).some(s=>s.role==='soldier'&&s.status!=='cancelled')
          mission={...mission,role:(task?.platformMetadata?.flag_count??0)>1||upgrade?'general':'soldier'}
        }
      }
      if (mission.role === 'general') return this.store.addPlanner(projectId,graph.id,mission)
      if (mode === 'general' && mission.role !== 'soldier') throw new HttpError(422, 'General mode requires Soldier')
      if (!mission.parentRunId) {
        const active = this.steps(projectId, mission.taskKey).filter(s => ['pending','running','paused'].includes(s.status))
        if (active.some(s => s.role === mission.role && s.description === mission.description)) throw new HttpError(409, 'Assign a different angle from the active Worker')

      }
      if(graph.type==='benchmark_task'&&graph.taskKey!==mission.taskKey) throw new HttpError(422,'taskKey belongs to another Graph')
      const scoped=this.store.forGraph(projectId,graph.id)
      if (this.steps(projectId, mission.taskKey).some(s => s.status === 'parked')) throw new HttpError(409, 'Task is parked')
      if (mission.parentRunId) {
        const run = this.store.run(mission.parentRunId)
        if (run.projectId !== projectId || run.status !== 'running' || run.activity !== 'plan') throw new HttpError(403, 'Delegating Run is not active in this Project')
        const planner=this.store.assignment(run)
        if(run.activity!=='plan'||planner?.role!=='general'||planner.status!=='running'||planner.taskKey!==mission.taskKey||mission.role!=='soldier')throw new HttpError(403,'General may delegate only same-task Soldier missions')
        let goal=this.store.node<Goal>(projectId,mission.goalId??planner.goalId,'goal')
        while(goal.id!==planner.goalId&&goal.parentId)goal=this.store.node<Goal>(projectId,goal.parentId,'goal')
        if(goal.id!==planner.goalId)throw new HttpError(403,'Delegation escapes the assigned Goal')
        if(planner.executionProfile==='isolated'&&mission.executionProfile==='direct')throw new HttpError(403,'Delegation cannot weaken execution isolation')
        mission={...mission,goalId:mission.goalId??planner.goalId,executionProfile:mission.executionProfile??planner.executionProfile}
        // Parallelism is governed by the existing worker and Max Step limits.
      }
      const { escalationReason, ...assignment } = mission
      const step = scoped.addStep(projectId, { ...assignment, executionProfile: mission.executionProfile, goalId: mission.goalId,
        ...(mission.parentRunId?{plannerId:this.store.assignment(this.store.run(mission.parentRunId))!.id}:{}), creator: mission.parentRunId ?? coordinatorRole(mode) })
      if (escalationReason) this.store.event(projectId, 'legion.escalated', step, { reason: escalationReason })
      return step
    })
  }
  park(projectId: string, taskKey: string, reason: string, resumeCondition: string) {
    return this.store.transaction(() => {
      this.active(projectId); requiredText(reason, 'reason'); requiredText(resumeCondition, 'resumeCondition')
      const steps = this.steps(projectId, taskKey).filter(s => !['done', 'cancelled'].includes(s.status))
      const planner=this.store.projectGraphs(projectId).find(g=>g.taskKey===taskKey)?.planner
      if(planner){planner.status='parked';planner.handoff=[planner.handoff,reason,'Resume: '+resumeCondition].filter(Boolean).join('\n');this.store.savePlanner(planner)}
      if (!steps.length&&!planner) throw new HttpError(404, 'No unfinished task Steps')
      for (const step of steps) {
        step.status = 'parked'; step.parkReason = reason; step.resumeCondition = resumeCondition
        this.store.saveNode(step); this.store.event(projectId, 'step.parked', step, { reason })
      }
      return steps
    })
  }
  reactivate(projectId: string, taskKey: string, reason: string) {
    return this.store.transaction(() => {
      this.active(projectId); requiredText(reason, 'reason')
      const record=this.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey)
      const completed=!!record&&JSON.parse(String(record.data)).platformCompleted===true
      const steps = this.steps(projectId, taskKey).filter(s => s.status === 'parked')
      const graph=this.store.projectGraphs(projectId).find(g=>g.taskKey===taskKey),planner=graph?.planner
      if(completed&&!(planner?.status==='parked'&&this.store.node<Goal>(projectId,graph!.goalId,'goal').status==='open'))throw new HttpError(409,'Task is already platform-completed; only its existing Planner may resume cleanup before acceptance')
      if (!steps.length&&planner?.status!=='parked') throw new HttpError(404, 'Task is not parked')
      const ids = new Set(steps.map(s => s.id))
      if (steps.some(s => s.handoffPending) || this.store.runs(projectId).some(r => (ids.has(r.stepId ?? '')||r.activity==='plan'&&r.graphId===graph?.id) && ['running', 'paused', 'unknown'].includes(r.status))) throw new HttpError(409, 'Confirm old executions stopped and resolve unknown results before reactivation')
      if(planner){planner.status='pending';this.store.savePlanner(planner);this.store.forGraph(projectId,graph!.id).event(projectId,'hint.added',null,{reason})}
      for (const step of steps) {
        step.status = completed?'cancelled':'pending'; delete step.parkReason; delete step.resumeCondition
        this.store.saveNode(step); this.store.event(projectId, completed?'step.cancelled':'step.reactivated', step, { reason })
      }
      return steps
    })
  }

  saveState(projectId:string|undefined,actor:string,summary:string) {
    const text=requiredText(summary,'summary')
    if(actor==='commander'){const c=this.campaign(projectId);c.state=text;if(this.store.project(c.projectId).mode==='benchmark'){if(c.stateScope!=='scheduling')delete c.nativeCompactionSummary;c.stateScope='scheduling'}this.saveCampaign(c);return{saved:true}}
    const run=this.store.run(actor);if(run.projectId!==projectId||run.status!=='running')throw new HttpError(409,'State actor is not active')
    const assignment=this.store.assignment(run)!;assignment.handoff=text;if(run.activity==='plan')this.store.savePlanner(assignment as import('./types.ts').GraphPlanner);else this.store.saveNode(assignment as Step);return{saved:true}
  }
  queueHandoff(runId:string,summary:string,nextWorker?:string) {
    const run=this.store.run(runId);if(run.status!=='running')throw new HttpError(409,'Handoff actor is not running')
    if(run.activity==='plan'){const planner=this.store.assignment(run) as import('./types.ts').GraphPlanner;planner.handoffRequest={summary:requiredText(summary,'summary'),...(nextWorker?{nextWorker}:{})};this.store.savePlanner(planner);return{requested:true,stopConfirmed:false}}
    const step=this.store.node<Step>(run.projectId,run.stepId!,'step');step.handoffRequest={summary:requiredText(summary,'summary'),...(nextWorker?{nextWorker}:{})};this.store.saveNode(step);return{requested:true,stopConfirmed:false}
  }
  settleHandoff(runId:string) {
    const run=this.store.run(runId);if(run.status!=='running'||run.pendingTools.length)return
    if(run.activity==='plan'){const planner=this.store.assignment(run) as import('./types.ts').GraphPlanner;if(planner.handoffRequest)this.requestHandoff(runId,planner.handoffRequest.summary,planner.handoffRequest.nextWorker);return}
    if(!run.stepId)return
    const step=this.store.node<Step>(run.projectId,run.stepId!,'step')
    if(step.status==='running'&&step.handoffRequest)this.requestHandoff(runId,step.handoffRequest.summary,step.handoffRequest.nextWorker)
  }

  requestHandoff(runId: string, summary: string, nextWorker?: string) {
    return this.store.transaction(() => {
      const run = this.store.run(runId); this.active(run.projectId)
      if (run.activity==='plan') {
        if(!['running','paused'].includes(run.status)||run.pendingTools.length)throw new HttpError(409,'Planner handoff requires settled tool outcomes')
        const planner=this.store.assignment(run) as import('./types.ts').GraphPlanner
        delete planner.handoffRequest;planner.status='parked';planner.handoff=requiredText(summary,'summary');planner.nextWorker=nextWorker??run.worker;this.store.savePlanner(planner)
        this.store.forGraph(run.projectId,run.graphId!).event(run.projectId,'planner.handoff_requested',null,{runId});return planner
      }
      if (!run.stepId || run.activity !== 'execute' || !['running', 'paused'].includes(run.status)) throw new HttpError(409, 'Run cannot hand off')
      if (run.pendingTools.length) throw new HttpError(409, 'Unconfirmed tool results prevent handoff')
      const step = this.store.node<Step>(run.projectId, run.stepId, 'step')
      if (!['running', 'paused'].includes(step.status)) throw new HttpError(409, 'Step cannot hand off')
      step.nextWorker = nextWorker; delete step.handoffRequest
      step.status = 'parked'; step.handoff = requiredText(summary, 'summary'); step.predecessorRunId = run.id; step.handoffPending = true
      this.store.saveNode(step); this.store.event(run.projectId, 'step.handoff_requested', step, { runId })
      return step
    })
  }
  completeHandoff(projectId: string, stepId: string) {
    return this.store.transaction(() => {
      this.active(projectId)
      const step = this.store.node<Step>(projectId, stepId, 'step')
      if (!step.handoffPending || step.status !== 'parked' || !step.predecessorRunId) throw new HttpError(409, 'No pending handoff')
      const old = this.store.run(step.predecessorRunId)
      if (['running', 'unknown'].includes(old.status) || old.pendingTools.length) throw new HttpError(409, 'Previous execution is not confirmed stopped')
      if (old.status === 'paused') { old.status = 'cancelled'; old.endedAt = now(); this.store.saveRun(old) }
      step.status = 'pending'; step.worker = null; step.handoffPending = false; step.failure = null; step.endedAt = null
      this.store.saveNode(step); this.store.event(projectId, 'step.handoff_ready', step, { runId: old.id })
      return step
    })
  }
  message(projectId: string, sender: string, receiver: string, type: 'HELP' | 'REPORT' | 'MESSAGE', content: string) {
    if(sender==='commander'&&receiver==='commander'){if(this.store.project(projectId).status==='deleting')throw new HttpError(403,'Project is deleting')}else this.active(projectId)
    if (!['HELP', 'REPORT', 'MESSAGE'].includes(type)) throw new HttpError(422, 'Invalid message type')
    for (const [actor,receiving] of [[sender,false],[receiver,true]] as const) if (actor !== 'commander') {
      const run = this.store.run(actor)
      const sleepingPlanner=receiving&&run.activity==='plan'&&run.status==='succeeded'&&this.store.assignment(run)?.status==='pending'&&this.store.runs(run.projectId).filter(r=>r.activity==='plan'&&r.graphId===run.graphId).at(-1)?.id===run.id
      if (run.projectId !== projectId || !['running', 'paused'].includes(run.status)&&!sleepingPlanner) throw new HttpError(409, 'Message actor is stopped or belongs to another Project')
    }
    if(sender!=='commander'&&receiver!=='commander') {
      const from=this.store.run(sender),to=this.store.run(receiver)
      if(from.graphId!==to.graphId) throw new HttpError(403,'Workers cannot message another Graph')
      const source=this.store.assignment(from)!,target=this.store.assignment(to)!
      if(from.activity!=='plan'&&to.activity!=='plan'&&('parentStepId' in source?source.parentStepId:undefined)!==target.id&&('parentStepId' in target?target.parentStepId:undefined)!==source.id) throw new HttpError(403,'Use the Commander for unrelated Agents')
    }
    const message = { id: 'msg-' + randomUUID(), projectId, sender, receiver, type, content: requiredText(content, 'content'), status: 'pending', createdAt: now() }
    this.store.db.prepare('INSERT INTO legion_messages VALUES (?,?,?,?,?,?)').run(message.id, projectId, sender, receiver, JSON.stringify(message), message.createdAt)
    const graphId=receiver!=='commander'?this.store.run(receiver).graphId:sender!=='commander'?this.store.run(sender).graphId:undefined
    ;(graphId?this.store.forGraph(projectId,graphId):this.store).event(projectId,'legion.message',null,{messageId:message.id,type,sender,receiver})
    this.store.changes.emit('legion-message', projectId, receiver)
    return message
  }
  messages(projectId: string, receiver: string) {
    this.store.project(projectId)
    return this.store.db.prepare('SELECT data FROM legion_messages WHERE project_id=? AND receiver=? ORDER BY created_at,id').all(projectId, receiver).map(r => JSON.parse(String(r.data)))
  }

  requeueUnread(projectId:string,receiver:string,ids:string[]) {
    for(const id of ids){const row=this.store.db.prepare('SELECT data FROM legion_messages WHERE project_id=? AND receiver=? AND id=?').get(projectId,receiver,id);if(!row)continue;const message=JSON.parse(String(row.data));if(message.status!=='queued')continue;message.status='pending';this.store.db.prepare('UPDATE legion_messages SET data=? WHERE id=?').run(JSON.stringify(message),id)}
  }

  delivery(projectId: string, receiver: string, id: string, status: 'queued' | 'admitted' | 'uncertain') {
    const row = this.store.db.prepare('SELECT data FROM legion_messages WHERE project_id=? AND receiver=? AND id=?').get(projectId, receiver, id)
    if (!row) throw new HttpError(404, 'Message does not belong to receiver')
    const message = JSON.parse(String(row.data))
    if (message.status === 'admitted' || message.status === status) return message
    if (status === 'queued' && message.status !== 'pending') throw new HttpError(409, 'Message delivery is not pending')
    message.status = status
    this.store.db.prepare('UPDATE legion_messages SET data=? WHERE id=?').run(JSON.stringify(message), id)
    return message
  }
  wait(projectId: string, receiver: string, after: number, signal?: AbortSignal) {
    this.store.project(projectId)
    if (!Number.isSafeInteger(after) || after < 0) throw new HttpError(422, 'Invalid graph cursor')
    return new Promise<{ cursor: number; messages: string[] }>((resolve, reject) => {
      const cleanup = () => { this.store.changes.off('change', changed); this.store.changes.off('legion-message', changed); signal?.removeEventListener('abort', abort) }
      const abort = () => { cleanup(); reject(signal?.reason ?? new Error('Legion wait aborted')) }
      const changed = (id?: string) => {
        if (id && id !== projectId) return
        if (signal?.aborted) { abort(); return }
        const cursor = Number(this.store.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM events WHERE project_id=? AND (? IS NULL OR graph_id=?)').get(projectId,this.store.graphScope??null,this.store.graphScope??null)!.cursor)
        const messages = this.messages(projectId, receiver).filter(m => m.status === 'pending' || m.status === 'queued').map(m => String(m.id))
        if (cursor > after || messages.length) { cleanup(); resolve({ cursor, messages }) }
      }
      this.store.changes.on('change', changed); this.store.changes.on('legion-message', changed)
      signal?.addEventListener('abort', abort, { once: true }); changed()
    })
  }

}
