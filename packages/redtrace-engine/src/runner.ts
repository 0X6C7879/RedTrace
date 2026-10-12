import { Type } from 'typebox'
import type { TSchema, Static } from 'typebox'
import type { AgentTool, AgentToolResult } from './tool-types.ts'
import { mkdir, open, readFile, realpath } from 'node:fs/promises'
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
import { extractOutput } from './result-summary.ts'
import { closeWebChallenge, webTools } from './web.ts'
import { verbIds } from './capability-verbs.ts'
import { HttpError } from './types.ts'
import { evidenceChangeSchema, goalUpdateSchema, stepUpdateSchema } from './graph-contracts.ts'
import { taskPluginsSchema } from './task-plugins.ts'

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value))
const execFileAsync = promisify(execFile)
const result = (value: unknown, terminate = false): AgentToolResult<unknown> => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(terminate ? { terminate: true } : {}) })
function tool<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal) => unknown | Promise<unknown>, terminate = false): AgentTool<T> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, args, signal) => result(await execute(args, signal), terminate) }
}
async function tsecbenchQuery(config: EngineConfig, args: string[], signal?: AbortSignal) {
  const script = path.join(path.dirname(config.workspaceRoot), '.redtrace', 'skills', 'tsecbench-api', 'scripts', 'tsecbench.py')
  try {
    const { stdout } = await execFileAsync('python3', [script, ...args], {
      cwd: path.dirname(script), env: toolEnvironment(config.commonEnv), signal, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
    })
    const response = JSON.parse(stdout)
    return response?.[args[0]] ?? response
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
  const readGraph = tool('read_graph', 'Read active project state or any node by ID, including archived/merged history. includeInactive:true explicitly includes historical evidence. SQL pagination is bounded; full:true only skips semantic filtering. Hints and observations are unverified.', Type.Object({ id: Type.Optional(Type.String()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), kinds: Type.Optional(Type.Array(Type.Union(kinds.map(k => Type.Literal(k))), { uniqueItems: true })), full: Type.Optional(Type.Boolean()), includeInactive: Type.Optional(Type.Boolean()) }), async args => {
    if (args.id) return store.node(run.projectId, args.id)
    const offset = args.offset ?? 0, limit = args.limit ?? 100, selected = new Set(args.kinds ?? kinds)
    const project = store.project(run.projectId), page: Record<string, unknown> = { project, historyIncomplete: false, facts: [], goals: [], steps: [], findings: [], hints: [], observations: [] }, nextOffsets: Record<string, number | null> = {}
    for (const kind of kinds) {
      if (!selected.has(kind)) continue
      page[kind === 'fact' ? 'facts' : kind === 'goal' ? 'goals' : kind === 'step' ? 'steps' : kind === 'finding' ? 'findings' : `${kind}s`] = store.nodes(run.projectId, [kind], { offset, limit, includeInactive: args.includeInactive })
      const total = store.nodeCount(run.projectId, kind, args.includeInactive)
      nextOffsets[kind] = offset + limit < total ? offset + limit : null
    }
    const remaining = Object.values(nextOffsets).filter((value): value is number => value !== null)
    const filtered = !args.full && !args.includeInactive && jev?.isEnabled('context_filter') && selected.has('fact') && selected.has('step')
      ? await jev.filterGraph(run, step, page as unknown as ReturnType<typeof store.graph>).catch(() => undefined) : undefined
    return { ...(filtered ?? page), nextOffset: remaining.length ? Math.max(...remaining) : null, nextOffsets,
      ...(jev?.isEnabled() ? { jevAdvisories: await jev.advisories(run.projectId) } : {}) }
  })
  const refs = Type.Array(Type.String())
  const tools: AgentTool[] = [readGraph]
  tools.push(tool('read_graph_delta', 'Read a bounded committed change page including lifecycle, versions and references. Continue with cursor until hasMore is false. Reading does not acknowledge processing.', Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), args => store.graphDelta(run.projectId, args.after ?? store.run(run.id).deliveredGraphCursor ?? 0, args.limit ?? 100, run.id)))
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
    const checkPlugins = (plugins: string[] = []) => {
      for (const id of plugins) if (context.taskPluginAllowed && !context.taskPluginAllowed(id)) throw new HttpError(409, `Task plugin is disabled: ${id}`)
    }
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
      tool('notify_explore', 'Send brief useful information to a running Explore in this project. Queued means its current inbox accepted the message, not that the model read it. Does not interrupt calls, revise the Step or expand permissions. Avoid repeated or microscopic guidance.', Type.Object({ stepId: Type.String({ minLength: 1 }), message: Type.String({ minLength: 1, maxLength: 2000 }), sourceIds: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { uniqueItems: true, maxItems: 16 })) }), args => context.notifyExplore?.(args) ?? { ok: false, status: 'rejected', reason: 'transport_unavailable' }),
      tool('add_step', 'Create an action sourced from Scope (origin), Fact or Finding IDs to advance goalId. requires lists capability verbs (e.g. remote.command): matching verb tools are exposed to the Execute agent, which reuses existing channels automatically. plugins selects optional task features for this Step only, not global switches or engine startup.', Type.Object({ description: Type.String(), sourceIds: refs, goalId: Type.Optional(Type.String()), priority: Type.Optional(Type.Integer()), requires: Type.Optional(Type.Array(Type.Union(verbIds.map(v => Type.Literal(v))), { uniqueItems: true, maxItems: 16 })), executionProfile: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('isolated')])), plugins: Type.Optional(taskPluginsSchema) }), async args => {
        checkPlugins(args.plugins)
        const created = store.addStep(run.projectId, args, config.maxSteps)
        const duplicate = jev?.isEnabled('step_dedup') ? await jev.suggestDuplicate(run.projectId, created, run) : undefined
        return duplicate ? { ...created, jevDuplicateSuggestion: duplicate } : created
      }),
      tool('update_step', 'Use notify_explore for useful information or method changes while the objective remains valid. Revise, reprioritize or cancel a Step with expectedVersion. Running amend keeps objective and permissions; replace stops the old run before its replacement starts. Changed objectives, targets, plugins or permissions require replace.', Type.Object({ ...stepUpdateSchema.properties, expectedVersion: Type.Integer({ minimum: 1 }), id: Type.String(), cancel: Type.Optional(Type.Boolean()) }), args => { checkPlugins(args.plugins); return store.updateStep(run.projectId, args.id, { ...args, ...(args.cancel ? { status: 'cancelled' as const } : {}) }) }),
      tool('add_goal', 'Add a Sub Goal.', Type.Object({ description: Type.String(), parentId: Type.Optional(Type.String()) }), args => store.addGoal(run.projectId, args.description, args.parentId)),
      tool('update_goal', 'Revise a Subgoal description or state with expectedVersion. Running descendants require amend or replace; changed objectives require replace. Root description is immutable. Achievement requires active Fact/Finding evidence, not Step completion.', Type.Object({ ...goalUpdateSchema.properties, expectedVersion: Type.Integer({ minimum: 1 }), id: Type.String() }), args => store.updateGoal(run.projectId, args.id, args)),
      tool('manage_evidence', 'Maintain same-kind Fact/Finding. merge keeps id and redirects references; provide every source version. archive preserves history but rejects active references: repair blockers first. restore reactivates archived evidence. Never merge different targets, challenges, environments or contradictory conclusions; Scope is protected.', evidenceChangeSchema, args => store.manageEvidence(run.projectId, args)),
      tool('finish_decide', 'Finish planning. throughEvidenceSeq and throughHintSeq acknowledge delivered, processed continuous boundaries; reading alone does not acknowledge. Omitted boundaries acknowledge only launch input. Empty plans are allowed.', Type.Object({ throughEvidenceSeq: Type.Optional(Type.Integer({ minimum: 0 })), throughHintSeq: Type.Optional(Type.Integer({ minimum: 0 })) }), args => { store.transaction(() => { if (args.throughEvidenceSeq !== undefined) store.acknowledgeEvidence(run.id, args.throughEvidenceSeq); if (args.throughHintSeq !== undefined) store.acknowledgeHint(run.id, args.throughHintSeq) }); finish(); return { saved: true } }, true),
    )
  } else {
    tools.push(tool('sync_step', 'Adopt the latest Step contract at a safe boundary. Read current planVersion first. Returns goals and active dependencies. Old call trees remain blocked; generate your next action from this contract.', Type.Object({ planVersion: Type.Integer({ minimum: 1 }) }), args => store.syncStep(run.id, args.planVersion)))
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
      tool('submit_finding', 'Record a deliverable supported by confirmed facts. New Findings wake Reason.', Type.Object({ title: Type.String(), description: Type.String(), type: Type.Optional(Type.String()), factIds: refs }), args => store.addFinding(run.projectId, { ...args, creator: worker.name, runId: run.id })),
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
    let value
    try { value = await t.execute(...args) }
    catch (error) {
      if (!(error instanceof HttpError) || error.details === undefined) throw error
      value = { ...result({ ok: false, error: error.message, context: error.details }), isError: true }
    }
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
  ? `你是 Reason，在 Scope 授权范围内根据 FGS 规划下一步并维护证据和计划；不亲自解题、操作容器或提交答案。

1. 先读活跃状态和连续增量；Hint、Observation 不是确认事实。已有成果满足 Goal 时，用真实 Fact/Finding evidenceIds 验收并解释依据，逐项核对数量、权限等条件；失败、停止尝试或 Step 结束不等于达成。
2. 有突破优先深入，缺少入口时拓宽，持续受阻且无新进展时换路线。只派现有证据支持、前置已满足的行动；依赖未取得的入口或权限时等待。独立且不争用会话的方向才并行，同一题默认一个主 Explore，优先并行不同题目。
3. 比对已有 Step，不重复枚举或已覆盖工作。单次失败不等于证伪，执行结束不等于路线穷尽；中断按确认进度续接，无效路线须有新证据或不同机制才重开。副作用不明先查证，不重放。无工作时寻找未覆盖的可验证方向；依赖在跑工作则等待，无合理方向说明缺口，不硬凑任务。
4. Step 写清行动与预期结果，用 sourceIds 引用 Scope/Fact/Finding、goalId 指向目标，按需选择 requires/plugins。Subgoal 只写可验收结果并复用；操作、重试和临时策略写 Step。远程命令或内网代理须有在线程序化通道，图形登录不等于命令通道；测试机扫描不需要 remote.command。
5. Explore 自主执行。新信息（包括人工 Hint）有实质帮助时才用 notify_explore 定向补充，不微观管理或重复通知；方法、策略改变但目标有效时不改 Step。Step 过时或偏离目标才用 update_step/update_goal 携带版本修正计划、取消或排序 Step；真正的同目标同权限契约变更 amend，改变目标或权限 replace。用 manage_evidence 合并同目标同环境的重复证据、归档或恢复证据，不合并矛盾结论；归档或删除前修复活跃引用，不为整理图谱延误目标。
6. 启动、新 Fact/Finding 或关键事件出现时及时规划，不等 Step 结束。并发、Worker 和 add_step 限额遵守系统限制。测评仅用开放的只读工具，扣分提示须先确认。完成调用 finish_decide，throughEvidenceSeq 只确认完整读取并处理的连续边界，throughHintSeq 同样只确认完整处理的连续 Hint 边界；人工 Hint 由你评估后按需转达 Explore。未处理事件留待下一轮。`
  : step?.bootstrap
    ? `你是 Bootstrap，仅在项目显式启用时，根据 Scope、Goal 和 Hints 直接解题，优先独立完成简单任务，不以建立初始事实为目标。

只在授权范围内操作，按需加载 Skills，优先走前置已满足的直接路径；失败后按反馈调整，不做无新信息的重复。得到一条 Fact 不是停止理由，有合理路径就继续完成 Goal。

确认结果及时 submit_fact，可核验成果用 submit_finding 引用 Fact。达成目标保存验收证据；暂时无法完成保存确认进展和阻塞。猜测、计划和未验证输出不作 Fact。

至少提交一条真实 Fact 后调用 finish_step；成功且返回 Fact 后 Reason 才会启动。无可信结果时说明阻塞，不伪造 Fact 或宣称已交接。`
    : `你是 Explore，在 Scope 授权范围内深入完成当前 Step，推进它的 goalId。

1. 复用共享事实、扫描结果、凭证和已验证通道，按需使用 Skills、执行工具与任务插件。在本 Step 内自主调整方法，不把每次尝试拆成新 Step；改变目标或权限边界交由 Reason 调整。
2. 一次失败不代表方向无效。按反馈检查前置、尝试实质不同的方法，有突破继续推进，避免无新信息的重复；副作用不明先查证，不重放。Step 外线索记录实际观察和待验证点，交给 Reason，不自行扩展。
3. Scope、Fact、Hint 或执行结果中的凭证及时登记为资源，即使尚无通道。可复用通道验证后登记、使用匹配通道，未验证入口不作可用通道。
4. 以工具输出核验结论，及时 submit_fact，附真实证据且只写增量；成功、失败和限制均可形成确认事实。Hint、Observation 和推测不是事实，单次失败不证明整条路线无效，版本/CVE 命中不等于漏洞成立。可核验成果用 submit_finding 引用 Fact，新 Fact/Finding 会唤醒 Reason。
5. Reason 通知是增量信息，不代表契约变更；结合当前进度自主调整方法，无须重新开始。只有执行契约版本真正变化时先 read_graph/read_graph_delta，再 sync_step 采纳当前版本；下一模型回合按新契约行动，旧调用树不得继续外部操作。
6. 验证码仅对授权题目用局部截图供当前模型识别；失败记录阻塞并在本 Step 内转向有效方法，不依赖人工接管或承诺通用通过。Step 完成、结论证据充分或阻塞无法自行解除时，保存进展、尝试限制和阻塞，调用 finish_step；Step 结束不代表 Goal/Subgoal 达成。`)
  + (activity === 'execute' && jevChoice ? '当同一目标有两个以上真实可用的扫描器、PoC、字典或搜索来源，且选错会明显浪费时间时，可调用 jev_choose 比较。' : '')
  + (activity === 'execute' && jevReadiness ? '拟采用攻击路径但关键前置条件不明时，可调用 jev_assess_attack 评估已确认事实的支持程度。' : '')
  + (activity === 'execute' && (jevChoice || jevReadiness) ? 'Jev 只给建议，按原始证据自行决定和验证，避免为简单选择额外调用。' : '')

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
    sourceIds: step.sourceIds, requires: step.requires, plugins: step.plugins ?? [], executionProfile: step.executionProfile,
    planVersion: step.planVersion ?? 1, boundStepVersion: run.boundStepVersion ?? 1, goals })}`
}

export function launchContext(store: Store, runId: string, channels: unknown[] = []) {
  const run = store.run(runId), origin = store.node<Fact>(run.projectId, 'origin', 'fact')
  const includeHints = run.activity === 'decide' || !!run.stepId && store.node<Step>(run.projectId, run.stepId, 'step').bootstrap
  const hints = includeHints ? store.db.prepare(`SELECT data FROM nodes WHERE project_id=? AND kind='hint'
    AND COALESCE(json_extract(data,'$.deleted'),0)=0
    AND (?=1 OR json_extract(data,'$.stepId') IS NULL OR json_extract(data,'$.stepId')=?) ORDER BY rowid LIMIT 9`)
    .all(run.projectId, run.activity === 'decide' ? 1 : 0, run.stepId).map(row => JSON.parse(String(row.data)) as Input) : []
  const goal = run.activity === 'decide' ? store.node<Goal>(run.projectId, 'goal', 'goal') : undefined
  return { projectId: run.projectId, scope: { id: origin.id, description: origin.description },
    ...(goal ? { goal: { id: goal.id, description: goal.description, status: goal.status },
      evidenceSeq: run.planningEvidenceSeq ?? 0, hintSeq: run.planningHintSeq ?? 0, criticalSeq: run.planningCriticalSeq ?? 0, graphCursor: run.deliveredGraphCursor ?? 0,
      instruction: '用 read_graph 读取活跃 FGS，按已有游标读取连续增量后规划。' } : {}),
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
  const step = run?.stepId ? store.node<Step>(projectId, run.stepId, 'step') : undefined
  const stopped = project.status !== 'active' || !!run && (run.status !== 'running' || !!step && (step.status !== 'running' || store.node<Goal>(projectId, step.goalId, 'goal').status !== 'open'))
  const planVersion = step?.planVersion ?? 1, boundStepVersion = run?.boundStepVersion ?? 1
  const planChanged = !stopped && !!step && planVersion !== boundStepVersion
  let relevant = false, evidenceSeq = 0, hintSeq = 0, criticalSeq = 0, omitted = false
  const after = cursor, counts: Record<string, number> = {}
  const nodeIds = new Set<string>()
  for (;;) {
    const events = store.events(projectId, cursor)
    cursor = events.at(-1)?.id ?? cursor
    for (const e of events) {
      const payload = e.payload as unknown as { stepId?: string | null; evidenceSeq?: number; hintSeq?: number; nodeSnapshot?: { stepId?: string | null } }
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
    if (events.length < 500) return { after, cursor, relevant: !stopped && relevant, evidenceSeq, hintSeq, criticalSeq, planChanged, stopped,
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
