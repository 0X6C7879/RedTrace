import { randomUUID } from 'node:crypto'
import { Store } from './store.ts'
import { HttpError, now, requiredText } from './types.ts'
import type { LegionRole, Step, Goal } from './types.ts'

export interface CommandCursor { delivered: number; acknowledged: number }
export interface Campaign {
  sessionId: string; status: 'idle' | 'running' | 'stopped'; state: string
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
      'sender TEXT NOT NULL, receiver TEXT NOT NULL, data TEXT NOT NULL, created_at TEXT NOT NULL);')
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
  finishCommand(processed: Record<string, number>, state: string) {
    return this.store.transaction(() => {
      const campaign = this.campaign()
      if (campaign.status !== 'running') throw new HttpError(409, 'Commander is not running')
      for (const [projectId, through] of Object.entries(processed)) {
        this.store.project(projectId)
        const cursor = campaign.cursors[projectId]
        if (!cursor || !Number.isSafeInteger(through) || through < cursor.acknowledged || through > cursor.delivered) throw new HttpError(422, 'Acknowledgement exceeds delivered project events')
        cursor.acknowledged = through
      }
      campaign.state = requiredText(state, 'state'); campaign.status = 'idle'; this.saveCampaign(campaign)
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
        const squads = this.store.nodes(projectId, ['step']).filter((s): s is Step => s.kind === 'step' && s.parentStepId === parent!.id && !s.deleted && ['pending', 'running', 'paused', 'parked'].includes(s.status))
        if (squads.length >= 2) throw new HttpError(409, 'General already has two active squads')
      }
      return this.store.addStep(projectId, { ...mission, goalId: mission.goalId ?? parent?.goalId,
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
  requestHandoff(runId: string, summary: string) {
    return this.store.transaction(() => {
      const run = this.store.run(runId); this.active(run.projectId)
      if (!run.stepId || run.activity !== 'execute' || !['running', 'paused'].includes(run.status)) throw new HttpError(409, 'Run cannot hand off')
      if (run.pendingTools.length) throw new HttpError(409, 'Unconfirmed tool results prevent handoff')
      const step = this.store.node<Step>(run.projectId, run.stepId, 'step')
      if (!['running', 'paused'].includes(step.status)) throw new HttpError(409, 'Step cannot hand off')
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
      step.status = 'pending'; step.handoffPending = false; step.failure = null; step.endedAt = null
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
    return message
  }
  messages(projectId: string, receiver: string) {
    this.store.project(projectId)
    return this.store.db.prepare('SELECT data FROM legion_messages WHERE project_id=? AND receiver=? ORDER BY created_at,id').all(projectId, receiver).map(r => JSON.parse(String(r.data)))
  }
}
