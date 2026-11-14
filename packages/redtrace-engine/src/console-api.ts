import path from 'node:path'
import { Type } from 'typebox'
import { body } from './http.ts'
import { HttpError } from './types.ts'
import type { Configuration, RawConfig } from './config.ts'
import { accessSync, constants, existsSync, readFileSync } from 'node:fs'
import type { Router } from './http.ts'
import type { Store } from './store.ts'
import type { Finding } from './types.ts'

export interface RuntimeCatalog {
  tools: { name: string; description?: string; parameters?: Record<string, any>; source: string; scope: string; status: string }[]
  mcp: { name: string; state: string; toolCount?: number; lastError?: string }[]
}
export interface ToolCall { projectId: string; runId: string; callId: string; name: string; arguments: Record<string, any>; timestamp: string; error?: boolean; status: string }

// Native model calls retain JSON-text arguments, including malformed attempts.
export function callArguments(value: any): Record<string, any> {
  if (typeof value === 'string') { try { return callArguments(JSON.parse(value)) } catch { return { raw: value } } }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : value == null ? {} : { raw: value }
}

// Audit is the source of truth: one invocation per session/call ID, including PTC subcalls.
export function auditCalls(store: Store): ToolCall[] {
  const calls = new Map<string, ToolCall>()
  for (const row of store.db.prepare("SELECT project_id,run_id,data FROM audit_events WHERE json_extract(data,'$.kind') IN ('tool.started','tool.completed','skill.started','skill.completed') ORDER BY id").all()) {
    const e = JSON.parse(String(row.data)), key = row.run_id + ':' + e.call_id
    if (!e.call_id) continue
    const previous = calls.get(key)
    calls.set(key, { projectId: String(row.project_id), runId: String(row.run_id), callId: e.call_id, name: e.title ?? previous?.name ?? '', arguments: callArguments(e.arguments ?? previous?.arguments), timestamp: e.timestamp ?? previous?.timestamp ?? '', error: e.error, status: e.kind.endsWith('completed') ? (e.error ? 'failed' : 'completed') : 'running' })
  }
  return [...calls.values()]
}
export function callStats(calls: ToolCall[]) { return { calls: calls.length, failures: calls.filter(c => c.error).length, lastCalledAt: calls.map(c => c.timestamp).sort().at(-1) ?? null } }
function cliCatalog(root: string) {
  const file = path.join(root, 'tools/tool_list.md')
  if (!existsSync(file)) return []
  const names = [...new Set([...readFileSync(file, 'utf8').matchAll(/^-\s+`([a-zA-Z0-9_+.-]+)`/gm)].map(m => m[1]))]
  return names.map(name => {
    const executable = (process.env.PATH ?? '').split(path.delimiter).flatMap(dir => process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'].map(ext => path.join(dir, name + ext)) : [path.join(dir, name)]).find(file => { try { accessSync(file, constants.X_OK); return true } catch { return false } })
    return { name, description: executable ?? '已登记，PATH 中无同名可执行文件', source: 'CLI', scope: 'shell', status: executable ? 'available' : 'unavailable' }
  })
}
export function toolAllowed(settings: RawConfig['tool_settings'], name: string, worker?: string) {
  const setting = settings?.[name]
  return setting?.enabled !== false && (setting?.workers === undefined || !!worker && setting.workers.includes(worker))
}
export function consoleRoutes(router: Router, store: Store, root: string, configuration: Configuration, runtime: () => RuntimeCatalog | Promise<RuntimeCatalog> = () => ({ tools: [], mcp: [] }), commanderCalls: () => Promise<ToolCall[]> = async () => []) {
  router.add('PUT', '/console/tools/:tool/settings', async c => {
    const b = await body(c.req, Type.Object({ expected_revision: Type.String({minLength:64,maxLength:64}), enabled: Type.Boolean(), workers: Type.Array(Type.String({minLength:1}), {uniqueItems:true}) }))
    if (c.params.tool === 'run_code') throw new HttpError(400, 'Manage the native Shell or end-capability tool instead')
    const {config} = configuration.resolvedSnapshot()
    if (b.workers.some(name => !config.workers.some(w => w.name === name))) throw new HttpError(400, 'Unknown Worker')
    return configuration.commit(b.expected_revision, raw => {
      const settings = raw.tool_settings ??= {}
      if (b.enabled && b.workers.length === config.workers.length) delete settings[c.params.tool]
      else settings[c.params.tool] = {enabled:b.enabled, ...(b.workers.length === config.workers.length ? {} : {workers:b.workers})}
      if (!Object.keys(settings).length) delete raw.tool_settings
    })
  })
  router.add('GET', '/console/findings', () => {
    const projects = new Map(store.projects().map(p => [p.id, p]))
    return store.db.prepare("SELECT data FROM nodes WHERE kind='finding' AND COALESCE(json_extract(data,'$.deleted'),0)=0 AND COALESCE(json_extract(data,'$.lifecycle'),'active')='active' ORDER BY rowid DESC").all().map(row => {
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
    const [live, commander] = await Promise.all([runtime(), commanderCalls()]), calls = [...auditCalls(store), ...commander]
    const {raw, revision, config} = configuration.resolvedSnapshot()
    const registrations = [...live.tools, ...cliCatalog(root)]
    const names = new Set(live.tools.map(t => t.name))
    for (const call of calls) if (!names.has(call.name)) { registrations.push({ name: call.name, description: '审计中出现；当前没有活跃注册', source: call.name.startsWith('mcp__') ? 'MCP' : '历史调用', scope: 'audit', status: 'inactive' }); names.add(call.name) }
    const groups = new Map<string, typeof registrations>()
    for (const tool of registrations) { const key = tool.source + ':' + tool.name; groups.set(key, [...(groups.get(key) ?? []), tool]) }
    const tools = [...groups.values()].map(group => {
      const tool = group[0]
      const observed = tool.source === 'CLI' ? calls.filter(c => ['bash', 'pwsh'].includes(c.name) && String(c.arguments.command ?? c.arguments.script ?? '').trim().split(/\s/)[0] === tool.name) : calls.filter(c => c.name === tool.name)
      const setting = raw.tool_settings?.[tool.name]
      return { ...tool, enabled: setting?.enabled !== false, workerBindings: setting?.workers ?? config.workers.map(w => w.name), manageable: tool.source !== 'CLI' && tool.name !== 'run_code', scopes: [...new Set(group.map(t => t.scope))], ...callStats(observed) }
    })
    return { tools, revision, workers: config.workers.map(w => ({name:w.name, roles:w.roles??[], enabled:w.enabled})), mcp: live.mcp, calls: calls.sort((a,b) => b.timestamp.localeCompare(a.timestamp)), stats: callStats(calls), note: '统计来自已留存原生审计，按 run/call ID 去重。CLI 仅归因直接以该命令开头的 Shell 调用；不估算脚本内部调用。' }
  })
}
