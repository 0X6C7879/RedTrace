import { mountLegionContext } from './legion-context.mjs'
import { Type } from 'typebox'
import { body, queryNumber } from '../src/http.ts'
import { attachLegionMailbox, runCommander, createCommanderController, readCommanderLog } from './legion.mjs'
import {createHash, randomUUID} from 'node:crypto'
import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { watch, realpathSync } from 'node:fs'
import { createEngine } from '../src/index.ts'
import { createPlanGuard } from '../src/plan-guard.ts'
import { taskTodoOwner } from '../src/legion-todos.ts'
import { efficiencyToolAvailable, graphTools, activityPrompt, activityLimits, graphUpdate, livePlan, launchContext, runMock } from '../src/runner.ts'
import { verbTools, verbToolAvailable, channelsFor, resourceTools } from '../src/capability-verbs.ts'
import { PluginManager, registerPluginRoutes } from '../../redtrace-dsh/lib/plugins.js'
import { load, mount, repoRoot } from '../../redtrace-dsh/lib/loader.js'
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

export { providerProfiles } from '../src/models.ts'

export function mountActivityPrompt(scoped, store, run, step) {
  scoped.systemPrompt.section({ name: 'redtrace:fgs', order: 0, text: () => activityPrompt(run.activity, step, store.project(run.projectId).mode, !!step && taskTodoOwner(step)) })
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
  let commanderController
  const engine = await createEngine({ root, database: options.database, configuration: options.configuration, autoStart: false,
    // The gate is created before the manager exists; it only dereferences it
    // when a request or dispatch actually asks, long after boot settles.
    adapterAvailability: () => pluginId => manager.running(pluginId),
    probeModel: (config, worker, signal) => probeModel(ctx, engine.configuration, config, worker, signal),
    selectWorker: (worker, activity, step) => {
      const preset = step?.role === 'reporter' ? 'soldier' : step?.role ?? 'soldier'
      if (!state()?.presets.has(preset)) return undefined
      return worker
    },
    runTask: input => {
      const context = { ...input, featureAvailable: id => manager.availableForTask(id) }
      return context.run.backend === 'mock' ? runMock(context) : executeDsh(context)
    } })
  const runtime = { runtime: true, root, server: options.server, sessionRoot: path.join(managed, 'sessions'), skillsDir: path.join(managed, 'skills'), workspacesDir: engine.configuration.workspaceRoot,
    pluginsManifest: path.join(managed, 'plugins.json'), engineScheduler: { start() { engine.scheduler.start(); commanderController?.start() }, async close() { await commanderController?.close(); await engine.scheduler.close() } } }
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
  let profileRevision = '', profileSignature = '', watcher
  let refreshPending = Promise.resolve()
  const refresh = () => refreshPending = refreshPending.catch(() => {}).then(refreshProfiles)
  const refreshProfiles = async () => {
    const shared = state(), mcpConfigs = engine.capabilities.mcpConfigs()
    if (shared && mcpSignature(mcpConfigs) !== shared.mcpSignature) await shared.remountMcp?.(mcpConfigs)
    const { raw, revision, config, signature } = engine.configuration.resolvedSnapshot()
    if (signature === profileSignature) return
    const { providers } = providerProfiles(config)
    // File-watch delivery can lag; the model snapshot and scheduler must use the same revision.
    engine.scheduler.update(config)
    applyCommonEnv(config.commonEnv)
    const adapter = [...ctx.get('loader').entries()].find(entry => entry.options.id === 'llm-pi-ai')
    if (!adapter) throw new Error('DSH llm-pi-ai profile entry is missing')
    await adapter.fiber.await()
    await adapter.update({ config: { providers, polling: config.llmPolling, credentialSource: { root: engine.configuration.root, filename: engine.configuration.filename, revision } } })
    await adapter.fiber.await()
    if (shared) shared.snapshot = { revision, workers: config.workers.map(w => ({ ...w })), providers, env: {}, commonEnv: config.commonEnv, tasks: raw.tasks, mcpConfigs,
      limits: { maxWorkers: config.maxWorkers, maxProjectWorkers: config.maxProjectWorkers, maxRunningProjects: config.maxRunningProjects, interval: 0 } }
    profileRevision = revision; profileSignature = signature
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
    engine.scheduler.wake(); commanderController?.wake()
  })
  try {
    await manager.boot(); registerPluginRoutes(ctx, manager)
    commanderController = createCommanderController(ctx, engine,()=>!!state()?.presets.has('commander'))
    engine.deletion.stopRuntime=async id=>{await commanderController.stop(id);await engine.scheduler.stopProject(id)}
    if (manager.running('redtrace-scheduler')) commanderController.start()
    engine.router.add('GET', '/runtime/config', async () => { await refresh(); return state()?.snapshot ?? { revision: '', workers: [] } })
    engine.router.add('GET', '/v2/legion/session/events', c => readCommanderLog(ctx, engine, queryNumber(c.url, 'offset', 0), queryNumber(c.url, 'limit', 100, 1, 500), c.signal, c.url.searchParams.get('projectId')))
    engine.router.add('POST','/v2/legion/resume',async c=>{const b=await body(c.req,Type.Object({projectId:Type.String({minLength:1})}));engine.store.project(b.projectId);return commanderController.resume(b.projectId)})
    engine.router.add('POST','/v2/legion/pause',async c=>{const b=await body(c.req,Type.Object({projectId:Type.String({minLength:1})}));await commanderController.close(b.projectId);return new engine.legion.constructor(engine.store,b.projectId).board()})
    engine.router.add('POST','/v2/legion/deadline',async c=>{const input=await body(c.req,Type.Object({projectId:Type.String({minLength:1}),deadline:Type.Integer({minimum:1})}));return engine.legion.setDeadline(input.deadline,input.projectId)})
    engine.router.add('POST', '/v2/legion/command', async c => {
      const input = await body(c.req, Type.Object({projectId:Type.String({minLength:1}), worker: Type.String({ minLength: 1 }) }))
      const config = engine.configuration.resolvedSnapshot().config
      if(!state()?.presets.has('commander'))throw new Error('Commander preset is disabled')
      return runCommander(ctx, engine, config.workers.find(worker => worker.name === input.worker), AbortSignal.timeout(config.decideTimeout * 1000),input.projectId)
    })
    watcher = watch(path.dirname(engine.configuration.filename), (_event, filename) => {
      if (!filename || String(filename) === path.basename(engine.configuration.filename)) void refresh().catch(error => ctx.logger.warn(error))
    })
    ctx.effect(() => async () => { watcher.close(); await commanderController?.close(); await engine.close() })
  } catch (error) { watcher?.close(); await engine.close(); throw error }

  async function executeDsh(context) {
    await refresh()
    const { store, run, config, signal, worker } = context, shared = state()
    if (run.activity !== 'execute') throw new Error('Independent Reason execution was removed')
    if (!shared) throw new Error('Cordis domain service is unavailable')
    const step = run.stepId ? store.node(run.projectId, run.stepId, 'step') : undefined
    const reporting = step?.role === 'reporter'
    const task = { usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens, cacheWriteTokens: run.cacheWriteTokens }, type: step?.role ?? 'soldier', projectId: run.projectId, intentId: run.stepId ?? undefined,
      worker: worker.name, sessionId: run.id, runId: run.id, committed: false, notificationEpoch: randomUUID(), server: options.server, startedAt: Date.now(), executionProfile: step?.executionProfile ?? 'direct' }
    if (!shared.presets.has(reporting ? 'soldier' : task.type)) throw new Error(`Cordis task preset ${task.type} is disabled`)
    const cwd = run.workspaceRoot ?? path.join(config.workspaceRoot, run.projectId); await mkdir(cwd, { recursive: true })
    let finished = false, concludeOnly = false, handle, legionMailbox
    let refreshLiveTools = () => {}
    const tools = graphTools(context, () => {
      finished = true; task.committed = true
      if (handle) {
        const pending = pendingGraphNotice(handle.agent)
        if (pending) handle.agent.inbox.remove(pending.message.id)
      }
    })
    const model = config.providers[worker.provider].models.find(m => m.id === worker.model)
    const effort = await resolveReasoningEffort(ctx.get('llm'), { provider: worker.provider, model: worker.model, reasoning: model.reasoning ?? 'auto_max' })
    const checkpoint = store.run(run.id).checkpoint, resume = !!checkpoint?.sessionId
    if (resume && !await ctx.get('sessionPersistence').stat(SessionId(run.id))) throw new Error('Execute checkpoint session is missing; refusing a new session')
    const { sessionDir } = await load('vendor/deepseek-harness/packages/spill/spill-local/lib/index.js')
    const ownSpillRead = executionEvidenceReadGuard(sessionDir(path.join(runtime.sessionRoot, 'spill'), run.id), cwd)
    const setup = async scoped => {
      if (!reporting) {
        // Skills mount DSH-natively from the full managed skills root; the
        // agent discovers and loads them through the skill tool on demand.
        scoped = await mountExecutionTools(scoped, { task, cwd, sessionRoot: runtime.sessionRoot, skillsDir: runtime.skillsDir, toolsDir: path.join(repoRoot, 'tools'), available: id => manager.availableForTask(id),
          onRefresh: refresh => sessionRefresh.set(run.id, async () => { await refresh(); refreshLiveTools() }) })
      }
      if (reporting) scoped.tools.restrict({ allow: [] })
      else mountLegionContext(scoped,ctx,{store,legion:engine.legion,run,task,message})
      mountActivityPrompt(scoped, store, run, step)
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
      for (const t of [...tools.filter(t => !/^(?:knowledge_|http_)/.test(t.name)), ...(!reporting ? resourceTools(context, verbRuntime) : [])]) registerTool(t)
      const liveVerbs = !reporting ? verbTools(context, verbRuntime, step) : []
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
      if (event.type === 'assistant/chunk' && ['text-delta', 'reasoning-delta'].includes(data.chunk?.type)) {
        for (const projected of eventProjection(task, event)) store.changes.emit('audit', run.projectId, { ...projected, project_id: run.projectId, graph_id:run.graphId, run_id: run.id })
        return
      }
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
      if(event.type==='tool/result')engine.legion.settleHandoff(run.id)
    })
    const cancel = () => { task.cancelled = true; if (handle) { handle.agent.cancel({ kind: 'hook', reason: 'FGS activity paused or cancelled' }) } }
    const message = (text, metadata = {}) => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user', ...metadata } })
    const prompt = text => handle.agent.followup(message(text))
    // Mid-run graph notices enter the native Agent inbox.
    let cursor = store.run(run.id).deliveredGraphCursor ?? 0
    const steer = projectId => {
      if (projectId !== run.projectId || finished || concludeOnly || signal.aborted || !handle) return
      const update = graphUpdate(store, projectId, cursor, run.stepId, run.id, manager.running('redtrace-critical-events'))
      queueGraphNotice(handle.agent, update, message)
      cursor = update.cursor
    }
    const unlistenGraph = listenGraphChanges(store, run, steer)
    const wait = async seconds => {
      const timer = setTimeout(() => { task.concludeOnly = concludeOnly = true; handle.agent.cancel({ kind: 'hook', reason: 'Activity execution timeout' }) }, seconds * 1000)
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
       if (!reporting && step?.role) legionMailbox = attachLegionMailbox(ctx, engine.legion, { projectId: run.projectId, actor: run.id, sessionId: run.id, agent: handle.agent, message, closing: () => finished || signal.aborted })
      // Changes committed during activation remain in the event log until this scan.
      steer(run.projectId)
      const limits = activityLimits(config, run.activity, step)
      await wait(limits.timeout)
      if (!finished && !task.committed && !signal.aborted) {
        task.concludeOnly = concludeOnly = true
        prompt(reporting ? '已进入超时收尾。只根据已读取的真实证据完成本漏洞报告，缺失内容明确标注未提供或未验证，调用 update_finding_report 保存；不得重新探测或伪造证据。' : run.activity === 'execute'
          ? '已进入超时收尾，必须调用 submit_fact 提交至少一条已有证据支持的汇总结论，再调用 finish_step。题目未解决时保留容器；没有成功成果时如实提交已验证的失败、限制或阻塞，禁止伪造事实。'
          : '仅处理已交付的证据并调用 finish_decide，不再执行外部操作。')
        await wait(limits.concludeTimeout)
      }
      if (!finished && !task.committed && !signal.aborted) throw new Error(concludeOnly ? 'Activity ended without a structured completion' : 'Agent execution failed')
    } finally {
      signal.removeEventListener('abort', cancel); legionMailbox?.()
      try { if (handle) { cancel(); await handle.agent.whenIdle(); await ctx.get('sessions').flush(handle.agent.session); store.checkpoint(run.id, { sessionId: run.id }); await handle.dispose() } }
      finally { sessionRefresh.delete(run.id); unlisten(); unlistenGraph(); shared.tasks.delete(run.id) }
    }
  }
}
