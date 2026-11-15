import { randomUUID } from 'node:crypto'
import { CommanderTodos } from './legion-todos.ts'
import { Store } from './store.ts'
import { HttpError, now, requiredText } from './types.ts'
import type { LegionRole, Step, Goal } from './types.ts'

export interface CommandCursor { delivered: number; acknowledged: number }
export interface Campaign {
  projectId: string; sessionId: string; status: 'idle' | 'running' | 'stopped'; state: string
  nextInspectionAt?: number; restarts?: number; failureCode?: string; nativeCompactionSummary?: string; hasSession?: boolean; workerName?: string; usage?: {inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number}; error?: string; endgame?: string; startedAt?: number; deadline?: number; pendingTools?: string[]; nextWorker?: string; reasoning?: string; previousSessionId?: string
  sessionHistory?: string[]
  cursors: Record<string, CommandCursor>
}
export interface SpawnMission {
  specialist?: Step['specialist']; escalationReason?: string; role: LegionRole; taskKey: string; description: string; sourceIds: string[]
  graphId?: string; goalId?: string; parentRunId?: string; priority?: number; executionProfile?: Step['executionProfile']
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
      'CREATE TABLE IF NOT EXISTS legion_platform_events(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_key TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS commander_todos(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,graph_id TEXT NOT NULL, data TEXT NOT NULL,PRIMARY KEY(project_id,graph_id));')
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
  classify(projectId:string,taskKey:string,difficulty:'easy'|'medium'|'hard'|'unclear',factIds:string[],family?:string,sourceTaskKey?:string) {
    this.active(projectId);requiredText(taskKey,'taskKey')
    if(!['easy','medium','hard','unclear'].includes(difficulty)||!factIds.length)throw new HttpError(422,'Classification requires a verdict and confirmed target evidence')
    const source=sourceTaskKey?this.tactics(projectId).find(t=>t.taskKey===sourceTaskKey):undefined
    if(sourceTaskKey&&(!family||sourceTaskKey===taskKey||source?.classification?.family!==family||!source.classification.difficulty||source.classification.difficulty==='unclear'))throw new HttpError(422,'Scout reuse requires a classified sibling with the same explicit family')
    for(const id of factIds){const fact=this.store.node(projectId,id,'fact');if(id==='origin'||!('stepId'in fact)||!fact.stepId||this.store.node<Step>(projectId,fact.stepId,'step').taskKey!==(sourceTaskKey??taskKey)||!sourceTaskKey&&this.store.node<Step>(projectId,fact.stepId,'step').role!=='scout'||this.store.node<Step>(projectId,fact.stepId,'step').status!=='done')throw new HttpError(422,'Classification evidence must come from this completed Scout task')}
    const row=this.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey)
    const graph=sourceTaskKey?this.store.projectGraphs(projectId).find(g=>g.taskKey===taskKey):undefined
    if(sourceTaskKey&&!graph)throw new HttpError(422,'Initialize the target task Graph before Scout reuse')
    const hint=graph?this.store.forGraph(projectId,graph.id).addInput(projectId,'hint','[Family Scout reuse] '+family+'; sibling='+sourceTaskKey+'; source Facts='+factIds.join(',')+'. UNVERIFIED IN THIS TARGET: read the sibling evidence, verify target product/version and family differences before exploiting.','commander'):undefined
    const data={...(row?JSON.parse(String(row.data)):{}),difficulty,factIds:sourceTaskKey?[]:factIds,...(family?{family}:{}),...(sourceTaskKey?{sourceTaskKey,sourceFactIds:factIds,hintId:hint!.id}:{}),classifiedAt:now()};this.store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,taskKey,JSON.stringify(data));this.store.event(projectId,'legion.classified',null,{taskKey,difficulty});return data
  }
  tactics(projectId:string,at=Date.now()) {
    const tasks=new Set([...this.store.projectGraphs(projectId).filter(g=>g.taskKey).map(g=>g.taskKey!),...this.store.nodes<Step>(projectId,['step']).filter(s=>!s.deleted).map(s=>s.taskKey??s.goalId)])
    const runs=this.store.runs(projectId)
    const evidence=new Map<string,string>(this.store.db.prepare("SELECT graph_id,MAX(created_at) AS at FROM events WHERE project_id=? AND type IN ('fact.added','finding.added') GROUP BY graph_id").all(projectId).map(r=>[String(r.graph_id),String(r.at)]))
    const activeAt=String(this.store.db.prepare("SELECT COALESCE(MAX(created_at),'1970-01-01') AS at FROM events WHERE project_id=? AND type='project.active'").get(projectId)!.at)
    return [...tasks].map(taskKey=>{
      const steps=this.steps(projectId,taskKey),ids=new Set(steps.map(s=>s.id))
      const taskRuns=runs.filter(r=>ids.has(r.stepId??'')),intervals=taskRuns.map(r=>[Date.parse(r.startedAt),r.endedAt?Date.parse(r.endedAt):at]).sort((a,b)=>a[0]-b[0])
      let elapsedMs=0,start=0,end=0;for(const [a,b]of intervals){if(a>end){elapsedMs+=end-start;start=a;end=b}else end=Math.max(end,b)}elapsedMs+=end-start
      const row=this.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey),classification=row?JSON.parse(String(row.data)):null
      const graph=this.store.projectGraphs(projectId).find(g=>g.taskKey===taskKey),lastEvidenceAt=evidence.get(graph?.id??steps[0]?.graphId??'')
      const running=taskRuns.filter(r=>r.status==='running'),stalledMinutes=running.length?Math.max(0,(at-Math.max(Math.min(...taskRuns.map(r=>Date.parse(r.startedAt))),Date.parse(lastEvidenceAt??'1970-01-01'),Date.parse(activeAt)))/60000):0
      const achieved=graph&&this.store.node<Goal>(projectId,graph.goalId,'goal').status==='achieved'
      const live=steps.filter(s=>['pending','running','paused'].includes(s.status)),general=live.find(s=>s.role==='general'),hasGeneral=!!general
      const generalRuns=taskRuns.filter(r=>r.stepId===general?.id),generalMinutes=generalRuns.length?(at-Math.min(...generalRuns.map(r=>Date.parse(r.startedAt))))/60000:0
      const needsScout=live.some(s=>s.role==='scout')&&(!classification?.difficulty||classification.difficulty==='unclear')
      const recommendation=achieved?'achieved':steps.some(s=>s.status==='parked')?'parked':needsScout?running.length&&stalledMinutes>=10?'second-angle':running.length&&stalledMinutes>=5?'tactical':'scout':classification?.difficulty==='hard'&&!hasGeneral?'general':!running.length?'dispatch':hasGeneral&&stalledMinutes>=30&&(generalMinutes>=25||stalledMinutes>=45)?'park':hasGeneral?'working':stalledMinutes>=20?'general':stalledMinutes>=10?'second-angle':stalledMinutes>=5?'tactical':'working'
      return{taskKey,elapsedMs,stalledMinutes,lastEvidenceAt,classification,recommendation,stepIds:steps.map(s=>s.id),facts:steps.flatMap(s=>s.factIds),generals:live.filter(s=>s.role==='general').length}
    })
  }
  /** Refresh durable handover data without replacing Commander-authored notes or copying FGS. */
  checkpointState(projectId:string,reason:string) {
    const c=this.campaign(projectId)
    let notes=c.state
    if(notes.startsWith('{')){try{const saved=JSON.parse(notes);if(saved.source==='commander-checkpoint')notes=saved.notes}catch{ /* Commander STATE may be plain text. */ }}
    const board=new LegionStore(this.store,projectId).boardSummary()
    c.state=JSON.stringify({source:'commander-checkpoint',reason,notes,cursors:c.cursors,board:board.lines,allocation:this.store.nodes<Step>(projectId,['step']).filter(s=>!s.deleted).map(s=>({stepId:s.id,taskKey:s.taskKey,role:s.role,status:s.status,worker:s.worker,nextWorker:s.nextWorker,parkReason:s.parkReason,resumeCondition:s.resumeCondition,handoff:s.handoff,failure:s.failure})),tasks:this.tactics(projectId),graphs:this.store.projectGraphs(projectId).map(g=>({id:g.id,taskKey:g.taskKey,originId:g.originId,goalId:g.goalId}))})
    this.saveCampaign(c)
    return c.state
  }
  assertInstanceClose(projectId:string,taskKey:string,exceptRun?:string) {
    this.store.project(projectId);const ids=new Set(this.steps(projectId,taskKey).map(s=>s.id))
    if(this.store.runs(projectId).some(r=>r.id!==exceptRun&&ids.has(r.stepId??'')&&(['running','paused','unknown'].includes(r.status)||r.pendingTools.length)))throw new HttpError(409,'Confirm every task execution stopped and resolve unknown outcomes before closing its instance')
    if(this.steps(projectId,taskKey).some(s=>s.status==='pending'))throw new HttpError(409,'Park pending task missions before closing its instance')
  }
  platformEvent(projectId:string,taskKey:string,action:string,response:unknown) {
    this.store.db.prepare('INSERT INTO legion_platform_events(project_id,task_key,action,data,created_at) VALUES (?,?,?,?,?)').run(projectId,taskKey,action,JSON.stringify(response),now())
  }

  board() {
    const store = this.store
    return { campaign: this.projectId || store.projects().length===1 ? { ...this.campaign(), ...this.budget() } : null, messages:this.store.db.prepare('SELECT data FROM legion_messages'+(this.projectId?' WHERE project_id=?':'')+' ORDER BY created_at DESC LIMIT 100').all(...(this.projectId?[this.projectId]:[])).map(r=>JSON.parse(String(r.data))), projects: store.projects().map(p => ({ id:p.id,title:p.title,mode:p.mode,objective:p.objective,status:p.status,revision:p.revision,campaign:this.campaign(p.id),graphs:store.projectGraphs(p.id),decisions:store.db.prepare("SELECT e.id,e.type,e.node_id,e.graph_id,e.created_at,json_extract(n.data,'$.description') AS description FROM events e LEFT JOIN nodes n ON n.project_id=e.project_id AND n.id=e.node_id WHERE e.project_id=? AND (e.type LIKE 'legion.%' OR e.type IN ('step.added','step.parked','step.reactivated','step.handoff_requested','step.handoff_ready','goal.updated','execute.started')) ORDER BY e.id DESC LIMIT 20").all(p.id).map(e=>({id:Number(e.id),type:String(e.type),nodeId:e.node_id,graphId:e.graph_id,createdAt:String(e.created_at),description:e.description})),runs:(['running','paused','unknown'] as const).flatMap(status=>store.runsByStatus(status,p.id)).map(r=>({id:r.id,graphId:r.graphId,stepId:r.stepId,status:r.status,worker:r.worker,provider:r.provider,model:r.model,contextPressure:r.contextPressure,inputTokens:r.inputTokens,outputTokens:r.outputTokens,cacheReadTokens:r.cacheReadTokens,cacheWriteTokens:r.cacheWriteTokens,pendingTools:r.pendingTools.length})),tactics:this.tactics(p.id),instances:p.benchmarkHosts??{},platform:Object.fromEntries(this.store.db.prepare('SELECT task_key,data FROM legion_tasks WHERE project_id=?').all(p.id).map(r=>{const d=JSON.parse(String(r.data));return[String(r.task_key),{confirmed:d.platformCompleted===true,submitted:!!d.submissionAttemptedAt,accepted:d.submissionAccepted===true}]})),scopeId:'origin', goals:store.nodes<Goal>(p.id,['goal']).map(g=>({id:g.id,graphId:g.graphId,description:g.description,status:g.status,version:g.version,evidenceIds:g.evidenceIds})), steps:store.nodes<Step>(p.id,['step']).map(s=>({id:s.id,graphId:s.graphId,description:s.description,taskKey:s.taskKey,role:s.role,specialist:s.specialist,status:s.status,parentStepId:s.parentStepId,parkReason:s.parkReason,resumeCondition:s.resumeCondition,handoffPending:s.handoffPending,predecessorRunId:s.predecessorRunId,goalId:s.goalId,factIds:s.factIds,initialMission:s.bootstrap})) })) }
  }
  inspectionDelay(projectId:string) {
    return this.tactics(projectId).some(task=>!['achieved','parked'].includes(task.recommendation))?60_000:90_000
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
      const events=this.store.events(projectId,start,limit),through=events.at(-1)?.id??start,graphs=this.store.projectGraphs(projectId)
      cursor.delivered=Math.max(cursor.delivered,through);c.cursors[projectId]=cursor;this.saveCampaign(c)
      return{events:events.map(e=>({id:e.id,type:e.type,taskKey:graphs.find(g=>g.id===e.graphId)?.taskKey??(e.payload as Record<string,unknown>).taskKey??null,createdAt:e.createdAt})),cursor:through,hasMore:this.store.events(projectId,through,1).length>0}
    })
  }
  boardSummary(taskKey?:string) {
    const id=this.owner(),project=this.store.project(id),campaign=this.campaign(id),budget=this.budget(Date.now(),id)
    const graphs=this.store.projectGraphs(id).filter(g=>(project.mode==='general'||g.type==='benchmark_task')&&(!taskKey||g.taskKey===taskKey))
    const steps=this.store.nodes<Step>(id,['step']).filter(s=>!s.deleted),runs=this.store.runs(id).filter(r=>['running','paused','unknown'].includes(r.status))
    const goals=this.store.nodes<Goal>(id,['goal']),tactics=this.tactics(id)
    const messages=this.messages(id,'commander').filter(m=>m.status!=='admitted').sort((a,b)=>(a.type==='HELP'?0:1)-(b.type==='HELP'?0:1))
    const lines=[`Project ${id} ${project.status}; budget=${budget.phase} ${budget.remainingMs??'open'}ms; cursor=${campaign.cursors[id]?.acknowledged??0}`]
    for(const m of messages.slice(0,8))lines.push(`${m.type} ${m.id} from ${m.sender}: ${String(m.content).replace(/\s+/g,' ').slice(0,120)}`)
    const tasks=graphs.map(g=>{
      const own=steps.filter(s=>s.graphId===g.id),live=runs.filter(r=>r.graphId===g.id),goal=goals.find(x=>x.id===g.goalId),tactic=tactics.find(x=>x.taskKey===g.taskKey)
      const priority=messages.some(m=>m.type==='HELP'&&live.some(r=>r.id===m.sender))?0:live.some(r=>r.status==='unknown'||r.pendingTools.length)?1:live.length?2:goal?.status==='achieved'?3:own.some(s=>s.status==='parked')?4:5
      return{g,own,live,goal,tactic,priority}
    }).sort((a,b)=>a.priority-b.priority||(a.g.taskKey??a.g.id).localeCompare(b.g.taskKey??b.g.id))
    const capacity=Math.max(0,99-lines.length)
    for(const task of tasks.slice(0,capacity))lines.push(`${task.g.taskKey} ${project.mode==='general'?'graph='+task.g.id+' origin='+task.g.originId+' goal='+task.g.goalId+' ':''}${task.goal?.status==='achieved'?'goal-achieved':task.own.some(s=>s.status==='parked')?'parked':task.live.length?'active':'pending'} submitted=${!!task.tactic?.classification?.submissionAttemptedAt} platform=${task.tactic?.classification?.platformCompleted===true?'confirmed':'unconfirmed'}; runs=${task.live.map(r=>r.id+':'+r.status).join(',')||'-'}; difficulty=${task.tactic?.classification?.difficulty??'unknown'} family=${task.tactic?.classification?.family??'-'}; workers=${task.own.filter(s=>!['done','cancelled'].includes(s.status)).map(s=>s.id+':'+s.role+':'+s.status+':'+s.description.slice(0,100)).join('|')||'-'}; stalled=${Math.floor(task.tactic?.stalledMinutes??0)}m; evidence=${task.tactic?.lastEvidenceAt??'-'}; next=${task.tactic?.recommendation??'scout'}`)
    if(tasks.length>capacity)lines.push(`omitted=${tasks.length-capacity}; query a task Graph on demand`)
    return{projectId:id,sessionId:campaign.sessionId,cursors:campaign.cursors,budget,lines:lines.slice(0,100)}
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
        const cursor = campaign.cursors[projectId]
        if (!cursor || !Number.isSafeInteger(through) || through < cursor.acknowledged || through > cursor.delivered) throw new HttpError(422, 'Acknowledgement exceeds delivered project events')
        cursor.acknowledged = through
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
  spawn(projectId: string, mission: SpawnMission, maxSteps: number | null = null) {
    return this.store.transaction(() => {
      this.active(projectId)
      if (['submission','ended'].includes(this.budget(Date.now(),projectId).phase)) throw new HttpError(409, 'Campaign is in submission-only or ended phase; no new Missions')
      requiredText(mission.taskKey, 'taskKey')
      const graphs=this.store.projectGraphs(projectId), graph=mission.graphId ? this.store.projectGraph(projectId,mission.graphId) : graphs.find(g=>g.taskKey===mission.taskKey) ?? (this.store.project(projectId).mode==='general'?graphs[0]:undefined)
      if(!graph) throw new HttpError(422,'Initialize the task Graph before creating a Mission')
      if (this.store.project(projectId).mode === 'general' && mission.role === 'scout') throw new HttpError(422, 'General mode has no Scout; Commander owns planning')
      if (!mission.parentRunId) {
        const task = this.tactics(projectId).find(t => t.taskKey === mission.taskKey)
        const active = this.steps(projectId, mission.taskKey).filter(s => ['pending','running','paused'].includes(s.status))
        if (active.some(s => s.role === mission.role && s.description === mission.description)) throw new HttpError(409, 'Assign a different angle from the active Worker')
        if (mission.role === 'general' && active.some(s => s.role === 'general')) throw new HttpError(409, 'General already active on this task')
      }
      if(graph.type==='benchmark_task'&&graph.taskKey!==mission.taskKey) throw new HttpError(422,'taskKey belongs to another Graph')
      const scoped=this.store.forGraph(projectId,graph.id)
      if (this.steps(projectId, mission.taskKey).some(s => s.status === 'parked')) throw new HttpError(409, 'Task is parked')
      let parent: Step | undefined
      if (mission.parentRunId) {
        const run = this.store.run(mission.parentRunId)
        if (run.projectId !== projectId || run.status !== 'running' || run.activity !== 'execute' || !run.stepId) throw new HttpError(403, 'Delegating Run is not active in this Project')
        parent = this.store.node<Step>(projectId, run.stepId, 'step')
        if (parent.role !== 'general' || parent.status !== 'running' || parent.taskKey !== mission.taskKey || mission.role === 'general' || mission.role === 'reporter') throw new HttpError(403, 'General may delegate only same-task Soldier/Scout missions')
        let goal = this.store.node<Goal>(projectId, mission.goalId ?? parent.goalId, 'goal')
        while (goal.id !== parent.goalId && goal.parentId) goal = this.store.node<Goal>(projectId, goal.parentId, 'goal')
        if (goal.id !== parent.goalId) throw new HttpError(403, 'Delegation escapes the assigned Goal')
        if (parent.executionProfile === 'isolated' && mission.executionProfile === 'direct') throw new HttpError(403, 'Delegation cannot weaken execution isolation')
        const squads = this.store.nodes(projectId, ['step']).filter((s): s is Step => s.kind === 'step' && s.parentStepId === parent!.id && !s.deleted && ['pending', 'running', 'paused', 'parked'].includes(s.status))
        if (squads.length >= 2) throw new HttpError(409, 'General already has two active squads')
      }
      const { escalationReason, ...assignment } = mission
      const step = scoped.addStep(projectId, { ...assignment, executionProfile: mission.executionProfile ?? parent?.executionProfile, goalId: mission.goalId ?? parent?.goalId,
        parentStepId: parent?.id, creator: mission.parentRunId ?? 'commander' }, maxSteps)
      if (escalationReason) this.store.event(projectId, 'legion.escalated', step, { reason: escalationReason })
      return step
    })
  }
  park(projectId: string, taskKey: string, reason: string, resumeCondition: string) {
    return this.store.transaction(() => {
      this.active(projectId); requiredText(reason, 'reason'); requiredText(resumeCondition, 'resumeCondition')
      const steps = this.steps(projectId, taskKey).filter(s => !['done', 'cancelled'].includes(s.status))
      if (!steps.length) throw new HttpError(404, 'No unfinished task Steps')
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
      const steps = this.steps(projectId, taskKey).filter(s => s.status === 'parked')
      if (!steps.length) throw new HttpError(404, 'Task is not parked')
      const ids = new Set(steps.map(s => s.id))
      if (steps.some(s => s.handoffPending) || this.store.runs(projectId).some(r => ids.has(r.stepId ?? '') && ['running', 'paused', 'unknown'].includes(r.status))) throw new HttpError(409, 'Confirm old executions stopped and resolve unknown results before reactivation')
      for (const step of steps) {
        step.status = 'pending'; delete step.parkReason; delete step.resumeCondition
        this.store.saveNode(step); this.store.event(projectId, 'step.reactivated', step, { reason })
      }
      return steps
    })
  }

  saveState(projectId:string|undefined,actor:string,summary:string) {
    const text=requiredText(summary,'summary')
    if(actor==='commander'){const c=this.campaign(projectId);c.state=text;this.saveCampaign(c);return{saved:true}}
    const run=this.store.run(actor);if(run.projectId!==projectId||!run.stepId||run.status!=='running')throw new HttpError(409,'State actor is not active')
    const step=this.store.node<Step>(projectId,run.stepId,'step');step.handoff=text;this.store.saveNode(step);return{saved:true}
  }
  queueHandoff(runId:string,summary:string,nextWorker?:string) {
    const run=this.store.run(runId);if(!run.stepId||run.status!=='running')throw new HttpError(409,'Handoff actor is not running')
    const step=this.store.node<Step>(run.projectId,run.stepId,'step');step.handoffRequest={summary:requiredText(summary,'summary'),...(nextWorker?{nextWorker}:{})};this.store.saveNode(step);return{requested:true,stopConfirmed:false}
  }
  settleHandoff(runId:string) {
    const run=this.store.run(runId);if(!run.stepId||run.status!=='running'||run.pendingTools.length)return
    const step=this.store.node<Step>(run.projectId,run.stepId,'step')
    if(step.status==='running'&&step.handoffRequest)this.requestHandoff(runId,step.handoffRequest.summary,step.handoffRequest.nextWorker)
  }

  requestHandoff(runId: string, summary: string, nextWorker?: string) {
    return this.store.transaction(() => {
      const run = this.store.run(runId); this.active(run.projectId)
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
    for (const actor of [sender, receiver]) if (actor !== 'commander') {
      const run = this.store.run(actor)
      if (run.projectId !== projectId || !['running', 'paused'].includes(run.status)) throw new HttpError(409, 'Message actor is stopped or belongs to another Project')
    }
    if(sender!=='commander'&&receiver!=='commander') {
      const from=this.store.run(sender),to=this.store.run(receiver)
      if(from.graphId!==to.graphId) throw new HttpError(403,'Workers cannot message another Graph')
      const source=this.store.node<Step>(projectId,from.stepId!,'step'),target=this.store.node<Step>(projectId,to.stepId!,'step')
      if(source.parentStepId!==target.id && target.parentStepId!==source.id) throw new HttpError(403,'Use the Commander for unrelated Agents')
    }
    const message = { id: 'msg-' + randomUUID(), projectId, sender, receiver, type, content: requiredText(content, 'content'), status: 'pending', createdAt: now() }
    this.store.db.prepare('INSERT INTO legion_messages VALUES (?,?,?,?,?,?)').run(message.id, projectId, sender, receiver, JSON.stringify(message), message.createdAt)
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
