#!/usr/bin/env node
import path from'node:path'
import os from'node:os'
import{parseArgs}from'node:util'
import{createHash}from'node:crypto'
import{backup,DatabaseSync}from'node:sqlite'
import{mkdir,readFile,writeFile,readdir,lstat,readlink,cp,rm,chmod,mkdtemp}from'node:fs/promises'
import{existsSync}from'node:fs'
import{execFileSync}from'node:child_process'
import{Configuration}from'../packages/redtrace-engine/src/config.ts'
import{Store}from'../packages/redtrace-engine/src/store.ts'
import{LegionStore}from'../packages/redtrace-engine/src/legion-store.ts'
import{ProjectEvidence}from'../packages/redtrace-engine/src/project-evidence.ts'
import{cutoverPreflight,resetLegionRuntime}from'../packages/redtrace-engine/src/legion-cutover.ts'
import{load}from'../packages/redtrace-dsh/lib/loader.js'
const{values}=parseArgs({options:{root:{type:'string',default:process.cwd()},backup:{type:'string'},acceptance:{type:'string'},apply:{type:'boolean',default:false}}})
const root=path.resolve(values.root),managed=path.join(root,'.redtrace'),sessionRoot=path.join(managed,'sessions'),configuration=new Configuration(root),digest=b=>createHash('sha256').update(b).digest('hex')
const skillCopies=[]
if(values.apply){if(!values.acceptance||!values.backup)throw Error('--apply requires --acceptance FILE and a fresh --backup DIRECTORY');const accepted=JSON.parse(await readFile(values.acceptance,'utf8'));for(const stage of ['E1','E2','E3','E4','E5','E6'])if(accepted.gates?.[stage]!==true)throw Error(stage+' acceptance is not recorded');if(!Object.keys(accepted.sourceHashes??{}).length)throw Error('Acceptance has no source hashes');for(const[file,sha]of Object.entries(accepted.sourceHashes))if(digest(await readFile(path.join(import.meta.dirname,'..',file)))!==sha)throw Error('Source changed after acceptance: '+file);for(const migration of accepted.skillMigrations??[]){if(!migration.path.startsWith('skills/')||migration.path.split('/').includes('..'))throw Error('Invalid Skill migration path');const target=path.join(root,migration.path),source=path.join(import.meta.dirname,'..',migration.path);if(!existsSync(target))continue;const current=digest(await readFile(target));if(current!==migration.before&&current!==migration.after)throw Error('Installed Skill has local drift: '+migration.path);if(digest(await readFile(source))!==migration.after)throw Error('Source Skill changed: '+migration.path);if(current!==migration.after)skillCopies.push({source,target})}}
const{Context}=await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'),persistence=await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js'),attachments=await load('vendor/deepseek-harness/packages/attachment/attachment-local/lib/index.js'),ctx=new Context(),store=new Store(path.join(managed,'engine.db'))
let disposed=false
try{
 await ctx.plugin(persistence,{root:sessionRoot,compression:'none'}).await();await ctx.plugin(attachments.default,{dshHome:process.env.DSH_HOME??path.join(os.homedir(),'.dsh')}).await()
 const services={sessionPersistence:ctx.get('sessionPersistence'),attachments:ctx.get('attachments')},legion=new LegionStore(store),evidence=new ProjectEvidence(store,configuration.workspaceRoot)
 const sessions=await services.sessionPersistence.list()
 // Native write ownership is the existing cross-process stopped-session proof.
 for(const session of sessions){const h=await services.sessionPersistence.open(session.header.id,'write');await h.close()}
 if(values.apply){if(store.runs().some(r=>['running','paused','unknown'].includes(r.status)||r.pendingTools.length)||legion.campaign().status==='running')throw Error('Stop/resolve actual executions before applying E7');for(const p of store.projects())if(p.status==='active')store.setStatus(p.id,'stopped')}
 const plan=await cutoverPreflight(store,evidence,services)
 if(!values.apply){console.log(JSON.stringify({mode:'preflight',dataReady:plan.dataReady,projects:plan.projects.map(p=>({projectId:p.projectId,dataReady:p.dataReady,blockers:p.blockers})),sessions:plan.sessions.length,cleanupAllowed:false},null,2));process.exitCode=plan.dataReady?0:1}
 else{
  if(!plan.dataReady)throw Error('Evidence preflight blockers: '+JSON.stringify(plan.projects.flatMap(p=>p.blockers)))
  const destination=path.resolve(values.backup);await mkdir(destination,{mode:0o700});const snapshot=await mkdtemp(path.join(destination,'snapshot-'))
  await cp(managed,path.join(snapshot,'.redtrace'),{recursive:true,preserveTimestamps:true});if(existsSync(configuration.workspaceRoot))await cp(configuration.workspaceRoot,path.join(snapshot,'workspaces'),{recursive:true,preserveTimestamps:true})
  for(const suffix of ['','-wal','-shm'])await rm(path.join(snapshot,'.redtrace/engine.db'+suffix),{force:true})
  await backup(store.db,path.join(snapshot,'.redtrace/engine.db'))
  const restored=new DatabaseSync(path.join(snapshot,'.redtrace/engine.db'),{readOnly:true});try{if(restored.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw Error('Backup database integrity failed');for(const table of ['projects','nodes','runs','audit_runs'])if(restored.prepare('SELECT COUNT(*) AS n FROM '+table).get().n!==store.db.prepare('SELECT COUNT(*) AS n FROM '+table).get().n)throw Error('Backup count mismatch: '+table)}finally{restored.close()}
  const inventory=async(directory)=>{const result={};async function visit(dir,relative=''){for(const entry of await readdir(dir,{withFileTypes:true})){const key=path.join(relative,entry.name),file=path.join(dir,entry.name);if(entry.isSymbolicLink())result[key]={link:await readlink(file)};else if(entry.isDirectory())await visit(file,key);else if(entry.isFile())result[key]={sha256:digest(await readFile(file)),bytes:(await lstat(file)).size}}}await visit(directory);return result}
  const manifest=await inventory(snapshot),archive=path.join(destination,'BACKUP.tar.gz');execFileSync('tar',['-czf',archive,'-C',snapshot,...await readdir(snapshot)]);await chmod(archive,0o600)
  const check=await mkdtemp(path.join(destination,'restore-check-'));execFileSync('tar',['-xzf',archive,'-C',check]);if(JSON.stringify(await inventory(check))!==JSON.stringify(manifest))throw Error('Backup archive reconstruction failed');await writeFile(path.join(destination,'BACKUP-HASHES.json'),JSON.stringify(manifest,null,2),{mode:0o600});await rm(check,{recursive:true});await rm(snapshot,{recursive:true})
  for(const session of plan.sessions)if((await services.sessionPersistence.stat(session.id))?.revision!==session.revision)throw Error('Session changed after preservation')
  const backupRecord={path:archive,sha256:digest(await readFile(archive))},result=resetLegionRuntime(store,evidence,plan,backupRecord)
  configuration.commit(configuration.read().revision,raw=>{const old=raw.tasks??{};raw.tasks={commander:old.commander??old.reason??{timeout:300,conclude_timeout:30},general:old.general??old.explore??{timeout:900,conclude_timeout:30},soldier:old.soldier??old.explore??old.bootstrap??{timeout:900,conclude_timeout:30}};raw.workers=raw.workers.map(w=>{const roles=w.roles??[...(w.reason!==false?['commander','general']:[]),...(w.explore!==false||w.bootstrap?['soldier']:[])];const{reason,explore,bootstrap,...rest}=w;return{...rest,roles:[...new Set(roles)]}})})
  const plugins=path.join(managed,'plugins.json');if(existsSync(plugins)){const manifest=JSON.parse(await readFile(plugins,'utf8'));for(const key of ['enabled','disabled'])if(manifest[key])manifest[key]=manifest[key].filter(id=>!['redtrace-reason','redtrace-explore','redtrace-bootstrap'].includes(id));await writeFile(plugins,JSON.stringify(manifest,null,2))}
  for(const item of skillCopies)await cp(item.source,item.target)
  await ctx.fiber.dispose();disposed=true;await rm(sessionRoot,{recursive:true,force:true});await mkdir(sessionRoot,{recursive:true})
  const report={...result,agentSessions:0,backup:backupRecord,configurationMigrated:true,installedSkillsMigrated:skillCopies.length,retainedArtifacts:store.db.prepare('SELECT COUNT(*) AS n FROM project_artifacts').get().n,serviceStarted:false}
  await writeFile(path.join(destination,'CUTOVER.json'),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify(report,null,2))
 }
}finally{if(!disposed)await ctx.fiber.dispose();store.close()}
