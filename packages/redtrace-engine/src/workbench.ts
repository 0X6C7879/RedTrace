import { tokenUsage } from './token-usage.ts'
import { taskTodoPlanner } from './legion-todos.ts'
import type { Store } from './store.ts'
import { HttpError } from './types.ts'
import type { Step, Finding, Goal, Run, GraphPlanner } from './types.ts'
import { conversationAuditEvents } from './store.ts'
import { LegionStore } from './legion-store.ts'
import type { Router } from './http.ts'
import { queryNumber } from './http.ts'

interface WorkerPageOptions { before?: number; limit: number; includeActive?: boolean; selectedRun?: string }

/** Label every run from its persisted position; load full records only for the requested page. */
function readWorkerInstances(store: Store, projectId: string, page?: WorkerPageOptions) {
  store.project(projectId)
  const scope = store.graphScope
  const planners = new Map(store.db.prepare("SELECT id,json_extract(data,'$.planner') AS planner FROM project_graphs WHERE project_id=? AND json_extract(data,'$.planner') IS NOT NULL").all(projectId)
    .map(row => [String(row.id), JSON.parse(String(row.planner)) as GraphPlanner]))
  const steps = new Map([...planners.values()].flatMap(planner => planner.legacyAssignments ?? []).map(step => [step.id, step]))
  for (const row of store.db.prepare("SELECT id,data FROM nodes WHERE project_id=? AND kind='step'").all(projectId)) {
    steps.set(String(row.id), JSON.parse(String(row.data)) as Step)
  }
  const positions = store.db.prepare("SELECT rowid,id,graph_id,step_id,activity,status FROM runs WHERE project_id=? AND (step_id IS NOT NULL OR activity='plan')"+(scope?' AND graph_id=?':'')+' ORDER BY rowid').all(...(scope?[projectId,scope]:[projectId]))
  const counts = new Map<string, number>()
  const indexed = positions.map(row => {
    const step = row.activity === 'plan' ? planners.get(String(row.graph_id)) : steps.get(String(row.step_id))
    if (!step) throw new HttpError(404, 'Run assignment not found')
    const specialist = 'specialist' in step ? step.specialist : undefined
    const label = specialist?.name ?? ({soldier:'Soldier',general:'General',scout:'Scout',reporter:'Reporter',worker:'Worker'}[step.role??'soldier'])
    const key = JSON.stringify([row.graph_id, label]), ordinal = (counts.get(key) ?? 0) + 1
    counts.set(key, ordinal)
    return { id: String(row.id), cursor: Number(row.rowid), status: row.status, step, specialist, label, key, ordinal }
  })
  const recent = page ? indexed.filter(w => w.cursor < (page.before ?? Number.MAX_SAFE_INTEGER)).slice(-(page.limit + 1)) : indexed
  const hasMore = !!page && recent.length > page.limit, entries = hasMore ? recent.slice(1) : recent
  const nextBefore = hasMore ? entries[0].cursor : null
  const first = entries[0]?.cursor ?? Number.MAX_SAFE_INTEGER
  const visible = page?.includeActive ? indexed.filter(w => w.cursor >= first || ['running','paused','unknown'].includes(String(w.status)) || w.id === page.selectedRun) : entries
  if (!visible.length) return { workers: [], nextBefore }

  const evidence = new Map(store.db.prepare("SELECT json_extract(data,'$.producerRunId') AS producer,COUNT(*) AS n FROM nodes WHERE project_id=? AND kind IN ('fact','finding') GROUP BY producer").all(projectId).map(r => [String(r.producer), Number(r.n)]))
  const details = new Map(store.db.prepare("SELECT id,json_remove(data,'$.checkpoint') AS data FROM runs WHERE id IN (SELECT value FROM json_each(?))").all(JSON.stringify(visible.map(w => w.id)))
    .map(row => [String(row.id), JSON.parse(String(row.data)) as Omit<Run, 'checkpoint'>]))
  const at = Date.now()
  const workers = visible.map(w => {
    const run = details.get(w.id)!, step = w.step
    const label = counts.get(w.key)! > 1 ? w.label + w.ordinal : w.label
    return { ...run, cursor: w.cursor, role: step.role, label, specialist: w.specialist, mission: step.description, taskKey: step.taskKey,
      handoff: run.handoff ?? step.handoff, facts: evidence.get(run.id) ?? 0,
      tokens: run.inputTokens + run.outputTokens + run.cacheReadTokens + run.cacheWriteTokens,
      elapsedMs: Math.max(0, (run.endedAt ? Date.parse(run.endedAt) : at) - Date.parse(run.startedAt)) }
  })
  return { workers, nextBefore }
}

export function workerInstances(store: Store, projectId: string) {
  return readWorkerInstances(store, projectId).workers
}

export function projectWorkbench(store:Store,legion:LegionStore,id:string,summary=false,selectedRun?:string) {
    const project=store.project(id),graphs=store.projectGraphs(id)
    const { workers, nextBefore } = readWorkerInstances(store, id, summary ? { limit: 100, includeActive: true, selectedRun } : undefined)
    const active = workers.filter(w => w.status === 'running')
    const activeSteps = new Set(active.map(w => w.stepId))
    const activeGraphs = new Set(active.map(w => w.graphId))
    const titles = new Map(graphs.map(g => [g.id, g.title]))
    const stepLimit = store.stepLimit()
    const goals=store.nodes<Goal>(id,['goal']),steps=store.nodes<Step>(id,['step'])
    const findings=store.nodes<Finding>(id,['finding'])
    return {project,graphs,workers,...(summary?{workerNextBefore:nextBefore}:{}),capacity:graphs.map(g=>store.planningCapacity(id,stepLimit,g.id)),planners:graphs.flatMap(g=>g.planner?[g.planner]:[]),usage:tokenUsage(store,id),pendingAgents:steps.filter(s=>s.status==='pending'&&!activeSteps.has(s.id)).map(s=>({stepId:s.id,graphId:s.graphId,role:s.role,specialist:s.specialist,title:s.specialist?.name??s.role??'Soldier',taskTitle:titles.get(s.graphId!),waitingReason:store.stepReady(s)?'等待执行额度':'等待前置证据',mission:s.description})),goals,steps,findings,todos:project.mode==='general'?legion.planningTodos(id).list(graphs[0].id):[],
      conversations:project.mode==='benchmark'?graphs.filter(g=>g.type==='benchmark_task').map(g=>({id:g.id,title:g.title,graphId:g.id,running:activeGraphs.has(g.id),updatedAt:g.updatedAt})):workers.map(w=>({id:w.id,title:w.label,runId:w.id,graphId:w.graphId,running:w.status==='running',updatedAt:w.endedAt??w.startedAt})),
      anomalies:workers.filter(w=>['failed','unknown'].includes(w.status)).map(w=>({runId:w.id,label:w.label,error:w.error,status:w.status}))}
}
export function workbenchRoutes(router:Router,store:Store,legion:LegionStore) {
  router.add('GET','/v2/projects/:project/workbench',c=>projectWorkbench(store,legion,c.params.project,c.url.searchParams.get('summary')==='1'))
  router.add('GET','/v2/projects/:project/workbench/workers',c=>{
    const id=c.params.project,graph=c.url.searchParams.get('graphId')
    return readWorkerInstances(graph?store.forGraph(id,graph):store,id,{before:queryNumber(c.url,'before',Number.MAX_SAFE_INTEGER),limit:queryNumber(c.url,'limit',100,1,500)})
  })
  router.add('GET','/v2/projects/:project/conversation',c=>{
    const id=c.params.project;store.project(id)
    const graph=c.url.searchParams.get('graphId'),runId=c.url.searchParams.get('runId')
    if(graph)store.projectGraph(id,graph)
    if(runId && (store.run(runId).projectId!==id || graph&&store.run(runId).graphId!==graph)) throw new HttpError(404,'Run does not belong to conversation')
    const before=c.url.searchParams.has('before'),cursor=queryNumber(c.url,before?'before':'after',before?Number.MAX_SAFE_INTEGER:0),limit=queryNumber(c.url,'limit',100,1,500)
    const filter=(graph?' AND run_id IN (SELECT id FROM runs WHERE project_id=? AND graph_id=?)':'')+(runId?' AND run_id=?':'')
    const params=[id,...(graph?[id,graph]:[]),...(runId?[runId]:[]),cursor,limit]
    const rows=store.db.prepare('SELECT id,data FROM audit_events WHERE project_id=?'+filter+' AND id'+(before?'<':'>')+'? ORDER BY id '+(before?'DESC':'ASC')+' LIMIT ?').all(...params)
    const events=rows.flatMap(row=>conversationAuditEvents({...JSON.parse(String(row.data)),id:Number(row.id)})).filter(e=>!['assistant.delta','thinking.delta'].includes(String(e.kind)))
    const workers=workerInstances(store,id),own=workers.filter(w=>(!graph||w.graphId===graph)&&(!runId||w.id===runId)),ids=new Set(own.map(w=>w.id))
    const messages=store.db.prepare('SELECT data FROM legion_messages WHERE project_id=? ORDER BY created_at DESC LIMIT 500').all(id).map(r=>JSON.parse(String(r.data))).filter(m=>ids.has(m.sender)||ids.has(m.receiver))
    const view=graph?store.forGraph(id,graph):store
    const rawGraphEvents=view.events(id,queryNumber(c.url,'eventAfter',0),100)
    const graphEvents=rawGraphEvents.filter(e=>!runId||e.nodeId===store.run(runId).stepId)
    const planner=graph?store.projectGraph(id,graph).planner??store.forGraph(id,graph).nodes<Step>(id,['step']).map(s=>taskTodoPlanner(s,store)).find(Boolean):undefined
    return {usage:tokenUsage(store,id,graph??undefined,runId??undefined),taskPlanner:planner?{stepId:planner.id,role:planner.role,status:planner.status}:null,todos:graph?legion.planningTodos(id).list(graph):[],eventCursor:rawGraphEvents.at(-1)?.id??queryNumber(c.url,'eventAfter',0),events:events.sort((a,b)=>Number(a.id)-Number(b.id)),messages,graphEvents,workers:own,
      cursor:rows.length?Math.max(...rows.map(r=>Number(r.id))):cursor,before:rows.length?Math.min(...rows.map(r=>Number(r.id))):null,hasMore:rows.length===limit}
  })
}
