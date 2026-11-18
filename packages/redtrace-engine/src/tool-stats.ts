import { TOOL_DOMAINS } from '../../redtrace-dsh/src/tool-domains.ts'
import { LEGACY_GENERAL_ROLES } from '../../redtrace-dsh/src/roles.ts'
import type { Store } from './store.ts'
import { queryNumber } from './http.ts'

/** One row per native call, including PTC children; starts are not outcomes. */
export function toolStatistics(store: Store, url: URL, names: string[]) {
  const originalName="COALESCE(json_extract(s.data,'$.title'),json_extract(e.data,'$.title'))"
  const aliases=Object.entries(TOOL_DOMAINS).flatMap(([name,actions])=>Object.entries(actions).map(([action,original])=>({name,action,original})))
  const mapped=(field:'name'|'action')=>`CASE ${originalName} ${aliases.map(a=>`WHEN '${a.original}' THEN '${a[field]}'`).join(' ')} ELSE ${field==='name'?originalName:'NULL'} END`
  const query = `WITH calls AS (
    SELECT run_id, json_extract(data,'$.call_id') AS call_id,
      MIN(CASE WHEN json_extract(data,'$.kind')='tool.started' THEN id END) AS start_id,
      MAX(CASE WHEN json_extract(data,'$.kind')='tool.completed' THEN id END) AS end_id
    FROM audit_events WHERE json_extract(data,'$.kind') IN ('tool.started','tool.completed')
      AND COALESCE(json_extract(data,'$.call_id'),'')<>'' GROUP BY run_id,call_id
  ), paired AS (
    SELECT c.run_id,c.call_id,r.project_id,
      COALESCE(json_extract(r.data,'$.graph_id'),json_extract(s.data,'$.graph_id'),json_extract(e.data,'$.graph_id')) AS graph_id,
      ${mapped('name')} AS name,${originalName} AS original_name,
      COALESCE(json_extract(s.data,'$.arguments.action'),${mapped('action')}) AS action,
      COALESCE(json_extract(s.data,'$.timestamp'),json_extract(e.data,'$.timestamp')) AS timestamp,
      json_extract(p.data,'$.title') AS project_title,json_extract(p.data,'$.mode') AS mode,
      CASE WHEN json_extract(p.data,'$.mode')='general' THEN
        CASE json_extract(r.data,'$.task_type') ${Object.entries(LEGACY_GENERAL_ROLES).map(([old,role])=>`WHEN '${old}' THEN '${role}'`).join(' ')} ELSE json_extract(r.data,'$.task_type') END
        ELSE CASE WHEN json_extract(r.data,'$.task_type')='reporter' THEN 'soldier' ELSE json_extract(r.data,'$.task_type') END END AS role,
      CASE WHEN c.end_id IS NULL THEN 'unfinished' WHEN json_extract(e.data,'$.error') THEN 'failed' ELSE 'succeeded' END AS status,
      CASE WHEN c.start_id IS NOT NULL AND c.end_id IS NOT NULL THEN MAX(0,ROUND((julianday(json_extract(e.data,'$.timestamp'))-julianday(json_extract(s.data,'$.timestamp')))*86400000)) END AS duration_ms,
      SUBSTR(COALESCE(json_extract(s.data,'$.arguments'),json_extract(e.data,'$.arguments'),''),1,1200) AS arguments_summary,
      SUBSTR(COALESCE(json_extract(e.data,'$.content'),json_extract(e.data,'$.error_message'),''),1,2000) AS result_summary
    FROM calls c LEFT JOIN audit_events s ON s.id=c.start_id LEFT JOIN audit_events e ON e.id=c.end_id
      JOIN audit_runs r ON r.id=c.run_id JOIN projects p ON p.id=r.project_id
  ), filtered AS (
    SELECT *, (SELECT json_extract(data,'$.title') FROM project_graphs WHERE id=paired.graph_id) AS graph_title
    FROM paired WHERE name IN (SELECT value FROM json_each(?))
      AND (?='' OR project_id=?) AND (?='' OR mode=?) AND (?='' OR role=?)
      AND (?='' OR timestamp>=?) AND (?='' OR timestamp<=?)
  ) `
  const filters = ['projectId','mode','role','from','to'].flatMap(key => { const value=url.searchParams.get(key)??''; return [value,value] })
  const params = [JSON.stringify(names), ...filters]
  const tools = store.db.prepare(query+`SELECT name,COUNT(*) AS calls,
    SUM(status='succeeded') AS succeeded,SUM(status='failed') AS failed,SUM(status='unfinished') AS unfinished,
    MAX(timestamp) AS last_call FROM filtered GROUP BY name ORDER BY calls DESC,name`).all(...params)
  const total = tools.reduce((n,t)=>n+Number(t.calls),0)
  const stats = { calls: total, usedTools: tools.length, succeeded: 0, failed: 0, unfinished: 0 }
  for (const tool of tools) for (const key of ['succeeded','failed','unfinished'] as const) stats[key]+=Number(tool[key])
  const name=url.searchParams.get('tool')??'',offset=queryNumber(url,'offset',0),limit=queryNumber(url,'limit',100,1,200)
  const history = name ? store.db.prepare(query+`SELECT * FROM filtered WHERE name=? ORDER BY timestamp DESC,run_id,call_id LIMIT ? OFFSET ?`).all(...params,name,limit,offset) : []
  return { stats, tools:tools.map(t=>({...t,name:t.name,share:total?Number(t.calls)/total:0})), history,
    actions:store.db.prepare(query+`SELECT name,action,COUNT(*) AS calls FROM filtered GROUP BY name,action ORDER BY name,action`).all(...params),
    total:name?Number(tools.find(t=>t.name===name)?.calls??0):total,offset,limit }
}
