import { randomUUID } from 'node:crypto'
import { Store } from './store.ts'
import { HttpError, now, requiredText } from './types.ts'
import type { LegionRole, Step, Goal } from './types.ts'

export interface CommandCursor { delivered: number; acknowledged: number }
export interface Campaign {
  sessionId: string; status: 'idle' | 'running' | 'stopped'; state: string
  hasSession?: boolean; workerName?: string; usage?: {inputTokens:number;outputTokens:number;cacheReadTokens:number;cacheWriteTokens:number}; error?: string; endgame?: string; startedAt?: number; deadline?: number; pendingTools?: string[]; nextWorker?: string; previousSessionId?: string
  cursors: Record<string, CommandCursor>
}
export interface SpawnMission {
  role: LegionRole; taskKey: string; description: string; sourceIds: string[]
  goalId?: string; parentRunId?: string; priority?: number; executionProfile?: Step['executionProfile']
}

/** Durable organization state; execution still belongs to Store and Scheduler. */
export class LegionStore {
  readonly store: Store
  constructor(store: Store) {
    this.store = store
    store.db.exec('CREATE TABLE IF NOT EXISTS campaign(id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS legion_messages(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,' +
      'sender TEXT NOT NULL, receiver TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS legion_tasks(project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_key TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(project_id,task_key));' +
      'CREATE TABLE IF NOT EXISTS legion_platform_events(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_key TEXT NOT NULL,action TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);')
  }
  campaign(): Campaign {
    const row = this.store.db.prepare('SELECT data FROM campaign WHERE id=1').get()
    if (row) return JSON.parse(String(row.data))
    const campaign: Campaign = { sessionId: 'command-' + randomUUID(), status: 'idle', state: '', cursors: {} }
    this.saveCampaign(campaign)
    return campaign
  }
  saveCampaign(campaign: Campaign) {
    this.store.db.prepare('INSERT INTO campaign VALUES (1,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data').run(JSON.stringify(campaign))
  }

  budget(at=Date.now()) {
    const c=this.campaign(), left=c.deadline===undefined?null:Math.max(0,c.deadline-at), total=c.deadline===undefined?null:c.deadline-(c.startedAt??at)
    return { remainingMs:left,phase:left===null?'open':left===0?'ended':left<=20*60000?'submission':total!==null&&left<=total/4?'endgame':'campaign' }
  }
  setDeadline(deadline:number) {
    if(!Number.isFinite(deadline)||deadline<=Date.now())throw new HttpError(422,'Deadline must be a future epoch in milliseconds')
    const c=this.campaign();c.startedAt=Date.now();c.deadline=deadline;this.saveCampaign(c);this.store.changes.emit('legion-budget');return this.budget()
  }
  classify(projectId:string,taskKey:string,difficulty:'easy'|'medium'|'hard'|'unclear',factIds:string[]) {
    this.active(projectId);requiredText(taskKey,'taskKey')
    if(!['easy','medium','hard','unclear'].includes(difficulty)||!factIds.length)throw new HttpError(422,'Classification requires a verdict and confirmed target evidence')
    for(const id of factIds){const fact=this.store.node(projectId,id,'fact');if(id==='origin'||!('stepId'in fact)||!fact.stepId||this.store.node<Step>(projectId,fact.stepId,'step').taskKey!==taskKey||this.store.node<Step>(projectId,fact.stepId,'step').role!=='scout'||this.store.node<Step>(projectId,fact.stepId,'step').status!=='done')throw new HttpError(422,'Classification evidence must come from this completed Scout task')}
    const data={difficulty,factIds,classifiedAt:now()};this.store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,taskKey,JSON.stringify(data));this.store.event(projectId,'legion.classified',null,{taskKey,difficulty});return data
  }
  tactics(projectId:string,at=Date.now()) {
    const tasks=new Set(this.store.nodes<Step>(projectId,['step']).filter(s=>!s.deleted).map(s=>s.taskKey??s.goalId))
    return [...tasks].map(taskKey=>{
      const steps=this.steps(projectId,taskKey),ids=new Set(steps.map(s=>s.id))
      const intervals=this.store.runs(projectId).filter(r=>ids.has(r.stepId??'')).map(r=>[Date.parse(r.startedAt),r.endedAt?Date.parse(r.endedAt):at]).sort((a,b)=>a[0]-b[0])
      let elapsedMs=0,start=0,end=0;for(const [a,b]of intervals){if(a>end){elapsedMs+=end-start;start=a;end=b}else end=Math.max(end,b)}elapsedMs+=end-start
      const row=this.store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey),classification=row?JSON.parse(String(row.data)):null
      const minutes=elapsedMs/60000,recommendation=steps.some(s=>s.status==='parked')?'parked':!classification?'scout':classification.difficulty==='hard'&&minutes<30?'general':minutes>=45?'park':minutes>=20?'general':minutes>=10?'second-angle':'tactical'
      return{taskKey,elapsedMs,classification,recommendation,stepIds:steps.map(s=>s.id),facts:steps.flatMap(s=>s.factIds),generals:steps.filter(s=>s.role==='general').length}
    })
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
    return { campaign: { ...this.campaign(), ...this.budget() }, messages:this.store.db.prepare('SELECT data FROM legion_messages ORDER BY created_at DESC LIMIT 100').all().map(r=>JSON.parse(String(r.data))), projects: store.projects().map(p => ({ id:p.id,title:p.title,status:p.status,revision:p.revision,runs:(['running','paused','unknown'] as const).flatMap(status=>store.runsByStatus(status,p.id)).map(r=>({id:r.id,stepId:r.stepId,status:r.status,worker:r.worker,provider:r.provider,model:r.model,contextPressure:r.contextPressure,pendingTools:r.pendingTools.length})),tactics:this.tactics(p.id),instances:p.benchmarkHosts??{},scopeId:'origin', goals:store.nodes<Goal>(p.id,['goal']).map(g=>({id:g.id,description:g.description,status:g.status,version:g.version,evidenceIds:g.evidenceIds})), steps:store.nodes<Step>(p.id,['step']).map(s=>({id:s.id,description:s.description,taskKey:s.taskKey,role:s.role,status:s.status,parentStepId:s.parentStepId,parkReason:s.parkReason,resumeCondition:s.resumeCondition,handoffPending:s.handoffPending,predecessorRunId:s.predecessorRunId,goalId:s.goalId,factIds:s.factIds,initialMission:s.bootstrap})) })) }
  }
  claimCommand() {
    return this.store.transaction(() => {
      const campaign = this.campaign()
      if (campaign.status !== 'idle') throw new HttpError(409, 'Commander is not idle')
      campaign.status = 'running'; this.saveCampaign(campaign); return campaign
    })
  }
  readChanges(projectId: string, after?: number, limit = 100) {
    return this.store.transaction(() => {
      this.store.project(projectId)
      const campaign = this.campaign(), cursor = campaign.cursors[projectId] ?? { delivered: 0, acknowledged: 0 }
      const start = after ?? cursor.acknowledged
      if (!Number.isSafeInteger(start) || start < 0 || start > cursor.delivered) throw new HttpError(422, 'Cannot skip undelivered project events')
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new HttpError(422, 'limit must be between 1 and 100')
      const result = this.store.graphDelta(projectId, start, limit)
      cursor.delivered = Math.max(cursor.delivered, result.cursor)
      campaign.cursors[projectId] = cursor; this.saveCampaign(campaign)
      return { ...result, acknowledgementBoundary: { ...cursor } }
    })
  }
  finishCommand(processed: Record<string, number>, state: string, release = true) {
    return this.store.transaction(() => {
      const campaign = this.campaign()
      if (campaign.status !== 'running') throw new HttpError(409, 'Commander is not running')
      for (const [projectId, through] of Object.entries(processed)) {
        this.store.project(projectId)
        const cursor = campaign.cursors[projectId]
        if (!cursor || !Number.isSafeInteger(through) || through < cursor.acknowledged || through > cursor.delivered) throw new HttpError(422, 'Acknowledgement exceeds delivered project events')
        cursor.acknowledged = through
      }
      campaign.state = requiredText(state, 'state'); campaign.status = release ? 'idle' : 'running'; this.saveCampaign(campaign)
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
      if (['submission','ended'].includes(this.budget().phase)) throw new HttpError(409, 'Campaign is in submission-only or ended phase; no new Missions')
      requiredText(mission.taskKey, 'taskKey')
      if (this.steps(projectId, mission.taskKey).some(s => s.status === 'parked')) throw new HttpError(409, 'Task is parked')
      let parent: Step | undefined
      if (mission.parentRunId) {
        const run = this.store.run(mission.parentRunId)
        if (run.projectId !== projectId || run.status !== 'running' || run.activity !== 'execute' || !run.stepId) throw new HttpError(403, 'Delegating Run is not active in this Project')
        parent = this.store.node<Step>(projectId, run.stepId, 'step')
        if (parent.role !== 'general' || parent.status !== 'running' || parent.taskKey !== mission.taskKey || mission.role === 'general') throw new HttpError(403, 'General may delegate only same-task Soldier/Scout missions')
        let goal = this.store.node<Goal>(projectId, mission.goalId ?? parent.goalId, 'goal')
        while (goal.id !== parent.goalId && goal.parentId) goal = this.store.node<Goal>(projectId, goal.parentId, 'goal')
        if (goal.id !== parent.goalId) throw new HttpError(403, 'Delegation escapes the assigned Goal')
        if (parent.executionProfile === 'isolated' && mission.executionProfile === 'direct') throw new HttpError(403, 'Delegation cannot weaken execution isolation')
        const squads = this.store.nodes(projectId, ['step']).filter((s): s is Step => s.kind === 'step' && s.parentStepId === parent!.id && !s.deleted && ['pending', 'running', 'paused', 'parked'].includes(s.status))
        if (squads.length >= 2) throw new HttpError(409, 'General already has two active squads')
      }
      return this.store.addStep(projectId, { ...mission, executionProfile: mission.executionProfile ?? parent?.executionProfile, goalId: mission.goalId ?? parent?.goalId,
        parentStepId: parent?.id, creator: mission.parentRunId ?? 'commander' }, maxSteps)
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
    if(actor==='commander'){const c=this.campaign();c.state=text;this.saveCampaign(c);return{saved:true}}
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
    this.active(projectId)
    if (!['HELP', 'REPORT', 'MESSAGE'].includes(type)) throw new HttpError(422, 'Invalid message type')
    for (const actor of [sender, receiver]) if (actor !== 'commander') {
      const run = this.store.run(actor)
      if (run.projectId !== projectId || !['running', 'paused'].includes(run.status)) throw new HttpError(409, 'Message actor is stopped or belongs to another Project')
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
        const cursor = Number(this.store.db.prepare('SELECT COALESCE(MAX(id),0) AS cursor FROM events WHERE project_id=?').get(projectId)!.cursor)
        const messages = this.messages(projectId, receiver).filter(m => m.status === 'pending' || m.status === 'queued').map(m => String(m.id))
        if (cursor > after || messages.length) { cleanup(); resolve({ cursor, messages }) }
      }
      this.store.changes.on('change', changed); this.store.changes.on('legion-message', changed)
      signal?.addEventListener('abort', abort, { once: true }); changed()
    })
  }

}
