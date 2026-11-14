import { callArguments, toolAllowed } from '../src/console-api.ts'
import { state } from '../../redtrace-dsh/lib/state.js'
import { readCommanderLog } from './legion.mjs'

export function runtimeCatalog(ctx) {
  const registry = ctx.get('tools'), agents = ctx.get('agents')?.list() ?? []
  const scopes = [{ scope: 'global', agent: undefined }, ...agents.map(agent => ({ scope: String(agent.session.id), agent }))]
  return {
    tools: scopes.flatMap(({scope,agent}) => (registry?.definitions(agent) ?? []).map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters, scope, status: 'registered', source: tool.name.startsWith('mcp__') ? 'MCP' : /^(legion_|submit_|read_graph$|read_execution$|project_|update_finding_|knowledge_|http_|remote_|resource_)/.test(tool.name) ? 'RedTrace' : 'DSH / 插件' }))),
    mcp: state()?.mcpStatuses?.() ?? [],
  }
}
export async function commanderCalls(ctx, engine) {
  const calls = new Map()
  for (const project of engine.store.projects()) {
    let offset = 0, page
    do {
      page = await readCommanderLog(ctx, engine, offset, 500, undefined, project.id)
      for (const event of page.events) if (['tool.started','tool.completed'].includes(event.kind) && event.call_id) {
        const key=page.sessionId+':'+event.call_id,previous=calls.get(key)
        calls.set(key,{projectId:project.id,runId:page.sessionId,callId:event.call_id,name:event.title??previous?.name??'',arguments:callArguments(event.arguments??previous?.arguments),timestamp:event.timestamp??previous?.timestamp??'',error:event.error,status:event.kind==='tool.completed'?(event.error?'failed':'completed'):'running'})
      }
      offset = page.nextOffset
    } while (page.hasMore)
  }
  return [...calls.values()]
}

// User tool switches apply at native dispatch, including PTC and Commander calls.
export function mountToolSettings(ctx, engine) {
  ctx.get('tools').guard(exec => {
    const settings = engine.configuration.resolvedSnapshot().raw.tool_settings
    if (!settings?.[exec.name]) return
    if (settings[exec.name].workers === undefined) return toolAllowed(settings, exec.name) ? undefined : '工具已在管理配置中停用'
    const sessionId = String(exec.agent?.session.id ?? '')
    const row = engine.store.db.prepare('SELECT data FROM runs WHERE id=?').get(sessionId)
    const worker = row ? JSON.parse(row.data).worker : engine.legion.campaigns().find(c => c.sessionId === sessionId)?.workerName
    return toolAllowed(settings, exec.name, worker) ? undefined : '工具已在管理配置中停用或未绑定此 Worker'
  })
}
