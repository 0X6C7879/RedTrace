import assert from 'node:assert/strict'
import { mkdtempSync, symlinkSync, rmSync, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { pathToFileURL } from 'node:url'
const root=process.argv[2], {Configuration}=await import(pathToFileURL(root+'/packages/redtrace-engine/src/config.ts'))
const configured=new Configuration(root).resolvedSnapshot().config
const source=process.env.LEGION_ACCEPT_API_KEY ? { ...configured, workers:[{enabled:true,backend:'dsh',provider:'acceptance',model:process.env.LEGION_ACCEPT_MODEL}],providers:{acceptance:{api:'openai-completions',baseUrl:process.env.LEGION_ACCEPT_BASE_URL,apiKey:process.env.LEGION_ACCEPT_API_KEY,models:[{id:process.env.LEGION_ACCEPT_MODEL,contextWindow:64000,maxTokens:6000,reasoning:'off',reasoningEfforts:false,thinkingFormat:'none'}]}} } : configured
const route=source.workers.find(w=>w.enabled&&w.backend==='dsh')
assert.ok(route,'No configured enabled real DSH worker')
const work=mkdtempSync(path.join(tmpdir(),'redtrace-legion-real-model-')); let child,ended=false,log=''
try {
  symlinkSync(root+'/static',work+'/static')
  const config=new Configuration(work);config.initialize();config.commit(config.read().revision,raw=>{
    const p=source.providers[route.provider]
    raw.providers={ [route.provider]: {api:p.api,base_url:p.baseUrl,...(p.apiKey?{api_key:p.apiKey}:{}),...(p.apiKeyEnv?{api_key_env:p.apiKeyEnv}:{}),models:p.models.map(m=>({id:m.id,context_window:m.contextWindow,max_tokens:m.maxTokens,reasoning:m.reasoning??'auto_max',reasoning_efforts:m.reasoningEfforts,thinking_format:m.thinkingFormat}))} }
    raw.workers=['commander','general','soldier','scout'].map(role=>({name:role,roles:[role],provider:route.provider,model:route.model,reason:false,explore:false,bootstrap:false,max_running:role==='soldier'?2:1}))
    raw.runtime={max_workers:4,max_project_workers:4,max_running_projects:1}
    raw.tasks=Object.fromEntries(['commander','general','soldier','scout'].map(role=>[role,{timeout:180,conclude_timeout:5}]))
  })
  const reservation=createServer();await new Promise(r=>reservation.listen(0,'127.0.0.1',r));const port=reservation.address().port;await new Promise(r=>reservation.close(r));const base='http://127.0.0.1:'+port
  child=spawn(process.execPath,[root+'/scripts/run-redtrace-node.mjs','--root',work,'--host','127.0.0.1','--port',String(port)],{cwd:root,env:{...process.env,DSH_HOME:work+'/.dsh',REDTRACE_SOURCE_ROOT:root,REDTRACE_CODE_ROOT:root,REDTRACE_DATA_ROOT:work+'/.redtrace'},stdio:['ignore','pipe','pipe']})
  const closed=new Promise(r=>child.once('close',()=>{ended=true;r()}));for(const s of [child.stdout,child.stderr])s.on('data',b=>log=(log+b).slice(-16000))
  const until=Date.now()+20000;while(Date.now()<until){try{if((await fetch(base+'/runtime/config')).ok)break}catch{}if(ended)throw Error('Host exited before readiness');await delay(50)}
  const call=async(route,body)=>{const r=await fetch(base+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{});const v=await r.json();if(!r.ok)throw Error('HTTP '+r.status+': '+JSON.stringify(v));return v}
  const graph=await call('/v2/projects',{title:'Authorized local four-role computation acceptance',origin:'LOCAL FIXTURE ONLY. This Scope is already confirmed Fact id=origin. The initial Scout MUST use sourceIds=[origin], goalId=goal, taskKey=local-coordination. All later actors and classification use that same taskKey. Never use a Goal ID as sourceIds. No network targets, recon, exploits, flag/platform operations or credentials are authorized. Inputs: lane A=[2,3], lane B=[3,4]. Required coordination protocol: Commander asks Scout to classify this local harness as hard/coordination, then dispatches one General. Commander MUST WAIT for the Scout Step to be done before spawning General. General MUST stay active, delegate exactly TWO Soldier Steps with disjoint lanes, and verify BOTH results from shared FGS. Use exact relative hyphen filenames lane-a.txt and lane-b.txt, no alternate names. Each Soldier uses ONE local shell command to calculate/write its sum and cat/test the result; then MUST call submit_fact with the real regular file path, legion_message REPORT, and finish_step in separate tool calls. Do not end with prose. Keep descriptions concise (under 200 words per Fact). Never put origin or any Fact ID in evidence.path. If a lane has a failed attempt, STOP this acceptance as failed; do not create a third Soldier. Expected lane sums are 5 and 7. General verifies both Facts, computes total 12, publishes integration Fact and REPORT, and finishes. Commander reads current evidence and accepts root Goal only after all four Steps are done. Publish only regular-file evidence inside the Project cwd, never directory paths. Use executionProfile=isolated for Scout, General and Soldiers. This is testing orchestration, not offensive work.',goal:'Local coordination acceptance: exactly one Scout, one General and two specialist Soldiers; lane A=5, B=7, total=12; real file-backed Facts; all producer Steps complete before Commander accepts this Goal.',bootstrap:false})
  let result; const deadline=Date.now()+240000;while(Date.now()<deadline){result=(await call('/v2/legion')).campaign;if(result.status==='stopped')throw Error('Commander stopped: '+result.error);if((await call('/v2/projects/'+graph.project.id)).project.status==='completed'&&result.status==='idle')break;await delay(200)}
  const g=await call('/v2/projects/'+graph.project.id), runs=await call('/v2/projects/'+graph.project.id+'/runs')
  child.kill('SIGTERM');await closed
  const {Store}=await import(pathToFileURL(root+'/packages/redtrace-engine/src/store.ts'));const store=new Store(work+'/.redtrace/engine.db')
  try {
    const messages=store.db.prepare('SELECT data FROM legion_messages').all().map(row=>JSON.parse(row.data))
    const summary={provider:route.provider,model:route.model,status:result.status,projectStatus:g.project.status,steps:g.steps.map(s=>({id:s.id,role:s.role,parentStepId:s.parentStepId,status:s.status})),facts:g.facts.filter(f=>f.id!=='origin').map(f=>({id:f.id,description:f.description,evidence:f.evidence})),runs:runs.map(r=>({id:r.id,status:r.status,worker:r.worker,stepId:r.stepId,startedAt:r.startedAt,endedAt:r.endedAt,pendingTools:r.pendingTools})),messageStatuses:messages.map(m=>({type:m.type,status:m.status})),stateSaved:!!result.state}
    const proofDir=path.join(path.dirname(new URL(import.meta.url).pathname),'real-model-evidence-'+Date.now());await (await import('node:fs/promises')).mkdir(proofDir,{recursive:true});await (await import('node:fs/promises')).writeFile(proofDir+'/result.json',JSON.stringify(summary,null,2));console.log('EVIDENCE_PATH='+proofDir+'/result.json');
    console.log(JSON.stringify(summary,null,2))
    assert.equal(g.project.status,'completed');assert.equal(g.steps.filter(s=>s.role==='scout').length,1);assert.equal(g.steps.filter(s=>s.role==='general').length,1);assert.equal(g.steps.filter(s=>s.role==='soldier'&&s.parentStepId).length,2);assert.ok(g.steps.every(s=>s.status==='done'))
    const scoutRun=runs.find(r=>g.steps.find(s=>s.id===r.stepId)?.role==='scout'),generalRun=runs.find(r=>g.steps.find(s=>s.id===r.stepId)?.role==='general');assert.ok(generalRun.startedAt>=scoutRun.endedAt,'General started before Scout completed classification');for(const r of runs.filter(r=>g.steps.find(s=>s.id===r.stepId)?.role==='soldier'))assert.ok(generalRun.endedAt>=r.endedAt,'General finished before its specialist');
    for(const [filename,expected]of [['lane-a.txt','5'],['lane-b.txt','7']])assert.equal(readFileSync(work+'/workspaces/'+graph.project.id+'/'+filename,'utf8').trim(),expected)
    const {ProjectEvidence}=await import(pathToFileURL(root+'/packages/redtrace-engine/src/project-evidence.ts'));const evidence=new ProjectEvidence(store,work+'/workspaces');for(const f of g.facts.filter(f=>f.id!=='origin'))for(const source of f.evidence)if(source.artifactId)assert.ok(evidence.read(graph.project.id,source.artifactId).sha256);assert.ok(result.state);assert.ok(messages.some(m=>m.type==='REPORT'&&m.status==='admitted'))
    console.log('REAL_MODEL_LOCAL_ACCEPTANCE=true; external_targets=0; production_data_modified=false')
  } finally {store.close()}
} catch(error) {
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(work+'/.redtrace/engine.db',{readOnly:true});try {
    const campaign=db.prepare('SELECT data FROM campaign WHERE id=1').get();let diagnostic=JSON.stringify({campaign:campaign?JSON.parse(campaign.data):null});for(const provider of Object.values(source.providers))if(provider.apiKey)diagnostic=diagnostic.replaceAll(provider.apiKey,'[REDACTED]');console.error(diagnostic)
  }finally{db.close()}throw error
} finally {if(child&&!ended){child.kill('SIGKILL');await new Promise(r=>child.once('close',r))}rmSync(work,{recursive:true,force:true})}
