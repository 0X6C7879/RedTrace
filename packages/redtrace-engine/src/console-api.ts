import { createHash } from 'node:crypto'
import { Type } from 'typebox'
import { body } from './http.ts'
import { HttpError } from './types.ts'
import type { Configuration, RawConfig } from './config.ts'
import type { Router } from './http.ts'
import type { Store } from './store.ts'
import type { Finding } from './types.ts'

export interface RuntimeCatalog {
  tools: { name: string; description?: string; parameters?: Record<string, any>; source: string; scope: string; status: string; role?: string; enabled?: boolean }[]
  mcp: { name: string; state: string; toolCount?: number; lastError?: string }[]
}
export function toolAllowed(settings: RawConfig['tool_settings'], name: string, worker?: string) {
  const setting = settings?.[name]
  return setting?.enabled !== false && (setting?.workers === undefined || !!worker && setting.workers.includes(worker))
}
export function consoleRoutes(router: Router, store: Store, configuration: Configuration, runtime: () => RuntimeCatalog | Promise<RuntimeCatalog> = () => ({ tools: [], mcp: [] })) {
  router.add('PUT', '/console/tools/:tool/settings', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: Type.String({minLength:64,maxLength:64}), enabled: Type.Boolean(), workers: Type.Array(Type.String({minLength:1}), {uniqueItems:true}) }))
    const registered = (await runtime()).tools.filter(tool => tool.name === c.params.tool)
    if (!registered.length || registered.some(tool => tool.source !== 'RedTrace')) throw new HttpError(400, 'Only registered RedTrace platform tools are managed here; DSH tools retain native defaults')
    const {config} = configuration.resolvedSnapshot()
    if (b.workers.some(name => !config.workers.some(w => w.name === name))) throw new HttpError(400, 'Unknown Worker')
    return configuration.commit(b.expected_revision, raw => {
      const settings = raw.tool_settings ??= {}
      if (b.enabled && b.workers.length === config.workers.length) delete settings[c.params.tool]
      else settings[c.params.tool] = {enabled:b.enabled, ...(b.workers.length === config.workers.length ? {} : {workers:b.workers})}
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
  router.add('GET', '/console/tools', async () => {
    const live = await runtime()
    const {raw, revision, config} = configuration.resolvedSnapshot()
    const registrations = live.tools
    const groups = new Map<string, typeof registrations>()
    for (const tool of registrations) { const key = JSON.stringify([tool.source, tool.name, tool.description, tool.parameters]); groups.set(key, [...(groups.get(key) ?? []), tool]) }
    const tools = [...groups].map(([key, group]) => {
      const tool = group.find(t => t.status === 'registered') ?? group[0]
      const setting = raw.tool_settings?.[tool.name]
      return { ...tool, id: createHash('sha256').update(key).digest('hex'), enabled: (tool.source !== 'RedTrace' || setting?.enabled !== false) && group.some(t => t.enabled !== false), visibleScopes: [...new Set(group.filter(t => t.status === 'registered' && t.enabled !== false).map(t => t.scope))], roles: [...new Set(group.map(t => t.role).filter(Boolean))], workerBindings: tool.source === 'RedTrace' && setting?.workers !== undefined ? setting.workers : config.workers.map(w => w.name), manageable: tool.source === 'RedTrace', scopes: [...new Set(group.filter(t => t.status === 'registered').map(t => t.scope))] }
    })
    return { tools, revision, workers: config.workers.map(w => ({name:w.name, roles:w.roles??[], enabled:w.enabled})), mcp: live.mcp, note: '列出真实注册代码提供的全部 Tool Schema，包含未运行角色和已停用工具；不包含 CLI、Skill 脚本或历史工具。开关反映工具配置与能力插件状态，不以会话是否运行判断启用。DSH 原生工具及外部 MCP 保持原生行为；平台开关在下一模型步骤及新调用生效。' }
  })
}
