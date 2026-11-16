import { toolAllowed } from '../src/console-api.ts'
import { state } from '../../redtrace-dsh/lib/state.js'
import { load } from '../../redtrace-dsh/lib/loader.js'

export async function mountSystemLogs(ctx, engine) {
  const { Logger } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
  engine.router.add('GET', '/console/logs', () => {
    const config = engine.configuration.resolvedSnapshot().config
    const secrets = [...Object.values(config.providers).map(p => p.apiKey ?? process.env[p.apiKeyEnv]), ...Object.entries(config.commonEnv ?? {}).filter(([name]) => /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/.test(name)).map(([,value]) => value)].filter(Boolean)
    return ctx.logger.buffer.map(entry => {
      let message = Logger.format({ colors: false }, entry)
      for (const secret of secrets) message = message.replaceAll(secret, '[REDACTED]')
      message = message.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]').replace(/([?&](?:api_key|key|token|access_token|password)=)[^&\s]+/gi, '$1[REDACTED]').replace(/(https?:\/\/)[^/\s@]+@/gi, '$1[REDACTED]@')
      return { id: entry.sn, timestamp: entry.ts, level: entry.type, source: entry.name, message }
    })
  })
}

export function platformToolOptions(engine, name, worker) {
  return { when: () => toolAllowed(engine.configuration.resolvedSnapshot().raw.tool_settings, name, worker) }
}

export function runtimeCatalog(ctx, engine, catalog = []) {
  const registry = ctx.get('tools'), agents = ctx.get('agents')?.list() ?? []
  const campaigns = engine?.legion.campaigns() ?? [], chats = engine?.chats.all() ?? []
  const settings = engine?.configuration.resolvedSnapshot().raw.tool_settings
  const scopes = [{ scope: 'global', agent: undefined }, ...agents.map(agent => ({ scope: String(agent.session.id), agent }))]
  return {
    tools: [...catalog, ...scopes.flatMap(({scope,agent}) => {
      const run = engine?.store.db.prepare('SELECT data FROM runs WHERE id=?').get(scope)
      const record = run && JSON.parse(run.data)
      const step = record?.stepId && engine.store.node(record.projectId, record.stepId, 'step')
      const campaign = campaigns.find(c => c.sessionId === scope)
      const chat = chats.find(c => c.sessionId === scope)
      const role = step ? step.role ?? 'soldier' : campaign ? 'commander' : chat?.projectId ? 'chief' : agent ? 'assistant' : 'global'
      const projectId = record?.projectId ?? campaign?.projectId ?? chat?.projectId
      const mode = projectId ? engine.store.project(projectId).mode : undefined
      const worker = record?.worker ?? campaign?.workerName ?? chat?.workerName
      return (registry?.definitions(agent) ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
        scope, role: mode ? role + ':' + mode : role, status: 'registered',
        enabled: !tool.redtrace || toolAllowed(settings, tool.name, worker),
        source: tool.redtrace ? 'RedTrace' : tool.name.startsWith('mcp__') ? 'MCP' : 'DSH' }))
    })],
    mcp: state()?.mcpStatuses?.() ?? [],
  }
}
// User tool switches apply at native dispatch, including PTC and Commander calls.
export function mountToolSettings(ctx, engine) {
  ctx.get('tools').guard(exec => {
    if (!ctx.get('tools').get(exec.name, exec.agent)?.redtrace) return
    const settings = engine.configuration.resolvedSnapshot().raw.tool_settings
    if (!settings?.[exec.name]) return
    if (settings[exec.name].workers === undefined) return toolAllowed(settings, exec.name) ? undefined : '工具已在管理配置中停用'
    const sessionId = String(exec.agent?.session.id ?? '')
    const row = engine.store.db.prepare('SELECT data FROM runs WHERE id=?').get(sessionId)
    const worker = row ? JSON.parse(row.data).worker : engine.legion.campaigns().find(c => c.sessionId === sessionId)?.workerName ?? engine.chats.all().find(c => c.sessionId === sessionId)?.workerName
    return toolAllowed(settings, exec.name, worker) ? undefined : '工具已在管理配置中停用或未绑定此 Worker'
  })
}
