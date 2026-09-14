import path from 'node:path'
import { mkdir } from 'node:fs/promises'
import { watch } from 'node:fs'
import { createEngine } from '../src/index.ts'
import { graphTools, activityPrompt, runPi, runMock } from '../src/runner.ts'
import { PluginManager, registerPluginRoutes } from '../../redtrace-dsh/lib/plugins.js'
import { load, repoRoot } from '../../redtrace-dsh/lib/loader.js'
import { mountExecutionTools } from '../../redtrace-dsh/lib/explore.js'
import { activateAgent, resolveReasoningEffort } from '../../redtrace-dsh/lib/scheduler.js'
import { state } from '../../redtrace-dsh/lib/state.js'
import { apply as applyDomain, applyCommonEnv, mcpSignature } from '../../redtrace-dsh/lib/domain.js'
import { createSkillView } from '../../redtrace-dsh/lib/capability.js'
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
  const root = path.resolve(options.root), managed = path.dirname(options.configuration), emptySkills = path.join(managed, 'empty-skills')
  await mkdir(emptySkills, { recursive: true })
  const { createUserMessage } = await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js')
  const { SessionId } = await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
  const engine = await createEngine({ root, database: options.database, configuration: options.configuration, autoStart: false,
    selectWorker: (worker, activity, step) => {
      const preset = activity === 'decide' ? 'reason' : step?.bootstrap ? 'bootstrap' : 'explore'
      if (!state()?.presets.has(preset)) return undefined
      return worker.backend !== 'mock' && step?.executionProfile === 'isolated' ? { ...worker, backend: 'dsh' } : worker
    },
    runTask: context => context.run.backend === 'mock' ? runMock(context) : context.run.backend === 'pi' ? runPi(context, engine.capabilities) : executeDsh(context) })
  const runtime = { runtime: true, root, server: options.server, sessionRoot: path.join(managed, 'sessions'), skillsDir: path.join(managed, 'skills'), workspacesDir: engine.configuration.workspaceRoot,
    pluginsManifest: path.join(managed, 'plugins.json') }
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
    'redtrace-prompt': { name: 'redtrace-prompt', apply() {} },
    'redtrace-domain': { name: 'redtrace-domain', async apply(scoped) { await applyDomain(scoped, { ...runtime, mcpConfigs: engine.capabilities.mcpConfigs() }); await refresh() } },
    // Raw Agent audit is committed directly below. No HTTP reporter or second scheduler is started.
    'redtrace-audit': { name: 'redtrace-audit', apply() {} },
    'redtrace-web': { name: 'redtrace-web', apply(scoped) { scoped.effect(() => ctx.webServer.registerFallback(engine.handler)) } },
    'redtrace-scheduler': { name: 'redtrace-scheduler', apply(scoped) { engine.scheduler.start(); scoped.effect(() => () => engine.scheduler.close()) } },
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
    let finished = false, concludeOnly = false, handle, toolScope, skillView
    const tools = graphTools(context, () => { finished = true; task.committed = true })
    const model = config.providers[worker.provider].models.find(m => m.id === worker.model)
    const effort = await resolveReasoningEffort(ctx.get('llm'), { provider: worker.provider, model: worker.model, reasoning: model.reasoning ?? 'auto_max' })
    const checkpoint = store.run(run.id).checkpoint, resume = !!checkpoint?.sessionId
    if (resume && !await ctx.sessionPersistence.readRaw(run.id)) throw new Error('Execute checkpoint session is missing; refusing a new session')
    const setup = async scoped => {
      if (run.activity === 'execute') {
        if (step?.capabilities.length) skillView = await createSkillView(runtime, run.id, engine.capabilities.resolve(step.capabilities))
        scoped = await mountExecutionTools(scoped, { task, cwd, skillsDir: skillView?.directory ?? emptySkills })
      }
      toolScope = scoped
      scoped.systemPrompt.section({ name: 'redtrace:fgs', order: 0, text: activityPrompt(run.activity) })
      for (const t of tools) scoped.tools.register({ name: t.name, description: t.description, parameters: t.parameters,
        output: { schema: { type: 'object', additionalProperties: true }, render: (_args, value) => value.content },
        async execute(args, execution) {
          if (finished || signal.aborted) throw new Error('Activity has stopped')
          const result = await t.execute(execution.callId ?? '', args, execution.signal)
          if (result.terminate) execution.concludeTurn?.()
          return result
        } })
      if (run.activity === 'decide') scoped.tools.restrict({ allow: tools.map(t => t.name) })
    }
    const unlisten = ctx.on('session/event', (session, event) => {
      if (String(session.id) !== run.id) return
      const data = event.data ?? {}
      store.transaction(() => {
        if (event.type === 'tool/call' && data.callId) store.toolStarted(run.id, String(data.callId), json(data))
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
      handle = await activateAgent(ctx.agents, SessionId(run.id), cwd, { agentOptions: { provider: worker.provider, model: worker.model, ...(effort ? { reasoningEffort: effort } : {}) }, setup }, resume)
      task.handle = handle
      signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) { cancel(); return }
      store.checkpoint(run.id, { sessionId: run.id })
      // Same minimal launch slice as runPi; the agent reads the rest of the graph on demand.
      const graph = store.graph(run.projectId)
      prompt(resume ? '继续' : JSON.stringify({ project: graph.project, goal: graph.goals.find(g => g.id === 'goal'), step: step ?? null, origin: graph.facts[0], instruction: '用 read_graph 获取所需状态后推进任务。' }))
      await wait(run.activity === 'decide' ? config.decideTimeout : config.executeTimeout)
      if (!finished && !task.committed && !signal.aborted) {
        concludeOnly = true; toolScope.tools.restrict({ allow: tools.map(t => t.name) })
        prompt('仅提交已有证据并调用结束工具，不再执行外部操作。'); await wait(config.concludeTimeout)
      }
      if (!finished && !task.committed && !signal.aborted) throw new Error(concludeOnly ? 'Activity ended without a structured completion' : 'Agent execution failed')
    } finally {
      signal.removeEventListener('abort', cancel)
      try { if (handle) { cancel(); await handle.agent.whenIdle(); await ctx.sessions.flush(handle.agent.session); store.checkpoint(run.id, { sessionId: run.id }); await handle.dispose() } }
      finally { unlisten(); store.changes.off('change', steer); shared.tasks.delete(run.id); await skillView?.cleanup() }
    }
  }
}
