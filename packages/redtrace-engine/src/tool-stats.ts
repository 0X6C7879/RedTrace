import type { Store } from './store.ts'
import { queryNumber } from './http.ts'

interface CallCounts {
  name: string; action: string | null; calls: number; succeeded: number; failed: number; unfinished: number; last_call: string | null
}

/** One row per native call, including PTC children; starts are not outcomes. */
export function toolStatistics(store: Store, url: URL, names: string[]) {
  const [project, mode, role, from, to, name] = ['projectId', 'mode', 'role', 'from', 'to', 'tool'].map(key => url.searchParams.get(key) ?? '')
  const offset = queryNumber(url, 'offset', 0), limit = queryNumber(url, 'limit', 100, 1, 200)
  const query = `WITH filtered AS MATERIALIZED (
    SELECT * FROM tool_calls WHERE name IN (SELECT value FROM json_each(?)) ${project ? 'AND project_id=?' : ''}
      AND (?='' OR mode=?) AND (?='' OR role=?) AND (?='' OR julianday(timestamp)>=julianday(?)) AND (?='' OR julianday(timestamp)<=julianday(?))
  ), counts AS (
    SELECT name,action,COUNT(*) AS calls,SUM(status='succeeded') AS succeeded,
      SUM(status='failed') AS failed,SUM(status='unfinished') AS unfinished,MAX(timestamp) AS last_call
    FROM filtered GROUP BY name,action ORDER BY name,action
  ), page AS MATERIALIZED (
    SELECT * FROM filtered WHERE name=? ORDER BY julianday(timestamp) DESC,run_id,call_id LIMIT ? OFFSET ?
  ), history AS (
    SELECT f.run_id,f.call_id,f.project_id,f.graph_id,f.name,f.original_name,f.action,f.timestamp,json_extract(p.data,'$.title') AS project_title,f.mode,f.role,f.status,
      json_extract(g.data,'$.title') AS graph_title,
      CASE WHEN f.start_id IS NOT NULL AND f.end_id IS NOT NULL THEN MAX(0,ROUND((julianday(json_extract(e.data,'$.timestamp'))-julianday(json_extract(s.data,'$.timestamp')))*86400000)) END AS duration_ms,
      SUBSTR(COALESCE(json_extract(s.data,'$.arguments'),json_extract(e.data,'$.arguments'),''),1,1200) AS arguments_summary,
      SUBSTR(COALESCE(json_extract(e.data,'$.content'),json_extract(e.data,'$.error_message'),''),1,2000) AS result_summary
    FROM page f LEFT JOIN audit_events s ON s.id=f.start_id LEFT JOIN audit_events e ON e.id=f.end_id
      JOIN projects p ON p.id=f.project_id LEFT JOIN project_graphs g ON g.id=f.graph_id
    ORDER BY julianday(f.timestamp) DESC,f.run_id,f.call_id
  ) SELECT (SELECT json_group_array(json_object('name',name,'action',action,'calls',calls,'succeeded',succeeded,'failed',failed,'unfinished',unfinished,'last_call',last_call)) FROM counts) AS counts,
    (SELECT json_group_array(json_object('run_id',run_id,'call_id',call_id,'project_id',project_id,'graph_id',graph_id,'name',name,'original_name',original_name,'action',action,'timestamp',timestamp,'project_title',project_title,'mode',mode,'role',role,'status',status,'graph_title',graph_title,'duration_ms',duration_ms,'arguments_summary',arguments_summary,'result_summary',result_summary)) FROM history) AS history`
  const params = [JSON.stringify(names), ...(project ? [project] : []), ...[mode, role, from, to].flatMap(value => [value, value]), name, limit, offset]
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
