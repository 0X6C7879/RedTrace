import { TOOL_DOMAINS } from '../../redtrace-dsh/src/tool-domains.ts'
import { LEGACY_GENERAL_ROLES } from '../../redtrace-dsh/src/roles.ts'
import type { Store } from './store.ts'
import { queryNumber } from './http.ts'

interface CallCounts {
  name: string; action: string | null; calls: number; succeeded: number; failed: number; unfinished: number; last_call: string | null
}

/** One row per native call, including PTC children; starts are not outcomes. */
export function toolStatistics(store: Store, url: URL, names: string[]) {
  const originalName = "COALESCE(json_extract(s.data,'$.title'),json_extract(e.data,'$.title'))"
  const aliases = Object.entries(TOOL_DOMAINS).flatMap(([name, actions]) => Object.entries(actions).map(([action, original]) => ({ name, action, original })))
  aliases.push({ name: 'http_session', action: 'batch', original: 'http_batch' }, { name: 'http_session', action: 'replay', original: 'http_replay' })
  const mapped = (field: 'name' | 'action') => `CASE ${originalName} ${aliases.map(a => `WHEN '${a.original}' THEN '${a[field]}'`).join(' ')} ELSE ${field === 'name' ? originalName : 'NULL'} END`
  const [project, mode, role, from, to, name] = ['projectId', 'mode', 'role', 'from', 'to', 'tool'].map(key => url.searchParams.get(key) ?? '')
  const offset = queryNumber(url, 'offset', 0), limit = queryNumber(url, 'limit', 100, 1, 200)
  const query = `WITH calls AS (
    SELECT run_id, json_extract(data,'$.call_id') AS call_id,
      MIN(CASE WHEN json_extract(data,'$.kind')='tool.started' THEN id END) AS start_id,
      MAX(CASE WHEN json_extract(data,'$.kind')='tool.completed' THEN id END) AS end_id
    FROM audit_events WHERE json_extract(data,'$.kind') IN ('tool.started','tool.completed')
      AND COALESCE(json_extract(data,'$.call_id'),'')<>'' ${project ? 'AND project_id=?' : ''}
    GROUP BY run_id,call_id
  ), paired AS (
    SELECT c.*,r.project_id,
      COALESCE(json_extract(r.data,'$.graph_id'),json_extract(s.data,'$.graph_id'),json_extract(e.data,'$.graph_id')) AS graph_id,
      ${mapped('name')} AS name,${originalName} AS original_name,
      COALESCE(json_extract(s.data,'$.arguments.action'),${mapped('action')}) AS action,
      COALESCE(json_extract(s.data,'$.timestamp'),json_extract(e.data,'$.timestamp')) AS timestamp,
      json_extract(p.data,'$.title') AS project_title,json_extract(p.data,'$.mode') AS mode,
      CASE WHEN json_extract(p.data,'$.mode')='general' THEN
        CASE json_extract(r.data,'$.task_type') ${Object.entries(LEGACY_GENERAL_ROLES).map(([old, role]) => `WHEN '${old}' THEN '${role}'`).join(' ')} ELSE json_extract(r.data,'$.task_type') END
        ELSE CASE WHEN json_extract(r.data,'$.task_type')='reporter' THEN 'soldier' ELSE json_extract(r.data,'$.task_type') END END AS role,
      CASE WHEN c.end_id IS NULL THEN 'unfinished' WHEN json_extract(e.data,'$.error') THEN 'failed' ELSE 'succeeded' END AS status
    FROM calls c LEFT JOIN audit_events s ON s.id=c.start_id LEFT JOIN audit_events e ON e.id=c.end_id
      JOIN audit_runs r ON r.id=c.run_id JOIN projects p ON p.id=r.project_id
  ), filtered AS MATERIALIZED (
    SELECT * FROM paired WHERE name IN (SELECT value FROM json_each(?))
      AND (?='' OR mode=?) AND (?='' OR role=?) AND (?='' OR julianday(timestamp)>=julianday(?)) AND (?='' OR julianday(timestamp)<=julianday(?))
  ), counts AS (
    SELECT name,action,COUNT(*) AS calls,SUM(status='succeeded') AS succeeded,
      SUM(status='failed') AS failed,SUM(status='unfinished') AS unfinished,MAX(timestamp) AS last_call
    FROM filtered GROUP BY name,action ORDER BY name,action
  ), page AS MATERIALIZED (
    SELECT * FROM filtered WHERE name=? ORDER BY julianday(timestamp) DESC,run_id,call_id LIMIT ? OFFSET ?
  ), history AS (
    SELECT f.run_id,f.call_id,f.project_id,f.graph_id,f.name,f.original_name,f.action,f.timestamp,f.project_title,f.mode,f.role,f.status,
      json_extract(g.data,'$.title') AS graph_title,
      CASE WHEN f.start_id IS NOT NULL AND f.end_id IS NOT NULL THEN MAX(0,ROUND((julianday(json_extract(e.data,'$.timestamp'))-julianday(json_extract(s.data,'$.timestamp')))*86400000)) END AS duration_ms,
      SUBSTR(COALESCE(json_extract(s.data,'$.arguments'),json_extract(e.data,'$.arguments'),''),1,1200) AS arguments_summary,
      SUBSTR(COALESCE(json_extract(e.data,'$.content'),json_extract(e.data,'$.error_message'),''),1,2000) AS result_summary
    FROM page f LEFT JOIN audit_events s ON s.id=f.start_id LEFT JOIN audit_events e ON e.id=f.end_id
      LEFT JOIN project_graphs g ON g.id=f.graph_id
    ORDER BY julianday(f.timestamp) DESC,f.run_id,f.call_id
  ) SELECT (SELECT json_group_array(json_object('name',name,'action',action,'calls',calls,'succeeded',succeeded,'failed',failed,'unfinished',unfinished,'last_call',last_call)) FROM counts) AS counts,
    (SELECT json_group_array(json_object('run_id',run_id,'call_id',call_id,'project_id',project_id,'graph_id',graph_id,'name',name,'original_name',original_name,'action',action,'timestamp',timestamp,'project_title',project_title,'mode',mode,'role',role,'status',status,'graph_title',graph_title,'duration_ms',duration_ms,'arguments_summary',arguments_summary,'result_summary',result_summary)) FROM history) AS history`
  const params = [...(project ? [project] : []), JSON.stringify(names), ...[mode, role, from, to].flatMap(value => [value, value]), name, limit, offset]
  const row = store.db.prepare(query).get(...params)!
  const counts = JSON.parse(String(row.counts)) as CallCounts[]
  const byName = new Map<string, Omit<CallCounts, 'action'>>()
  const fields = ['calls', 'succeeded', 'failed', 'unfinished'] as const
  const stats = { calls: 0, usedTools: 0, succeeded: 0, failed: 0, unfinished: 0 }
  for (const count of counts) {
    const tool = byName.get(count.name) ?? { name: count.name, calls: 0, succeeded: 0, failed: 0, unfinished: 0, last_call: null }
    for (const field of fields) { tool[field] += count[field]; stats[field] += count[field] }
    if (count.last_call && (!tool.last_call || count.last_call > tool.last_call)) tool.last_call = count.last_call
    byName.set(count.name, tool)
  }
  stats.usedTools = byName.size
  const tools = [...byName.values()].sort((a, b) => b.calls - a.calls || (a.name < b.name ? -1 : 1))
  return { stats, tools: tools.map(tool => ({ ...tool, share: tool.calls / stats.calls })), history: JSON.parse(String(row.history)) as Record<string, string | number | null>[],
    actions: counts.map(({ name, action, calls }) => ({ name, action, calls })), total: name ? byName.get(name)?.calls ?? 0 : stats.calls, offset, limit }
}
