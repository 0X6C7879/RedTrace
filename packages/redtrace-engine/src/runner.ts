import { Agent, createEditTool, createReadTool, createWriteTool, estimateContextTokens, generateSummaryWithUsage } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { Type } from 'typebox'
import type { TSchema, Static } from 'typebox'
import type { AgentHarnessTool, AgentMessage, AgentTool, AgentToolResult, ExecutionToolContext, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { runShell } from './shell.ts'
import { modelSession } from './models.ts'
import type { TaskContext } from './scheduler.ts'
import type { Json, Step } from './types.ts'
import { directions } from './capabilities.ts'
import type { Capabilities } from './capabilities.ts'

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value))
const result = (value: unknown, terminate = false): AgentToolResult<unknown> => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(terminate ? { terminate: true } : {}) })
function tool<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal) => unknown | Promise<unknown>, terminate = false): AgentTool<T> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, args, signal) => result(await execute(args, signal), terminate) }
}
function bindTool<T extends TSchema, D>(base: AgentHarnessTool<ExecutionToolContext, T, D>, env: NodeExecutionEnv): AgentTool<T, D> {
  return { ...base, execute: (id, args, signal, update) => base.execute(id, args, signal, update, { env }) }
}

export function graphTools({ store, run, worker, config, signal }: TaskContext, finish: () => void): AgentTool[] {
  const readGraph = tool('read_graph', 'Read project state or a specific graph node. Page through facts, observations and Steps with offset. Hints and observations are unverified inputs.', Type.Object({ id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })) }), args => {
    if (args.id) return store.node(run.projectId, args.id)
    const g = store.graph(run.projectId)
    const offset = args.offset ?? 0, end = offset + 100
    return { ...g, facts: g.facts.slice(offset, end), observations: g.observations.slice(offset, end), steps: g.steps.slice(offset, end), nextOffset: Math.max(g.facts.length, g.observations.length, g.steps.length) > end ? end : null }
  })
  const refs = Type.Array(Type.String())
  const tools: AgentTool[] = [readGraph]
  if (run.activity === 'decide') {
    tools.push(
      tool('add_step', 'Create an action sourced from Scope (origin), Fact or Finding IDs to advance goalId. Leave capabilities empty for a general task; select specialized Skills only when needed.', Type.Object({ description: Type.String(), sourceIds: refs, goalId: Type.Optional(Type.String()), priority: Type.Optional(Type.Integer()), capabilities: Type.Optional(Type.Array(Type.Union(directions.map(c => Type.Literal(c))))), executionProfile: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('isolated')])) }), args => store.addStep(run.projectId, args, config.maxSteps)),
      tool('update_step', 'Reprioritize or abandon a Step.', Type.Object({ id: Type.String(), priority: Type.Optional(Type.Integer()), cancel: Type.Optional(Type.Boolean()) }), args => store.updateStep(run.projectId, args.id, { priority: args.priority, ...(args.cancel ? { status: 'cancelled' } : {}) })),
      tool('add_goal', 'Add a Sub Goal.', Type.Object({ description: Type.String(), parentId: Type.Optional(Type.String()) }), args => store.addGoal(run.projectId, args.description, args.parentId)),
      tool('update_goal', 'Mark a goal achieved using Fact or Finding evidence IDs (never Scope), or abandon a Sub Goal. Step completion alone is not goal achievement.', Type.Object({ id: Type.String(), status: Type.Union([Type.Literal('open'), Type.Literal('achieved'), Type.Literal('cancelled')]), evidenceIds: Type.Optional(refs) }), args => store.updateGoal(run.projectId, args.id, args)),
      tool('finish_decide', 'Finish this planning activity. Empty plans are allowed when no useful action is currently available.', Type.Object({}), () => { finish(); return { saved: true } }, true),
    )
  } else {
    tools.push(
      tool('submit_fact', 'Submit a confirmed fact and the evidence supporting it.', Type.Object({ description: Type.String(), evidence: Type.Array(Type.Object({ description: Type.String(), path: Type.Optional(Type.String()) })) }), args => store.addFact(run.projectId, args.description, { runId: run.id, evidence: args.evidence, creator: worker.name })),
      tool('submit_finding', 'Record a deliverable supported by confirmed facts. This does not trigger Decide.', Type.Object({ title: Type.String(), description: Type.String(), type: Type.Optional(Type.String()), factIds: refs }), args => store.addFinding(run.projectId, { ...args, creator: worker.name, runId: run.id })),
      tool('finish_step', 'Finish this Step. Submit confirmed facts before finishing; do not invent success or evidence.', Type.Object({ summary: Type.String() }), args => { store.runEvent(run.id, 'step.summary', json(args)); finish(); return { saved: true } }, true),
    )
  }
  return tools.map(t => ({ ...t, execute: async (...args) => { if (signal.aborted || store.run(run.id).status !== 'running') throw new Error('Activity has stopped'); return t.execute(...args) } }))
}

export const activityPrompt = (activity: 'decide' | 'execute') => activity === 'decide'
  ? '你负责 Decide。FGS 的永久节点只有 Scope、Fact、Finding、Subgoal、Goal。任务创建、Fact 增加、Execute 完成或失败、任务重新激活触发你；Finding、Hint、Observation、Goal 和 Step 的变更不触发你。基于 Scope 和现有 Fact/Finding 评估目标与行动。Subgoal 必须是可验收的结果，先检查并复用已有目标；操作、重试、临时策略写成 Step，不要重复创建子目标。每个 Step 用 sourceIds 引用 Scope/Fact/Finding，并用 goalId 指向它推进的目标。目标验收使用真实 Fact/Finding evidenceIds，解释这些证据如何满足目标；失败、停止尝试、Step 结束不等于目标达成。容量满时仍可验收或调整目标，不再新增 Step。只规划，不执行外部操作。完成后调用 finish_decide。'
  : '你负责 Execute。沿当前 Step 执行，推进它的 goalId。以工具输出验证结论并及时 submit_fact，成功、失败和限制都可形成已确认事实；可交付成果提交为引用 Fact 的 Finding。Fact 会触发 Decide，Finding 不会。Hint 和 Observation 不是已确认事实。完成时调用 finish_step；Step 完成只表示本次执行结束，不表示 Goal/Subgoal 达成。'

export async function runPi(context: TaskContext, capabilities?: Capabilities) {
  const { store, run, worker, config, signal } = context
  const { models, model, thinkingLevel } = await modelSession(config, worker)
  const graph = store.graph(run.projectId), step = run.stepId ? store.node<Step>(run.projectId, run.stepId, 'step') : undefined
  if (step?.executionProfile === 'isolated') throw new Error('Isolated execution requires the Cordis isolation adapter; refusing direct execution')
  const cwd = path.join(config.workspaceRoot, run.projectId); await mkdir(cwd, { recursive: true })
  let finished = false, concludeOnly = false
  const tools = graphTools(context, () => { finished = true })
  const graphNames = new Set(tools.map(t => t.name))
  let external: Awaited<ReturnType<typeof import('./mcp.ts')['connectMcp']>> | undefined
  if (run.activity === 'execute') {
    const env = new NodeExecutionEnv({ cwd })
    tools.push(bindTool(createReadTool(), env), bindTool(createEditTool(), env), bindTool(createWriteTool(), env),
      tool('shell', `Run a command using ${process.platform === 'win32' ? 'Windows PowerShell' : 'bash'} in the project Workspace. Full output is saved to a file.`, Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }), (args, abort) => runShell(args.command, cwd, { signal: abort, timeout: args.timeout, env: config.commonEnv })))
    if (capabilities && step?.capabilities.length) {
      const selected = capabilities.resolve(step.capabilities).skills
      tools.push(tool('read_skill', `Read an explicitly selected Skill. Available Skills: ${selected.join(', ')}`, Type.Object({ name: Type.String() }), ({ name }) => {
        if (!selected.includes(name)) throw new Error('Skill is not selected for this Step')
        return { ...capabilities.skill(name), directory: capabilities.directory(name) }
      }))
    }
    const configs = capabilities?.mcpConfigs() ?? []
    if (configs.length) { external = await (await import('./mcp.ts')).connectMcp(configs, cwd, signal, config.commonEnv); tools.push(...external.tools) }
  }
  const saved = store.run(run.id).checkpoint
  const messages = run.activity === 'execute' && saved && typeof saved === 'object' && !Array.isArray(saved) && Array.isArray(saved.messages) ? saved.messages as unknown as AgentMessage[] : []
  const agent = new Agent({ initialState: { model, tools, thinkingLevel, messages,
    systemPrompt: activityPrompt(run.activity) },
    sessionId: run.id, toolExecution: 'sequential',
    streamFn: (m, context, options) => models.streamSimple(m, context, { ...options, maxTokens: model.maxTokens, maxRetries: 2 }),
    prepareNextTurnWithContext: async ({ context }, abort) => {
      const reserve = Math.min(model.maxTokens, Math.floor(model.contextWindow / 3))
      if (finished || concludeOnly || estimateContextTokens(context.messages).tokens < model.contextWindow - reserve) return
      // Compact only at a completed tool boundary, preserving the entire transcript in the audit log.
      const summary = await generateSummaryWithUsage(context.messages, models, model, reserve, abort, 'Preserve confirmed evidence, exact artifact paths, current Step, completed tool effects, unknown results, and remaining work. Never suggest repeating an unconfirmed side effect.')
      if (!summary.ok) throw summary.error
      const current = store.run(run.id), usage = summary.value.usage
      current.inputTokens += usage.input; current.outputTokens += usage.output; current.cacheReadTokens += usage.cacheRead; current.cacheWriteTokens += usage.cacheWrite
      store.transaction(() => { store.saveRun(current); store.runEvent(run.id, 'context.compacted', json(summary.value)) })
      const compacted: AgentMessage[] = [{ role: 'user', content: `Session checkpoint (FGS remains authoritative):\n${summary.value.text}`, timestamp: Date.now() }]
      store.checkpoint(run.id, json({ messages: compacted }))
      return { context: { ...context, messages: compacted } }
    },
    beforeToolCall: async ({ toolCall }) => {
      const current = store.run(run.id)
      if (signal.aborted || finished || current.status !== 'running') return { block: true, reason: 'Activity has stopped' }
      if (concludeOnly && !graphNames.has(toolCall.name)) return { block: true, reason: 'Execution timed out; only summarize and submit existing evidence' }
      store.toolStarted(run.id, toolCall.id, json(toolCall))
      return undefined
    },
    afterToolCall: async ({ toolCall, result: output }) => { store.toolEnded(run.id, toolCall.id, json(output)); return undefined },
  })
  const abort = () => agent.abort()
  signal.addEventListener('abort', abort, { once: true })
  store.runEvent(run.id, 'system.prompt', json({ content: activityPrompt(run.activity) }))
  let cursor = Number(store.db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM events WHERE project_id=?').get(run.projectId)!.value)
  const changed = (projectId: string) => {
    if (projectId !== run.projectId || run.activity !== 'execute' || !agent.state.isStreaming) return
    const g = store.graph(projectId)
    const events = store.events(projectId, cursor)
    cursor = events.at(-1)?.id ?? cursor
    if (!events.some(e => e.type === 'hint.added' || (e.type === 'fact.added' && (e.payload as unknown as { stepId?: string }).stepId !== run.stepId))) return
    // Model reads canonical state on demand; no transcript-to-transcript coordination.
    if (g.project.status === 'active') agent.steer({ role: 'user', content: '共享图已有更新。需要时用 read_graph 查看，不必改变当前 Step。', timestamp: Date.now() })
  }
  store.changes.on('change', changed)
  agent.subscribe(event => {
    if (event.type === 'message_end' || event.type === 'turn_end' || event.type === 'agent_end') store.checkpoint(run.id, json({ messages: agent.state.messages }))
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const usage = event.message.usage, current = store.run(run.id)
      current.inputTokens += usage.input; current.outputTokens += usage.output; current.cacheReadTokens += usage.cacheRead; current.cacheWriteTokens += usage.cacheWrite
      store.transaction(() => store.saveRun(current))
    }
    if (event.type !== 'message_update') store.runEvent(run.id, event.type, json(event))
  })
  try {
    if (signal.aborted) return
    const seconds = run.activity === 'decide' ? config.decideTimeout : config.executeTimeout
    let timeout = setTimeout(() => { concludeOnly = true; agent.abort() }, seconds * 1000)
    try {
      await agent.prompt(messages.length ? '继续' : JSON.stringify({ project: graph.project, goal: graph.goals.find(g => g.id === 'goal'), step: step ?? null, origin: graph.facts[0], instruction: '用 read_graph 获取所需状态后推进任务。' }))
    } finally { clearTimeout(timeout) }
    if (signal.aborted || finished) return
    // One same-session conclude attempt, never a fresh execution after timeout/error.
    concludeOnly = true
    timeout = setTimeout(() => agent.abort(), config.concludeTimeout * 1000)
    try { await agent.prompt('仅提交已经获得的证据并调用结束工具。不再执行外部操作。') } finally { clearTimeout(timeout) }
    if (!finished && !signal.aborted) throw new Error(agent.state.errorMessage ?? 'Activity ended without a structured completion')
  } finally {
    store.changes.off('change', changed); signal.removeEventListener('abort', abort)
    agent.abort(); await agent.waitForIdle()
    store.checkpoint(run.id, json({ messages: agent.state.messages }))
    await external?.close()
  }
}

export async function runMock({ store, run, signal }: TaskContext) {
  if (signal.aborted) return
  const graph = store.graph(run.projectId)
  if (run.activity === 'decide') {
    const fact = graph.facts.find(f => f.id !== 'origin')
    if (fact) store.updateGoal(run.projectId, 'goal', { status: 'achieved', evidenceIds: [fact.id] })
    else if (!graph.steps.length) store.addStep(run.projectId, { description: 'Deterministic mock verification', sourceIds: ['origin'] })
  } else {
    const fact = store.addFact(run.projectId, 'Mock verification completed', { runId: run.id, creator: 'mock', evidence: [{ description: 'Deterministic test runner; no external operation' }] })
    store.addFinding(run.projectId, { title: 'Mock result', description: 'Deterministic test result', factIds: [fact.id] })
  }
}
