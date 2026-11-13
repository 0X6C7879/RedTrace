import {randomUUID} from 'node:crypto'
import {Store} from './store.ts'
import {ProjectEvidence} from './project-evidence.ts'
import {HttpError,requiredText,now} from './types.ts'
import type {Fact,Step} from './types.ts'

/** Documents and FTS are retained knowledge, never a second project state graph. */
export class LegionExperience {
  readonly store:Store
  readonly workspaceRoot:string
  constructor(store:Store,workspaceRoot:string){
    this.store=store;this.workspaceRoot=workspaceRoot
    store.db.exec("CREATE TABLE IF NOT EXISTS legion_experience(id INTEGER PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,family TEXT NOT NULL,title TEXT NOT NULL,body TEXT NOT NULL,artifact_id TEXT NOT NULL,fact_ids TEXT NOT NULL,created_at TEXT NOT NULL);CREATE VIRTUAL TABLE IF NOT EXISTS legion_experience_fts USING fts5(title,body,family,content='legion_experience',content_rowid='id');CREATE TRIGGER IF NOT EXISTS legion_experience_insert AFTER INSERT ON legion_experience BEGIN INSERT INTO legion_experience_fts(rowid,title,body,family) VALUES(new.id,new.title,new.body,new.family);END;CREATE TRIGGER IF NOT EXISTS legion_experience_delete AFTER DELETE ON legion_experience BEGIN INSERT INTO legion_experience_fts(legion_experience_fts,rowid,title,body,family) VALUES('delete',old.id,old.title,old.body,old.family);END;CREATE TABLE IF NOT EXISTS legion_transfers(id TEXT PRIMARY KEY,source_id INTEGER NOT NULL REFERENCES legion_experience(id) ON DELETE CASCADE,target_project TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,task_key TEXT NOT NULL,data TEXT NOT NULL)")
  }
  capture(projectId:string,input:{family:string;title:string;body:string;factIds:string[]}){
    this.store.project(projectId);if(!input.factIds.length)throw new HttpError(422,'Experience requires confirmed source Facts')
    for(const id of input.factIds){this.store.node(projectId,id,'fact');if(id==='origin')throw new HttpError(422,'Scope alone is not experience evidence')}
    const family=requiredText(input.family,'family'),title=requiredText(input.title,'title'),body=requiredText(input.body,'body')
    const document='# '+title+'\n\nFamily: '+family+'\nSource Project: '+projectId+'\nSource Facts: '+input.factIds.join(', ')+'\n\n'+body+'\n\nTransfer is a Hint only. Reverify product, version, scope and prerequisites in the target Project.\n'
    const artifact=new ProjectEvidence(this.store,this.workspaceRoot).publish(projectId,Buffer.from(document),{description:'Verified source experience: '+title})
    const row=this.store.db.prepare('INSERT INTO legion_experience(project_id,family,title,body,artifact_id,fact_ids,created_at) VALUES (?,?,?,?,?,?,?) RETURNING id').get(projectId,family,title,body,artifact.id,JSON.stringify(input.factIds),now())!
    return{id:Number(row.id),projectId,family,title,artifactId:artifact.id,sha256:artifact.sha256}
  }
  search(query:string,family?:string){
    const words=requiredText(query,'query').match(/[\p{L}\p{N}_-]+/gu)??[];if(!words.length)return[]
    const match=words.map(word=>'"'+word.replaceAll('"','""')+'"').join(' OR ')
    return this.store.db.prepare('SELECT e.id,e.project_id AS projectId,e.family,e.title,e.artifact_id AS artifactId,snippet(legion_experience_fts,1,\'[\',\']\',\'…\',32) AS snippet FROM legion_experience_fts JOIN legion_experience e ON e.id=legion_experience_fts.rowid WHERE legion_experience_fts MATCH ?'+(family?' AND e.family=?':'')+' ORDER BY bm25(legion_experience_fts) LIMIT 20').all(...(family?[match,family]:[match]))
  }
  transfer(sourceId:number,targetProject:string,taskKey:string,brief:string){
    const source=this.store.db.prepare('SELECT * FROM legion_experience WHERE id=?').get(sourceId);if(!source)throw new HttpError(404,'Experience not found')
    this.store.project(targetProject);requiredText(taskKey,'taskKey');requiredText(brief,'brief')
    const sourceView=Object.create(this.store) as Store
    Object.defineProperties(sourceView,{projectScope:{value:String(source.project_id)},graphScope:{value:undefined}})
    new ProjectEvidence(sourceView,this.workspaceRoot).read(String(source.project_id),String(source.artifact_id))
    const id='transfer-'+randomUUID(),content='[Family Transfer '+id+'] UNVERIFIED IN THIS TARGET. Source '+source.project_id+' / experience '+sourceId+' / family '+source.family+' / artifact '+source.artifact_id+'\n'+brief+'\nReverify target product/version and prerequisites before using this technique. Do not promote source claims into target Facts.'
    const graph=this.store.projectGraphs(targetProject).find(g=>g.taskKey===taskKey)??this.store.projectGraphs(targetProject).find(g=>g.type==='main')
    if(!graph)throw new HttpError(422,'Initialize the target task Graph before transfer')
    const hint=this.store.forGraph(targetProject,graph.id).addInput(targetProject,'hint',content,'commander')
    const data={id,sourceProjectId:String(source.project_id),sourceFactIds:JSON.parse(String(source.fact_ids)),targetProject,taskKey,hintId:hint.id,brief,confirmedFactIds:[],status:'needs-reverification'}
    this.store.db.prepare('INSERT INTO legion_transfers VALUES (?,?,?,?,?)').run(id,sourceId,targetProject,taskKey,JSON.stringify(data));return data
  }
  confirm(id:string,targetProject:string,factIds:string[]){
    const row=this.store.db.prepare('SELECT data FROM legion_transfers WHERE id=? AND target_project=?').get(id,targetProject);if(!row)throw new HttpError(404,'Transfer is not in this target Project')
    const data=JSON.parse(String(row.data));if(!factIds.length)throw new HttpError(422,'Target re-verification requires target Facts')
    for(const fid of factIds){const fact=this.store.node<Fact>(targetProject,fid,'fact');if(fid==='origin'||!fact.stepId||this.store.node<Step>(targetProject,fact.stepId,'step').taskKey!==data.taskKey)throw new HttpError(422,'Re-verification must come from this target task')}
    data.status='target-verified';data.confirmedFactIds=factIds;this.store.db.prepare('UPDATE legion_transfers SET data=? WHERE id=?').run(JSON.stringify(data),id);return data
  }
  transfers(projectId?:string){return this.store.db.prepare('SELECT data FROM legion_transfers'+(projectId?' WHERE target_project=?':'')).all(...(projectId?[projectId]:[])).map(r=>JSON.parse(String(r.data)))}
}
