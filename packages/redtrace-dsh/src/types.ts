type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type TaskType = 'reason' | 'explore' | 'bootstrap'
export type ExecutionProfile = 'direct' | 'isolated'
export type ReasoningPolicy = 'auto_max' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type { Json }

/** A DSH-native Worker: the scheduling and model-routing unit of the runtime. */
export interface WorkerSpec {
  name: string
  enabled: boolean
  /** pi-ai provider name; resolved through the provider profiles in the snapshot. */
  provider: string
  model: string
  bootstrap: boolean
  reason: boolean
  explore: boolean
  maxRunning: number
  priority: number
  maxTokens?: number
  reasoning?: ReasoningPolicy
}

export interface TaskLimits {
  timeout: number
  conclude_timeout?: number
  max_intents?: number
}

export interface RuntimeConfig {
  runtime?: boolean
  server?: string
  root?: string
  sessionRoot?: string
  skillsDir?: string
  workspacesDir?: string
  interval?: number
  maxWorkers?: number
  maxRunningProjects?: number
  maxProjectWorkers?: number
  tasks?: Partial<Record<TaskType, TaskLimits>>
  mcpConfigs?: Record<string, Json>[]
  /** Where the plugin manager persists its manifest; defaults next to settings.yaml. */
  pluginsManifest?: string
  /** The FGS engine scheduler handle, passed by the Node compatibility host. */
  engineScheduler?: { start(): void; close(): Promise<void> }
}

/** A validated launch config: the required paths and server are present. */
export interface RuntimeOptions extends RuntimeConfig {
  server: string
  root: string
  sessionRoot: string
  skillsDir: string
  workspacesDir: string
}

/** Hot-reloadable runtime config served by the RedTrace server at `/runtime/config`. */
export interface RuntimeSnapshot {
  revision: string
  workers: WorkerSpec[]
  tasks: Record<TaskType, TaskLimits>
  limits: {
    maxWorkers: number
    maxRunningProjects: number
    maxProjectWorkers: number
    interval: number
  }
  providers?: Record<string, Record<string, Json>>
  env?: Record<string, string>
  /** Worker-facing common_env from redtrace.yaml; forwarded into worker shell processes. */
  commonEnv?: Record<string, string>
  /** Fresh MCP mount shapes; the domain plugin remounts clients on change. */
  mcpConfigs?: Array<Record<string, Json>>
}

/** The model route a task captured from its selected Worker at launch. */
export interface WorkerRoute {
  provider: string
  model: string
  maxTokens?: number
  reasoning: ReasoningPolicy
}

export interface RuntimeTask {
  type: TaskType
  projectId: string
  intentId?: string
  executionProfile?: ExecutionProfile
  /** Real Worker name; used for claim, heartbeat, audit, and the run index. */
  worker: string
  /** Model route captured from the selected Worker at launch. */
  route?: WorkerRoute
  limits?: TaskLimits
  maxIntents?: number
  committed: boolean
  server?: string
  sessionId?: string
  /** Resume this timed-out session directly in its conclude phase. */
  concludeOnly?: boolean
  /** Resume a session interrupted by stopping its Project. */
  resumeOnly?: boolean
  runId?: string
  revision?: number
  /** Latest planning revision actually delivered through the launch prompt or Graph changes tool. */
  planningRevision?: number
  /** New Fact checkpoint announced to a running Reason but not read through the Graph changes tool yet. */
  pendingPlanningRevision?: number
  pendingContextRevision?: number
  /** Blackboard revision durably injected into the project Reason session. */
  contextRevision?: number
  /** Hint ids this worker has already seen: launch prompt + runtime injections. */
  deliveredHints?: Set<string>
  startedAt?: number
  handle?: AgentHandle
  cancelled?: boolean
  streamedText?: boolean
  streamedThinking?: boolean
  /** Last system prompt already projected to the audit stream. */
  projectedSystem?: string
  /** callId → tool name, so tool/result events can carry the tool title. */
  toolNames?: Map<string, string>
  /** Cumulative provider usage reported on assistant/message events. */
  usage?: TaskUsage
}

/** Cumulative provider token usage for one task (sums of disjoint buckets). */
export interface TaskUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

export interface Agent {
  id: string
  session: unknown
  followup(message: unknown): void
  inject(message: unknown): void
  cancel(cause: { kind: 'hook'; reason: string } | { kind: 'disposed' }): void
  whenIdle(): Promise<void>
}

export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>
}

export interface ScopedContext {
  tools: { restrict(filter: { allow?: string[]; deny?: string[] }): () => void }
  systemPrompt: { section(value: { name: string; order: number; text: string }): () => void }
  plugin(plugin: unknown, config?: unknown): CordisFiber
  isolate(name: string): ScopedContext
}

export interface CordisFiber { await(): Promise<unknown>; dispose(): Promise<void> }

export interface RuntimeContext extends ScopedContext {
  agents: {
    create(options: Record<string, unknown>): Promise<AgentHandle>
    resume(options: Record<string, unknown>): Promise<AgentHandle>
  }
  sessions: { flush(session: unknown): Promise<void> }
  sessionPersistence?: SessionPersistence
  webServer?: {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler(req: any, res: any): void | Promise<void> }): () => void
    registerFallback(handler: (req: any, res: any) => void | Promise<void>): () => void
  }
  on(event: string, listener: (...args: any[]) => void): () => void
  effect(factory: () => (() => void | Promise<void>), label?: string): void
  logger?: { warn(value: unknown): void }
  get(name: string): unknown
}

export interface LlmService {
  resolveModelInfo(provider: string, model: string): Promise<{
    provider: string
    id: string
    name: string
    reasoning?: { efforts: readonly { id: string; name: string }[] }
  }>
}

export interface SessionPersistence {
  stat(id: string): Promise<{ header: Record<string, unknown> } | undefined>
}

export interface SessionEvent {
  seq?: number
  ts?: string
  type: string
  data?: Record<string, unknown>
}

/** Message helpers from the DSH llm/session core packages. */
export interface MessageFactory {
  createUserMessage(value: Record<string, unknown>): unknown
  SessionId(value: string): unknown
}
