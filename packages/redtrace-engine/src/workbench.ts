import type { Store } from './store.ts'
import { HttpError } from './types.ts'
import type { Step, Finding } from './types.ts'
import { conversationAuditEvents } from './store.ts'
import { LegionStore } from './legion-store.ts'
import type { Router } from './http.ts'
import { queryNumber } from './http.ts'

/** Labels derive from persisted execution order, never the currently visible subset. */
export function workerInstances(store: Store, projectId: string) {
  const steps = new Map(store.nodes<Step>(projectId,['step']).map(s=>[s.id,s]))
  const counts = new Map<string,number>()
  const evidence=new Map(store.db.prepare("SELECT json_extract(data,'$.producerRunId') AS producer,COUNT(*) AS n FROM nodes WHERE project_id=? AND kind IN ('fact','finding') GROUP BY producer").all(projectId).map(r=>[String(r.producer),Number(r.n)]))
  return store.runs(projectId).filter(r=>r.stepId).map(run=>{
    const step=steps.get(run.stepId!)!, role=step.specialist?.name ?? ({soldier:'Soldier',general:'General',scout:'Scout',reporter:'Reporter',worker:'Worker'}[step.role??'soldier'])
    const n=(counts.get(role)??0)+1; counts.set(role,n)
    const tokens=run.inputTokens+run.outputTokens+run.cacheReadTokens+run.cacheWriteTokens
    const facts=evidence.get(run.id)??0
    return {...run,role:step.role,label:role+n,specialist:step.specialist,mission:step.description,taskKey:step.taskKey,handoff:run.handoff??step.handoff,facts,tokens,elapsedMs:Math.max(0,Date.parse(run.endedAt??new Date().toISOString())-Date.parse(run.startedAt))}
  })
}

export function projectWorkbench(store:Store,legion:LegionStore,id:string) {
    const project=store.project(id),graphs=store.projectGraphs(id),workers=workerInstances(store,id)
    const goals=store.nodes(id,['goal']),steps=store.nodes<Step>(id,['step'])
    const findings=store.nodes<Finding>(id,['finding'])
    return {project,graphs,workers,pendingAgents:steps.filter(s=>s.status==='pending'&&!workers.some(w=>w.stepId===s.id&&w.status==='running')).map(s=>({stepId:s.id,graphId:s.graphId,role:s.role,specialist:s.specialist,title:s.specialist?.name??s.role??'Soldier',mission:s.description})),goals,steps,findings,todos:project.mode==='general'?legion.planningTodos(id).list(graphs[0].id):[],
      conversations:project.mode==='benchmark'?graphs.filter(g=>g.type==='benchmark_task').map(g=>({id:g.id,title:g.title,graphId:g.id,running:workers.some(w=>w.graphId===g.id&&w.status==='running'),updatedAt:g.updatedAt})):workers.map(w=>({id:w.id,title:w.label,runId:w.id,graphId:w.graphId,running:w.status==='running',updatedAt:w.endedAt??w.startedAt})),
      anomalies:workers.filter(w=>['failed','unknown'].includes(w.status)).map(w=>({runId:w.id,label:w.label,error:w.error,status:w.status}))}
}
export function workbenchRoutes(router:Router,store:Store,legion:LegionStore) {
  router.add('GET','/v2/projects/:project/workbench',c=>projectWorkbench(store,legion,c.params.project))
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
    return {todos:graph?legion.planningTodos(id).list(graph):[],eventCursor:rawGraphEvents.at(-1)?.id??queryNumber(c.url,'eventAfter',0),events:events.sort((a,b)=>Number(a.id)-Number(b.id)),messages,graphEvents,workers:own,
      cursor:rows.length?Math.max(...rows.map(r=>Number(r.id))):cursor,before:rows.length?Math.min(...rows.map(r=>Number(r.id))):null,hasMore:rows.length===limit}
  })
}
