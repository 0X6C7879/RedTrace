import type {Store} from './store.ts'
import {HttpError} from './types.ts'
import {auditSummaries} from './audit-projection.ts'
export interface TracePage {after?:number;before?:number;limit?:number;query?:string;eventId?:number;includeThinking?:boolean}
/** Audit is canonical; Planner reads a locator index unless it requests one exact event. */
export function readRunTrace(store:Store,projectId:string,runId:string,page:TracePage={},graphId?:string) {
 const run=store.run(runId)
 if(run.projectId!==projectId||graphId&&run.graphId!==graphId)throw new HttpError(403,'Run belongs to another task or Project')
 const scope='run_id=?'
 const summary={id:run.id,graphId:run.graphId,stepId:run.stepId,activity:run.activity,worker:run.worker,status:run.status,error:run.error,failureCode:run.failureCode,startedAt:run.startedAt,endedAt:run.endedAt,pendingTools:run.pendingTools.length,predecessorRunId:run.predecessorRunId,tokens:{input:run.inputTokens,output:run.outputTokens,cacheRead:run.cacheReadTokens,cacheWrite:run.cacheWriteTokens}}
 if(page.eventId!==undefined){const row=store.db.prepare('SELECT id,data FROM audit_events WHERE '+scope+' AND id=?').get(runId,page.eventId);if(!row)throw new HttpError(404,'Audit event not found');const total=Number(store.db.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE '+scope).get(runId)!.n);return{run:summary,total,event:{...JSON.parse(String(row.data)),id:Number(row.id)}}}
 const limit=page.limit??30,backward=page.before!==undefined,values=[page.after??0,page.before??Number.MAX_SAFE_INTEGER,...(page.query?[page.query]:[])]
 const filter="id>? AND id<?"+(page.query?' AND instr(lower(data),lower(?))>0':'')+(page.includeThinking?'':" AND COALESCE(kind,'') NOT IN ('thinking.message','thinking.delta','system.prompt','user.message')")
 const counts=store.db.prepare('SELECT COUNT(*) AS total, COUNT(CASE WHEN '+filter+' THEN 1 END) AS matching FROM audit_events WHERE '+scope).get(...values,runId)!
 const total=Number(counts.total),matching=Number(counts.matching)
 const rows=store.db.prepare('SELECT id,CAST(data AS BLOB) AS data FROM audit_events WHERE '+scope+' AND '+filter+' ORDER BY id '+(backward?'DESC':'ASC')+' LIMIT ?').all(runId,...values,limit)
 const events=auditSummaries(rows).sort((a,b)=>a.id-b.id)
 return{run:summary,total,matching,events,range:{after:page.after??0,before:page.before??null,limit,first:events[0]?.id??null,last:events.at(-1)?.id??null},hasMore:matching>rows.length,nextAfter:!backward&&matching>rows.length?events.at(-1)?.id:null,nextBefore:backward&&matching>rows.length?events[0]?.id:null}
}
