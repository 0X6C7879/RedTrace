import type { FixedRole } from '../../redtrace-dsh/src/roles.ts'
export type Activity = 'decide' | 'execute' | 'plan'
export type ProjectStatus = 'active' | 'stopped' | 'completed' | 'deleting'
export type StepStatus = 'pending' | 'running' | 'paused' | 'parked' | 'blocked' | 'done' | 'cancelled'
export type RunStatus = 'running' | 'paused' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface Project {
  id: string; title: string; mode: 'benchmark' | 'general'; objective?:string; status: ProjectStatus; bootstrap: boolean; createdAt: string
  revision: number; planningRevision: number; decidedRevision: number; retryAfter: number
  factSeq: number; endedSeq: number; acknowledgedFactSeq: number; acknowledgedEndedSeq: number
  evidenceSeq?: number; acknowledgedEvidenceSeq?: number
  hintSeq?: number; acknowledgedHintSeq?: number
  criticalSeq?: number; acknowledgedCriticalSeq?: number
  benchmarkHosts?: Record<string,string[]>
  initialPlanningPending: boolean; planningRetryPending: boolean
  failureCount?: number; failureSignature?: string | null; circuitOpen?: boolean; contextRevision?: number
}
export interface ProjectGraph {
  id: string; projectId: string; type: 'main' | 'benchmark_task'; taskKey: string | null; title: string
  status: 'active' | 'completed'; originId: string; goalId: string; createdAt: string; updatedAt: string
  revision: number; factSeq: number; evidenceSeq: number; hintSeq: number; endedSeq: number
  planner?: GraphPlanner
}
/** Graph-owned planning actor, never an FGS execution node. */
export interface GraphPlanner {
  id: string; projectId: string; graphId: string; role: 'general'; taskKey: string; description: string
  goalId: string; sourceIds: string[]; executionProfile: 'direct' | 'isolated'; priority: number
  status: StepStatus; handoff?: string; nextWorker?: string; retryAfter?: number | null; failureCount?: number
  handoffRequest?: {summary:string;nextWorker?:string}
  cursor: { delivered: number; acknowledged: number }; createdAt: string; legacyAssignments?: Step[]
}
export type TaskAssignment = Step | GraphPlanner
export type LegionRole = Exclude<FixedRole, 'commander'> | 'reporter'
export interface Evidence { path?: string; artifactId?: string; runId?: string; toolCallId?: string; description: string }
export interface Specialist { name: string; responsibilities: string; capabilities: string[]; scope: string }
export interface LegionAssignment {
  specialist?: Specialist
  reportFindingId?: string
  role?: LegionRole | 'scout'; taskKey?: string; parentStepId?: string; plannerId?: string // Scout can occur in stored Steps only.
  parkReason?: string; resumeCondition?: string
  predecessorRunId?: string; handoff?: string; handoffPending?: boolean; nextWorker?: string
  handoffRequest?: { summary: string; nextWorker?: string }
}
export interface NodeBase { graphId?: string | null; id: string; projectId: string; createdAt: string; creator: string; version?: number }
export interface Fact extends NodeBase { producerRunId?:string; kind: 'fact'; title: string; description: string; doc?: Evidence; stepId: string | null; evidence: Evidence[]; producerStepIds?: string[] }
export interface Goal extends NodeBase { kind: 'goal'; description: string; parentId: string | null; status: 'open' | 'achieved' | 'cancelled'; evidenceIds: string[] }
export interface Step extends NodeBase, LegionAssignment {
  kind: 'step'; description: string; goalId: string; sourceIds: string[]; dependsOn?: string[]; factIds: string[]
  status: StepStatus; priority: number; worker: string | null; executionProfile: 'direct' | 'isolated'
  /** Legacy declarations; ignored by execution. */
  requires?: string[]; attempts: number; endedAt: string | null; failure: string | null
  plugins?: string[]
  scoutVerdict?: {difficulty:'easy'|'medium'|'hard'|'unclear';family?:string}
  bootstrap: boolean; deleted?: boolean; resultGoalId?: string; sourceGoalId?: string
  failureCount?: number; retryAfter?: number | null; circuitOpen?: boolean; runtimeMs?: number
  planVersion?: number; replaces?: string; replacedBy?: string; replacementPending?: boolean
}
export interface Finding extends NodeBase { producerRunId?:string; kind: 'finding'; title: string; description: string; type: string; factIds: string[]; details: Json; severity?: 'critical' | 'high' | 'medium' | 'low'; assetIds?: string[]; report?: Evidence; stepId?: string | null; producerStepIds?: string[] }
export interface Input extends NodeBase { kind: 'hint' | 'observation'; content: string; stepId: string | null; deleted: boolean }
export type GraphNode = Fact | Goal | Step | Finding | Input
export interface Graph { graph?: ProjectGraph; project: Project; facts: Fact[]; goals: Goal[]; steps: Step[]; findings: Finding[]; hints: Input[]; observations: Input[] }
export interface GraphEvent { graphId?: string | null; id: number; projectId: string; revision: number; type: string; nodeId: string | null; payload: Json; createdAt: string }
export interface Run {
  graphId?: string | null
  id: string; projectId: string; stepId: string | null; activity: Activity; worker: string
  backend: 'dsh' | 'mock'; status: RunStatus; startedAt: string; endedAt: string | null
  baseRevision: number; checkpoint: Json; pendingTools: string[]; error: string | null
  planningFactSeq?: number; planningEndedSeq?: number
  planningCriticalSeq?: number
  planningEvidenceSeq?: number; processedEvidenceSeq?: number; deliveredEvidenceSeq?: number; boundStepVersion?: number
  planningHintSeq?: number; processedHintSeq?: number; deliveredHintSeq?: number
  processedGraphCursor?: number
  deliveredGraphCursor?: number
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
  failureCode?: string; heartbeatAt?: string; trigger?: string
  provider?: string; model?: string; workspaceRoot?: string
  contextPressure?: { source: 'dsh-token-meter'; tokens: number; capacity: number; ratio: number }
  predecessorRunId?: string; handoff?: string
}
export interface Worker {
  roles?: FixedRole[]
  name: string; provider: string; model: string; enabled: boolean
  /** Capabilities from the worker configuration: Decide, ordinary Steps, bootstrap Steps. */
  reason?: boolean; explore?: boolean; bootstrap?: boolean
  maxRunning: number; priority: number; backend: Run['backend']
}
export interface Provider {
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; baseUrl: string
  apiKey?: string; apiKeyEnv?: string
  models: { id: string; contextWindow: number; maxTokens: number; reasoning?: string; reasoningEfforts?: Record<string, string | null> | boolean | null; thinkingFormat?: string }[]
}
export interface LlmPolling { enabled: boolean; models: Record<string, string[]> }
export interface EngineConfig {
  llmPolling?: LlmPolling
  commanderInspection?: {active:number;idle:number}
  maxBenchmarkTasks?: number | null
  taskLimits?: Record<string, {timeout:number;concludeTimeout:number}>
  workers: Worker[]; providers: Record<string, Provider>; maxWorkers: number; maxProjectWorkers: number
  maxRunningProjects: number; maxSteps: number | null; decideTimeout: number; executeTimeout: number
  concludeTimeout: number; bootstrapTimeout: number; bootstrapConcludeTimeout: number
  workspaceRoot: string; commonEnv?: Record<string, string>
}
export class HttpError extends Error {
  status: number
  details?: unknown
  constructor(status: number, message: string, details?: unknown) { super(message); this.status = status; this.details = details }
}
export function activeEvidence(node: GraphNode): boolean {
  return !('deleted' in node && node.deleted)
}
export function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(422, `${name} must be a non-empty string`)
  return value.trim()
}
export function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new HttpError(422, `${name} must be an integer >= ${minimum}`)
  return value
}
export const isScopeId = (id:string) => id==='origin'||id.startsWith('origin-graph-')
export const now = () => new Date().toISOString()
