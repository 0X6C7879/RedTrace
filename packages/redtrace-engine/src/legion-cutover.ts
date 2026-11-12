import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {Store} from './store.ts'
import {LegionStore} from './legion-store.ts'
import {ProjectEvidence} from './project-evidence.ts'
import type {EvidenceSessionServices} from './project-evidence.ts'
import {HttpError,now} from './types.ts'

/** E7 only: evidence preparation is never a runtime-deletion permission. */
export async function cutoverPreflight(store:Store,evidence:ProjectEvidence,services:EvidenceSessionServices){
 const projects=[]
 for(const project of store.projects())projects.push(await evidence.preflightReset(project.id,services))
 return{projects,dataReady:projects.every(p=>p.dataReady),sessions:(await services.sessionPersistence.list()).map(s=>({id:s.header.id,revision:s.revision}))}
}
export function resetLegionRuntime(store:Store,evidence:ProjectEvidence,plan:Awaited<ReturnType<typeof cutoverPreflight>>,backup:{path:string;sha256:string}){
 if(createHash('sha256').update(readFileSync(backup.path)).digest('hex')!==backup.sha256)throw new HttpError(409,'Verified backup hash changed')
 if(!plan.dataReady||plan.projects.some(p=>!p.dataReady))throw new HttpError(409,'Evidence/runtime preflight has blockers')
 if(JSON.stringify(plan.projects.map(p=>p.projectId).sort())!==JSON.stringify(store.projects().map(p=>p.id).sort()))throw new HttpError(409,'Project inventory changed after preservation')
 const legion=new LegionStore(store)
 if(legion.campaign().status==='running'||store.runs().some(r=>['running','paused','unknown'].includes(r.status)||r.pendingTools.length))throw new HttpError(409,'Execution is not confirmed stopped')
 const count=(table:string)=>Number(store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get()!.n)
 const before={steps:Number(store.db.prepare("SELECT COUNT(*) AS n FROM nodes WHERE kind='step'").get()!.n),runs:count('runs'),auditRuns:count('audit_runs')}
 store.transaction(()=>{
  for(const p of plan.projects){if(store.project(p.projectId).revision!==p.observedRevision)throw new HttpError(409,'Project changed after preservation');for(const node of p.detachments)store.saveNode(node.after)}
  for(const table of ['audit_runs','runs','legion_messages','legion_tasks','campaign','critical_keys','events'])store.db.exec('DELETE FROM '+table)
  store.db.exec("DELETE FROM nodes WHERE kind='step'")
  const table=(name:string)=>!!store.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name)
  if(table('resource_leases'))store.db.exec('DELETE FROM resource_leases')
  if(table('shared_resources'))store.db.exec('UPDATE shared_resources SET intent_id=NULL')
  if(table('operation_tasks'))store.db.exec('UPDATE operation_tasks SET intent_id=NULL')
  for(const project of store.projects()){
   if(project.status==='active'||project.status==='deleting')throw new HttpError(409,'Project scheduling is not stopped')
   for(const node of store.nodes(project.id,['fact','finding','goal','hint','observation']))store.event(project.id,node.kind==='hint'?'hint.added':node.kind+'.retained',node,{})
   store.event(project.id,'project.legion_cutover',null,{backupSha256:backup.sha256})
  }
  const campaign=legion.campaign();legion.saveCampaign({...campaign,hasSession:false,status:'stopped',state:'Runtime cleared after verified evidence preservation and backup. Projects remain stopped; explicit resume only.'})
  store.db.prepare('INSERT OR REPLACE INTO metadata VALUES (?,?)').run('legion-cutover',JSON.stringify({at:now(),backupSha256:backup.sha256}))
 })
 for(const p of plan.projects)for(const row of store.db.prepare('SELECT id FROM project_artifacts WHERE project_id=?').all(p.projectId))evidence.read(p.projectId,String(row.id))
 if(store.db.prepare("SELECT 1 FROM nodes WHERE kind='step'").get()||store.runs().length||count('audit_runs'))throw new Error('Runtime reset verification failed')
 if(store.db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Retained database has dangling foreign references')
 return{before,after:{steps:0,runs:0,auditRuns:0},projects:store.projects().map(p=>({id:p.id,status:p.status})),agentSessionsPendingRemoval:plan.sessions.map(s=>s.id)}
}
