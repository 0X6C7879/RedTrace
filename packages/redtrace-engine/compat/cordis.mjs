import path from 'node:path'
import { mkdir, realpath } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createEngine } from '../src/index.ts'
import { graphTools, activityPrompt, activityLimits, runPi, runMock } from '../src/runner.ts'
import { isJevRecoveryPath, traceCall } from '../src/jev.ts'
import { verbTools, verbToolAvailable, channelsFor, resourceTools } from '../src/capability-verbs.ts'
import { PluginManager, registerPluginRoutes } from '../../redtrace-dsh/lib/plugins.js'
import { load, repoRoot } from '../../redtrace-dsh/lib/loader.js'
import { mountExecutionTools } from '../../redtrace-dsh/lib/execution-tools.js'
import { activateAgent, resolveReasoningEffort } from '../../redtrace-dsh/lib/agent.js'
import { state } from '../../redtrace-dsh/lib/state.js'
import { apply as applyDomain, applyCommonEnv, mcpSignature } from '../../redtrace-dsh/lib/domain.js'
import { accumulateUsage, eventProjection } from '../../redtrace-dsh/lib/audit.js'

export const name = 'redtrace-node'
export const inject = ['webServer', 'settings']
const json = value => JSON.parse(JSON.stringify(value))

export function providerProfiles(config) {
  const providers = {}, env = {}
  for (const [name, p] of Object.entries(config.providers)) {
    const keyName = `REDTRACE_DSH_KEY_${Buffer.from(name).toString('hex').toUpperCase()}`
    const key = p.apiKey ?? process.env[p.apiKeyEnv]
    if (key) env[keyName] = key
    providers[name] = { displayName: name, api: p.api, baseURL: p.baseUrl.replace(/\/$/, ''), apiKeyEnv: keyName,
      models: p.models.map(m => ({ id: m.id, name: m.id, contextWindow: m.contextWindow, maxTokens: m.maxTokens,
        ...(m.reasoningEfforts == null ? {} : { reasoningEfforts: m.reasoningEfforts }),
        ...(p.api === 'openai-completions' && ['deepseek', 'openai'].includes(m.thinkingFormat) ? { compat: { thinkingFormat: m.thinkingFormat } } : {}) })) }
  }
  return { providers, env }
}

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

export async function apply(ctx, options) {
  const root = path.resolve(options.root), managed = path.dirname(options.configuration)
  const { createUserMessage } = await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js')
  const { SessionId } = await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
  const engine = await createEngine({ root, database: options.database, configuration: options.configuration, autoStart: false,
    // The gate is created before the manager exists; it only dereferences it
    // when a request or dispatch actually asks, long after boot settles.
    adapterAvailability: () => pluginId => manager.running(pluginId),
    selectWorker: (worker, activity, step) => {
      const preset = activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore'
      if (!state()?.presets.has(preset)) return undefined
      return worker.backend !== 'mock' && step?.executionProfile === 'isolated' ? { ...worker, backend: 'dsh' } : worker
    },
    runTask: context => context.run.backend === 'mock' ? runMock(context) : context.run.backend === 'pi' ? runPi(context, engine.capabilities, verbRuntime) : executeDsh(context) })
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
  let profileRevision = '', sceneRevision = '', providerKeys = new Set(), watcher
  const refresh = async () => {
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
    const config = engine.configuration.resolve(raw), { providers, env } = providerProfiles(config)
    for (const key of providerKeys) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env); providerKeys = new Set(Object.keys(env))
    applyCommonEnv(config.commonEnv)
    await ctx.get('settings').replace('llm-pi-ai', { providers })
    if (shared) shared.snapshot = { revision, workers: config.workers.map(w => ({ ...w })), providers, env, commonEnv: config.commonEnv, tasks: raw.tasks, mcpConfigs,
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
    await Promise.all([...sessionRefresh.values()].map(refresh => refresh()))
    engine.scheduler.wake()
  })
  try {
    await manager.boot(); registerPluginRoutes(ctx, manager)
    engine.router.add('GET', '/runtime/config', async () => { await refresh(); return state()?.snapshot ?? { revision: '', workers: [] } })
    watcher = watch(path.dirname(engine.configuration.filename), (_event, filename) => {
      if (!filename || String(filename) === path.basename(engine.configuration.filename)) void refresh().catch(error => ctx.logger.warn(error))
    })
    ctx.effect(() => async () => { watcher.close(); await engine.close(); for (const key of providerKeys) delete process.env[key] })
  } catch (error) { watcher?.close(); await engine.close(); throw error }

  async function executeDsh(context) {
    await refresh()
    const { store, run, config, signal, worker, jev } = context, shared = state()
    if (!shared) throw new Error('Cordis domain service is unavailable')
    const step = run.stepId ? store.node(run.projectId, run.stepId, 'step') : undefined
    const task = { usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens, cacheWriteTokens: run.cacheWriteTokens }, type: run.activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore', projectId: run.projectId, intentId: run.stepId ?? undefined,
      worker: worker.name, sessionId: run.id, runId: run.id, committed: false, server: options.server, startedAt: Date.now(), executionProfile: step?.executionProfile ?? 'direct' }
    if (!shared.presets.has(task.type)) throw new Error(`Cordis task preset ${task.type} is disabled`)
    const cwd = path.join(config.workspaceRoot, run.projectId); await mkdir(cwd, { recursive: true })
    let finished = false, concludeOnly = false, handle, pendingSkillNotice = ''
    let refreshLiveTools = () => {}
    const tools = graphTools(context, () => { finished = true; task.committed = true })
    const model = config.providers[worker.provider].models.find(m => m.id === worker.model)
    const effort = await resolveReasoningEffort(ctx.get('llm'), { provider: worker.provider, model: worker.model, reasoning: model.reasoning ?? 'auto_max' })
    const checkpoint = store.run(run.id).checkpoint, resume = !!checkpoint?.sessionId
    if (resume && !await ctx.get('sessionPersistence').readRaw(run.id)) throw new Error('Execute checkpoint session is missing; refusing a new session')
    const setup = async scoped => {
      if (run.activity === 'execute') {
        // Skills mount DSH-natively from the full managed skills root; the
        // agent discovers and loads them through the skill tool on demand.
        scoped = await mountExecutionTools(scoped, { task, cwd, skillsDir: runtime.skillsDir, toolsDir: path.join(repoRoot, 'tools'), available: id => manager.running(id),
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
      // The DSH tools runtime projects parameters as lossless JSON; the graph
      // and verb tools carry typebox symbol annotations, so detach them into
      // plain JSON Schema before registration.
      const registerTool = t => scoped.tools.register({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => value.content },
        async execute(args, execution) {
          if (finished || signal.aborted) throw new Error('Activity has stopped')
          const result = await t.execute(execution.callId ?? '', args, execution.signal)
          if (result.terminate) execution.concludeTurn?.()
          return result
        } })
      for (const t of [...tools.filter(t => !t.name.startsWith('jev_')), ...(run.activity === 'execute' ? resourceTools(context, verbRuntime) : [])]) registerTool(t)
      const liveVerbs = run.activity === 'execute' ? verbTools(context, verbRuntime, step) : []
      const refreshJevTools = refreshToolRegistrations(tools.filter(t => t.name.startsWith('jev_')),
        t => jev?.isEnabled(t.name === 'jev_choose' ? 'candidate_choice' : 'attack_readiness'), registerTool)
      const refreshVerbTools = refreshToolRegistrations(liveVerbs, t => verbToolAvailable(verbRuntime, t.name), registerTool)
      refreshLiveTools = () => {
        refreshJevTools()
        refreshVerbTools()
      }
      refreshLiveTools()
      // The conclude phase cuts non-graph tools at execution time: a
      // restriction cannot, because the DSH capability stack registers the
      // session tools in this scope's own layer, which restrictions never
      // filter. The guard mirrors the pi backend's conclude gate.
      const graphNames = new Set(tools.map(t => t.name))
      scoped.tools.guard(exec => concludeOnly && !graphNames.has(exec.name) ? 'Execution timed out; only summarize and submit existing evidence'
        : (exec.name === 'jev_choose' && !jev?.isEnabled('candidate_choice') || exec.name === 'jev_assess_attack' && !jev?.isEnabled('attack_readiness')) ? 'Jev plugin is disabled'
          : !verbToolAvailable(verbRuntime, exec.name) ? 'Capability adapter is disabled' : undefined)
      // Decide sees only its scoped graph tools: the tools runtime restricts
      // global names only, so an empty allow set masks every global tool
      // (webshell/c2 family) for this agent.
      if (run.activity === 'decide') scoped.tools.restrict({ allow: [] })
    }
    const traceWindow = [], tracePending = new Map()
    const unlisten = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== run.id) return
      const data = event.data ?? {}
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
        if (event.type === 'tool/call' && data.callId) store.toolStarted(run.id, String(data.callId), json(data), false)
        if (event.type === 'tool/result' && data.message?.source?.callId) store.toolEnded(run.id, String(data.message.source.callId), json(data))
        accumulateUsage(task, event)
        if (task.usage) { const current = store.run(run.id); Object.assign(current, task.usage); store.saveRun(current) }
        const metadata = JSON.parse(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id).data)
        store.audit(metadata, json(eventProjection(task, event)))
      })
    })
    const cancel = () => handle?.agent.cancel({ kind: 'hook', reason: 'FGS activity paused or cancelled' })
    const message = text => createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
    const prompt = text => handle.agent.followup(message(text))
    // Mid-run blackboard updates reach a running Execute the same way the pi backend steers it.
    let cursor = Number(store.db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM events WHERE project_id=?').get(run.projectId).value)
    const steer = projectId => {
      if (projectId !== run.projectId || run.activity !== 'execute' || finished || concludeOnly || !handle) return
      const events = store.events(projectId, cursor)
      cursor = events.at(-1)?.id ?? cursor
      if (!events.some(e => e.type === 'hint.added' || (e.type === 'fact.added' && e.payload && e.payload.stepId !== run.stepId))) return
      handle.agent.inject(message('共享图已有更新。需要时用 read_graph 查看，不必改变当前 Step。'))
    }
    store.changes.on('change', steer)
    const wait = async seconds => {
      const timer = setTimeout(() => { concludeOnly = true; handle.agent.cancel({ kind: 'hook', reason: 'Activity execution timeout' }) }, seconds * 1000)
      try { await handle.agent.whenIdle() } finally { clearTimeout(timer) }
    }
    try {
      shared.tasks.set(run.id, task)
      handle = await activateAgent(ctx.get('agents'), SessionId(run.id), cwd, { agentOptions: { provider: worker.provider, model: worker.model, ...(effort ? { reasoningEffort: effort } : {}) }, setup }, resume)
      task.handle = handle
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) { cancel(); return }
      store.checkpoint(run.id, { sessionId: run.id })
      // Same minimal launch slice as runPi; the agent reads the rest of the graph on demand.
      const graph = store.graph(run.projectId)
      prompt(resume ? '继续' : JSON.stringify({ project: graph.project, goal: graph.goals.find(g => g.id === 'goal'), step: step ?? null, origin: graph.facts[0],
        ...(step?.requires?.length ? { channels: channelsFor(verbRuntime, step.requires) } : {}),
        instruction: '用 read_graph 获取所需状态后推进任务。' }))
      if (pendingSkillNotice && jev?.isEnabled('skill_suggestion')) void prompt(pendingSkillNotice).catch(() => {})
      pendingSkillNotice = ''
      const limits = activityLimits(config, run.activity, step)
      await wait(limits.timeout)
      if (!finished && !task.committed && !signal.aborted) {
        concludeOnly = true
        prompt('仅提交已有证据并调用结束工具，不再执行外部操作。'); await wait(limits.concludeTimeout)
      }
      if (!finished && !task.committed && !signal.aborted) throw new Error(concludeOnly ? 'Activity ended without a structured completion' : 'Agent execution failed')
    } finally {
      signal.removeEventListener('abort', cancel)
      try { if (handle) { cancel(); await handle.agent.whenIdle(); await ctx.get('sessions').flush(handle.agent.session); store.checkpoint(run.id, { sessionId: run.id }); await handle.dispose() } }
      finally { sessionRefresh.delete(run.id); unlisten(); store.changes.off('change', steer); shared.tasks.delete(run.id) }
    }
  }
}
