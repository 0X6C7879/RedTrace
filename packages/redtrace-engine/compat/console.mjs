import { originalTool } from '../../redtrace-dsh/lib/tool-domains.js'
import { executionRole, coordinatorRole } from '../../redtrace-dsh/lib/roles.js'
import { toolAllowed } from '../src/console-api.ts'
import { state } from '../../redtrace-dsh/lib/state.js'
import { load } from '../../redtrace-dsh/lib/loader.js'

export async function mountSystemLogs(ctx, engine) {
  const { Logger } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
  const cursors=new Map(engine.store.projects().map(p=>[p.id,Number(engine.store.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events WHERE project_id=?').get(p.id).n)]))
  const lifecycle=new Set(['project.created','project.active','project.stopped','project.completed','project.reopened','step.added','step.updated','step.revised','step.replacement','step.parked','step.reactivated','goal.added','goal.updated','fact.added','finding.added','finding.report_updated','execute.started','execute.succeeded','execute.failed','execute.paused','execute.cancelled','execute.unknown','legion.worker_restarted','step.handoff_requested','step.handoff_ready'])
  const changed=projectId=>{
    const project=engine.store.projects().find(p=>p.id===projectId);if(!project){cursors.delete(projectId);return}
    let rows
    do{
      rows=engine.store.events(projectId,cursors.get(projectId)??0,100)
      for(const event of rows){
        cursors.set(projectId,event.id)
        if(!lifecycle.has(event.type))continue
        const payload=event.payload??{},message=project.mode+' Project='+projectId+' '+event.type+(event.nodeId?' node='+event.nodeId:'')+(payload.runId?' Run='+payload.runId:'')
        if(['execute.failed','execute.unknown'].includes(event.type))ctx.logger.warn(message)
        else ctx.logger.info(message)
      }
    }while(rows.length===100)
  }
  engine.store.changes.on('change',changed)
  ctx.effect(()=>()=>engine.store.changes.off('change',changed))
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

export function platformToolOptions(engine, name, role) {
  return { when: () => toolAllowed(engine.configuration.resolvedSnapshot().raw.tool_settings, name, role) }
}

export async function runtimeCatalog(ctx, engine, catalog = [], namesOnly = false) {
  const registry = ctx.get('tools'), agents = ctx.get('agents')?.list() ?? []
  const campaigns = namesOnly ? [] : engine?.legion.campaigns() ?? [], chats = namesOnly ? [] : engine?.chats.all() ?? []
  const definitions = agent => (registry?.definitions(agent) ?? []).filter(tool=>agent||tool.name.startsWith('mcp__'))
  const source = tool => tool.name.startsWith('mcp__') ? 'MCP' : tool.redtrace ? 'RedTrace' : 'DSH'
  const settings = engine?.configuration.resolvedSnapshot().raw.tool_settings
  const scopes = [{ scope: 'global', agent: undefined }, ...agents.map(agent => ({ scope: String(agent.session.id), agent }))]
  const runs=[]
  return {
    tools: [...catalog, ...(await Promise.all(scopes.map(async ({scope,agent}) => {
      const run = engine?.store.db.prepare('SELECT data FROM runs WHERE id=?').get(scope)
      const record = run && JSON.parse(run.data)
      const step = record && engine.store.assignment(record)
      if (step?.role === 'scout') return []
      if (namesOnly) return definitions(agent).map(tool=>({ name:tool.name, scope, status:'registered', source:source(tool) }))
      const campaign = campaigns.find(c => c.sessionId === scope)
      const chat = chats.find(c => c.sessionId === scope)
      const role = step ? executionRole(engine.store.project(record.projectId).mode,step.role) : campaign ? coordinatorRole(engine.store.project(campaign.projectId).mode) : undefined
      const projectId = record?.projectId ?? campaign?.projectId ?? chat?.projectId
      const mode = projectId ? engine.store.project(projectId).mode : undefined
      const selection = agent ? await registry.resolve({agent,modelSelection:agent.model.current(),signal:new AbortController().signal}) : undefined
      const visible = new Set(agent ? registry.schemas(agent,selection).map(t=>t.name) : [])
      if(agent){const selectedSchemas=registry.schemas(agent,selection);const wire=JSON.stringify(selectedSchemas);runs.push({runId:scope,role,mode,visibleSchemas:visible.size,schemaBytes:Buffer.byteLength(wire),schemaEstimatedTokens:Math.ceil(wire.length/4),schemaTokenMethod:'ceil(serialized chars/4), not billing'})}
      selection?.dispose()
      return definitions(agent).flatMap(tool => (tool.name.startsWith('mcp__')&&!agent?['soldier']:[role]).map(binding=>({ name: tool.name, description: tool.description, parameters: tool.parameters,
        scope, role:binding, mode, status: 'registered',
        enabled: toolAllowed(settings, tool.name, binding), visible: visible.has(tool.name),
        source: source(tool) })))
    }))).flat()],
    runs,
    mcp: state()?.mcpStatuses?.() ?? [],
  }
}
// User tool switches apply at native dispatch, including PTC and Commander calls.
function agentRole(engine, agent) {
  const id=String(agent?.session.id??'')
  const row=engine.store.db.prepare('SELECT data FROM runs WHERE id=?').get(id),run=row&&JSON.parse(row.data)
  if(run?.activity==='plan')return 'general'
  if(run?.stepId){
    const role=engine.store.node(run.projectId,run.stepId,'step').role
    return role==='scout'?role:executionRole(engine.store.project(run.projectId).mode,role)
  }
  const campaign=engine.legion.campaigns().find(c=>c.sessionId===id)
  return campaign?coordinatorRole(engine.store.project(campaign.projectId).mode):undefined
}
export function mountToolSettings(ctx, engine) {
  const tools=ctx.get('tools'),nativeResolve=tools.resolve.bind(tools)
  // Keep native activation/ownership/disposal; filter its selected definitions, never wrap execution.
  tools.resolve=async context=>{
    const selected=await nativeResolve(context),role=agentRole(engine,context.agent)
    return {dispose:()=>selected.dispose(),view:scope=>{
      const settings=engine.configuration.resolvedSnapshot().raw.tool_settings
      return new Map([...selected.view(scope)].filter(([name])=>toolAllowed(settings,name,role)))
    }}
  }
  ctx.effect(()=>()=>{tools.resolve=nativeResolve})
  tools.guard(exec=>{const settings=engine.configuration.resolvedSnapshot().raw.tool_settings,role=agentRole(engine,exec.agent),original=originalTool(exec.name,exec.arguments?.action);return toolAllowed(settings,exec.name,role)&&(!original||toolAllowed(settings,original,role))?undefined:'工具已在管理配置中停用或未绑定此角色'})
}

/** Keep native MCP definitions/ownership; refresh scoped conditions with each native remount. */
export function mountMcpRoleTools(scoped, global, engine, role) {
  const active=new Map()
  const refresh=()=>{
    const definitions=new Map(global.get('tools').definitions().filter(t=>t.name.startsWith('mcp__')).map(t=>[t.name,t]))
    for(const [name,entry] of active)if(definitions.get(name)!==entry.definition){entry.dispose();active.delete(name)}
    for(const [name,definition] of definitions)if(!active.has(name))active.set(name,{definition,dispose:scoped.tools.register(definition,platformToolOptions(engine,name,role))})
  }
  refresh()
  return refresh
}
