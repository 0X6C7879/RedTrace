type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type TaskType = 'reason' | 'explore' | 'bootstrap'
export type ExecutionProfile = 'direct' | 'isolated'
export type CapabilityName =
  | 'common' | 'web' | 'api' | 'database' | 'thick-client' | 'supply-chain'
  | 'exploit-research' | 'network' | 'internal' | 'pivoting'
  | 'windows-privesc' | 'linux-privesc' | 'ad' | 'post-exploitation' | 'c2'
  | 'reverse' | 'pwn' | 'malware' | 'crypto' | 'mobile' | 'cloud'
  | 'blockchain' | 'firmware-iot' | 'hardware' | 'wireless' | 'radio-sdr'
  | 'ot-ics' | 'identity' | 'email' | 'ai-security' | 'forensics'
  | 'threat-hunting'
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
  staticDir?: string
  interval?: number
  maxWorkers?: number
  maxRunningProjects?: number
  maxProjectWorkers?: number
  tasks?: Partial<Record<TaskType, TaskLimits>>
  mcpConfigs?: Record<string, Json>[]
  webProxy?: string
  /** Where the plugin manager persists its manifest; defaults next to settings.yaml. */
  pluginsManifest?: string
}

/** A validated launch config: the required paths and server are present. */
export interface RuntimeOptions extends RuntimeConfig {
  server: string
  root: string
  sessionRoot: string
  skillsDir: string
  workspacesDir: string
  staticDir?: string
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
  /** Session-isolated symlink view of the capability-filtered Skill catalog. */
  skillViewDir?: string
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
  supportsRawArtifacts: boolean
  readRaw(id: string): Promise<{ meta: Record<string, unknown> } | undefined>
  locate(meta: Record<string, unknown>): { path: string } | undefined
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

export interface AuditRun {
  engine?: string
  intent_id?: string | null
  session_id?: string | null
  status?: string
  task_type?: string
}

export interface ProjectSummary {
  id: string
  title?: string
  status: 'active' | 'stopped' | 'completed' | 'deleting'
  bootstrap_enabled?: boolean
  reason: unknown | null
  planning_revision: number
  reason_evaluated_revision: number
  reason_context_revision: number
  reason_retry_after?: number | null
  reason_circuit_open?: boolean
}

export interface Intent {
  id: string
  from: string[]
  to?: string | null
  description: string
  creator: string
  worker?: string | null
  execution_profile?: ExecutionProfile
  capabilities: CapabilityName[]
  created_at: string
  state: string
  retry_after?: number | null
  circuit_open?: boolean
}

export interface ResourceSummary {
  id: string
  kind: string
  name: string
  target?: string | null
  summary?: string | null
  status?: string
}

export interface ProjectDetail {
  project: ProjectSummary & { title: string; bootstrap_enabled: boolean }
  facts: Array<{ id: string; description: string }>
  intents: Intent[]
  hints: Array<{ id: string; content: string; creator: string; created_at: string }>
  blackboard_revision: number
}

export interface BlackboardChange {
  revision: number
  kind: string
  node_id: string
  action: string
  created_at?: string
  node: Record<string, Json> | null
}

export interface BlackboardChangesPage {
  since: number
  revision: number
  next_revision: number
  has_more: boolean
  changes: BlackboardChange[]
}
