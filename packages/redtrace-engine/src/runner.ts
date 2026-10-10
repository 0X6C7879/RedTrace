import { Agent, createEditTool, createReadTool, createWriteTool, estimateContextTokens, generateSummaryWithUsage } from '@earendil-works/pi-agent-core'
import { NodeExecutionEnv } from '@earendil-works/pi-agent-core/node'
import { Type } from 'typebox'
import type { TSchema, Static } from 'typebox'
import type { AgentHarnessTool, AgentMessage, AgentTool, AgentToolResult, ExecutionToolContext, ThinkingLevel } from '@earendil-works/pi-agent-core'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { runShell, toolEnvironment } from './shell.ts'
import { isJevRecoveryPath, traceCall, type TraceCall } from './jev.ts'
import { modelSession } from './models.ts'
import type { Store } from './store.ts'
import type { TaskContext } from './scheduler.ts'
import type { EngineConfig, Fact, Json, Step, Project, Run, Goal } from './types.ts'
import { knowledgeTools } from './knowledge.ts'
import { extractOutput } from './result-summary.ts'
import { closeWebChallenge, webTools } from './web.ts'
import type { Capabilities } from './capabilities.ts'
import { channelsFor, resourceTools, verbIds, verbToolAvailable, verbTools, type VerbRuntime } from './capability-verbs.ts'

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value))
const execFileAsync = promisify(execFile)
const result = (value: unknown, terminate = false): AgentToolResult<unknown> => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(terminate ? { terminate: true } : {}) })
function tool<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal) => unknown | Promise<unknown>, terminate = false): AgentTool<T> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, args, signal) => result(await execute(args, signal), terminate) }
}
function bindTool<T extends TSchema, D>(base: AgentHarnessTool<ExecutionToolContext, T, D>, env: NodeExecutionEnv): AgentTool<T, D> {
  return { ...base, execute: (id, args, signal, update) => base.execute(id, args, signal, update, { env }) }
}

async function tsecbenchQuery(config: EngineConfig, args: string[], signal?: AbortSignal) {
  const script = path.join(path.dirname(config.workspaceRoot), '.redtrace', 'skills', 'tsecbench-api', 'scripts', 'tsecbench.py')
  try {
    const { stdout } = await execFileAsync('python3', [script, ...args], {
      cwd: path.dirname(script), env: toolEnvironment(config.commonEnv), signal, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
    })
    return JSON.parse(stdout)
  } catch (error) {
    try { return JSON.parse((error as { stderr?: string }).stderr ?? '') }
    catch { throw new Error('TSecBench query failed or timed out') }
  }
}

export function efficiencyToolAvailable(context: TaskContext, name: string) {
  const plugin = name.startsWith('knowledge_') ? 'redtrace-knowledge' : name.startsWith('trace_') ? 'redtrace-trace-search' : name.startsWith('web_') || name === 'http_batch' ? 'redtrace-browser-http' : undefined
  return !plugin || !context.featureAvailable || context.featureAvailable(plugin)
}

export function graphTools(context: TaskContext, finish: () => void): AgentTool[] {
  const { store, run, worker, config, signal, jev } = context
  const evidenceRoot = path.join(run.workspaceRoot ?? path.join(config.workspaceRoot ?? path.join(os.tmpdir(), 'redtrace-workspaces'), run.projectId), '.redtrace-output', 'evidence')
  const installRoot = config.workspaceRoot ? path.dirname(config.workspaceRoot) : undefined
  const step = run.stepId ? store.node<Step>(run.projectId, run.stepId, 'step') : undefined
  const kinds = ['fact', 'goal', 'step', 'finding', 'hint', 'observation'] as const
  const readGraph = tool('read_graph', 'Read project state or a specific graph node. Page every node type in the database with offset and limit; full:true skips semantic filtering but remains one bounded page. Hints and observations are unverified.', Type.Object({ id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), kinds: Type.Optional(Type.Array(Type.Union(kinds.map(k => Type.Literal(k))), { uniqueItems: true })), full: Type.Optional(Type.Boolean()) }), async args => {
    if (args.id) return store.node(run.projectId, args.id)
    const offset = args.offset ?? 0, limit = args.limit ?? 100, selected = new Set(args.kinds ?? kinds)
    const project = store.project(run.projectId), page: Record<string, unknown> = { project, historyIncomplete: false, facts: [], goals: [], steps: [], findings: [], hints: [], observations: [] }, nextOffsets: Record<string, number | null> = {}
    for (const kind of kinds) {
      if (!selected.has(kind)) continue
      page[kind === 'fact' ? 'facts' : kind === 'goal' ? 'goals' : kind === 'step' ? 'steps' : kind === 'finding' ? 'findings' : `${kind}s`] = store.nodes(run.projectId, [kind], { offset, limit })
      const total = store.nodeCount(run.projectId, kind)
      nextOffsets[kind] = offset + limit < total ? offset + limit : null
    }
    const remaining = Object.values(nextOffsets).filter((value): value is number => value !== null)
    const filtered = !args.full && jev?.isEnabled('context_filter') && selected.has('fact') && selected.has('step')
      ? await jev.filterGraph(run, step, page as unknown as ReturnType<typeof store.graph>).catch(() => undefined) : undefined
    return { ...(filtered ?? page), nextOffset: remaining.length ? Math.max(...remaining) : null, nextOffsets,
      ...(jev?.isEnabled() ? { jevAdvisories: await jev.advisories(run.projectId) } : {}) }
  })
  const refs = Type.Array(Type.String())
  const tools: AgentTool[] = [readGraph]
  tools.push({ name: 'evidence_read', label: 'evidence_read', description: 'Read at most 7.6 KiB from a large tool result by byte offset, 1-based line, or keyword. Artifacts are scoped to this run; request the next bounded slice when needed.', parameters: Type.Object({ id: Type.String({ pattern: '^ev-[a-f0-9]{64}$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })), line: Type.Optional(Type.Integer({ minimum: 1 })), query: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 7600 })) }), executionMode: 'sequential', execute: async (_toolId: string, args: { id: string; offset?: number; line?: number; query?: string; length?: number }) => {
    if (!/^ev-[a-f0-9]{64}$/.test(args.id) || [args.offset, args.line, args.query].filter(value => value !== undefined).length > 1) throw new Error('Provide a valid evidence ID and only one read selector')
    const runRoot = path.join(evidenceRoot, run.id), root = await realpath(runRoot), base = await realpath(evidenceRoot)
    if (!root.startsWith(base + path.sep)) throw new Error('Evidence path is outside this run')
    const file = path.join(root, `${args.id}.json`), bytes = await readFile(file)
    if (createHash('sha256').update(bytes).digest('hex') !== args.id.slice(3)) throw new Error('Evidence hash mismatch')
    const text = bytes.toString('utf8'), length = args.length ?? 7600
    let offset = args.offset ?? 0
    if (args.query !== undefined) {
      const match = text.toLowerCase().indexOf(args.query.toLowerCase())
      if (match < 0) throw new Error('Keyword not found in this evidence artifact')
      offset = Math.max(0, Buffer.byteLength(text.slice(0, match)) - 400)
    }
    if (args.line !== undefined) {
      const lines = text.split('\n')
      if (args.line > lines.length) throw new Error('Line is outside this evidence artifact')
      offset = Buffer.byteLength(lines.slice(0, args.line - 1).join('\n')) + (args.line > 1 ? 1 : 0)
    }
    if (offset > bytes.length) throw new Error('Offset is outside this evidence artifact')
    const chunk = bytes.subarray(offset, offset + length), nextOffset = offset + chunk.length < bytes.length ? offset + chunk.length : null
    const content = `Evidence ${args.id} | byte ${offset}-${offset + chunk.length}/${bytes.length} | nextOffset=${nextOffset ?? 'none'}\n${chunk.toString('utf8')}`
    return { content: [{ type: 'text', text: content }], details: { id: args.id, offset, bytes: chunk.length, totalBytes: bytes.length, nextOffset } }
  } } as unknown as AgentTool)
  if (run.activity === 'decide') {
    const origin = store.node<Fact>(run.projectId, 'origin', 'fact')
    const skill = installRoot ? path.join(installRoot, '.redtrace', 'skills', 'tsecbench-api') : ''
    if (/(?:tsecbench|tsec[\s-]*benchmark)/i.test(origin.description) && existsSync(path.join(skill, 'SKILL.md')) && existsSync(path.join(skill, 'scripts', 'tsecbench.py'))) {
      tools.push(
        tool('tsecbench_list', 'List TSec Benchmark challenges with descriptions, difficulty, progress and container status. Read only.', Type.Object({}), (_args, abort) => tsecbenchQuery(config, ['list'], abort)),
        tool('tsecbench_hint', 'View a TSec Benchmark challenge hint. Viewing may reduce its flag score; requires explicit score penalty confirmation. Does not start, submit or close challenges.', Type.Object({ unique_code: Type.String(), confirm_score_penalty: Type.Boolean() }), (args, abort) =>
          args.confirm_score_penalty ? tsecbenchQuery(config, ['hint', args.unique_code, '--confirm-score-penalty'], abort) : { ok: false, error: 'score_penalty_confirmation_required' }),
      )
    }
    tools.push(
      tool('add_step', 'Create an action sourced from Scope (origin), Fact or Finding IDs to advance goalId. requires lists capability verbs (e.g. remote.command): matching verb tools are exposed to the Execute agent, which reuses existing channels automatically.', Type.Object({ description: Type.String(), sourceIds: refs, goalId: Type.Optional(Type.String()), priority: Type.Optional(Type.Integer()), requires: Type.Optional(Type.Array(Type.Union(verbIds.map(v => Type.Literal(v))), { uniqueItems: true, maxItems: 16 })), executionProfile: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('isolated')])) }), async args => {
        const created = store.addStep(run.projectId, args, config.maxSteps)
        const duplicate = jev?.isEnabled('step_dedup') ? await jev.suggestDuplicate(run.projectId, created, run) : undefined
        return duplicate ? { ...created, jevDuplicateSuggestion: duplicate } : created
      }),
      tool('update_step', 'Reprioritize or abandon a Step.', Type.Object({ id: Type.String(), priority: Type.Optional(Type.Integer()), cancel: Type.Optional(Type.Boolean()) }), args => store.updateStep(run.projectId, args.id, { priority: args.priority, ...(args.cancel ? { status: 'cancelled' } : {}) })),
      tool('add_goal', 'Add a Sub Goal.', Type.Object({ description: Type.String(), parentId: Type.Optional(Type.String()) }), args => store.addGoal(run.projectId, args.description, args.parentId)),
      tool('update_goal', 'Mark a goal achieved using Fact or Finding evidence IDs (never Scope), or abandon a Sub Goal. Step completion alone is not goal achievement.', Type.Object({ id: Type.String(), status: Type.Union([Type.Literal('open'), Type.Literal('achieved'), Type.Literal('cancelled')]), evidenceIds: Type.Optional(refs) }), args => store.updateGoal(run.projectId, args.id, args)),
      tool('finish_decide', 'Finish this planning activity. Empty plans are allowed when no useful action is currently available.', Type.Object({}), () => { finish(); return { saved: true } }, true),
    )
  } else {
    const targetText = `${store.node<Fact>(run.projectId, 'origin', 'fact').description} ${step?.description ?? ''}`
    if (/\b(?:web|http|https|api|url|browser|website|网页|网站|接口|浏览器|登录页)\b/i.test(targetText)) tools.push(...webTools(context))
    const benchmarkOrigin = store.node<Fact>(run.projectId, 'origin', 'fact').description
    const benchmarkSkill = installRoot ? path.join(installRoot, '.redtrace', 'skills', 'tsecbench-api') : ''
    if (/(?:tsecbench|tsec[\s-]*benchmark)/i.test(benchmarkOrigin) && existsSync(path.join(benchmarkSkill, 'SKILL.md')) && existsSync(path.join(benchmarkSkill, 'scripts', 'tsecbench.py'))) {
      tools.push(
        tool('tsecbench_start', 'Start the explicitly selected authorized benchmark challenge. Pass the exact unique_code from tsecbench_list; no arbitrary platform or network target is accepted.', Type.Object({ unique_code: Type.String({ minLength: 1, maxLength: 128 }) }), async args => {
          const started = await tsecbenchQuery(config, ['start', args.unique_code], signal) as { unique_code?: unknown; container_addr?: unknown }
          if (started.unique_code !== args.unique_code || !Array.isArray(started.container_addr) || !started.container_addr.length || started.container_addr.some(address => typeof address !== 'string' || address.length > 255)) throw new Error('Benchmark start returned an invalid challenge or target list')
          store.addFact(run.projectId, `Platform started TSecBench ${args.unique_code}; authorized targets: ${(started.container_addr as string[]).join(', ')}`, { runId: run.id, creator: worker.name, evidence: [{ description: 'TSecBench SDK start response' }] })
          const hosts=(started.container_addr as string[]).map(value=>{const url=new URL(/^https?:/.test(value)?value:`http://${value}`);if(url.username || url.password)throw new Error('Platform returned credential-bearing target');return url.host.toLowerCase()})
          store.setBenchmarkHosts(run.projectId,args.unique_code,hosts)
          return started
        }),
        tool('tsecbench_submit', 'Submit one flag for the active authorized challenge. Only a platform-confirmed correct result is recorded as a critical planning signal; secrets in tool arguments are redacted from audit events.', Type.Object({ unique_code: Type.String({ minLength: 1, maxLength: 128 }), flag: Type.String({ minLength: 1, maxLength: 4096 }) }), async args => {
          const submitted = await tsecbenchQuery(config, ['submit', args.unique_code, '--flag', args.flag], signal) as { correct?: unknown; matched_flag_index?: unknown; correct_flag_count?: unknown; total_flag_count?: unknown; awarded?: unknown; cumulative_score?: unknown }
          if (submitted.correct === true && Number.isSafeInteger(submitted.correct_flag_count) && Number.isSafeInteger(submitted.total_flag_count) && Number(submitted.correct_flag_count) > 0) {
            const count = Number(submitted.correct_flag_count), key = `tsecbench:${args.unique_code}:progress:${count}`
            store.transaction(() => {
              if (store.recordCriticalSignal(run.projectId, key, json({ source: 'platform-confirmed-flag', unique_code: args.unique_code, correct_flag_count: count, total_flag_count: submitted.total_flag_count, awarded: submitted.awarded, cumulative_score: submitted.cumulative_score })))
                store.addFact(run.projectId, `TSecBench ${args.unique_code}: platform confirmed ${count}/${submitted.total_flag_count} flags; awarded ${submitted.awarded ?? 'unknown'} points`, { runId: run.id, creator: worker.name, evidence: [{ description: 'TSecBench SDK confirmed correct flag submission' }] })
            })
          }
          return submitted
        }),
        tool('tsecbench_close', 'Close only the exact TSecBench challenge this Execute worker finished or abandoned, to release its container.', Type.Object({ unique_code: Type.String({ minLength: 1, maxLength: 128 }) }), async args=>{const result=await tsecbenchQuery(config,['close',args.unique_code],signal);store.setBenchmarkHosts(run.projectId,args.unique_code);await closeWebChallenge(store,run.projectId,args.unique_code);return result}),
      )
    }
    tools.push(
      tool('trace_search', 'Search indexed tool-call traces in this project only. Returns up to 5 matching events; request a bounded trace_read for exact evidence.', Type.Object({ query: Type.String({ minLength: 2, maxLength: 300 }), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 5 })) }), args => store.traceSearch(run.projectId, args.query, args.limit ?? 5)),
      tool('trace_read', 'Read one exact tool-trace event already returned by trace_search. Results are project-scoped and large events become evidence artifacts.', Type.Object({ run_id: Type.String(), event_id: Type.Integer({ minimum: 1 }), source: Type.Optional(Type.Union([Type.Literal('native'),Type.Literal('audit')])) }), args => store.traceEvent(run.projectId, args.run_id, args.event_id, args.source)),
    )
    tools.push(
      tool('submit_fact', 'Submit a confirmed fact and the evidence supporting it.', Type.Object({ description: Type.String(), evidence: Type.Array(Type.Object({ description: Type.String(), path: Type.Optional(Type.String()) })) }), args => store.addFact(run.projectId, args.description, { runId: run.id, evidence: args.evidence, creator: worker.name })),
      tool('submit_finding', 'Record a deliverable supported by confirmed facts. This does not trigger Decide.', Type.Object({ title: Type.String(), description: Type.String(), type: Type.Optional(Type.String()), factIds: refs }), args => store.addFinding(run.projectId, { ...args, creator: worker.name, runId: run.id })),
      tool('finish_step', step?.bootstrap
        ? 'Finish Bootstrap after submitting at least one confirmed Fact. Reason remains blocked until Bootstrap succeeds with a Fact.'
        : 'Finish this Step. Submit confirmed facts before finishing; do not invent success or evidence.', Type.Object({ summary: Type.String() }), args => {
          const current = store.node<Step>(run.projectId, run.stepId!, 'step')
          if (current.bootstrap && !current.factIds.length) throw new Error('Bootstrap must submit at least one Fact before finishing')
          store.runEvent(run.id, 'step.summary', json(args)); finish(); return { saved: true }
        }, true),
    )
    if (jev) tools.push(tool('jev_choose', 'Compare 2–8 currently available scanners, PoC files, wordlists, or web sources for one concrete objective. Advisory only; you choose and execute. References: scanner executable name/path, PoC or wordlist file path under its configured directory, or web URL.', Type.Object({
      kind: Type.Union([Type.Literal('scanner'), Type.Literal('poc'), Type.Literal('wordlist'), Type.Literal('web')]),
      objective: Type.String(), candidates: Type.Array(Type.Object({ id: Type.String(), title: Type.String(), detail: Type.Optional(Type.String()), reference: Type.String() }), { minItems: 2, maxItems: 8 }),
      factIds: Type.Optional(refs),
    }), args => jev.chooseCandidate(run, args.kind, args.objective, args.candidates, args.factIds)))
    if (jev) tools.push(tool('jev_assess_attack', 'Rate how confirmed Facts support the necessary prerequisites of a proposed attack. Returns evidence readiness, not success probability. Advisory only.', Type.Object({
      approach: Type.String(), prerequisites: Type.Array(Type.String(), { minItems: 1, maxItems: 8 }), factIds: refs,
    }), args => jev.assessAttack(run, args.approach, args.prerequisites, args.factIds)))
  }
  tools.push(...knowledgeTools(evidenceRoot, context))
  return tools.map(t => ({ ...t, execute: async (...args) => {
    if (!efficiencyToolAvailable(context, t.name)) throw new Error('Efficiency tool plugin is disabled')
    if (signal.aborted || store.run(run.id).status !== 'running') throw new Error('Activity has stopped')
    const value = await t.execute(...args)
    const output = value && typeof value === 'object' && Array.isArray((value as AgentToolResult<unknown>).content)
      ? value as AgentToolResult<unknown>
      : result(value)
    return t.name === 'evidence_read' ? output : boundToolOutput(output, evidenceRoot, run.id)
  } }))
}

export async function boundToolOutput(output: AgentToolResult<unknown>, evidenceRoot: string, runId: string): Promise<AgentToolResult<unknown>> {
  const text = output.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const raw = Buffer.from(JSON.stringify(output.details === undefined || text === JSON.stringify(output.details)
    ? output.details ?? text : { content: output.content, details: output.details }))
  const hasRawBody = (value: unknown): boolean => Array.isArray(value) ? value.some(hasRawBody) : value && typeof value === 'object'
    ? Object.entries(value).some(([key, item]) => /^(?:requestBody|responseBody|(?:request|response)?BodyBase64)$/i.test(key) || hasRawBody(item)) : false
  if (raw.byteLength <= 8192 && Buffer.byteLength(text) <= 8192 && !hasRawBody(output.details)) return output
  const id = `ev-${createHash('sha256').update(raw).digest('hex')}`, directory = path.join(evidenceRoot, runId)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const base = await realpath(evidenceRoot), realDirectory = await realpath(directory)
  if (!realDirectory.startsWith(base + path.sep)) throw new Error('Evidence path is outside the project workspace')
  const filename = path.join(realDirectory, `${id}.json`)
  let handle
  try { handle = await open(filename, 'wx', 0o600); await handle.writeFile(raw); await handle.close() }
  catch (error) {
    await handle?.close().catch(() => {})
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (!(await readFile(filename)).equals(raw)) throw new Error('Evidence ID collision')
  }
  const safe = (value: unknown): unknown => Array.isArray(value) ? value.map(safe) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).map(([key, item]) => {
      if (/^(?:authorization|cookie|set-cookie|password|secret|token|api[_-]?key|flag|requestBody|responseBody|(?:request|response)?BodyBase64)$/i.test(key)) return [key, '[REDACTED]']
      if (/^(?:url|location)$/i.test(key) && typeof item === 'string') {
        try {
          const url = new URL(item, 'http://redtrace.invalid')
          for (const param of [...url.searchParams.keys()]) if (/^(?:auth(?:orization)?|cookie|csrf|key|password|secret|session|token|api[_-]?key|code)$/i.test(param)) url.searchParams.set(param, '[REDACTED]')
          const safeUrl = url.origin === 'http://redtrace.invalid' ? `${url.pathname}${url.search}${url.hash}` : url.toString()
          return [key, safeUrl.length > 160 ? `${safeUrl.slice(0, 157)}...` : safeUrl]
        } catch { return [key, item.slice(0, 160)] }
      }
      return [key, safe(item)]
    }))
    : value
  const summarize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(summarize)
    if (!value || typeof value !== 'object') return value
    const record = value as Record<string, unknown>
    if (typeof record.text === 'string') return {...record,text:undefined,extraction:extractOutput(record.text)}
    if (Array.isArray(record.results)) return { results: record.results.map(item => {
      const row = item as Record<string, unknown>
      return Object.fromEntries(['index', 'method', 'url', 'status', 'location', 'durationMs', 'responseBytes', 'responseSha256', 'differenceFromFirst', 'error', 'evidence', 'extraction'].filter(key => key in row).map(key => [key, row[key]]))
    }) }
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, summarize(item)]))
  }
  const sourceDetails = output.details && typeof output.details === 'object' ? output.details as Record<string, unknown> : {}
  const metadata = { ...(sourceDetails.outputPath ? { outputPath: sourceDetails.outputPath, readPath: `read({path:${JSON.stringify(sourceDetails.outputPath)}})` } : {}),
    ...(sourceDetails.stdoutPath ? {stdoutPath:sourceDetails.stdoutPath,stderrPath:sourceDetails.stderrPath}:{}),
    ...(sourceDetails.exitCode !== undefined ? { exitCode: sourceDetails.exitCode } : {}), ...(sourceDetails.bytes !== undefined ? { outputBytes: sourceDetails.bytes } : {}),
    ...(sourceDetails.sha256 !== undefined ? { outputSha256: sourceDetails.sha256 } : {}), ...(sourceDetails.error !== undefined ? { error: String(sourceDetails.error).slice(0, 1000) } : {}) }
  let visible = output.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  try { visible = JSON.stringify(safe(summarize(output.details ?? JSON.parse(visible)))) } catch { visible = visible.replace(/("?(?:authorization|cookie|set-cookie|password|secret|token|api[_-]?key|flag)"?\s*[:=]\s*")[^"]*(")/ig, '$1[REDACTED]$2') }
  const preview = Buffer.from(visible).subarray(0, 6144).toString('utf8')
  const summary = { ...metadata, evidenceId: id, evidenceBytes: raw.byteLength, evidenceSha256: id.slice(3), preview, read: 'evidence_read({id,offset,length})' }
  while (Buffer.byteLength(JSON.stringify(summary)) > 8192 && summary.preview.length) summary.preview = summary.preview.slice(0, Math.floor(summary.preview.length * 0.75))
  return { ...output, content: [{ type: 'text', text: JSON.stringify(summary) }, ...output.content.filter(block => block.type !== 'text')], details: summary }
}

export const activityPrompt = (activity: 'decide' | 'execute', step?: Step, jevChoice = false, jevReadiness = false) => (activity === 'decide'
  ? '你负责 Decide。FGS 的永久节点只有 Scope、Fact、Finding、Subgoal、Goal。任务首次启动允许规划；之后普通 Fact 与 Execute 成功或失败结束事件配对且有 Step 容量时触发你；运行时验证的新能力、路由、平台新增得分或能力失效通过关键事件提前唤醒，满容量时只能重排或取消，add_step 不绕过容量限制，失败重试保留原事件边界。重新激活、Finding、Hint、Observation、Goal 和 Step 的其他变更不单独触发你。基于 Scope 和现有 Fact/Finding 评估目标与行动。Subgoal 必须是可验收的结果，先检查并复用已有目标；操作、重试、临时策略写成 Step，不要重复创建子目标。每个 Step 用 sourceIds 引用 Scope/Fact/Finding，并用 goalId 指向它推进的目标。一道题默认一个主 Explore，优先并行不同题目；仅拆分明确独立且不会争用认证会话的工作。只创建基于现有证据即可执行的 Step；依赖尚未证实的入口或权限时，等 Fact 到来再规划。需要远程命令或内网代理时先确认已有在线的程序化通道；图形桌面登录本身不提供这类通道。不要并行创建重复的目标枚举；在测试机上扫描不需要 remote.command。目标验收使用真实 Fact/Finding evidenceIds，解释这些证据如何满足目标；失败、停止尝试、Step 结束不等于目标达成。只规划，不执行解题、容器或提交操作；如提供测评查询工具，可直接查询题目或在确认扣分后查看提示。完成后调用 finish_decide。'
  : step?.bootstrap
    ? '你负责 Bootstrap。基于 Scope、Goal 和 Hints 理解任务，按需加载 Skills 并持续推进初始探索。在得到至少一个经证据支持的客观结果前不得结束；必须先用 submit_fact 提交 Fact，再调用 finish_step。Bootstrap 成功且返回 Fact 后 Reason 才会启动。不要把猜测、计划或未验证输出写成 Fact。'
    : '你负责 Execute。沿当前 Step 执行，推进它的 goalId。先复用共享的扫描结果、凭证和已验证远程通道；Scope、Fact、Hint 或执行结果中已有的账号口令，若资源中尚无对应凭证，就及时登记，即使远程通道尚不可用。发现可复用通道时及时登记为资源，后续操作使用匹配的通道。未验证的入口不要登记为可用通道。以工具输出验证结论并及时 submit_fact，成功、失败和限制都可形成已确认事实；可交付成果提交为引用 Fact 的 Finding。新 Fact 与成功或失败的 Step 结束事件配对后触发 Decide，Finding 不会。Hint 和 Observation 不是已确认事实。验证码仅在授权题目内使用局部截图供当前模型识别；无法识别时记录阻塞并转向其他有效方向，不依赖人工接管或承诺通用通过。完成时调用 finish_step；Step 完成只表示本次执行结束，不表示 Goal/Subgoal 达成。')
  + (activity === 'execute' && jevChoice ? '当同一目标有两个以上真实可用的扫描器、PoC、字典或搜索来源，且选错会明显浪费时间时，可调用 jev_choose 比较。' : '')
  + (activity === 'execute' && jevReadiness ? '拟采用攻击路径但关键前置条件不明时，可调用 jev_assess_attack 评估已确认事实的支持程度。' : '')
  + (activity === 'execute' && (jevChoice || jevReadiness) ? 'Jev 只给建议，按原始证据自行决定和验证，避免为简单选择额外调用。' : '')

export function activityLimits(config: EngineConfig, activity: 'decide' | 'execute', step?: Step) {
  if (activity === 'decide') return { timeout: config.decideTimeout, concludeTimeout: config.concludeTimeout }
  if (step?.bootstrap) return { timeout: config.bootstrapTimeout, concludeTimeout: config.bootstrapConcludeTimeout }
  return { timeout: config.executeTimeout, concludeTimeout: config.concludeTimeout }
}

export function criticalNotice(project: Project, run: Run, sent: boolean, enabled = true) {
  return enabled && !sent && run.activity==='decide' && project.status==='active' && (project.criticalSeq ?? 0)>(run.planningCriticalSeq ?? 0)
    ? '运行时已验证新的关键状态变化（可能包含能力失效）；读取 FGS，将其与当前计划合并，只重排仍有效的 Step。' : undefined
}

export function graphUpdate(store: Store, projectId: string, cursor: number, stepId: string | null) {
  let relevant = false
  for (;;) {
    const events = store.events(projectId, cursor)
    cursor = events.at(-1)?.id ?? cursor
    relevant ||= events.some(e => e.type === 'hint.added' || (e.type === 'fact.added' && (e.payload as unknown as { stepId?: string }).stepId !== stepId))
    if (events.length < 500) return { cursor, relevant }
  }
}

export async function runPi(context: TaskContext, capabilities?: Capabilities, verbs?: VerbRuntime) {
  const { store, run, worker, config, signal, jev } = context
  const { models, model, thinkingLevel } = await modelSession(config, worker)
  const graph={project:store.project(run.projectId),goals:[store.node<Goal>(run.projectId,'goal','goal')],facts:[store.node<Fact>(run.projectId,'origin','fact')]}, step = run.stepId ? store.node<Step>(run.projectId, run.stepId, 'step') : undefined
  if (step?.executionProfile === 'isolated') throw new Error('Isolated execution requires the Cordis isolation adapter; refusing direct execution')
  const cwd = path.join(config.workspaceRoot, run.projectId); await mkdir(cwd, { recursive: true })
  let finished = false, concludeOnly = false
  const tools = graphTools(context, () => { finished = true })
  const graphNames = new Set(tools.map(t => t.name))
  let external: Awaited<ReturnType<typeof import('./mcp.ts')['connectMcp']>> | undefined
  if (run.activity === 'execute') {
    const env = new NodeExecutionEnv({ cwd })
    const read = bindTool(createReadTool(), env)
    if (jev) {
      const originalExecute = read.execute
      read.execute = async (id, args, abort, update) => {
        const output = await originalExecute(id, args, abort, update)
        if (!jev.isEnabled('tool_filter') && !jev.isEnabled('external_filter')) return output
        const rawPath = String((args as { path?: string }).path ?? ''), extension = path.extname(rawPath).toLowerCase()
        if (!['.txt', '.md', '.log', '.rst', '.html'].includes(extension)) return output
        if (!output.content.every(block => block.type === 'text')) return output
        let resolved: string, workspace: string, poc: string | undefined
        try {
          resolved = await realpath(path.resolve(cwd, rawPath)); workspace = await realpath(cwd)
          if (!(resolved === workspace || resolved.startsWith(workspace + path.sep))) {
            try { poc = await realpath(process.env.REDTRACE_POC_DIR ?? path.join(config.workspaceRoot, '..', 'tools', 'poc')) } catch { poc = undefined }
          }
        } catch { return output }
        if (isJevRecoveryPath(resolved)) return output
        if (!['.txt', '.md', '.log', '.rst', '.html'].includes(path.extname(resolved).toLowerCase())) return output
        const external = !!poc && (resolved === poc || resolved.startsWith(poc + path.sep))
        if (!(resolved === workspace || resolved.startsWith(workspace + path.sep)) && !external) return output
        const text = output.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const filtered = await jev.filterToolText(run, rawPath, text, external).catch(() => undefined)
        return filtered ? { ...output, content: [{ type: 'text' as const, text: filtered }] } : output
      }
    }
    tools.push(read, bindTool(createEditTool(), env), bindTool(createWriteTool(), env),
      tool('shell', `Run a command using ${process.platform === 'win32' ? 'Windows PowerShell' : 'bash'} in the project Workspace. Full output is saved to a file.`, Type.Object({ command: Type.String(), timeout: Type.Optional(Type.Number({ exclusiveMinimum: 0 })) }), async (args, abort) => {
        let output: Awaited<ReturnType<typeof runShell>>
        try {output=await runShell(args.command,cwd,{signal:abort,timeout:args.timeout,env:config.commonEnv})}
        catch (failure) {const error=failure as Error & Record<string,unknown>; return {error:error.message,completion:'unknown',exitCode:error.exitCode ?? null,outputPath:error.outputPath,stdoutPath:error.stdoutPath,stderrPath:error.stderrPath,bytes:error.bytes,sha256:error.sha256}}
        const filtered = jev?.isEnabled('tool_filter') ? await jev.filterToolText(run, 'shell output', output.text).catch(() => undefined) : undefined
        return filtered ? { ...output, text: filtered } : output
      }))
    if (verbs) tools.push(...resourceTools(context, verbs))
    if (verbs && step?.requires?.length) tools.push(...verbTools(context, verbs, step))
    const configs = capabilities?.mcpConfigs() ?? []
    if (configs.length) { external = await (await import('./mcp.ts')).connectMcp(configs, cwd, signal, config.commonEnv); tools.push(...external.tools) }
  }
  const agentTools = tools.map(current => {
    if (graphNames.has(current.name)) return current
    const execute = current.execute
    return { ...current, execute: async (...args: Parameters<AgentTool['execute']>) => {
      const value = await execute(...args)
      const output = value && typeof value === 'object' && Array.isArray((value as AgentToolResult<unknown>).content)
        ? value as AgentToolResult<unknown> : result(value)
      return boundToolOutput(output, path.join(run.workspaceRoot ?? cwd, '.redtrace-output', 'evidence'), run.id)
    } } as AgentTool
  })
  const traceWindow: TraceCall[] = [], traceRevisions = new Map<string, number>()
  const saved = store.run(run.id).checkpoint
  const messages = run.activity === 'execute' && saved && typeof saved === 'object' && !Array.isArray(saved) && Array.isArray(saved.messages) ? saved.messages as unknown as AgentMessage[] : []
  const visibleTools = () => agentTools.filter(t => efficiencyToolAvailable(context, t.name) && (t.name !== 'jev_choose' || jev?.isEnabled('candidate_choice'))
    && (t.name !== 'jev_assess_attack' || jev?.isEnabled('attack_readiness')) && (!verbs || verbToolAvailable(verbs, t.name)))
  const agent = new Agent({ initialState: { model, tools: agentTools, thinkingLevel, messages,
    systemPrompt: activityPrompt(run.activity, step, jev?.isEnabled('candidate_choice'), jev?.isEnabled('attack_readiness')) },
    sessionId: run.id, toolExecution: 'sequential',
    streamFn: (m, context, options) => models.streamSimple(m, {
      ...context,
      systemPrompt: activityPrompt(run.activity, step, jev?.isEnabled('candidate_choice'), jev?.isEnabled('attack_readiness')),
      tools: visibleTools(),
    }, { ...options, maxTokens: model.maxTokens, maxRetries: 2 }),
    prepareNextTurnWithContext: async ({ context }, abort) => {
      const next = { ...context, systemPrompt: activityPrompt(run.activity, step, jev?.isEnabled('candidate_choice'), jev?.isEnabled('attack_readiness')), tools: visibleTools() }
      const reserve = Math.min(model.maxTokens, Math.floor(model.contextWindow / 3))
      if (finished || concludeOnly || estimateContextTokens(context.messages).tokens < model.contextWindow - reserve) return { context: next }
      // Compact only at a completed tool boundary, preserving the entire transcript in the audit log.
      const summary = await generateSummaryWithUsage(context.messages, models, model, reserve, abort, 'Preserve confirmed evidence, exact artifact paths, current Step, completed tool effects, unknown results, and remaining work. Never suggest repeating an unconfirmed side effect.')
      if (!summary.ok) throw summary.error
      const current = store.run(run.id), usage = summary.value.usage
      current.inputTokens += usage.input; current.outputTokens += usage.output; current.cacheReadTokens += usage.cacheRead; current.cacheWriteTokens += usage.cacheWrite
      store.transaction(() => { store.saveRun(current); store.runEvent(run.id, 'context.compacted', json(summary.value)) })
      const compacted: AgentMessage[] = [{ role: 'user', content: `Session checkpoint (FGS remains authoritative):\n${summary.value.text}`, timestamp: Date.now() }]
      store.checkpoint(run.id, json({ messages: compacted }))
      return { context: { ...next, messages: compacted } }
    },
    beforeToolCall: async ({ toolCall }) => {
      const current = store.run(run.id)
      if (!efficiencyToolAvailable(context, toolCall.name)) return { block: true, reason: 'Efficiency tool plugin is disabled' }
      if (signal.aborted || finished || current.status !== 'running') return { block: true, reason: 'Activity has stopped' }
      if ((toolCall.name === 'jev_choose' && !jev?.isEnabled('candidate_choice')) || (toolCall.name === 'jev_assess_attack' && !jev?.isEnabled('attack_readiness'))) return { block: true, reason: 'Jev plugin is disabled' }
      if (verbs && !verbToolAvailable(verbs, toolCall.name)) return { block: true, reason: 'Capability adapter is disabled' }
      if (concludeOnly && !graphNames.has(toolCall.name)) return { block: true, reason: 'Execution timed out; only summarize and submit existing evidence' }
      const notice = store.toolStarted(run.id, toolCall.id, json(toolCall), true, !context.featureAvailable || context.featureAvailable('redtrace-repeat-reminder'),createHash('sha256').update(JSON.stringify(config.commonEnv ?? {})).digest('hex'))
      if (notice) agent.steer({ role:'user',content:notice,timestamp:Date.now() })
      if (jev?.isEnabled('trace_observer')) traceRevisions.set(toolCall.id, store.project(run.projectId).revision)
      return undefined
    },
    afterToolCall: async ({ toolCall, result: output }) => {
      store.toolEnded(run.id, toolCall.id, json(output))
      if (jev?.isEnabled('trace_observer')) {
        const previous = traceRevisions.get(toolCall.id)
        traceRevisions.delete(toolCall.id)
        traceWindow.push(traceCall(toolCall.name, toolCall.arguments, output.content, Boolean((output as { isError?: boolean }).isError),
          previous !== undefined && store.project(run.projectId).revision !== previous))
        if (traceWindow.length === 10) {
          const window = traceWindow.splice(0)
          void jev.observeTrace(run, step, window).then(stalled => { if (stalled && !signal.aborted && jev.isEnabled('trace_observer')) agent.steer({ role: 'user', content: 'Jev 提醒：最近一组工具调用可能在重复工作或偏离当前 Step。请检查已有证据与目标，再决定下一步。', timestamp: Date.now() }) }).catch(() => {})
        }
      }
      return undefined
    },
  })
  const abort = () => agent.abort()
  signal.addEventListener('abort', abort, { once: true })
  store.runEvent(run.id, 'system.prompt', json({ content: activityPrompt(run.activity, step, jev?.isEnabled('candidate_choice'), jev?.isEnabled('attack_readiness')) }))
  let cursor = Number(store.db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM events WHERE project_id=?').get(run.projectId)!.value)
  let criticalReminderSent = false
  const changed = (projectId: string) => {
    if (projectId !== run.projectId || signal.aborted || finished || concludeOnly) return
    if (run.activity === 'decide') {
      const project = store.project(projectId)
      const notice=criticalNotice(project,run,criticalReminderSent,!context.featureAvailable || context.featureAvailable('redtrace-critical-events'))
      if (notice) {
        criticalReminderSent = true
        agent.steer({ role: 'user', content:notice, timestamp: Date.now() })
      }
      return
    }
    if (run.activity !== 'execute') return
    const update = graphUpdate(store, projectId, cursor, run.stepId); cursor = update.cursor
    const { relevant } = update
    if (!relevant) return
    // Model reads canonical state on demand; no transcript-to-transcript coordination.
    if (store.project(projectId).status === 'active') agent.steer({ role: 'user', content: '共享图已有更新。需要时用 read_graph 查看，不必改变当前 Step。', timestamp: Date.now() })
  }
  store.changes.on('change', changed)
  let modelCall = ''
  agent.subscribe(event => {
    if (event.type === 'message_start' && event.message.role === 'assistant') store.metricStart(run.id, modelCall=`model-${randomUUID()}`, 'model')
    if (event.type === 'message_end' && event.message.role === 'assistant') store.metricEnd(run.id,modelCall)
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
    const limits = activityLimits(config, run.activity, step)
    const seconds = limits.timeout
    let timeout = setTimeout(() => { concludeOnly = true; agent.abort() }, seconds * 1000)
    try {
      await agent.prompt(messages.length ? '继续' : JSON.stringify({ project: graph.project, goal: graph.goals.find(g => g.id === 'goal'), step: step ?? null, origin: graph.facts[0],
        ...(step?.requires?.length && verbs ? { channels: channelsFor(verbs,step.requires,8,run.projectId) } : {}),
        instruction: '用 read_graph 获取所需状态后推进任务。' }))
    } finally { clearTimeout(timeout) }
    if (signal.aborted || finished) return
    // One same-session conclude attempt, never a fresh execution after timeout/error.
    concludeOnly = true
    timeout = setTimeout(() => agent.abort(), limits.concludeTimeout * 1000)
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
