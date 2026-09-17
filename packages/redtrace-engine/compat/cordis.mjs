import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createEngine } from '../src/index.ts'
import { graphTools, activityPrompt, runPi, runMock } from '../src/runner.ts'
import { verbTools, channelsFor, resourceTools } from '../src/capability-verbs.ts'
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
  let profileRevision = '', providerKeys = new Set(), watcher
  const refresh = async () => {
    const shared = state(), mcpConfigs = engine.capabilities.mcpConfigs()
    if (shared && mcpSignature(mcpConfigs) !== shared.mcpSignature) await shared.remountMcp?.(mcpConfigs)
    const { raw, revision } = engine.configuration.read()
    if (revision === profileRevision) return
    const config = engine.configuration.resolve(raw), { providers, env } = providerProfiles(config)
    for (const key of providerKeys) if (!(key in env)) delete process.env[key]
    Object.assign(process.env, env); providerKeys = new Set(Object.keys(env))
    applyCommonEnv(config.commonEnv)
    await ctx.get('settings').replace('llm-pi-ai', { providers })
    if (shared) shared.snapshot = { revision, workers: config.workers.map(w => ({ ...w, maxRunning: w.maxRunning, reason: w.decide, explore: w.execute, bootstrap: true })), providers, env, commonEnv: config.commonEnv, tasks: raw.tasks, mcpConfigs,
      limits: { maxWorkers: config.maxWorkers, maxProjectWorkers: config.maxProjectWorkers, maxRunningProjects: config.maxRunningProjects, interval: 0 } }
    profileRevision = revision
  }
  const replacements = {
    // The domain replacement merges fresh MCP configs and pulls the first
    // runtime snapshot during boot; everything else mounts for real.
    'redtrace-domain': { name: 'redtrace-domain', async apply(scoped) { await applyDomain(scoped, { ...runtime, mcpConfigs: engine.capabilities.mcpConfigs() }); await refresh() } },
  }
  const manager = new PluginManager(ctx, runtime, repoRoot, load, replacements, () => engine.scheduler.wake())
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
    const { store, run, config, signal, worker } = context, shared = state()
    if (!shared) throw new Error('Cordis domain service is unavailable')
    const step = run.stepId ? store.node(run.projectId, run.stepId, 'step') : undefined
    const task = { usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, cacheReadTokens: run.cacheReadTokens, cacheWriteTokens: run.cacheWriteTokens }, type: run.activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore', projectId: run.projectId, intentId: run.stepId ?? undefined,
      worker: worker.name, sessionId: run.id, runId: run.id, committed: false, server: options.server, startedAt: Date.now(), executionProfile: step?.executionProfile ?? 'direct' }
    if (!shared.presets.has(task.type)) throw new Error(`Cordis task preset ${task.type} is disabled`)
    const cwd = path.join(config.workspaceRoot, run.projectId); await mkdir(cwd, { recursive: true })
    let finished = false, concludeOnly = false, handle
    const tools = graphTools(context, () => { finished = true; task.committed = true })
    const model = config.providers[worker.provider].models.find(m => m.id === worker.model)
    const effort = await resolveReasoningEffort(ctx.get('llm'), { provider: worker.provider, model: worker.model, reasoning: model.reasoning ?? 'auto_max' })
    const checkpoint = store.run(run.id).checkpoint, resume = !!checkpoint?.sessionId
    if (resume && !await ctx.get('sessionPersistence').readRaw(run.id)) throw new Error('Execute checkpoint session is missing; refusing a new session')
    const setup = async scoped => {
      if (run.activity === 'execute') {
        // Skills mount DSH-natively from the full managed skills root; the
        // agent discovers and loads them through the skill tool on demand.
        scoped = await mountExecutionTools(scoped, { task, cwd, skillsDir: runtime.skillsDir, toolsDir: path.join(repoRoot, 'tools'), available: id => manager.running(id) })
      }
      scoped.systemPrompt.section({ name: 'redtrace:fgs', order: 0, text: activityPrompt(run.activity) })
      // The DSH tools runtime projects parameters as lossless JSON; the graph
      // and verb tools carry typebox symbol annotations, so detach them into
      // plain JSON Schema before registration.
      for (const t of [...tools, ...(run.activity === 'execute' ? [...resourceTools(context, verbRuntime), ...verbTools(context, verbRuntime, step)] : [])]) scoped.tools.register({ name: t.name, description: t.description, parameters: JSON.parse(JSON.stringify(t.parameters)),
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => value.content },
        async execute(args, execution) {
          if (finished || signal.aborted) throw new Error('Activity has stopped')
          const result = await t.execute(execution.callId ?? '', args, execution.signal)
          if (result.terminate) execution.concludeTurn?.()
          return result
        } })
      // The conclude phase cuts non-graph tools at execution time: a
      // restriction cannot, because the DSH capability stack registers the
      // session tools in this scope's own layer, which restrictions never
      // filter. The guard mirrors the pi backend's conclude gate.
      const graphNames = new Set(tools.map(t => t.name))
      scoped.tools.guard(exec => concludeOnly && !graphNames.has(exec.name) ? 'Execution timed out; only summarize and submit existing evidence' : undefined)
      // Decide sees only its scoped graph tools: the tools runtime restricts
      // global names only, so an empty allow set masks every global tool
      // (webshell/c2 family) for this agent.
      if (run.activity === 'decide') scoped.tools.restrict({ allow: [] })
    }
    const unlisten = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== run.id) return
      const data = event.data ?? {}
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
      await wait(run.activity === 'decide' ? config.decideTimeout : config.executeTimeout)
      if (!finished && !task.committed && !signal.aborted) {
        concludeOnly = true
        prompt('仅提交已有证据并调用结束工具，不再执行外部操作。'); await wait(config.concludeTimeout)
      }
      if (!finished && !task.committed && !signal.aborted) throw new Error(concludeOnly ? 'Activity ended without a structured completion' : 'Agent execution failed')
    } finally {
      signal.removeEventListener('abort', cancel)
      try { if (handle) { cancel(); await handle.agent.whenIdle(); await ctx.get('sessions').flush(handle.agent.session); store.checkpoint(run.id, { sessionId: run.id }); await handle.dispose() } }
      finally { unlisten(); store.changes.off('change', steer); shared.tasks.delete(run.id) }
    }
  }
}
