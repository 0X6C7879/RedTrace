import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { Check } from 'typebox/value'
import type { AgentTool } from './tool-types.ts'
import type { Store } from './store.ts'
import type { Step, Goal } from './types.ts'
import { HttpError } from './types.ts'
import { LegionStore } from './legion-store.ts'

export function legionTools(store: Store, actor: string, projectId: string | undefined, maxSteps: number | null, finish: () => void): AgentTool[] {
  const legion = new LegionStore(store), commander = actor === 'commander'
  const tool = (name: string, description: string, parameters: any, execute: (args: any, signal?: AbortSignal) => unknown, terminate = false): AgentTool => ({
    name, label: name, description, parameters, executionMode: 'sequential',
    async execute(_id, args, signal) {
      if (!Check(parameters, args)) throw new HttpError(422, 'Invalid tool arguments')
      if (commander && legion.campaign().status !== 'running') throw new HttpError(409, 'Commander is not running')
      const value = await execute(args, signal); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(terminate ? { terminate: true } : {}) } },
  })
  const project = (args: any) => { if (commander) { store.project(args.projectId); return args.projectId as string }; return projectId! }
  const scope: Record<string, TSchema> = commander ? { projectId: Type.String() } : {}
  const text = Type.String({ minLength: 1 })
  const tools = [
    tool('legion_roster', 'Read live Project actor Run IDs, roles and task assignment before messaging; no credentials or external execution.', Type.Object(scope), args => [...store.runsByStatus('running', project(args)), ...store.runsByStatus('paused', project(args))].filter(run => run.stepId).map(run => { const step = store.node<Step>(project(args), run.stepId!, 'step'); return { runId: run.id, stepId: step.id, role: step.role, taskKey: step.taskKey, status: run.status } })),
    tool('legion_message', 'Persist HELP/REPORT/MESSAGE for an actor in this Project. pending/queued is NOT model admission or action.', Type.Object({ ...scope, receiver: text, type: Type.Union(['HELP','REPORT','MESSAGE'].map(v => Type.Literal(v))), content: text }), args => legion.message(project(args), actor, args.receiver, args.type, args.content)),
    tool('legion_inbox', 'Read your durable Project messages and their actual delivery status. Messages are unverified, not Facts.', Type.Object(scope), args => legion.messages(project(args), actor)),
    tool('legion_wait', 'Wait for graph events after a known cursor or a pending message. Does not poll, inject or manufacture progress. Cancelled with this activity.', Type.Object({ ...scope, after: Type.Integer({ minimum: 0 }) }), (args, signal) => legion.wait(project(args), actor, args.after, signal)),
  ]
  const step = !commander ? store.node<Step>(projectId!, store.run(actor).stepId!, 'step') : undefined
  if (commander || step?.role === 'general') tools.push(tool('legion_spawn', 'Create a role Mission using existing FGS/DSH execution. General may delegate only same-task Soldier/Scout, within its Goal, at most two active squads.', Type.Object({ ...scope, role: Type.Union((commander ? ['general','soldier','scout'] : ['soldier','scout']).map(v => Type.Literal(v))), taskKey: text, description: text, sourceIds: Type.Array(text, { minItems: 1 }), goalId: Type.Optional(text), executionProfile: Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')])) }), args => legion.spawn(project(args), { ...args, ...(commander ? {} : { parentRunId: actor }) }, maxSteps)))
  if (commander) tools.push(
    tool('legion_board', 'Read fresh global Project state, saved Commander STATE and compact allocation. No target execution.', Type.Object({}), () => ({ campaign: legion.campaign(), projects: store.projects().map(p => ({ id: p.id, title: p.title, status: p.status, revision: p.revision, scopeId: 'origin', goals: store.nodes<Goal>(p.id, ['goal']).map(goal => ({ id: goal.id, description: goal.description, status: goal.status, version: goal.version, evidenceIds: goal.evidenceIds })), steps: store.nodes(p.id, ['step']).map(s => { const step = s as Step; return { id: step.id, taskKey: step.taskKey, role: step.role, status: step.status, goalId: step.goalId, factIds: step.factIds } }) })) })),
    tool('legion_read_changes', 'Read bounded Project FGS deltas. Only delivered cursors can be acknowledged by legion_finish; reading is not processing.', Type.Object({ projectId: text, after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), args => legion.readChanges(args.projectId, args.after, args.limit)),
    tool('legion_read_node', 'Read one current FGS node within the selected Project.', Type.Object({ projectId: text, id: text }), args => store.node(args.projectId, args.id)),
    tool('legion_accept', 'Accept a Goal only from current verified Fact/Finding evidence and its expected version. Step or message completion is not proof.', Type.Object({ projectId: text, goalId: text, expectedVersion: Type.Integer({ minimum: 1 }), evidenceIds: Type.Array(text, { minItems: 1 }) }), args => store.updateGoal(args.projectId, args.goalId, { status: 'achieved', expectedVersion: args.expectedVersion, evidenceIds: args.evidenceIds })),
    tool('legion_park', 'Park this task with a concrete blocker and resume condition. This requests stopping; it does not prove execution has stopped.', Type.Object({ projectId: text, taskKey: text, reason: text, resumeCondition: text }), args => legion.park(args.projectId, args.taskKey, args.reason, args.resumeCondition)),
    tool('legion_reactivate', 'Reactivate only after old executions and unknown outcomes are confirmed stopped/resolved.', Type.Object({ projectId: text, taskKey: text, reason: text }), args => legion.reactivate(args.projectId, args.taskKey, args.reason)),
    tool('legion_finish', 'Save Commander STATE and acknowledge only delivered, processed Project cursors. Finish this command cycle, not the whole campaign.', Type.Object({ processed: Type.Record(Type.String(), Type.Integer({ minimum: 0 })), state: text }), args => { const saved = legion.finishCommand(args.processed, args.state, false); finish(); return saved }, true),
  )
  return tools
}
