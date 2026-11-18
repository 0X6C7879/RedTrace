import type {Store} from './store.ts'
import {HttpError} from './types.ts'
export interface TracePage {after?:number;before?:number;limit?:number;query?:string;eventId?:number;includeThinking?:boolean}
/** Audit is canonical; Planner reads a locator index unless it requests one exact event. */
export function readRunTrace(store:Store,projectId:string,runId:string,page:TracePage={},graphId?:string) {
 const run=store.run(runId)
 if(run.projectId!==projectId||graphId&&run.graphId!==graphId)throw new HttpError(403,'Run belongs to another task or Project')
 const total=Number(store.db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE project_id=? AND run_id=?').get(projectId,runId)!.n)
 const summary={id:run.id,graphId:run.graphId,stepId:run.stepId,activity:run.activity,worker:run.worker,status:run.status,error:run.error,failureCode:run.failureCode,startedAt:run.startedAt,endedAt:run.endedAt,pendingTools:run.pendingTools.length,predecessorRunId:run.predecessorRunId,tokens:{input:run.inputTokens,output:run.outputTokens,cacheRead:run.cacheReadTokens,cacheWrite:run.cacheWriteTokens}}
 if(page.eventId!==undefined){const row=store.db.prepare('SELECT id,data FROM audit_events WHERE project_id=? AND run_id=? AND id=?').get(projectId,runId,page.eventId);if(!row)throw new HttpError(404,'Audit event not found');return{run:summary,total,event:{...JSON.parse(String(row.data)),id:Number(row.id)}}}
 const limit=page.limit??30,backward=page.before!==undefined,values=[projectId,runId,page.after??0,page.before??Number.MAX_SAFE_INTEGER,page.query??'']
 const filter="project_id=? AND run_id=? AND id>? AND id<? AND instr(lower(data),lower(?))>0"+(page.includeThinking?'':" AND COALESCE(json_extract(data,'$.kind'),'') NOT IN ('thinking.message','thinking.delta','system.prompt','user.message')")
 const matching=Number(store.db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE '+filter).get(...values)!.n)
 const rows=store.db.prepare('SELECT id,data FROM audit_events WHERE '+filter+' ORDER BY id '+(backward?'DESC':'ASC')+' LIMIT ?').all(...values,limit)
 const events=rows.map(row=>{const event=JSON.parse(String(row.data));return{id:Number(row.id),kind:event.kind,title:event.title,callId:event.call_id,timestamp:event.timestamp,error:event.error,summary:typeof event.content==='string'?event.content.slice(0,180):undefined,detailAvailable:true}}).sort((a,b)=>a.id-b.id)
 return{run:summary,total,matching,events,range:{after:page.after??0,before:page.before??null,limit,first:events[0]?.id??null,last:events.at(-1)?.id??null},hasMore:matching>rows.length,nextAfter:!backward&&matching>rows.length?events.at(-1)?.id:null,nextBefore:backward&&matching>rows.length?events[0]?.id:null}
}
