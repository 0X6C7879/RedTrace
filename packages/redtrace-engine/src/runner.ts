import { Type } from 'typebox'
import type { TSchema, Static } from 'typebox'
import type { AgentTool, AgentToolResult } from './tool-types.ts'
import { readFile, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createHash } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { recordBenchmarkSubmission, tsecbenchQuery } from './benchmark.ts'
import type { Store } from './store.ts'
import type { TaskContext } from './scheduler.ts'
import type { EngineConfig, Fact, Json, Step, Project, Run, Goal, Input } from './types.ts'
import { ProjectEvidence } from './project-evidence.ts'
import { legionTools } from './legion-tools.ts'
import { legionMission } from './legion-missions.ts'
import { CommanderTodos, taskTodoOwner } from './legion-todos.ts'
import { knowledgeTools } from './knowledge.ts'
import { httpTools } from './http-tools.ts'
import { Check } from 'typebox/value'
import { HttpError } from './types.ts'
import { nodeContent } from './graph-content.ts'
import { reporterTools } from './reporter.ts'

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value))
const result = (value: unknown, terminate = false): AgentToolResult<unknown> => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(terminate ? { terminate: true } : {}) })
function tool<T extends TSchema>(name: string, description: string, parameters: T, execute: (args: Static<T>, signal?: AbortSignal) => unknown | Promise<unknown>, terminate = false): AgentTool<T> {
  return { name, label: name, description, parameters, executionMode: 'sequential', execute: async (_id, args, signal) => result(await execute(args, signal), terminate) }
}
export function efficiencyToolAvailable(context: TaskContext, name: string) {
  const plugin = name.startsWith('knowledge_') ? 'redtrace-knowledge' : name.startsWith('http_') ? 'redtrace-http' : undefined
  return !plugin || !context.featureAvailable || context.featureAvailable(plugin)
}

export function graphTools(context: TaskContext, finish: () => void): AgentTool[] {
  const { run, worker, config, signal } = context
  const store = run.graphId ? context.store.forGraph(run.projectId,run.graphId) : context.store.forProject(run.projectId)
  if (run.activity !== 'execute') throw new HttpError(410, 'Independent Reason execution was replaced by Commander')
  const maxSteps = () => context.currentMaxSteps ? context.currentMaxSteps() : config.maxSteps ?? null
  const evidenceRoot = path.join(run.workspaceRoot ?? path.join(config.workspaceRoot ?? path.join(os.tmpdir(), 'redtrace-workspaces'), run.projectId), '.redtrace-output', 'evidence')
  const installRoot = config.workspaceRoot ? path.dirname(config.workspaceRoot) : undefined
  const step = run.stepId ? store.node<Step>(run.projectId, run.stepId, 'step') : undefined
  const kinds = ['fact', 'goal', 'step', 'finding', 'hint', 'observation'] as const
  const readGraph = tool('read_graph', 'Sapper graph/show/doc: without id read only titles, folding supporting Facts under Findings except active Step dependencies. With id read a summary and linked Fact summaries; detail=doc returns full document/evidence references for project_evidence_read. Hints and observations are unverified. SQL pagination is bounded.', Type.Object({ id: Type.Optional(Type.String()), detail: Type.Optional(Type.Union([Type.Literal('summary'), Type.Literal('doc')])), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })), kinds: Type.Optional(Type.Array(Type.Union(kinds.map(k => Type.Literal(k))), { uniqueItems: true })) }, { additionalProperties: false }), async args => {
    if (args.id) return { ...store.readNode(run.projectId, args.id, args.detail), planningCapacity: store.planningCapacity(run.projectId, maxSteps()), acknowledgementBoundary: store.acknowledgementBoundary(run.id) }
    const offset = args.offset ?? 0, limit = args.limit ?? 100, selected = new Set(args.kinds ?? kinds)
    const project = store.project(run.projectId), page: Record<string, unknown> = { project, graph:run.graphId?store.projectGraph(run.projectId,run.graphId):null, facts: [], goals: [], steps: [], findings: [], hints: [], observations: [] }, nextOffsets: Record<string, number | null> = {}
    for (const kind of kinds) {
      if (!selected.has(kind)) continue
      page[kind === 'fact' ? 'facts' : kind === 'goal' ? 'goals' : kind === 'step' ? 'steps' : kind === 'finding' ? 'findings' : `${kind}s`] = store.nodes(run.projectId, [kind], { offset, limit, context: true }).map(node => nodeContent(node))
      const total = store.nodeCount(run.projectId, kind, true)
      nextOffsets[kind] = offset + limit < total ? offset + limit : null
    }
    const remaining = Object.values(nextOffsets).filter((value): value is number => value !== null)
    return { ...page, planningCapacity: store.planningCapacity(run.projectId, maxSteps()), acknowledgementBoundary: store.acknowledgementBoundary(run.id), nextOffset: remaining.length ? Math.max(...remaining) : null, nextOffsets }
  })
  const refs = Type.Array(Type.String())
  const reporting = step?.role === 'reporter'
  const tools: AgentTool[] = [readGraph, ...(!reporting && step?.role ? legionTools(store, run.id, run.projectId, maxSteps(), finish, config) : [])]
  tools.push(tool('project_evidence_read', 'Read hash-verified Project evidence independently of the producer Run or Session. Artifact IDs are Project-scoped. Binary pages return encoding=base64; decode content accordingly.', Type.Object({ artifact_id: Type.String({ pattern: '^artifact-[a-f0-9]{64}$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 7600 })) }), args => new ProjectEvidence(store, config.workspaceRoot).read(run.projectId, args.artifact_id, args.offset, args.length)))
  tools.push(tool('read_graph_delta', 'Read a bounded page of change metadata and current node titles. Historical Facts remain readable by ID. Continue with cursor until hasMore is false. Reading does not acknowledge processing.', Type.Object({ after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), args => ({ ...store.graphDelta(run.projectId, args.after ?? store.run(run.id).deliveredGraphCursor ?? 0, args.limit ?? 100, run.id), planningCapacity: store.planningCapacity(run.projectId, maxSteps()), acknowledgementBoundary: store.acknowledgementBoundary(run.id) })))
  tools.push({ name: 'evidence_read', label: 'evidence_read', description: 'Read at most 7.6 KiB from a large tool result by byte offset, 1-based line, or keyword. Artifacts are scoped to this Project; pass run_id for another producer Run; request the next bounded slice when needed.', parameters: Type.Object({ run_id: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })), id: Type.String({ pattern: '^ev-[a-f0-9]{64}$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })), line: Type.Optional(Type.Integer({ minimum: 1 })), query: Type.Optional(Type.String({ minLength: 1, maxLength: 300 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 7600 })) }), executionMode: 'sequential', execute: async (_toolId: string, args: { run_id?: string; id: string; offset?: number; line?: number; query?: string; length?: number }) => {
    if (!/^ev-[a-f0-9]{64}$/.test(args.id) || [args.offset, args.line, args.query].filter(value => value !== undefined).length > 1) throw new Error('Provide a valid evidence ID and only one read selector')
    const producer = store.run(args.run_id ?? run.id)
    if (producer.projectId !== run.projectId || producer.graphId !== run.graphId) throw new Error('Evidence producer belongs to another Project')
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
  tools.push(...reporterTools({ ...context, store }, finish).filter(t => reporting || t.name === 'read_execution'))
  if (!reporting) {

    tools.push(tool('sync_step', 'Adopt the latest Step contract at a safe boundary. Read current planVersion first. Returns goals and active dependencies. Old call trees remain blocked; generate your next action from this contract.', Type.Object({ planVersion: Type.Integer({ minimum: 1 }) }), args => store.syncStep(run.id, args.planVersion)))
    tools.push(...httpTools(context))
    const benchmarkOrigin = store.scopeFact(run.projectId).description
    const benchmarkSkill = installRoot ? path.join(installRoot, 'skills', 'tsecbench-api') : ''
    if (/(?:tsecbench|tsec[\s-]*benchmark)/i.test(benchmarkOrigin) && existsSync(path.join(benchmarkSkill, 'SKILL.md')) && existsSync(path.join(benchmarkSkill, 'scripts', 'tsecbench.py'))) {
      tools.push(
        tool('tsecbench_list', 'Read challenge descriptions, progress and container state; no lifecycle operation.', Type.Object({}), (_args, abort) => tsecbenchQuery(config, ['list'], abort)),
        tool('tsecbench_submit', 'Submit one flag for the active authorized challenge and return the platform response. Does not create Facts; the Worker must verify the response and explicitly submit_fact for decision-relevant results. Tool arguments and results are retained verbatim in audit events.', Type.Object({ unique_code: Type.String({ minLength: 1, maxLength: 128 }), flag: Type.String({ minLength: 1, maxLength: 4096 }) }), async (args, abort) => {const response=await tsecbenchQuery(config, ['submit', args.unique_code, '--flag', args.flag], abort);recordBenchmarkSubmission(store,run.projectId,args.unique_code,response);return response}),
      )
    }
    tools.push(
      tool('submit_fact', 'Publish an incremental confirmed Fact: short title, one-sentence description, optional detailed Markdown doc with exact commands/output, evidence and constraints. Existing file paths are preserved immediately; never put a node ID in path. Keep Artifact/Run/Tool Call provenance. Urgent goal proof, cross-Step prerequisites and real blockers must not wait.', Type.Object({ title: Type.String({ minLength: 1 }), description: Type.String(), doc: Type.Optional(Type.String()), evidence: Type.Array(Type.Object({ description: Type.String(), path: Type.Optional(Type.String()), artifactId: Type.Optional(Type.String()), runId: Type.Optional(Type.String()), toolCallId: Type.Optional(Type.String()) })) }), args => {
        const storage = new ProjectEvidence(store, config.workspaceRoot)
        const evidence = args.evidence.map(source => {
          if (source.artifactId) storage.read(run.projectId, source.artifactId)
          return source.path ? { ...source, artifactId: storage.promoteFile(run.projectId, { ...source, runId: run.id }, run.workspaceRoot).id, runId: run.id } : source
        })
        const doc = args.doc ? { artifactId: storage.publish(run.projectId, Buffer.from(args.doc), { description: args.title+' — doc', runId: run.id }).id, description: args.title+' — doc', runId: run.id } : undefined
        return store.addFact(run.projectId, args.description, { title: args.title, doc, runId: run.id, evidence, creator: worker.name })
      }),
      tool('submit_finding', 'ARTEX report_finding: register only a vulnerability actually triggered and verified in this target, never version/CVE matches or guesses. title=name, type=vulnclass, description=summary; severity and affected assetIds plus supporting factIds. A separate Reporter Session writes the report; do not write it during Explore. New Findings reach Commander through FGS deltas.', Type.Object({ title: Type.String(), description: Type.String(), type: Type.String(), severity: Type.Union(['critical','high','medium','low'].map(v => Type.Literal(v))), assetIds: Type.Array(Type.String()), factIds: refs }), args => store.addFinding(run.projectId, { ...args, creator: worker.name, runId: run.id })),
      tool('finish_step', step?.bootstrap
        ? 'Finish this Soldier initial Mission only after publishing a confirmed Fact; Commander owns Goal acceptance.'
        : 'Finish this Step only after explicitly submitting at least one confirmed, evidence-backed Fact. Consolidate the result, including verified failures or blockers, then call finish_step; a text summary alone does not complete the Step.', Type.Object({ summary: Type.String(),...(store.project(run.projectId).mode==='benchmark'&&step?.role==='scout'?{difficulty:Type.Union(['easy','medium','hard','unclear'].map(v=>Type.Literal(v))),family:Type.Optional(Type.String({minLength:1}))}:{}) }), args => {
          const current = store.node<Step>(run.projectId, run.stepId!, 'step')
          if (!current.factIds.length) throw new Error('Legion Worker must submit at least one Fact before finishing')
          if(store.project(run.projectId).mode==='benchmark'&&current.role==='scout'){current.scoutVerdict={difficulty:args.difficulty as 'easy'|'medium'|'hard'|'unclear',...(args.family?{family:args.family as string}:{})};store.saveNode(current)}
          store.runEvent(run.id, 'step.summary', json(args)); finish(); return { saved: true }
        }, true),
    )
  }
  if (!reporting) tools.push(...knowledgeTools(evidenceRoot, context))
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

export const activityPrompt = (_activity: 'decide' | 'execute', step?: Step, mode: 'benchmark' | 'general' = 'benchmark', planner = true) => legionMission(step?.role ?? 'soldier', mode, planner) + (step ? '\nAssigned Project='+step.projectId+' Graph='+step.graphId+' taskKey='+step.taskKey+'. Read and write only this Graph.' : '') + (step?.specialist ? '\nSpecialist assignment (within existing authorized Scope): '+JSON.stringify(step.specialist) : '') + (step?.bootstrap && mode==='general' ? '\nInitial Mission: establish evidence for the supplied Goal as a Soldier. Commander owns planning and acceptance.' : '')

export function activityLimits(config: EngineConfig, activity: 'decide' | 'execute', step?: Step) {
  return config.taskLimits?.[activity==='decide'?'commander':step?.role==='reporter'?'soldier':step?.role??'soldier'] ?? {timeout:config.executeTimeout,concludeTimeout:config.concludeTimeout}
}

const livePlans = new WeakMap<Store, Map<string, { revision: number; bound: number; text: string }>>()
export function livePlan(store: Store, runId: string) {
  const run = store.run(runId)
  if (!run.stepId) return ''
  const revision = store.project(run.projectId).revision, bound = run.boundStepVersion ?? 1
  let cache = livePlans.get(store)
  if (!cache) { cache = new Map(); livePlans.set(store, cache) }
  const saved = cache.get(runId)
  if (saved?.revision === revision && saved.bound === bound) return saved.text
  const step = store.node<Step>(run.projectId, run.stepId, 'step'), goals = []
  let goalId: string | null = step.goalId
  while (goalId) {
    const goal: Goal = store.node<Goal>(run.projectId, goalId, 'goal')
    goals.push({ id: goal.id, description: goal.description, status: goal.status, version: goal.version ?? 1 })
    goalId = goal.parentId
  }
  const text = `当前执行契约（以本快照为准）：${JSON.stringify({ id: step.id, description: step.description, status: step.status,
    sourceIds: step.sourceIds, executionProfile: step.executionProfile,
    planVersion: step.planVersion ?? 1, boundStepVersion: run.boundStepVersion ?? 1, goals })}`
  cache.set(runId, { revision, bound, text }); if (cache.size > 128) cache.delete(cache.keys().next().value!)
  return text
}

export function launchContext(store: Store, runId: string, channels: unknown[] = [], maxSteps: number | null = null) {
  const run = store.run(runId)
  if(run.graphId)store=store.forGraph(run.projectId,run.graphId)
  const origin = store.node<Fact>(run.projectId, 'origin', 'fact')
  const step = run.stepId ? store.node<Step>(run.projectId, run.stepId, 'step') : undefined
  const includeHints = !!run.stepId
  const acknowledgedHintSeq = run.activity === 'decide' ? store.project(run.projectId).acknowledgedHintSeq ?? 0 : 0
  const hints = includeHints ? store.db.prepare(`SELECT n.data FROM nodes n JOIN events e
    ON e.project_id=n.project_id AND e.node_id=n.id AND e.type='hint.added'
    WHERE n.project_id=? AND (? IS NULL OR n.graph_id=?) AND n.kind='hint' AND COALESCE(json_extract(n.data,'$.deleted'),0)=0
    AND COALESCE(json_extract(e.data,'$.hintSeq'),1)>?
    AND (?=1 OR json_extract(n.data,'$.stepId') IS NULL OR json_extract(n.data,'$.stepId')=?) ORDER BY n.rowid LIMIT 9`)
    .all(run.projectId,run.graphId??null,run.graphId??null, acknowledgedHintSeq, run.activity === 'decide' ? 1 : 0, run.stepId).map(row => JSON.parse(String(row.data)) as Input) : []
  const goal = run.activity === 'decide' ? store.node<Goal>(run.projectId, 'goal', 'goal') : undefined
  return { projectId: run.projectId, graphId:run.graphId, ...(run.handoff ? {handoff:{confirmedState:run.handoff,predecessorRunId:run.predecessorRunId}} : {}), planningCapacity: store.planningCapacity(run.projectId, maxSteps), acknowledgementBoundary: store.acknowledgementBoundary(run.id), scope: { id: origin.id, description: origin.description },
    ...(step && store.project(run.projectId).mode==='benchmark' && taskTodoOwner(step,store) ? {planningTodos:new CommanderTodos(store,run.projectId).list(step.graphId!)} : {}),
    ...(step?.role === 'reporter' ? { reportTrigger: { tool: 'submit_finding', finding_id: step.sourceIds[0], finding: store.readNode(run.projectId, step.sourceIds[0]) } } : {}),
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
   const reporting = step?.role === 'reporter'
   const stopped = !(reporting ? ['active','completed'].includes(project.status) : project.status === 'active') || !!run && (run.status !== 'running' || !!step && (step.status !== 'running' || !reporting && store.node<Goal>(projectId, step.goalId, 'goal').status !== 'open'))
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
  if (run.stepId && store.node<Step>(run.projectId, run.stepId, 'step').role === 'reporter') throw new HttpError(409, 'Reporter requires a DSH Session; mock mode does not fabricate vulnerability reports')
  const graph = store.graph(run.projectId)
  if (run.activity !== 'execute') throw new HttpError(410,'Independent Reason execution was removed')
  {
    const fact = store.addFact(run.projectId, 'Mock verification completed', { runId: run.id, creator: 'mock', evidence: [{ description: 'Deterministic test runner; no external operation' }] })
    store.addFinding(run.projectId, { title: 'Mock result', description: 'Deterministic test result', factIds: [fact.id] })
  }
}
