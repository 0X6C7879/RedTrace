import {createHash, randomUUID} from 'node:crypto'
import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { watch, realpathSync } from 'node:fs'
import { createEngine } from '../src/index.ts'
import { createPlanGuard } from '../src/plan-guard.ts'
import { efficiencyToolAvailable, graphTools, activityPrompt, activityLimits, graphUpdate, livePlan, launchContext, runMock } from '../src/runner.ts'
import { verbTools, verbToolAvailable, channelsFor, resourceTools } from '../src/capability-verbs.ts'
import { PluginManager, registerPluginRoutes } from '../../redtrace-dsh/lib/plugins.js'
import { load, mount, repoRoot } from '../../redtrace-dsh/lib/loader.js'
import { SESSION_QUERY_TOOLS } from '../../redtrace-dsh/lib/session-query.js'
import { mountExecutionTools } from '../../redtrace-dsh/lib/execution-tools.js'
import { activateAgent, resolveReasoningEffort } from '../../redtrace-dsh/lib/agent.js'
import { state } from '../../redtrace-dsh/lib/state.js'
import { apply as applyDomain, applyCommonEnv, mcpSignature } from '../../redtrace-dsh/lib/domain.js'
import { accumulateUsage, eventProjection } from '../../redtrace-dsh/lib/audit.js'
import { providerProfiles } from '../src/models.ts'
import { probeModel, admitToolImages } from './llm.mjs'

export const name = 'redtrace-node'
export const inject = ['webServer']
const json = value => JSON.parse(JSON.stringify(value))

export function executionEvidenceReadGuard(directory, cwd) {
  return exec => {
    if (exec.name !== 'read') return undefined
    try {
      const file = realpathSync(path.resolve(cwd, exec.arguments.file_path))
      for (const candidate of [directory, cwd]) {
        let root
        try { root = realpathSync(candidate) } catch { continue }
        const relative = path.relative(root, file)
        if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) continue
        if (relative.split(path.sep).some(part => /^(?:\.env(?:\..*)?|\.redtrace-secrets|\.redtrace|\.ssh|\.aws|\.credentials|secrets?)$/i.test(part))) continue
        return undefined
      }
    } catch { /* Missing files and symlink escapes are denied. */ }
    return 'Read only this Project’s evidence/outputs or own Spill; private credentials and foreign Projects are denied'
  }
}

export async function mountReasonTools(scoped) {
  scoped.tools.restrict({ allow: ['read', ...SESSION_QUERY_TOOLS] })
  await mount(scoped, 'packages/redtrace-dsh/lib/reason-read.js')
}

export { providerProfiles } from '../src/models.ts'

export function mountActivityPrompt(scoped, run, step) {
  scoped.systemPrompt.section({ name: 'redtrace:fgs', order: 0, text: () => activityPrompt(run.activity, step) })
}

export function refreshToolRegistrations(tools, enabled, register) {
  const active = new Map()
  return () => {
    for (const t of tools) {
      const live = enabled(t)
      if (live && !active.has(t.name)) active.set(t.name, register(t))
      if (!live && active.has(t.name)) { active.get(t.name)(); active.delete(t.name) }
    }
  }
}

const noticePrefix = '[RedTrace FGS] '
const exploreNoticePrefix = '[RedTrace Reason] '
const exploreNotice = message => {
  if (message.source?.redtraceExploreNotice) return message.source.redtraceExploreNotice
  const text = message.content?.[0]?.text
  if (!text?.startsWith(exploreNoticePrefix)) return undefined
  try { return JSON.parse(text.slice(exploreNoticePrefix.length)) } catch { return undefined }
}
const auditNotice = (store, notice, status, reason) => {
  const row = store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(notice.fromRunId)
  if (row) store.audit(JSON.parse(row.data), [{ event_uid: `explore-notice:${notice.notificationId}:${status}`,
    kind: `explore.notification.${status}`, timestamp: new Date().toISOString(), data: { ...notice, ...(reason ? { reason } : {}) } }])
}

const invalidExploreNotice = (store, run, notice) => {
  try {
    const current = store.run(run.id), step = store.node(run.projectId, run.stepId, 'step')
    if (store.project(run.projectId).status !== 'active' || current.status !== 'running' || step.status !== 'running' || step.deleted || step.replacedBy || store.node(run.projectId, step.goalId, 'goal').status !== 'open') return 'target_stopped'
    if ((step.planVersion ?? 1) !== notice.planVersion) return 'contract_changed'
    if (notice.sources.some(source => {
      const node = store.node(run.projectId, source.id)
      return node.deleted || node.lifecycle && node.lifecycle !== 'active' || (node.version ?? 1) !== source.version
    })) return 'source_changed'
  } catch { return 'target_or_source_missing' }
}

export function filterExploreNotices(store, run, messages) {
  return messages.filter(message => {
    const notice = exploreNotice(message), invalid = notice && invalidExploreNotice(store, run, notice)
    if (invalid) auditNotice(store, notice, 'discarded', invalid)
    return !invalid
  })
}

export function pruneExploreNotices(store, run, agent, reason) {
  for (const message of [...agent.inbox.nextStep]) {
    const notice = exploreNotice(message)
    if (!notice) continue
    const invalid = reason || invalidExploreNotice(store, run, notice)
    if (invalid && agent.inbox.remove(message.id)) auditNotice(store, notice, 'discarded', invalid)
  }
}

export function notifyExplore(context, shared, input, message) {
  const { store, run, signal } = context
  const reject = reason => ({ ok: false, status: 'rejected', reason })
  const fail = reason => ({ ok: false, status: 'failed', reason })
  if (run.activity !== 'decide' || signal.aborted) return reject('reason_not_running')
  let notice, agent, native
  try {
    if (store.run(run.id).status !== 'running') return reject('reason_not_running')
    if (store.project(run.projectId).status !== 'active') return reject('project_inactive')
    const text = typeof input.message === 'string' ? input.message.trim() : ''
    const ids = input.sourceIds ?? []
    if (!text || text.length > 2000 || !Array.isArray(ids) || ids.length > 16 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string' || !id.trim())) return reject('invalid_message_or_sources')
    const step = store.node(run.projectId, input.stepId, 'step')
    if (step.bootstrap || step.deleted || step.replacedBy || step.replacementPending || step.status !== 'running' || store.node(run.projectId, step.goalId, 'goal').status !== 'open') return reject('step_not_running')
    const targets = store.runsByStatus('running', run.projectId).filter(r => r.activity === 'execute' && r.stepId === step.id)
    if (targets.length !== 1) return reject('no_unique_running_target')
    const target = targets[0], task = shared?.tasks.get(target.id)
    if (!task || task.type !== 'explore' || task.projectId !== run.projectId || task.intentId !== step.id || task.runId !== target.id || task.sessionId !== target.id || task.committed || task.cancelled || task.concludeOnly) return reject('session_not_ready_or_closing')
    agent = task.handle?.agent
    if (!agent || String(agent.id) !== target.id || agent.status !== 'running') return reject('session_not_ready_or_idle')
    const sources = [...ids].sort().map(id => {
      const node = store.node(run.projectId, id)
      if (!['fact', 'finding'].includes(node.kind) || node.deleted || node.lifecycle && node.lifecycle !== 'active') throw new Error('invalid_source')
      return { id, version: node.version ?? 1 }
    })
    if (!task.notificationEpoch) return reject('session_not_ready')
    const planVersion = step.planVersion ?? 1
    const notificationId = createHash('sha256').update(JSON.stringify([run.projectId, target.id, task.notificationEpoch, planVersion, text, sources])).digest('hex')
    notice = { notificationId, fromRunId: run.id, projectId: run.projectId, stepId: step.id, runId: target.id, sessionId: task.sessionId, planVersion, sources, message: text }
    pruneExploreNotices(store, target, agent)
    const pending = agent.inbox.nextStep.map(exploreNotice).filter(Boolean)
    const response = { notificationId, stepId: step.id, runId: target.id, sessionId: task.sessionId }
    if (pending.some(n => n.notificationId === notificationId) || store.db.prepare('SELECT 1 FROM audit_events WHERE event_uid=?').get(`explore-notice:${notificationId}:queued`)) return { ok: true, status: 'duplicate', ...response }
    if (pending.length >= 8) return reject('queue_full')
    native = message(text, { redtraceExploreNotice: notice })
    // Native inject is synchronous and non-waking: no check-to-send await or cancellation.
    agent.inject(native)
    auditNotice(store, notice, 'queued')
    return { ok: true, status: 'queued', ...response }
  } catch (error) {
    if (notice && native && agent?.inbox.nextStep.some(m => m.id === native.id)) return fail('enqueue_or_audit_uncertain; do not automatically retry')
    const reason = error instanceof Error ? error.message : String(error)
    return error?.status === 404 || reason === 'invalid_source' ? reject(error?.status === 404 ? 'target_or_source_missing' : 'invalid_source') : fail(`delivery_failed: ${reason}`)
  }
}

const pendingGraphNotice = agent => {
  for (const message of agent.inbox.nextStep) {
    if (message.source?.redtraceGraphUpdate) return { message, update: message.source.redtraceGraphUpdate }
    const text = message.content?.[0]?.text
    if (!text?.startsWith(noticePrefix)) continue
    try { return { message, update: JSON.parse(text.split('\n')[0].slice(noticePrefix.length)) } } catch { /* Ignore unrelated or legacy messages. */ }
  }
}

export function queueGraphNotice(agent, update, message) {
  const pending = pendingGraphNotice(agent)
  if (update.stopped) { if (pending) agent.inbox.remove(pending.message.id); return false }
  if (!update.relevant) return false
  let combined = update
  if (pending) {
    const old = pending.update, nodeIds = [...new Set([...old.nodeIds, ...update.nodeIds])]
    const counts = { ...old.counts }
    for (const [type, count] of Object.entries(update.counts)) counts[type] = (counts[type] ?? 0) + count
    combined = { ...update, after: Math.min(old.after, update.after), cursor: Math.max(old.cursor, update.cursor), counts,
      evidenceSeq: Math.max(old.evidenceSeq, update.evidenceSeq), hintSeq: Math.max(old.hintSeq ?? 0, update.hintSeq ?? 0), criticalSeq: Math.max(old.criticalSeq, update.criticalSeq),
      nodeIds: nodeIds.slice(0, 16), omitted: old.omitted || update.omitted || nodeIds.length > 16, wake: old.wake || update.wake }
  }
  const instruction = combined.planChanged
    ? `当前 Step planVersion=${combined.planVersion}，boundStepVersion=${combined.boundStepVersion}。读取最新契约后在安全边界 sync_step；旧调用树不能继续执行。`
    : 'FGS 出现新的状态变化，请检查未处理的增量。'
  const next = message(instruction, { redtraceGraphUpdate: combined })
  if (pending && combined.wake && agent.status === 'idle') {
    if (!agent.inbox.remove(pending.message.id)) return queueGraphNotice(agent, update, message)
  }
  else if (pending) {
    if (agent.inbox.replace(pending.message.id, next)) return true
    return queueGraphNotice(agent, update, message)
  }
  if (combined.wake) agent.steer(next)
  else agent.inject(next)
  return true
}

export function listenGraphChanges(store, run, changed) {
  const event = run.stepId ? `step:${run.projectId}:${run.stepId}` : 'change'
  const listener = run.stepId ? () => changed(run.projectId) : changed
  store.changes.on(event, listener)
  return () => store.changes.off(event, listener)
}

export async function apply(ctx, options) {
  const root = path.resolve(options.root), managed = path.dirname(options.configuration)
  const { createUserMessage, HarnessError } = await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js')
  const { SessionId } = await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
  const engine = await createEngine({ root, database: options.database, configuration: options.configuration, autoStart: false,
    // The gate is created before the manager exists; it only dereferences it
    // when a request or dispatch actually asks, long after boot settles.
    adapterAvailability: () => pluginId => manager.running(pluginId),
    probeModel: (config, worker, signal) => probeModel(ctx, engine.configuration, config, worker, signal),
    selectWorker: (worker, activity, step) => {
      const preset = activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore'
      if (!state()?.presets.has(preset)) return undefined
      return worker
    },
    runTask: input => {
      const context = { ...input, featureAvailable: id => manager.availableForTask(id) }
      return context.run.backend === 'mock' ? runMock(context) : executeDsh(context)
    } })
  const runtime = { runtime: true, root, server: options.server, sessionRoot: path.join(managed, 'sessions'), skillsDir: path.join(managed, 'skills'), workspacesDir: engine.configuration.workspaceRoot,
    pluginsManifest: path.join(managed, 'plugins.json'), engineScheduler: engine.scheduler }
  // The repo-local security-asset map (wordlists / payloads / PoC references /
  // target-upload tunnel binaries) as stable env names every worker can use.
  // `??=` keeps a user-provided override; the names are neither credential-
  // shaped nor DSH_* so they survive the subprocess environment scrub.
  process.env.REDTRACE_TOOLS_DIR ??= path.join(repoRoot, 'tools')
  process.env.REDTRACE_TOOLS_BIN ??= path.join(repoRoot, 'tools', 'bin')
  process.env.REDTRACE_WORDLISTS_DIR ??= path.join(repoRoot, 'tools', 'wordlists')
  process.env.REDTRACE_PAYLOADS_DIR ??= path.join(repoRoot, 'tools', 'payloads')
  process.env.REDTRACE_POC_DIR ??= path.join(repoRoot, 'tools', 'poc')
  const verbRuntime = { operations: engine.operations, isAdapterAvailable: pluginId => manager.running(pluginId) }
  // The engine handler serves the Web UI and the whole API; the Cordis web
  // server only owns the plugin-manager routes and falls through to it.
  ctx.effect(() => ctx.webServer.registerFallback(engine.handler))
  let profileRevision = '', watcher
  let refreshPending = Promise.resolve()
  const refresh = () => refreshPending = refreshPending.catch(() => {}).then(refreshProfiles)
  const refreshProfiles = async () => {
    const shared = state(), mcpConfigs = engine.capabilities.mcpConfigs()
    if (shared && mcpSignature(mcpConfigs) !== shared.mcpSignature) await shared.remountMcp?.(mcpConfigs)
    const { raw, revision } = engine.configuration.read()
    if (revision === profileRevision) return
    const config = engine.configuration.resolve(raw), { providers } = providerProfiles(config)
    // File-watch delivery can lag; the model snapshot and scheduler must use the same revision.
    engine.scheduler.update(config)
    applyCommonEnv(config.commonEnv)
    const adapter = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'llm-pi-ai')
    if (!adapter) throw new Error('DSH llm-pi-ai profile entry is missing')
    await adapter.fiber.await()
    await adapter.update({ config: { providers, credentialSource: { root: engine.configuration.root, filename: engine.configuration.filename, revision } } })
    await adapter.fiber.await()
    if (shared) shared.snapshot = { revision, workers: config.workers.map(w => ({ ...w })), providers, env: {}, commonEnv: config.commonEnv, tasks: raw.tasks, mcpConfigs,
      limits: { maxWorkers: config.maxWorkers, maxProjectWorkers: config.maxProjectWorkers, maxRunningProjects: config.maxRunningProjects, interval: 0 } }
    profileRevision = revision
  }
  const replacements = {
    // The domain replacement merges fresh MCP configs and pulls the first
    // runtime snapshot during boot; everything else mounts for real.
    'redtrace-domain': { name: 'redtrace-domain', async apply(scoped) { await applyDomain(scoped, { ...runtime, mcpConfigs: engine.capabilities.mcpConfigs() }); await refresh() } },
  }
  const sessionRefresh = new Map()
  const manager = new PluginManager(ctx, runtime, repoRoot, load, replacements, async () => {
    await engine.operations.synchronizeAdapters()
    await Promise.all([...sessionRefresh.values()].map(refresh => refresh()))
    engine.scheduler.wake()
  })
  try {
    await manager.boot(); registerPluginRoutes(ctx, manager)
    engine.router.add('GET', '/runtime/config', async () => { await refresh(); return state()?.snapshot ?? { revision: '', workers: [] } })
    watcher = watch(path.dirname(engine.configuration.filename), (_event, filename) => {
      if (!filename || String(filename) === path.basename(engine.configuration.filename)) void refresh().catch(error => ctx.logger.warn(error))
    })
    ctx.effect(() => async () => { watcher.close(); await engine.close() })
  } catch (error) { watcher?.close(); await engine.close(); throw error }

  async function executeDsh(context) {
    await refresh()
    const { store, run, config, signal, worker } = context, shared = state()
    if (!shared) throw new Error('Cordis domain service is unavailable')
    const step = run.stepId ? store.node(run.projectId, run.stepId, 'step') : undefined
    const task = { usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens, cacheWriteTokens: run.cacheWriteTokens }, type: run.activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore', projectId: run.projectId, intentId: run.stepId ?? undefined,
      worker: worker.name, sessionId: run.id, runId: run.id, committed: false, notificationEpoch: randomUUID(), server: options.server, startedAt: Date.now(), executionProfile: step?.executionProfile ?? 'direct' }
    if (!shared.presets.has(task.type)) throw new Error(`Cordis task preset ${task.type} is disabled`)
    const cwd = path.join(config.workspaceRoot, run.projectId); await mkdir(cwd, { recursive: true })
    let finished = false, concludeOnly = false, handle
    let refreshLiveTools = () => {}
    const tools = graphTools({ ...context, notifyExplore: input => notifyExplore(context, shared, input, message) }, () => {
      finished = true; task.committed = true
      if (handle) {
        const pending = pendingGraphNotice(handle.agent)
        if (pending) handle.agent.inbox.remove(pending.message.id)
        pruneExploreNotices(store, run, handle.agent, 'completed')
      }
    })
    const model = config.providers[worker.provider].models.find(m => m.id === worker.model)
    const effort = await resolveReasoningEffort(ctx.get('llm'), { provider: worker.provider, model: worker.model, reasoning: model.reasoning ?? 'auto_max' })
    const checkpoint = store.run(run.id).checkpoint, resume = !!checkpoint?.sessionId
    if (resume && !await ctx.get('sessionPersistence').stat(SessionId(run.id))) throw new Error('Execute checkpoint session is missing; refusing a new session')
    const { sessionDir } = await load('vendor/deepseek-harness/packages/spill/spill-local/lib/index.js')
    const ownSpillRead = executionEvidenceReadGuard(sessionDir(path.join(runtime.sessionRoot, 'spill'), run.id), cwd)
    const setup = async scoped => {
      if (run.activity === 'decide') {
        await mountReasonTools(scoped)
      }
      if (run.activity === 'execute') {
        scoped.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          return decision.kind === 'enter' ? { ...decision, messages: filterExploreNotices(store, run, decision.messages) } : decision
        })
        // Skills mount DSH-natively from the full managed skills root; the
        // agent discovers and loads them through the skill tool on demand.
        scoped = await mountExecutionTools(scoped, { task, cwd, sessionRoot: runtime.sessionRoot, skillsDir: runtime.skillsDir, toolsDir: path.join(repoRoot, 'tools'), available: id => manager.availableForTask(id),
          onRefresh: refresh => sessionRefresh.set(run.id, async () => { await refresh(); refreshLiveTools() }) })
      }
      mountActivityPrompt(scoped, run, step)
      const planGuard = run.activity === 'execute' ? createPlanGuard(store, run.id) : undefined
      if (planGuard) {
        scoped.on('session/event', (session, event) => { if (String(session.id) === run.id && event.type === 'step/start') planGuard.beginTurn() })
        scoped.on('tools/result', exec => { if (!exec.parent) planGuard.settled(String(exec.rootCallId)) })
        // Native spill reads retain the existing archived-evidence recovery allowance.
        scoped.tools.guard(exec => planGuard.check({ name: exec.name === 'read' && ownSpillRead(exec) === undefined ? 'evidence_read' : exec.name, rootCallId: String(exec.rootCallId) }))
      }
      scoped.systemPrompt.context({ name: 'redtrace:live-plan', order: 2, required: true, interpolate: false,
        text: () => livePlan(store, run.id) })
      // The DSH tools runtime projects parameters as lossless JSON; the graph
      // and verb tools carry typebox symbol annotations, so detach them into
      // plain JSON Schema before registration.
      const registerTool = t => scoped.tools.register({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => value.content },
        async execute(args, execution) {
          if (finished || signal.aborted) throw new Error('Activity has stopped')
          const { Check } = await import('typebox/value')
          if (!Check(t.parameters, args)) throw new Error('Invalid tool arguments')
          const result = await admitToolImages(ctx.get('attachments'), await t.execute(execution.callId ?? '', args, execution.signal))
          if (result.isError) throw new HarnessError(result.content.filter(block => block.type === 'text').map(block => block.text).join('\n'), result.details?.context?.code ?? 'REDTRACE_TOOL_ERROR')
          if (result.terminate) execution.concludeTurn?.()
          return result
        } })
      for (const t of [...tools.filter(t => !/^(?:knowledge_|http_)/.test(t.name)), ...(run.activity === 'execute' ? resourceTools(context, verbRuntime) : [])]) registerTool(t)
      const liveVerbs = run.activity === 'execute' ? verbTools(context, verbRuntime, step) : []
      const refreshEfficiencyTools = refreshToolRegistrations(tools.filter(t => /^(?:knowledge_|http_)/.test(t.name)), t => efficiencyToolAvailable(context, t.name), registerTool)
      const refreshVerbTools = refreshToolRegistrations(liveVerbs, t => verbToolAvailable(verbRuntime, t.name), registerTool)
      refreshLiveTools = () => {
        refreshVerbTools()
        refreshEfficiencyTools()
      }
      refreshLiveTools()
      scoped.tools.guard(exec => !verbToolAvailable(verbRuntime, exec.name) ? 'Capability adapter is disabled' : undefined)
    }
    const unlisten = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== run.id) return
      const data = event.data ?? {}
      if (event.type === 'user/message') { const notice = exploreNotice(data); if (notice) auditNotice(store, notice, 'admitted') }
      if (event.type === 'step/start') store.metricStart(run.id, `model-${data.turn}-${data.step}`, 'model')
      if (event.type === 'assistant/message' || event.type === 'step/end') store.metricEnd(run.id, `model-${data.turn}-${data.step}`)
      store.transaction(() => {
        // DSH's projected tool/call is the canonical audit row. The lifecycle
        // tracker still owns pendingTools, but must not emit a second started
        // row through Store.runEvent.
        if (event.type === 'tool/call' && data.callId) {
          store.toolStarted(run.id, String(data.callId), json(data), false)
        }
        if (event.type === 'tool/result' && data.message?.source?.callId) store.toolEnded(run.id, String(data.message.source.callId), json(data))
        accumulateUsage(task, event)
        if (task.usage) { const current = store.run(run.id); Object.assign(current, task.usage); store.saveRun(current) }
        const metadata = JSON.parse(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id).data)
        store.audit(metadata, json(eventProjection(task, event)))
      })
    })
    const cancel = () => { task.cancelled = true; if (handle) { pruneExploreNotices(store, run, handle.agent, 'cancelled'); handle.agent.cancel({ kind: 'hook', reason: 'FGS activity paused or cancelled' }) } }
    const message = (text, metadata = {}) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', ...metadata } })
    const prompt = text => handle.agent.followup(message(text))
    // Mid-run graph notices enter the native Agent inbox.
    let cursor = store.run(run.id).deliveredGraphCursor ?? 0
    const steer = projectId => {
      if (projectId !== run.projectId || finished || concludeOnly || signal.aborted || !handle) return
      pruneExploreNotices(store, run, handle.agent)
      const update = graphUpdate(store, projectId, cursor, run.stepId, run.id, manager.running('redtrace-critical-events'))
      queueGraphNotice(handle.agent, update, message)
      cursor = update.cursor
    }
    const unlistenGraph = listenGraphChanges(store, run, steer)
    const wait = async seconds => {
      const timer = setTimeout(() => { task.concludeOnly = concludeOnly = true; pruneExploreNotices(store, run, handle.agent, 'timeout'); handle.agent.cancel({ kind: 'hook', reason: 'Activity execution timeout' }) }, seconds * 1000)
      try { await handle.agent.whenIdle() } finally { clearTimeout(timer) }
    }
    try {
      shared.tasks.set(run.id, task)
      handle = await activateAgent(ctx.get('agents'), SessionId(run.id), cwd, { agentOptions: { provider: worker.provider, model: worker.model, ...(effort ? { reasoningEffort: effort } : {}) }, setup }, resume)
      task.handle = handle
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) { cancel(); return }
      store.checkpoint(run.id, { sessionId: run.id })
      cursor = Math.max(cursor, pendingGraphNotice(handle.agent)?.update.cursor ?? 0)
      prompt(resume ? '继续' : JSON.stringify(launchContext(store, run.id,
        channelsFor(verbRuntime, [], 8, run.projectId), (context.currentMaxSteps ? context.currentMaxSteps() : config.maxSteps))))
      // Changes committed during activation remain in the event log until this scan.
      steer(run.projectId)
      const limits = activityLimits(config, run.activity, step)
      await wait(limits.timeout)
      if (!finished && !task.committed && !signal.aborted) {
        task.concludeOnly = concludeOnly = true
        prompt(run.activity === 'execute'
          ? '已进入超时收尾，必须调用 submit_fact 提交至少一条已有证据支持的汇总结论，再调用 finish_step。题目未解决时保留容器；没有成功成果时如实提交已验证的失败、限制或阻塞，禁止伪造事实。'
          : '仅处理已交付的证据并调用 finish_decide，不再执行外部操作。')
        await wait(limits.concludeTimeout)
      }
      if (!finished && !task.committed && !signal.aborted) throw new Error(concludeOnly ? 'Activity ended without a structured completion' : 'Agent execution failed')
    } finally {
      signal.removeEventListener('abort', cancel)
      try { if (handle) { cancel(); await handle.agent.whenIdle(); await ctx.get('sessions').flush(handle.agent.session); store.checkpoint(run.id, { sessionId: run.id }); await handle.dispose() } }
      finally { sessionRefresh.delete(run.id); unlisten(); unlistenGraph(); shared.tasks.delete(run.id) }
    }
  }
}
