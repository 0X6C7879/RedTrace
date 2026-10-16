import { Type } from 'typebox'
import type { TSchema, Static } from 'typebox'
import type { AgentTool, AgentToolResult } from './tool-types.ts'
import { readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import { execFile } from 'node:child_process'
import path from 'node:path'
import { promisify } from 'node:util'
import { toolEnvironment } from './shell.ts'
import type { Store } from './store.ts'
import type { TaskContext } from './scheduler.ts'
import type { EngineConfig, Fact, Json, Step, Project, Run, Goal, Input } from './types.ts'
import { knowledgeTools } from './knowledge.ts'
import { redactSensitive } from './store.ts'
import { httpTools } from './http-tools.ts'
import { Check } from 'typebox/value'
import { HttpError } from './types.ts'
import { evidenceChangeSchema, goalUpdateSchema, stepUpdateSchema } from './graph-contracts.ts'

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value))
const execFileAsync = promisify(execFile)
const result = (value: unknown, terminate = false): AgentToolResult<unknown> => ({ content: [{ type: 'text', text: JSON.stringify(redactSensitive(value)) }], details: value, ...(terminate ? { terminate: true } : {}) })
function tool<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal) => unknown | Promise<unknown>, terminate = false): AgentTool<T> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, args, signal) => result(await execute(args, signal), terminate) }
}
async function tsecbenchQuery(config: EngineConfig, args: string[], signal?: AbortSignal) {
  const script = path.join(path.dirname(config.workspaceRoot), '.redtrace', 'skills', 'tsecbench-api', 'scripts', 'tsecbench.py')
  try {
    const { stdout } = await execFileAsync(process.env.REDTRACE_BENCHMARK_PYTHON || 'python3', [script, ...args], {
      cwd: path.dirname(script), env: toolEnvironment(config.commonEnv), signal, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
    })
    const response = JSON.parse(stdout)
    if (response?.ok === false) throw new HttpError(502, response.message ?? response.error ?? 'TSecBench SDK failure', response)
    return response?.[args[0]] ?? response
  } catch (error) {
    if (error instanceof HttpError) throw error
    const failure = error as { stdout?: string; stderr?: string; code?: string; killed?: boolean; message?: string }
    for (const text of [failure.stderr, failure.stdout]) {
      try { const parsed = JSON.parse(text ?? ''); throw new HttpError(502, parsed.message ?? parsed.error ?? 'TSecBench SDK failure', parsed) } catch (parsedError) { if (parsedError instanceof HttpError) throw parsedError }
    }
    throw new HttpError(502, failure.killed ? 'TSecBench query timed out; execution outcome may be unknown' : 'TSecBench query failed', { code: failure.code ?? null, message: failure.message ?? null })
  }
}

export function efficiencyToolAvailable(context: TaskContext, name: string) {
  const plugin = name.startsWith('knowledge_') ? 'redtrace-knowledge' : name.startsWith('http_') ? 'redtrace-http' : undefined
  return !plugin || !context.featureAvailable || context.featureAvailable(plugin)
}

export function graphTools(context: TaskContext, finish: () => void): AgentTool[] {
  const { store, run, worker, config, signal } = context
  const maxSteps = () => context.currentMaxSteps ? context.currentMaxSteps() : config.maxSteps ?? null
  const evidenceRoot = path.join(run.workspaceRoot ?? path.join(config.workspaceRoot ?? path.join(os.tmpdir(), 'redtrace-workspaces'), run.projectId), '.redtrace-output', 'evidence')
  const installRoot = config.workspaceRoot ? path.dirname(config.workspaceRoot) : undefined
  const step = run.stepId ? store.node<Step>(run.projectId, run.stepId, 'step') : undefined
  const kinds = ['fact', 'goal', 'step', 'finding', 'hint', 'observation'] as const
  const readGraph = tool('read_graph', 'Read current project state or a current node by ID. Merged sources and deleted evidence no longer exist. SQL pagination is bounded. Hints and observations are unverified.', Type.Object({ id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), kinds: Type.Optional(Type.Array(Type.Union(kinds.map(k => Type.Literal(k))), { uniqueItems: true })) }, { additionalProperties: false }), async args => {
    if (args.id) return { ...store.node(run.projectId, args.id), planningCapacity: store.planningCapacity(run.projectId, maxSteps()), acknowledgementBoundary: store.acknowledgementBoundary(run.id) }
    const offset = args.offset ?? 0, limit = args.limit ?? 100, selected = new Set(args.kinds ?? kinds)
    const project = store.project(run.projectId), page: Record<string, unknown> = { project, facts: [], goals: [], steps: [], findings: [], hints: [], observations: [] }, nextOffsets: Record<string, number | null> = {}
    for (const kind of kinds) {
      if (!selected.has(kind)) continue
      page[kind === 'fact' ? 'facts' : kind === 'goal' ? 'goals' : kind === 'step' ? 'steps' : kind === 'finding' ? 'findings' : `${kind}s`] = store.nodes(run.projectId, [kind], { offset, limit })
      const total = store.nodeCount(run.projectId, kind)
      nextOffsets[kind] = offset + limit < total ? offset + limit : null
    }
    const remaining = Object.values(nextOffsets).filter((value): value is number => value !== null)
    return { ...page, planningCapacity: store.planningCapacity(run.projectId, maxSteps()), acknowledgementBoundary: store.acknowledgementBoundary(run.id), nextOffset: remaining.length ? Math.max(...remaining) : null, nextOffsets }
  })
  const refs = Type.Array(Type.String())
  const tools: AgentTool[] = [readGraph]
  tools.push(tool('read_graph_delta', 'Read a bounded page of change metadata and current surviving nodes. Merged/deleted IDs have no historical body. Continue with cursor until hasMore is false. Reading does not acknowledge processing.', Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), args => ({ ...store.graphDelta(run.projectId, args.after ?? store.run(run.id).deliveredGraphCursor ?? 0, args.limit ?? 100, run.id), planningCapacity: store.planningCapacity(run.projectId, maxSteps()), acknowledgementBoundary: store.acknowledgementBoundary(run.id) })))
  tools.push({ name: 'evidence_read', label: 'evidence_read', description: 'Read at most 7.6 KiB from a large tool result by byte offset, 1-based line, or keyword. Artifacts are scoped to this Project; pass run_id for another producer Run; request the next bounded slice when needed.', parameters: Type.Object({ run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })), id: Type.String({ pattern: '^ev-[a-f0-9]{64}$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })), line: Type.Optional(Type.Integer({ minimum: 1 })), query: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 7600 })) }), executionMode: 'sequential', execute: async (_toolId: string, args: { run_id?: string; id: string; offset?: number; line?: number; query?: string; length?: number }) => {
    if (!/^ev-[a-f0-9]{64}$/.test(args.id) || [args.offset, args.line, args.query].filter(value => value !== undefined).length > 1) throw new Error('Provide a valid evidence ID and only one read selector')
    const producer = store.run(args.run_id ?? run.id)
    if (producer.projectId !== run.projectId) throw new Error('Evidence producer belongs to another Project')
    const runRoot = path.join(evidenceRoot, producer.id), root = await realpath(runRoot), base = await realpath(evidenceRoot)
    const workspace = await realpath(run.workspaceRoot ?? path.dirname(path.dirname(evidenceRoot)))
    if (!base.startsWith(workspace + path.sep)) throw new Error('Evidence root escapes this Project')
    if (!root.startsWith(base + path.sep)) throw new Error('Evidence path is outside this Project')
    const file = await realpath(path.join(root, `${args.id}.json`))
    if (path.dirname(file) !== root) throw new Error('Evidence path escapes producer Run')
    const bytes = await readFile(file)
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
        tool('tsecbench_vpn', 'Probe benchmark VPN reachability. Nothing probes it automatically, so run this when a platform call fails or before trusting challenge container addresses.', Type.Object({}), (_args, abort) => tsecbenchQuery(config, ['vpn'], abort)),
        tool('tsecbench_hint', 'View a TSec Benchmark challenge hint. Viewing may reduce its flag score; requires explicit score penalty confirmation. Does not start, submit or close challenges.', Type.Object({ unique_code: Type.String(), confirm_score_penalty: Type.Boolean() }), (args, abort) =>
          args.confirm_score_penalty ? tsecbenchQuery(config, ['hint', args.unique_code, '--confirm-score-penalty'], abort) : { ok: false, error: 'score_penalty_confirmation_required' }),
      )
    }
    tools.push(
      tool('notify_explore', 'Send brief useful information to a running Explore in this project. Queued means its current inbox accepted the message, not that the model read it. Does not interrupt calls, revise the Step or expand permissions. Avoid repeated or microscopic guidance.', Type.Object({ stepId: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1, maxLength: 2000 }), sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, maxItems: 16 })) }), args => context.notifyExplore?.(args) ?? { ok: false, status: 'rejected', reason: 'transport_unavailable' }),
      tool('add_step', 'Create an evidence-backed Step to advance goalId. Explore autonomously chooses enabled tools. Check planningCapacity before adding work; pending/running/paused Steps count toward maxSteps.', Type.Object({ description: Type.String(), sourceIds: refs, goalId: Type.Optional(Type.String()), priority: Type.Optional(Type.Integer()), executionProfile: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('isolated')])) }), args => store.addStep(run.projectId, args, maxSteps())),
      tool('update_step', 'Use notify_explore for information or method changes while the objective remains valid. Amend or replace a Step with expectedVersion. Changed goals or execution isolation require replace; enabled tools do not.', Type.Object({ ...stepUpdateSchema.properties, expectedVersion: Type.Integer({ minimum: 1 }), id: Type.String(), cancel: Type.Optional(Type.Boolean()) }), args => store.updateStep(run.projectId, args.id, { ...args, ...(args.cancel ? { status: 'cancelled' as const } : {}) })),
      tool('add_goal', 'Add a Sub Goal.', Type.Object({ description: Type.String(), parentId: Type.Optional(Type.String()) }), args => store.addGoal(run.projectId, args.description, args.parentId)),
      tool('update_goal', 'Revise a Subgoal description or state with expectedVersion. Running descendants require amend or replace; changed objectives require replace. Root description is immutable. Achievement requires active Fact/Finding evidence, not Step completion.', Type.Object({ ...goalUpdateSchema.properties, expectedVersion: Type.Integer({ minimum: 1 }), id: Type.String() }), args => store.updateGoal(run.projectId, args.id, args)),
      tool('manage_evidence', 'Maintain current Fact/Finding. merge keeps the target ID, redirects references and permanently removes sources; provide every source version and optionally the final description, or Finding title/details. Omitted content keeps the target value. delete permanently removes evidence after active references are repaired. Keep necessary conclusions and proof; there is no archive or restore. Never merge different targets, challenges, environments or contradictory conclusions; Scope is protected.', evidenceChangeSchema, args => store.manageEvidence(run.projectId, args)),
      tool('finish_decide', 'Finish planning. throughEvidenceSeq and throughHintSeq acknowledge delivered, processed continuous boundaries; reading alone does not acknowledge. Omitted boundaries acknowledge only launch input. Empty plans are allowed.', Type.Object({ throughEvidenceSeq: Type.Optional(Type.Integer({ minimum: 0 })), throughHintSeq: Type.Optional(Type.Integer({ minimum: 0 })) }), args => { store.transaction(() => { if (args.throughEvidenceSeq !== undefined) store.acknowledgeEvidence(run.id, args.throughEvidenceSeq); if (args.throughHintSeq !== undefined) store.acknowledgeHint(run.id, args.throughHintSeq) }); finish(); return { saved: true } }, true),
    )
  } else {
    tools.push(tool('sync_step', 'Adopt the latest Step contract at a safe boundary. Read current planVersion first. Returns goals and active dependencies. Old call trees remain blocked; generate your next action from this contract.', Type.Object({ planVersion: Type.Integer({ minimum: 1 }) }), args => store.syncStep(run.id, args.planVersion)))
    tools.push(...httpTools(context))
    const benchmarkOrigin = store.node<Fact>(run.projectId, 'origin', 'fact').description
    const benchmarkSkill = installRoot ? path.join(installRoot, '.redtrace', 'skills', 'tsecbench-api') : ''
    if (/(?:tsecbench|tsec[\s-]*benchmark)/i.test(benchmarkOrigin) && existsSync(path.join(benchmarkSkill, 'SKILL.md')) && existsSync(path.join(benchmarkSkill, 'scripts', 'tsecbench.py'))) {
      tools.push(
        tool('tsecbench_list', 'Read challenge descriptions, progress and container state; no lifecycle operation.', Type.Object({}), (_args, abort) => tsecbenchQuery(config, ['list'], abort)),
        tool('tsecbench_vpn', 'Probe benchmark VPN reachability. Nothing probes it automatically, so run this when a platform call fails or before trusting challenge container addresses.', Type.Object({}), (_args, abort) => tsecbenchQuery(config, ['vpn'], abort)),
        tool('tsecbench_start', 'Start the explicitly selected authorized benchmark challenge. Pass the exact unique_code from tsecbench_list; no arbitrary platform or network target is accepted.', Type.Object({ unique_code: Type.String({ minLength: 1, maxLength: 128 }) }), async (args, abort) => {
          const started = await tsecbenchQuery(config, ['start', args.unique_code], abort) as { unique_code?: unknown; container_addr?: unknown }
          if (started.unique_code !== args.unique_code || !Array.isArray(started.container_addr) || !started.container_addr.length || started.container_addr.some(address => typeof address !== 'string' || address.length > 255)) throw new Error('Benchmark start returned an invalid challenge or target list')
          const hosts=(started.container_addr as string[]).map(value=>{const url=new URL(/^https?:/.test(value)?value:`http://${value}`);if(url.username || url.password)throw new Error('Platform returned credential-bearing target');return url.host.toLowerCase()})
          store.transaction(() => {
            store.setBenchmarkHosts(run.projectId, args.unique_code, hosts)
            store.addInput(run.projectId, 'observation', `Platform started TSecBench ${args.unique_code}; authorized targets: ${(started.container_addr as string[]).join(', ')}`, worker.name, run.stepId)
          })
          return started
        }),
        tool('tsecbench_submit', 'Submit one flag for the active authorized challenge and return the platform response. Does not create Facts or wake Reason; Explore must verify the response and explicitly submit_fact for decision-relevant results. Secrets in tool arguments are redacted from audit events.', Type.Object({ unique_code: Type.String({ minLength: 1, maxLength: 128 }), flag: Type.String({ minLength: 1, maxLength: 4096 }) }), (args, abort) => tsecbenchQuery(config, ['submit', args.unique_code, '--flag', args.flag], abort)),
        tool('tsecbench_close', 'Close only the exact authorized TSecBench challenge that is complete or that Reason explicitly assigned this Step to close before switching challenges, to release its container.', Type.Object({ unique_code: Type.String({ minLength: 1, maxLength: 128 }) }), async (args,abort)=>{const result=await tsecbenchQuery(config,['close',args.unique_code],abort);store.setBenchmarkHosts(run.projectId,args.unique_code);return result}),
      )
    }
    tools.push(
      tool('submit_fact', 'Publish a new decision-relevant, evidence-backed conclusion; consolidate related observations, not startup/status or duplicate Facts. Urgent goal proof, cross-Step prerequisites and real blockers must not wait.', Type.Object({ description: Type.String(), evidence: Type.Array(Type.Object({ description: Type.String(), path: Type.Optional(Type.String()) })) }), args => store.addFact(run.projectId, args.description, { runId: run.id, evidence: args.evidence, creator: worker.name })),
      tool('submit_finding', 'Record a deliverable supported by confirmed facts. New Findings wake Reason.', Type.Object({ title: Type.String(), description: Type.String(), type: Type.Optional(Type.String()), factIds: refs }), args => store.addFinding(run.projectId, { ...args, creator: worker.name, runId: run.id })),
      tool('finish_step', step?.bootstrap
        ? 'Finish Bootstrap after submitting at least one confirmed Fact. Reason remains blocked until Bootstrap succeeds with a Fact.'
        : 'Finish this Step only after explicitly submitting at least one confirmed, evidence-backed Fact. Consolidate the result, including verified failures or blockers, then call finish_step; a text summary alone does not complete the Step.', Type.Object({ summary: Type.String() }), args => {
          const current = store.node<Step>(run.projectId, run.stepId!, 'step')
          if (!current.factIds.length) throw new Error(`${current.bootstrap ? 'Bootstrap' : 'Explore'} must submit at least one Fact before finishing`)
          store.runEvent(run.id, 'step.summary', json(args)); finish(); return { saved: true }
        }, true),
    )
  }
  tools.push(...knowledgeTools(evidenceRoot, context))
  return tools.map(t => ({ ...t, execute: async (...args) => {
    if (!Check(t.parameters, args[1])) throw new HttpError(422, 'Invalid tool arguments')
    if (!efficiencyToolAvailable(context, t.name)) throw new Error('Efficiency tool plugin is disabled')
    if (signal.aborted || store.run(run.id).status !== 'running') throw new Error('Activity has stopped')
    let value
    try { value = await t.execute(...args) }
    catch (error) {
      if (!(error instanceof HttpError) || error.details === undefined) throw error
      value = { ...result({ ok: false, error: error.message, context: error.details }), isError: true }
    }
    const output = value && typeof value === 'object' && Array.isArray((value as AgentToolResult<unknown>).content)
      ? value as AgentToolResult<unknown>
      : result(value)
    return output
  } }))
}

export const activityPrompt = (activity: 'decide' | 'execute', step?: Step) => (activity === 'decide'
  ? `你是任务的规划者(Reason)，负责根据 FGS 判断目标进展、规划下一步、协调 Explore 并维护图谱，不亲自解决任务。FGS（Fact-Goal-Step Graph）是共享的实时任务状态图。Fact 表示有证据支持的已确认事实；Goal/Subgoal 表示需要满足的验收条件；Step 表示基于已有事实、指向特定 Goal 的执行行动；Finding 表示由 Fact 支撑的可交付成果。Step 通过 sourceIds 引用执行依据，通过 goalId 关联目标，执行产生的新 Fact/Finding 可以支持后续 Step 或作为 Goal 的验收依据。Step 完成不等于 Goal 达成，Goal 必须由真实证据验收。Hint、Observation 和未经验证的推测不属于确认事实。FGS 只维护当前有效状态，执行历史和原始日志由独立记录保存。

1. 掌握态势：每次新会话先读取当前 FGS，明确 Scope、Goal、Fact/Finding 和活跃 Step。会话期间出现新事件时，通过 read_graph_delta 连续获取变化，只按需展开相关证据，不重复全图读取。Hint、Observation 和推测不能直接作为确认事实。
2. 优先验收目标：判断现有 Fact/Finding 是否已满足 Goal，逐项核对数量、权限、范围及其他验收条件。确认达成后引用真实 evidenceIds 完成验收并说明依据。Step 结束、探索失败或路线放弃均不代表 Goal 达成。
3. 规划有效方向：以目标达成速度和成功可能性为优先。有突破就深入，缺少入口就拓宽，持续受阻且没有新进展就根据已经证据重新评估和规划。依赖未取得的能力或权限时等待，不提前派发后续行动。
4. 避免重复与空转：对照已有 Step 和执行结果，区分成功、失败、阻塞、中断及真正穷尽。单次失败不能否定整条路线；中断优先续接已确认进度，已充分验证的无效路线只有出现新证据或实质不同的方法才重开。已有工作覆盖当前方向时不重复派发。目标未达成且没有待执行或运行中的 Step 时，优先续接未完工作或寻找未覆盖方向；确无可执行路径则说明具体阻塞，不虚构任务。
5. 调度规则：效率优先，以最快速度完成目标为前提。每个 Step 都要分配至少一个题目，同一题目也可以分给多个 Step 协作完成，较困难题目(单Worker难以完成，有至少2个fact都没有重大突破的)的题目可以分多个 Step 并发共同解决(多个Step任务不能有冲突，要考虑跨Worker的协作，如果难以分出边界依旧采用单Worker执行)。同题多 Step 协作不指定固定的容器负责人。题目未解决时默认保留实例，不能仅因某个 Step 结束或失败就关闭。某题持续难以突破、占用实例槽位并影响全局进展时，可根据已有证据决定关闭并换题。先停止或调整旧题相关 Step，避免其继续操作即将关闭的实例；在新建的其他题目 Step 中明确写出需要关闭的旧题及随后要解决的新题，由执行新题的 Explore 先关闭旧题、确认槽位释放，再启动新题，无须另建专门的清理 Step。保持活跃题目并发为 3（平台活跃容器上限为 3，所有活跃 Step 中最多只能分配3个不同的题目），直到未解题目数<3；maxSteps>3，合理分配 Step，不用保持最大 Step 数。创建 Step 前检查 planningCapacity，遵守 Worker 和并发限制。
6. 维护计划与协作：Step 应明确行动方向和对应目标，用 sourceIds 引用依据、goalId 关联目标。Subgoal 只描述可验收的阶段成果，操作和策略属于 Step。FGS上新增的信息或人工 Hint 对现有 Step 有实质帮助时，用 notify_explore 定向补充；不重复通知或微观管理。不得在没有依据时限制 Step 的行动及方法选择。Step 过时或偏离目标时才用带版本的 update_step/update_goal 修正，或替换/取消 Step。同目标、同权限的执行契约变更使用 amend；目标或执行隔离变化使用 replace。远程命令和内网代理必须具备已验证的在线程序化通道，图形登录不等于命令通道。
7. 维护 FGS：FGS 保存当前有效状态，而非探索历史。用 manage_evidence 可以合并结论一致或相近的 Fact/Finding，必要时提交整理后的结论；删除过时、冗余且不再需要的 Fact/Finding。保留后续决策需要的证据，不合并矛盾结论。合并和删除不可恢复，操作前核对版本并修复活跃引用。图谱整理不得妨碍目标推进。
8. 及时结束本轮：每次唤醒只判断新信息是否改变目标验收、可执行前置或现有计划。没有实质变化时允许不做修改，继续等待 Explore。处理完已交付的连续证据和 Hint 后调用 finish_decide；throughEvidenceSeq、throughHintSeq 只确认实际完整处理的连续序号，不能超过 acknowledgementBoundary。未处理部分留待下一轮。

核心要求：有价值的方向及时派发；已有工作充分覆盖时不重复规划。`
  : step?.bootstrap
    ? `你是 Bootstrap，仅在项目显式启用时，根据 Scope、Goal 和 Hints 直接解题，优先独立完成简单任务，不以建立初始事实为目标。

只在授权范围内操作，按需加载 Skills，优先走前置已满足的直接路径；失败后按反馈调整，不做无新信息的重复。得到一条 Fact 不是停止理由，有合理路径就继续完成 Goal。

确认结果及时 submit_fact，可核验成果用 submit_finding 引用 Fact。达成目标保存验收证据；暂时无法完成保存确认进展和阻塞。猜测、计划和未验证输出不作 Fact。

至少提交一条真实 Fact 后调用 finish_step；成功且返回 Fact 后 Reason 才会启动。无可信结果时说明阻塞，不伪造 Fact 或宣称已交接。`
    : `你是执行者(Explore)，唯一任务是完成当前 Step，推进其关联 Goal，将有价值的探索结果写回 FGS，只读取当前 Step 的引用证据，不默认读取全图和完整题库。FGS（Fact-Goal-Step Graph）是共享的实时任务状态图。Fact 表示有证据支持的已确认事实；Goal/Subgoal 表示需要满足的验收条件；Step 表示基于已有事实、指向特定 Goal 的执行行动；Finding 表示由 Fact 支撑的可交付成果。Step 通过 sourceIds 引用执行依据，通过 goalId 关联目标，执行产生的新 Fact/Finding 可以支持后续 Step 或作为 Goal 的验收依据。Step 完成不等于 Goal 达成，Goal 必须由真实证据验收。Hint、Observation 和未经验证的推测不属于确认事实。FGS 只维护当前有效状态，执行历史和原始日志由独立记录保存。

1. 专注当前 Step：理解目标、前置条件和已有证据，复用Fact、扫描结果、凭证及已验证通道。自主选择 Skills、工具和方法，不重复已完成的工作。Step 内可以自由调整策略、串联多阶段操作。每次只处理一道题目，不要同时启动或解答多道题，同一道题允许多个 Step 协作。复用已启动的实例和已验证地址，避免重复启动。题目未解决时默认保留容器，不因自身 Step 完成、失败、放弃或超时而自行关闭。题目完成后，再关闭容器并核验。Reason 在当前 Step 中明确要求关闭旧题并转做新题时，先关闭指定旧题、确认槽位释放，再启动新题。
2. 深入探索与递归进化：将探索视为持续自我改进的过程，根据工具反馈、环境变化和执行结果不断修正假设、优化策略。主动分析失败的原因，识别方法的适用条件、失效边界和潜在突破口，从历史尝试中总结和反思，使后续行动持续改进。单次失败、无回显或工具报错不能证明路线无效，应检查前置条件并尝试具有实质差异的方法。发现关键突破后优先深入验证和利用；持续受阻时重新评估假设，决定继续深入、拓宽探索或切换机制，不机械重复无效尝试。将反思融入正常执行，不进行独立或频繁的自评循环，始终以目标达成率、执行速度和工具效率为优先。
3. 保存可复用成果：将取得的关键成果、中间产物、失败尝试和关键操作可简要保存到工作目录的证据文件。发现凭证或其他资源时及时登记；可复用通道必须验证后才能视为有效。需要远程执行时使用与能力匹配的已验证通道。
4. 提交有决策价值的 Fact：submit_fact 是唤醒 Reason 的决策事件，不是执行日志。提交真实证据支持、足以影响目标验收、执行前置或后续计划的新结论；超时还没有关键进展时就如实提交已验证的失败、限制或阻塞。默认将同一 Step、同一目标和环境的多个观察合并为一条阶段 Fact；description 说明已验证结论、覆盖范围及剩余缺口，evidence 保留关键操作、证明性输出及原始记录路径。仅当结论相互独立且需要不同后续行动时才拆分。容器启动、目标地址返回、单个指纹或状态码、一次失败、局部进度及重复确认不单独提交 Fact；先记录证据，继续探索。已验证的目标成果、其他 Step 等待的关键前置或必须由 Reason 处理的阻塞，应立即提交，不等待 Step 结束。提交 Fact 后，只要当前 Step 仍有有效路径，就继续执行。
5. 严格验证 Finding：漏洞或其他可交付成果必须有可复现的实际证据，先提交对应 Fact，再用 submit_finding 引用确认事实。版本/CVE 匹配、扫描器提示、可疑参数或推测不能代替漏洞验证。发现组件或 CVE 线索时主动使用 knowledge_search，需要详情再使用 knowledge_read；离线知识仅用于辅助判断和选择方法，不构成漏洞成立的证据，无命中也不妨碍继续探索。
6. 适应实时计划：Reason 的 notify_explore 只是增量信息，不代表执行契约变化；结合现有进度自主决定是否采用。只有 Step 契约版本变化时，才读取最新图谱并用 sync_step 同步。同步后在下一模型回合按新契约继续，旧调用树不得继续执行外部操作。
7. 结构化收尾：当前 Step 已完成、无法继续或收到收尾指令时，将尚未上报的有效进展整理为至少一条有真实证据的汇总 Fact，再调用 finish_step。如果未完成目标就如实说明已验证的尝试、限制和阻塞，不伪造成功，不把启动状态当作成果。必须确保工具调用成功，文本总结不能代替提交。

核心要求：始终以推进目标、深入探索、减少无效操作和保留可靠证据为原则。如果碰到验证码等人机验证，自行识别或使用OCR识别，受阻时记录并尝试其他有效路径，不依赖人工接管。`)

export function activityLimits(config: EngineConfig, activity: 'decide' | 'execute', step?: Step) {
  if (activity === 'decide') return { timeout: config.decideTimeout, concludeTimeout: config.concludeTimeout }
  if (step?.bootstrap) return { timeout: config.bootstrapTimeout, concludeTimeout: config.bootstrapConcludeTimeout }
  return { timeout: config.executeTimeout, concludeTimeout: config.concludeTimeout }
}

export function livePlan(store: Store, runId: string) {
  const run = store.run(runId)
  if (!run.stepId) return ''
  const step = store.node<Step>(run.projectId, run.stepId, 'step'), goals = []
  let goalId: string | null = step.goalId
  while (goalId) {
    const goal: Goal = store.node<Goal>(run.projectId, goalId, 'goal')
    goals.push({ id: goal.id, description: goal.description, status: goal.status, version: goal.version ?? 1 })
    goalId = goal.parentId
  }
  return `当前执行契约（以本快照为准）：${JSON.stringify({ id: step.id, description: step.description, status: step.status,
    sourceIds: step.sourceIds, executionProfile: step.executionProfile,
    planVersion: step.planVersion ?? 1, boundStepVersion: run.boundStepVersion ?? 1, goals })}`
}

export function launchContext(store: Store, runId: string, channels: unknown[] = [], maxSteps: number | null = null) {
  const run = store.run(runId), origin = store.node<Fact>(run.projectId, 'origin', 'fact')
  const includeHints = run.activity === 'decide' || !!run.stepId && store.node<Step>(run.projectId, run.stepId, 'step').bootstrap
  const acknowledgedHintSeq = run.activity === 'decide' ? store.project(run.projectId).acknowledgedHintSeq ?? 0 : 0
  const hints = includeHints ? store.db.prepare(`SELECT n.data FROM nodes n JOIN events e
    ON e.project_id=n.project_id AND e.node_id=n.id AND e.type='hint.added'
    WHERE n.project_id=? AND n.kind='hint' AND COALESCE(json_extract(n.data,'$.deleted'),0)=0
    AND COALESCE(json_extract(e.data,'$.hintSeq'),1)>?
    AND (?=1 OR json_extract(n.data,'$.stepId') IS NULL OR json_extract(n.data,'$.stepId')=?) ORDER BY n.rowid LIMIT 9`)
    .all(run.projectId, acknowledgedHintSeq, run.activity === 'decide' ? 1 : 0, run.stepId).map(row => JSON.parse(String(row.data)) as Input) : []
  const goal = run.activity === 'decide' ? store.node<Goal>(run.projectId, 'goal', 'goal') : undefined
  return { projectId: run.projectId, planningCapacity: store.planningCapacity(run.projectId, maxSteps), acknowledgementBoundary: store.acknowledgementBoundary(run.id), scope: { id: origin.id, description: origin.description },
    ...(goal ? { goal: { id: goal.id, description: goal.description, status: goal.status },
      evidenceSeq: run.planningEvidenceSeq ?? 0, hintSeq: run.planningHintSeq ?? 0, criticalSeq: run.planningCriticalSeq ?? 0, graphCursor: run.deliveredGraphCursor ?? 0,
      } : {}),
    ...(hints.length ? { hints: { unverified: true, items: hints.slice(0, 8).map(h => ({ id: h.id, content: h.content })), hasMore: hints.length > 8,
      ...(hints.length > 8 ? { read: { tool: 'read_graph', kinds: ['hint'], offset: 0, limit: 100 }, filter: { ...(run.activity === 'decide' ? { allSteps: true } : { stepId: run.stepId }), includeProjectHints: true } } : {}) } } : {}),
    ...(channels.length ? { channels } : {}) }
}

export function criticalNotice(project: Project, run: Run, notifiedSeq: number, enabled = true) {
  return enabled && run.activity === 'decide' && project.status === 'active' && (project.criticalSeq ?? 0) > Math.max(run.planningCriticalSeq ?? 0, notifiedSeq)
    ? `运行时已验证新的关键状态变化（可能包含能力失效）；criticalSeq=${project.criticalSeq}。读取 FGS，将其与当前计划合并，只重排仍有效的 Step。` : undefined
}

export function graphUpdate(store: Store, projectId: string, cursor: number, stepId: string | null, runId?: string, criticalEnabled = true) {
  const project = store.project(projectId), run = runId ? store.run(runId) : undefined
  const latestCursor = stepId === null ? undefined : Number(store.db.prepare('SELECT MAX(id) AS id FROM events WHERE project_id=?').get(projectId)?.id ?? cursor)
  const step = run?.stepId ? store.node<Step>(projectId, run.stepId, 'step') : undefined
  const stopped = project.status !== 'active' || !!run && (run.status !== 'running' || !!step && (step.status !== 'running' || store.node<Goal>(projectId, step.goalId, 'goal').status !== 'open'))
  const planVersion = step?.planVersion ?? 1, boundStepVersion = run?.boundStepVersion ?? 1
  const planChanged = !stopped && !!step && planVersion !== boundStepVersion
  let relevant = false, evidenceSeq = 0, hintSeq = 0, criticalSeq = 0, omitted = false
  const after = cursor, counts: Record<string, number> = {}
  const nodeIds = new Set<string>()
  for (;;) {
    const events = store.events(projectId, cursor, 500, stepId ?? undefined)
    cursor = events.at(-1)?.id ?? cursor
    for (const e of events) {
      const payload = e.payload as unknown as { evidenceSeq?: number; hintSeq?: number }
      const added = e.type === 'fact.added' || e.type === 'finding.added'
      const critical = stepId === null && criticalEnabled && e.type === 'planning.critical'
      const hint = ['hint.added', 'hint.deleted'].includes(e.type)
      const changed = stepId === null ? added || hint || critical
        : planChanged && e.nodeId === stepId && ['step.revised', 'step.updated'].includes(e.type)
      if (hint && changed) hintSeq = Math.max(hintSeq, payload.hintSeq ?? 0)
      if (added && changed) evidenceSeq = Math.max(evidenceSeq, payload.evidenceSeq ?? 0)
      if (critical) criticalSeq = project.criticalSeq ?? 0
      relevant ||= changed
      if (changed) {
        counts[e.type] = (counts[e.type] ?? 0) + 1
        if (e.nodeId && !nodeIds.has(e.nodeId)) { if (nodeIds.size < 16) nodeIds.add(e.nodeId); else omitted = true }
      }
    }
    if (events.length < 500) return { after, cursor: latestCursor ?? cursor, relevant: !stopped && relevant, evidenceSeq, hintSeq, criticalSeq, planChanged, stopped,
      planVersion, boundStepVersion, wake: !!criticalSeq || planChanged || stepId === null && (!!evidenceSeq || !!hintSeq), counts, nodeIds: [...nodeIds], omitted }
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
