import { domainAction, TOOL_DOMAINS } from '../../redtrace-dsh/src/tool-domains.ts'
import { FIXED_ROLES, MODE_ROLES, type FixedRole } from '../../redtrace-dsh/src/roles.ts'
import { toolStatistics } from './tool-stats.ts'
import { createHash } from 'node:crypto'
import { Type } from 'typebox'
import { body } from './http.ts'
import { HttpError } from './types.ts'
import type { Configuration, RawConfig } from './config.ts'
import type { Router } from './http.ts'
import type { Store } from './store.ts'
import type { Finding } from './types.ts'

export interface RuntimeCatalog {
  tools: { name: string; description?: string; parameters?: Record<string, any>; source: string; scope: string; status: string; role?: string; enabled?: boolean; mode?: string; visible?: boolean }[]
  runs?: {runId:string;visibleSchemas:number}[]
  mcp: { name: string; state: string; toolCount?: number; lastError?: string }[]
}
export function toolAllowed(settings: RawConfig['tool_settings'], name: string, role?: FixedRole) {
  const mapped=domainAction(name),setting=settings?.[mapped?.domain??name]
  const allowed=(value?:{enabled:boolean;roles?:NonNullable<RawConfig['tool_settings']>[string]['roles']})=>value?.enabled!==false&&(value?.roles===undefined||!!role&&value.roles.includes(role))
  if(!allowed(setting))return false
  return !mapped||allowed(setting?.actions?.[mapped.action])&&allowed(settings?.[name])
}
export function consoleRoutes(router: Router, store: Store, configuration: Configuration, runtime: () => RuntimeCatalog | Promise<RuntimeCatalog> = () => ({ tools: [], mcp: [] })) {
  router.add('PUT', '/console/tools/:tool/settings', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: Type.String({minLength:64,maxLength:64}), enabled: Type.Boolean(), roles: Type.Array(Type.Union(FIXED_ROLES.map(role=>Type.Literal(role))), {uniqueItems:true}), actions:Type.Optional(Type.Record(Type.String(),Type.Object({enabled:Type.Boolean(),roles:Type.Optional(Type.Array(Type.Union(FIXED_ROLES.map(role=>Type.Literal(role))),{uniqueItems:true}))},{additionalProperties:false}))) }))
    const registered = (await runtime()).tools.filter(tool => tool.name === c.params.tool)
    if (!registered.length) throw new HttpError(400, 'Tool Schema is not registered')
    const roles = [...new Set(registered.map(t=>t.role).filter((role):role is FixedRole=>FIXED_ROLES.includes(role as FixedRole)))].sort((a,b)=>FIXED_ROLES.indexOf(a)-FIXED_ROLES.indexOf(b))
    if (b.roles.some(role=>!roles.includes(role))) throw new HttpError(400, 'Role has no registration for this tool')
    if(b.actions)for(const [action,setting] of Object.entries(b.actions)){if(!TOOL_DOMAINS[c.params.tool]?.[action])throw new HttpError(422,'Unknown tool action');if(setting.roles?.some(role=>!registered.some(t=>t.role===role&&t.parameters?.properties?.action?.enum?.includes(action))))throw new HttpError(400,'Role has no registration for this action')}
    return configuration.commit(b.expected_revision, raw => {
      const settings = raw.tool_settings ??= {}
      if (b.enabled && b.roles.length === roles.length && !settings[c.params.tool]?.actions && !b.actions) delete settings[c.params.tool]
      else settings[c.params.tool] = {...(settings[c.params.tool]?.actions?{actions:settings[c.params.tool].actions}:{}),...(b.actions?{actions:b.actions}:{}),enabled:b.enabled, ...(b.roles.length === roles.length ? {} : {roles:b.roles})}
      if (!Object.keys(settings).length) delete raw.tool_settings
    })
  })
  router.add('GET', '/console/findings', c => {
    const projects = new Map(store.projects().map(p => [p.id, p]))
    const project=c.url.searchParams.get('projectId'),graph=c.url.searchParams.get('graphId');if(project){store.project(project);if(graph)store.projectGraph(project,graph)}
    return store.db.prepare("SELECT data FROM nodes WHERE kind='finding' AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND COALESCE(json_extract(data,'$.lifecycle'),'active')='active'"+(project?" AND project_id=?":"")+(graph?" AND json_extract(data,'$.graphId')=?":"")+" ORDER BY rowid DESC").all(...(project?[project]:[]),...(graph?[graph]:[])).map(row => {
      const f = JSON.parse(String(row.data)) as Finding, p = projects.get(f.projectId)!
      const { details: _, report: __, ...summary } = f
      return { ...summary, hasReport: !!f.report, projectTitle: p.title, projectStatus: p.status, mode: p.mode, graphTitle: f.graphId ? store.projectGraph(p.id, f.graphId).title : p.title }
    })
  })
  router.add('GET', '/console/findings/:project/:finding', c => {
    const finding = store.forProject(c.params.project).node<Finding>(c.params.project, c.params.finding, 'finding')
    return store.forGraph(c.params.project, finding.graphId!).readNode(c.params.project, finding.id, 'doc')
  })
  router.add('GET','/console/tool-stats',async c=>{const live=await runtime();return {...toolStatistics(store,c.url,[...new Set(live.tools.map(t=>t.name))]),projects:store.projects().map(p=>({id:p.id,title:p.title,mode:p.mode}))}})
  router.add('GET', '/console/tools', async () => {
    const live = await runtime()
    const {raw, revision} = configuration.resolvedSnapshot()
    const registrations = live.tools
    const groups = new Map<string, typeof registrations>()
    for (const tool of registrations) { const key = JSON.stringify([tool.source, tool.name]); groups.set(key, [...(groups.get(key) ?? []), tool]) }
    const tools = [...groups].map(([key, group]) => {
      const tool = [...group].sort((a,b)=>JSON.stringify(b.parameters).length-JSON.stringify(a.parameters).length)[0]
      const variants=new Map<string,typeof group>();for(const row of group){const schema=JSON.stringify(row.parameters);variants.set(schema,[...(variants.get(schema)??[]),row])}
      const schemas=[...variants.values()].map(rows=>{const t=rows[0],wire=JSON.stringify({name:t.name,description:t.description,parameters:t.parameters});return{roles:[...new Set(rows.map(r=>r.role).filter(Boolean))],description:t.description,parameters:t.parameters,bytes:Buffer.byteLength(wire),estimatedTokens:Math.ceil(wire.length/4)}})
      const setting = raw.tool_settings?.[tool.name]
      const roles = [...new Set(group.map(t=>t.role).filter((role):role is FixedRole=>FIXED_ROLES.includes(role as FixedRole)))].sort((a,b)=>FIXED_ROLES.indexOf(a)-FIXED_ROLES.indexOf(b))
      const bindings = setting?.roles ?? roles
      return { ...tool, schemas, contexts:[...new Set(group.map(t=>t.scope==='assistant'?'assistant':t.role?'task':'runtime'))],actions:[...new Set(group.flatMap(t=>t.parameters?.properties?.action?.enum??[]))], actionSettings:setting?.actions??{}, schemaBytes:Buffer.byteLength(JSON.stringify({name:tool.name,description:tool.description,parameters:tool.parameters})), schemaEstimatedTokens:Math.ceil(JSON.stringify({name:tool.name,description:tool.description,parameters:tool.parameters}).length/4), id: createHash('sha256').update(key).digest('hex'), enabled: setting?.enabled !== false && group.some(t => t.enabled !== false),
        visibleScopes: [...new Set(group.filter(t => t.status === 'registered' && t.visible).map(t => t.scope))], roles,
        roleBindings: bindings.filter(r=>roles.includes(r)), manageable: roles.length>0,
        scopes: [...new Set(group.filter(t => t.status === 'registered').map(t => t.scope))] }
    })
    return { tools, revision, roleGroups: MODE_ROLES, runs: live.runs ?? [], mcp: live.mcp,
      schemaCounts: Object.fromEntries(['DSH','RedTrace','MCP'].map(source=>[source,tools.filter(t=>t.source===source).length])),
      note: '每个工具一行；角色版本的精确 Schema 在详情中查看。助手会话不属于任务角色。启停与角色绑定对新调用生效。' }
  })
}
