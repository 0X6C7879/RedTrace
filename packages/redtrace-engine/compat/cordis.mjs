import {createHash, randomUUID} from 'node:crypto'
import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { watch, realpathSync } from 'node:fs'
import { createEngine } from '../src/index.ts'
import { createPlanGuard } from '../src/plan-guard.ts'
import { efficiencyToolAvailable, graphTools, activityPrompt, activityLimits, graphUpdate, livePlan, launchContext, runMock } from '../src/runner.ts'
import { isJevRecoveryPath, traceCall } from '../src/jev.ts'
import { verbTools, verbToolAvailable, channelsFor, resourceTools } from '../src/capability-verbs.ts'
import { PluginManager, registerPluginRoutes } from '../../redtrace-dsh/lib/plugins.js'
import { load, repoRoot } from '../../redtrace-dsh/lib/loader.js'
import { SESSION_QUERY_TOOLS } from '../../redtrace-dsh/lib/session-query.js'
import { mountExecutionTools } from '../../redtrace-dsh/lib/execution-tools.js'
import { activateAgent, resolveReasoningEffort } from '../../redtrace-dsh/lib/agent.js'
import { state } from '../../redtrace-dsh/lib/state.js'
import { TASK_PLUGINS } from '../../redtrace-dsh/lib/task-plugins.js'
import { apply as applyDomain, applyCommonEnv, mcpSignature } from '../../redtrace-dsh/lib/domain.js'
import { accumulateUsage, eventProjection } from '../../redtrace-dsh/lib/audit.js'
import { providerProfiles } from '../src/models.ts'
import { probeModel, admitToolImages } from './llm.mjs'

export const name = 'redtrace-node'
export const inject = ['webServer']
const json = value => JSON.parse(JSON.stringify(value))

export function reasonSpillGuard(directory, cwd) {
  return exec => {
    if (exec.name !== 'read') return undefined
    try {
      const root = realpathSync(directory), file = realpathSync(path.resolve(cwd, exec.arguments.file_path))
      const relative = path.relative(root, file)
      if (relative && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)) return undefined
    } catch { /* Missing or inaccessible spill files are denied. */ }
    return 'Reason may read only its own spilled tool results'
  }
}

export { providerProfiles } from '../src/models.ts'

export async function filterDshJevResult(jev, run, cwd, exec, result, decision) {
  if (!jev?.isEnabled('tool_filter') && !jev?.isEnabled('external_filter')) return decision
  if (decision.kind !== 'accept' || result.isError || Object.hasOwn(decision, 'value')) return decision
  let args = exec.arguments ?? {}
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return decision } }
  const name = String(exec.name ?? ''), content = decision.content ?? result.content
  if (!Array.isArray(content) || !content.every(block => block?.type === 'text' && typeof block.text === 'string')) return decision
  const text = content.map(block => block.text).join('\n')
  if (Buffer.byteLength(text, 'utf8') <= 8 * 1024) return decision
  let source = '', external = false
  if (name === 'read') {
    source = String(args.file_path ?? '')
    if (!/\.(?:txt|md|log|rst|html)$/i.test(source)) return decision
    let resolved, workspace, poc
    try {
      resolved = await realpath(path.resolve(cwd, source)); workspace = await realpath(cwd)
      if (!(resolved === workspace || resolved.startsWith(workspace + path.sep))) {
        try { poc = await realpath(process.env.REDTRACE_POC_DIR ?? path.join(repoRoot, 'tools', 'poc')) } catch { poc = undefined }
      }
    } catch { return decision }
    if (isJevRecoveryPath(resolved)) return decision
    if (!['.txt', '.md', '.log', '.rst', '.html'].includes(path.extname(resolved).toLowerCase())) return decision
    external = !!poc && (resolved === poc || resolved.startsWith(poc + path.sep))
    if (!external && resolved !== workspace && !resolved.startsWith(workspace + path.sep)) return decision
  } else if (name === 'web_search' || name === 'web_fetch') {
    source = name === 'web_search' ? (Array.isArray(args.queries) ? args.queries.join(', ') : name) : String(args.url ?? name)
    external = true
  } else if (name === 'bash' || name === 'grep' || name === 'terminal_read') {
    source = String(args.command ?? args.pattern ?? args.id ?? args.session_id ?? name)
  } else return decision
  const filtered = await jev.filterToolText(run, source, text, external).catch(() => undefined)
  return filtered ? { kind: 'accept', content: [{ type: 'text', text: filtered }], ...(decision.additionalContexts ? { additionalContexts: decision.additionalContexts } : {}) } : decision
}

export async function rankDshWebResult(jev, run, exec, result, decision) {
  if (!jev?.isEnabled('candidate_choice') || exec.name !== 'web_search' || decision.kind !== 'accept' || result.isError || Object.hasOwn(decision, 'value')) return decision
  const sources = result.value?.sources
  if (!Array.isArray(sources) || sources.length < 2) return decision
  let args = exec.arguments ?? {}
  if (typeof args === 'string') { try { args = JSON.parse(args) } catch { return decision } }
  const candidates = sources.slice(0, 8).map((source, index) => ({ id: `source_${index + 1}`, title: String(source.title || source.url || '').slice(0, 160),
    detail: String(source.snippet || '').slice(0, 500), reference: String(source.url || '') }))
  const objective = Array.isArray(args.queries) ? args.queries.join('; ').slice(0, 600) : String(args.query || '').slice(0, 600)
  if (!objective) return decision
  const advice = await jev.chooseCandidate(run, 'web', objective, candidates, [], true).catch(() => undefined)
  if (advice?.status !== 'advisory') return decision
  const selected = candidates.find(item => item.id === advice.recommendedId)
  const note = selected ? `Jev 来源匹配建议：先读 ${selected.id} (${selected.reference})。选择置信度 ${advice.confidence.toFixed(2)}；仍需核实原文。`
    : 'Jev 来源匹配建议：当前结果没有明显优先来源；请自行核实。'
  return { ...decision, content: [...(decision.content ?? result.content ?? []), { type: 'text', text: note }] }
}

export function mountJevPrompt(scoped, run, step, jev) {
  scoped.systemPrompt.section({ name: 'redtrace:fgs', order: 0, text: () => activityPrompt(run.activity, step, jev?.isEnabled('candidate_choice'), jev?.isEnabled('attack_readiness')) })
  if (run.activity === 'execute') scoped.systemPrompt.section({ name: 'redtrace:jev-skill', order: 1,
    text: () => jev?.isEnabled('candidate_choice') || jev?.isEnabled('attack_readiness')
      ? '同一目标出现多个真实可用候选且选择代价明显时，按需加载 jev-decision Skill，再调用 Jev 决策工具；简单选择无需加载。typesafe-ai Skill 用于开发 TypeSafe 集成，不是执行渗透所必需。' : '' })
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
    native = message(`${exploreNoticePrefix}${JSON.stringify(notice)}`)
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
  const instruction = `${combined.evidenceSeq ? '新增确认的 Fact/Finding。' : '共享 FGS 已更新。'}${combined.criticalSeq ? '运行时已验证新的关键状态变化（可能包含能力失效）。' : ''}`
    + (combined.planChanged ? `当前 Step planVersion=${combined.planVersion}，boundStepVersion=${combined.boundStepVersion}。读取最新契约后在安全边界 sync_step；旧调用树不能继续执行。` : '')
    + '从已有连续游标用 read_graph_delta 读取变更；省略的节点仍在完整增量中。读取不等于处理确认。'
  const next = message(`${noticePrefix}${JSON.stringify(combined)}\n${instruction}`)
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
  const { createUserMessage } = await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js')
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
      const selected = input.run.stepId ? input.store.node(input.run.projectId, input.run.stepId, 'step').plugins ?? [] : []
      for (const id of selected) if (!manager.taskPluginAllowed(id)) throw new Error(`task_plugin_disabled: ${id}; management policy forbids this Step's requested feature`)
      const context = { ...input, featureAvailable: id => manager.availableForTask(id, selected), taskPluginAllowed: id => manager.taskPluginAllowed(id) }
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
  let profileRevision = '', sceneRevision = '', watcher
  let refreshPending = Promise.resolve()
  const refresh = () => refreshPending = refreshPending.catch(() => {}).then(refreshProfiles)
  const refreshProfiles = async () => {
    const shared = state(), mcpConfigs = engine.capabilities.mcpConfigs()
    if (shared && mcpSignature(mcpConfigs) !== shared.mcpSignature) await shared.remountMcp?.(mcpConfigs)
    const { raw, revision } = engine.configuration.read()
    const nextScenes = JSON.stringify(raw.jev?.scenes ?? {})
    if (nextScenes !== sceneRevision) {
      engine.jev.setScenes(raw.jev?.scenes)
      sceneRevision = nextScenes
      await Promise.all([...sessionRefresh.values()].map(update => update()))
    }
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
    engine.jev.setEnabled(manager.running('redtrace-jev'))
    // The jev-decision skill only documents this plugin's tools: while the
    // plugin is stopped it must leave the catalog entirely, or every Execute
    // turn keeps paying its entry as prompt tokens.
    try { engine.capabilities.setEnabled('jev-decision', manager.running('redtrace-jev')) } catch (error) { ctx.logger.warn(error) }
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
    const { store, run, config, signal, worker, jev } = context, shared = state()
    if (!shared) throw new Error('Cordis domain service is unavailable')
    const step = run.stepId ? store.node(run.projectId, run.stepId, 'step') : undefined
    const task = { usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens, cacheWriteTokens: run.cacheWriteTokens }, type: run.activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore', projectId: run.projectId, intentId: run.stepId ?? undefined,
      worker: worker.name, sessionId: run.id, runId: run.id, committed: false, notificationEpoch: randomUUID(), server: options.server, startedAt: Date.now(), executionProfile: step?.executionProfile ?? 'direct', ...(step?.plugins?.length ? { plugins: step.plugins } : {}) }
    if (!shared.presets.has(task.type)) throw new Error(`Cordis task preset ${task.type} is disabled`)
    const cwd = path.join(config.workspaceRoot, run.projectId); await mkdir(cwd, { recursive: true })
    let finished = false, concludeOnly = false, handle, pendingSkillNotice = ''
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
    const ownSpillRead = reasonSpillGuard(sessionDir(path.join(runtime.sessionRoot, 'spill'), run.id), cwd)
    const setup = async scoped => {
      if (run.activity === 'decide') {
        scoped.tools.guard(ownSpillRead)
        scoped.systemPrompt.section({ name: 'redtrace:task-plugins', order: 3, text: 'Step.plugins 仅为对应 Step 的 Explore 装载；只能选择 allowed 插件。' })
        scoped.systemPrompt.context({ name: 'redtrace:task-plugins', order: 3, required: true, interpolate: false,
          text: () => TASK_PLUGINS.map(p => `${p.id}: ${p.description} (${manager.taskPluginAllowed(p.id) ? 'allowed' : 'disabled'})`).join('\n') })
      }
      if (run.activity === 'execute') {
        scoped.on('agent/pre-step', async (_payload, next) => {
          const decision = await next()
          return decision.kind === 'enter' ? { ...decision, messages: filterExploreNotices(store, run, decision.messages) } : decision
        })
        // Skills mount DSH-natively from the full managed skills root; the
        // agent discovers and loads them through the skill tool on demand.
        scoped = await mountExecutionTools(scoped, { task, cwd, skillsDir: runtime.skillsDir, toolsDir: path.join(repoRoot, 'tools'), available: id => manager.availableForTask(id, task.plugins), contextualAttempts: true,
          onRefresh: refresh => sessionRefresh.set(run.id, async () => { await refresh(); refreshLiveTools() }) })
        if (jev?.isEnabled('skill_suggestion')) void (async () => {
          try {
            const skills = await scoped.skills.list({ cwd, signal })
            const suggestion = await jev.suggestSkill(run, step, skills)
            if (!suggestion || signal.aborted || !jev.isEnabled('skill_suggestion')) return
            const notice = `Jev Skill 建议（仅供参考，尚未加载）：${suggestion.name}。请判断它是否适合当前 Step，再决定是否使用。`
            if (handle) await prompt(notice); else pendingSkillNotice = notice
          } catch { /* Skill lookup and Jev are advisory; keep Execute available. */ }
        })()
        scoped.on('tools/post-execute', async (exec, result, next) => {
          const decision = await next()
          const filtered = await filterDshJevResult(jev, run, cwd, exec, result, decision)
          return rankDshWebResult(jev, run, exec, result, filtered)
        })
      }
      mountJevPrompt(scoped, run, step, jev)
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
          const result = await admitToolImages(ctx.get('attachments'), await t.execute(execution.callId ?? '', args, execution.signal))
          if (result.terminate) execution.concludeTurn?.()
          return result
        } })
      for (const t of [...tools.filter(t => !t.name.startsWith('jev_') && !/^(?:knowledge_|web_|http_batch$)/.test(t.name)), ...(run.activity === 'execute' ? resourceTools(context, verbRuntime) : [])]) registerTool(t)
      const liveVerbs = run.activity === 'execute' ? verbTools(context, verbRuntime, step) : []
      const refreshJevTools = refreshToolRegistrations(tools.filter(t => t.name.startsWith('jev_')),
        t => jev?.isEnabled(t.name === 'jev_choose' ? 'candidate_choice' : 'attack_readiness'), registerTool)
      const refreshEfficiencyTools = refreshToolRegistrations(tools.filter(t => /^(?:knowledge_|web_|http_batch$)/.test(t.name)), t => efficiencyToolAvailable(context, t.name), registerTool)
      const refreshVerbTools = refreshToolRegistrations(liveVerbs, t => verbToolAvailable(verbRuntime, t.name), registerTool)
      refreshLiveTools = () => {
        refreshJevTools()
        refreshVerbTools()
        refreshEfficiencyTools()
      }
      refreshLiveTools()
      // The conclude phase cuts non-graph tools at execution time: a
      // restriction cannot, because the DSH capability stack registers the
      // session tools in this scope's own layer, which restrictions never
      // filter. The guard enforces the same-session conclude boundary.
      const graphNames = new Set(tools.map(t => t.name))
      scoped.tools.guard(exec => concludeOnly && !graphNames.has(exec.name) && (exec.name !== 'read' || ownSpillRead(exec) !== undefined) ? 'Execution timed out; only summarize and submit existing evidence'
        : (exec.name === 'jev_choose' && !jev?.isEnabled('candidate_choice') || exec.name === 'jev_assess_attack' && !jev?.isEnabled('attack_readiness')) ? 'Jev plugin is disabled'
          : !verbToolAvailable(verbRuntime, exec.name) ? 'Capability adapter is disabled' : undefined)
      // Native read is guarded above; other global capabilities stay masked.
      if (run.activity === 'decide') scoped.tools.restrict({ allow: ['read', ...SESSION_QUERY_TOOLS] })
    }
    const traceWindow = [], tracePending = new Map()
    const unlisten = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== run.id) return
      const data = event.data ?? {}
      if (event.type === 'user/message') { const notice = exploreNotice(data); if (notice) auditNotice(store, notice, 'admitted') }
      if (event.type === 'step/start') store.metricStart(run.id, `model-${data.turn}-${data.step}`, 'model')
      if (event.type === 'assistant/message' || event.type === 'step/end') store.metricEnd(run.id, `model-${data.turn}-${data.step}`)
      if (jev?.isEnabled('trace_observer')) {
        if (event.type === 'tool/call' && data.callId) tracePending.set(String(data.callId), {
          name: String(data.name ?? 'unknown'), args: data.arguments, revision: store.project(run.projectId).revision,
        })
        if (event.type === 'tool/result' && data.message?.source?.callId) {
          const id = String(data.message.source.callId), prior = tracePending.get(id)
          tracePending.delete(id)
          if (prior) traceWindow.push(traceCall(prior.name, prior.args, data.message.content,
            Boolean(data.message.isError), store.project(run.projectId).revision !== prior.revision))
          if (traceWindow.length >= 10) {
            const recent = traceWindow.splice(0, 10)
            void jev.observeTrace(run, step, recent).then(stalled => stalled && !signal.aborted && jev.isEnabled('trace_observer')
              ? prompt('Jev 提醒：最近一组工具调用可能在重复工作或偏离当前 Step。请检查已有证据与目标，再决定下一步。') : undefined).catch(() => {})
          }
        }
      }
      store.transaction(() => {
        // DSH's projected tool/call is the canonical audit row. The lifecycle
        // tracker still owns pendingTools, but must not emit a second started
        // row through Store.runEvent.
        if (event.type === 'tool/call' && data.callId) {
          const notice = store.toolStarted(run.id, String(data.callId), json(data), false, manager.running('redtrace-repeat-reminder'),createHash('sha256').update(JSON.stringify(config.commonEnv ?? {})).digest('hex'))
          if (notice && handle) handle.agent.inject(message(notice))
        }
        if (event.type === 'tool/result' && data.message?.source?.callId) store.toolEnded(run.id, String(data.message.source.callId), json(data))
        accumulateUsage(task, event)
        if (task.usage) { const current = store.run(run.id); Object.assign(current, task.usage); store.saveRun(current) }
        const metadata = JSON.parse(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id).data)
        store.audit(metadata, json(eventProjection(task, event)))
      })
    })
    const cancel = () => { task.cancelled = true; if (handle) { pruneExploreNotices(store, run, handle.agent, 'cancelled'); handle.agent.cancel({ kind: 'hook', reason: 'FGS activity paused or cancelled' }) } }
    const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
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
        step?.requires?.length ? channelsFor(verbRuntime, step.requires, 8, run.projectId) : [])))
      // Changes committed during activation remain in the event log until this scan.
      steer(run.projectId)
      if (pendingSkillNotice && jev?.isEnabled('skill_suggestion')) void prompt(pendingSkillNotice).catch(() => {})
      pendingSkillNotice = ''
      const limits = activityLimits(config, run.activity, step)
      await wait(limits.timeout)
      if (!finished && !task.committed && !signal.aborted) {
        task.concludeOnly = concludeOnly = true
        prompt('仅提交已有证据并调用结束工具，不再执行外部操作。'); await wait(limits.concludeTimeout)
      }
      if (!finished && !task.committed && !signal.aborted) throw new Error(concludeOnly ? 'Activity ended without a structured completion' : 'Agent execution failed')
    } finally {
      signal.removeEventListener('abort', cancel)
      try { if (handle) { cancel(); await handle.agent.whenIdle(); await ctx.get('sessions').flush(handle.agent.session); store.checkpoint(run.id, { sessionId: run.id }); await handle.dispose() } }
      finally { sessionRefresh.delete(run.id); unlisten(); unlistenGraph(); shared.tasks.delete(run.id) }
    }
  }
}
