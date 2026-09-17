export type Activity = 'decide' | 'execute'
export type ProjectStatus = 'active' | 'stopped' | 'completed' | 'deleting'
export type StepStatus = 'pending' | 'running' | 'paused' | 'blocked' | 'done' | 'cancelled'
export type RunStatus = 'running' | 'paused' | 'succeeded' | 'failed' | 'unknown' | 'cancelled'
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface Project {
  id: string; title: string; status: ProjectStatus; bootstrap: boolean; createdAt: string
  revision: number; planningRevision: number; decidedRevision: number; retryAfter: number
  failureCount?: number; failureSignature?: string | null; circuitOpen?: boolean; contextRevision?: number
}
export interface Evidence { path?: string; runId?: string; toolCallId?: string; description: string }
export interface NodeBase { id: string; projectId: string; createdAt: string; creator: string }
export interface Fact extends NodeBase { kind: 'fact'; description: string; stepId: string | null; evidence: Evidence[]; deleted?: boolean }
export interface Goal extends NodeBase { kind: 'goal'; description: string; parentId: string | null; status: 'open' | 'achieved' | 'cancelled'; evidenceIds: string[] }
export interface Step extends NodeBase {
  kind: 'step'; description: string; goalId: string; sourceIds: string[]; factIds: string[]
  status: StepStatus; priority: number; worker: string | null; executionProfile: 'direct' | 'isolated'
  requires: string[]; attempts: number; endedAt: string | null; failure: string | null
  bootstrap: boolean; deleted?: boolean; resultGoalId?: string; sourceGoalId?: string
  failureCount?: number; retryAfter?: number | null; circuitOpen?: boolean; runtimeMs?: number
}
export interface Finding extends NodeBase { kind: 'finding'; title: string; description: string; type: string; factIds: string[]; details: Json; stepId?: string | null }
export interface Input extends NodeBase { kind: 'hint' | 'observation'; content: string; stepId: string | null; deleted: boolean }
export type GraphNode = Fact | Goal | Step | Finding | Input
export interface Graph { project: Project; facts: Fact[]; goals: Goal[]; steps: Step[]; findings: Finding[]; hints: Input[]; observations: Input[] }
export interface GraphEvent { id: number; projectId: string; revision: number; type: string; nodeId: string | null; payload: Json; createdAt: string }
export interface Run {
  id: string; projectId: string; stepId: string | null; activity: Activity; worker: string
  backend: 'pi' | 'dsh' | 'mock'; status: RunStatus; startedAt: string; endedAt: string | null
  baseRevision: number; checkpoint: Json; pendingTools: string[]; error: string | null
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
  heartbeatAt?: string; trigger?: string
  provider?: string; model?: string; workspaceRoot?: string
}
export interface Worker {
  name: string; provider: string; model: string; enabled: boolean; decide: boolean; execute: boolean
  maxRunning: number; priority: number; backend: Run['backend']
}
export interface Provider {
  api: 'openai-completions' | 'openai-responses' | 'anthropic-messages'; baseUrl: string
  apiKey?: string; apiKeyEnv?: string
  models: { id: string; contextWindow: number; maxTokens: number; reasoning?: string; reasoningEfforts?: Record<string, string | null> | boolean | null; thinkingFormat?: string }[]
}
export interface EngineConfig {
  workers: Worker[]; providers: Record<string, Provider>; maxWorkers: number; maxProjectWorkers: number
  maxRunningProjects: number; maxSteps: number | null; decideTimeout: number; executeTimeout: number
  concludeTimeout: number; workspaceRoot: string; commonEnv?: Record<string, string>
}
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}
export function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new HttpError(422, `${name} must be a non-empty string`)
  return value.trim()
}
export function integer(value: unknown, name: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new HttpError(422, `${name} must be an integer >= ${minimum}`)
  return value
}
export const now = () => new Date().toISOString()
