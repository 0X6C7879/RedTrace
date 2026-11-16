import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import {Store} from '../src/store.ts'
import {LegionStore} from '../src/legion-store.ts'

const root=path.resolve(import.meta.dirname,'../../..')
const html=readFileSync(path.join(root,'static/index.html'),'utf8')
function page(){
  const context=vm.createContext({window:{},console,localStorage:{getItem(){return null},setItem(){}},location:{hash:'#/projects/p/commander'}})
  vm.runInContext(readFileSync(path.join(root,'static/fgs-view.js'),'utf8'),context)
  vm.runInContext([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].find(m=>m[1].includes('function redtraceApp()'))![1],context)
  const app=vm.runInContext('redtraceApp()',context)
  app.showToast=()=>{};app.legionProjectId='p';app.projects=[{id:'p',title:'Target'}]
  app.legion={campaign:{status:'stopped'},projects:[{id:'p',title:'Target',status:'active',steps:[{id:'s',description:'Verify arithmetic',role:'soldier',taskKey:'target',status:'parked'}],runs:[],tactics:[]}],messages:[],transfers:[]}
  return app
}
const worker={name:'fixture',provider:'mock',model:'mock',backend:'mock' as const,enabled:true,maxRunning:10,priority:0}

test('Board exposes paused and unknown execution, with Mission descriptions, without terminal history',()=>{
  const store=new Store(':memory:'),legion=new LegionStore(store),p=store.createProject({title:'console',origin:'local only',goal:'verify'}).project
  try{
    for(const status of ['running','paused','unknown','succeeded'] as const){
      const step=legion.spawn(p.id,{role:'worker',taskKey:status,description:'Mission '+status,sourceIds:['origin']})
      const run=store.claim(p.id,'execute',worker,step.id)
      if(status!=='running')store.finishRun(run.id,status)
    }
    const board=legion.board().projects[0]
    assert.deepEqual(board.runs.map(r=>r.status).sort(),['paused','running','unknown'])
    assert.equal(board.steps.length,4)
    assert.ok(board.steps.every(s=>s.description?.startsWith('Mission ')))
  }finally{store.close()}
})

test('readable state distinguishes Park, paused, stopped and uncertain; forms do not request raw IDs',()=>{
  const app=page()
  assert.equal(app.legionStatus('stopped'),'执行已停止')
  assert.notEqual(app.legionStatus('paused'),app.legionStatus('parked'))
  assert.equal(app.legionStatus('queued'),'已排队，未入模')
  assert.equal(app.legionStatus('unknown'),'结果待核验')
  const methods=html.slice(html.indexOf('    legionProject('),html.indexOf('    async init()'))
  assert.doesNotMatch(methods,/prompt\(/)
  assert.doesNotMatch(html,/来源项目 ID|目标项目 ID|Fact ID，逗号分隔|commander 或运行中的 Run ID/)
  assert.match(html,/<dialog[^>]*aria-labelledby="legion-editor-title"/)
})

test('recipient and model choices follow project ownership, actual Run state and same-role enabled routes',()=>{
  const app=page(),p=app.legion.projects[0]
  p.runs=[{id:'live',stepId:'s',status:'running',worker:'current'},{id:'pause',stepId:'s',status:'paused'},{id:'unknown',stepId:'s',status:'unknown'}]
  app.workerConfig.workers=[{name:'current',enabled:true,roles:['soldier']},{name:'eligible',enabled:true,roles:['soldier']},{name:'wrong-role',enabled:true,roles:['scout']},{name:'disabled',enabled:false,roles:['soldier']}]
  assert.equal(Array.from(app.legionRecipients('p'),(r:any)=>r.id).join(','),'live,pause')
  assert.equal(app.legionRecipients('another').length,0)
  assert.equal(Array.from(app.legionWorkers(p,p.runs[0]),(w:any)=>w.name).join(','),'eligible')
  assert.match(app.legionRunLabel('p',p.runs[0]),/Soldier.*Verify arithmetic/)
})

test('resume cannot present paused or unknown executions as stopped; handoff and inactive projects stay explicit',()=>{
  const app=page(),p=app.legion.projects[0]
  for(const status of ['running','paused','unknown']){p.runs=[{id:'r',stepId:'s',status}];assert.match(app.legionResumeBlock(p,'target'),/核验停止/)}
  p.runs=[];p.steps[0].handoffPending=true;assert.match(app.legionResumeBlock(p,'target'),/交接/)
  p.steps[0].handoffPending=false;assert.equal(app.legionResumeBlock(p,'target'),'')
  p.status='stopped';assert.match(app.legionResumeBlock(p,'target'),/项目/)
})

test('Fact selectors exclude scope and unrelated task proof, preserving actual target Fact IDs',async()=>{
  const app=page()
  app.api=async(method:string,url:string)=>{assert.equal(method,'GET');assert.equal(url,'/v2/projects/p/facts');return[{id:'origin'},{id:'f',stepId:'s',description:'Actual proof'},{id:'other',stepId:'elsewhere'},{id:'human'}]}
  await app.loadLegionFacts('p')
  assert.equal(app.legionFactOptions('p').length,3)
  assert.equal(Array.from(app.legionFactOptions('p','target'),(f:any)=>f.id).join(','),'f')
  app.api=async()=>{throw Error('Evidence unavailable')};await app.loadLegionFacts('p')
  assert.match(app.legionFactErrors.p,/unavailable/);assert.equal(app.legionFactOptions('p').length,0)
})

test('operation error preserves form and draft; successful target verification uses the selected real evidence',async()=>{
  const app=page(),calls:any[]=[],messages:string[]=[]
  app.showToast=(message:string)=>messages.push(message)
  app.closeLegionEditor=()=>calls.push('close')
  app.legionEditor={kind:'confirm',projectId:'p',transferId:'transfer-1',taskKey:'target',factIds:['f']}
  app.api=async(method:string,url:string,body:any)=>{calls.push({method,url,body});throw Error('409 Actual target evidence required')}
  await app.submitLegionEditor()
  assert.match(app.legionEditorError,/409/);assert.equal(app.legionEditor.factIds[0],'f');assert.equal(calls.includes('close'),false);assert.equal(app.legionEditorSaving,false)
  calls.length=0;app.api=async(method:string,url:string,body:any)=>{calls.push({method,url,body});return method==='GET'?app.legion:{status:'target-verified'}}
  await app.submitLegionEditor()
  assert.equal(calls[0].url,'/v2/legion/transfer/transfer-1/confirm')
  assert.equal(JSON.stringify(calls[0].body),JSON.stringify({projectId:'p',factIds:['f']}))
  assert.ok(calls.includes('close'));assert.equal(app.legionPending[calls[0].url],false)
})

test('unresolved resume is not reported as success and a failed refresh retains a clearly marked old snapshot',async()=>{
  const app=page(),toasts:string[]=[]
  app.showToast=(message:string)=>toasts.push(message)
  app.api=async(method:string)=>method==='GET'?app.legion:{unresolved:[{runId:'r',reason:'unknown'}]}
  assert.equal(await app.legionAction('/v2/legion/resume',{}),false)
  assert.match(app.legionNotice,/未全部完成/);assert.equal(toasts.length,0)
  const previous=app.legion;app.api=async()=>{throw Error('Network failed')};await app.loadLegion()
  assert.equal(app.legion,previous);assert.match(app.legionError,/旧快照.*Network failed/);assert.equal(app.legionLoading,false)
})

test('evidence preview follows actual byte offsets and reports binary evidence rather than pretending it is text',async()=>{
  const app=page(),item={id:1,projectId:'p',artifactId:'a',title:'proof'},urls:string[]=[]
  app.api=async(_method:string,url:string)=>{urls.push(url);return urls.length===1?{offset:0,bytes:3,totalBytes:6,nextOffset:3,sha256:'hash',content:'abc'}:{offset:3,bytes:3,totalBytes:6,nextOffset:null,sha256:'hash',content:'def'}}
  await app.readLegionExperience(item);await app.readLegionExperience(item,true)
  assert.equal(app.legionPreview,'abcdef');assert.equal(app.legionPreviewMeta.bytes,6);assert.match(urls[1],/offset=3$/)
  let error='';app.showToast=(message:string)=>error=message;app.api=async()=>({encoding:'base64',content:'AA=='});await app.readLegionExperience(item)
  assert.match(error,/二进制/);assert.equal(app.legionPreview,'');assert.equal(app.legionReading,false)
})

test('messages preserve unsent content on error, clear it only after acceptance and never claim the model has read it',async()=>{
  const app=page(),toasts:string[]=[]
  app.legionMessage={projectId:'p',receiver:'commander',type:'HELP',content:'Actual blocker'}
  app.showToast=(message:string)=>toasts.push(message);app.api=async()=>{throw Error('Rejected')}
  await app.sendLegionMessage();assert.equal(app.legionMessage.content,'Actual blocker')
  app.api=async(method:string)=>method==='GET'?app.legion:{status:'pending'};await app.sendLegionMessage()
  assert.equal(app.legionMessage.content,'');assert.match(toasts.at(-1)!,/保存.*实际交付/)
})

test('benchmark deep link opens workspace overview and loads Commander status',async()=>{
  const app=page();let board=0,workers=0
  app.loadLegion=()=>board++;app.loadWorkerConfig=()=>workers++;app.handleRoute()
  await new Promise(resolve=>setImmediate(resolve))
  assert.equal(app.appPage,'workspace');assert.equal(app.view,'benchmark')
  assert.equal(board,1);assert.equal(workers,1)
  assert.doesNotMatch(html,/aria-label=\"军团\"/)
})

test('benchmark cards exclude the main graph and show runs from each task Step',async()=>{
  const app=page(),calls:string[]=[]
  const graphs=[{id:'main',type:'main',title:'Main',taskKey:'main'},{id:'g1',type:'benchmark_task',title:'Task',taskKey:'task'}]
  assert.equal(app.filteredTaskGraphs({graphs,steps:[]}).length,1)
  app.selectedProjectId='p';app.selectedGraphId='g1';app.fgs={steps:[{id:'s1'},{id:'s2'}]}
  app.api=async(_method:string,url:string)=>{calls.push(url);return {workers:[{id:'r1',worker:'one',graphId:'g1'},{id:'r2',worker:'two',graphId:'g1'},{id:'foreign',worker:'other',graphId:'g2'}]}}
  app.loadGraphLog=async()=>{calls.push('events:'+app.selectedGraphId)}
  await app.loadGraphWorkerRuns()
  assert.deepEqual(Array.from(app.graphWorkerRuns,(r:any)=>r.id),['r2','r1'])
  assert.equal(app.fgsRunId,'r2');assert.equal(calls.at(-1),'events:g1')
})


test('worker snapshot exposes effective four-role defaults without inventing an unlimited Mission cap',async()=>{
  const {Configuration}=await import('../src/config.ts'),{mkdtempSync,mkdirSync,writeFileSync,rmSync}=await import('node:fs'),os=await import('node:os')
  const dir=mkdtempSync(path.join(os.tmpdir(),'console-default-config-'))
  try{
    mkdirSync(dir+'/.redtrace');writeFileSync(dir+'/.redtrace/redtrace.yaml','workers: []\n')
    const snapshot=new Configuration(dir).snapshot(),app=page()
    app.applyWorkerSnapshot(snapshot)
    assert.equal(snapshot.tasks.commander.timeout,300)
    assert.equal(snapshot.tasks.scout.timeout,240)
    assert.equal(Object.keys(snapshot.tasks).sort().join(','),'commander,general,planner,scout,soldier,worker')
    assert.equal(app.runtimeTaskPayload().tasks.commander.max_intents,undefined)
    app.runtimeTaskForm.tasks.commander.max_intents='';assert.equal(app.runtimeTaskPayload().tasks.commander.max_intents,undefined)
    app.runtimeTaskForm.tasks.commander.max_intents=7;assert.equal(app.runtimeTaskPayload().tasks.commander.max_intents,7)
    assert.doesNotMatch(html.slice(html.indexOf('<section x-show="appPage === \'settings\'"'),html.indexOf('<!-- New Project -->')),/providerClass\(role\)|providerDotClass\(role\)|providerLabel\(role\)/)
  }finally{rmSync(dir,{recursive:true,force:true})}
})


test('workspace Mission detail preserves Park and paused distinction instead of displaying stale Worker activity',()=>{
  const app=page()
  assert.equal(app.intentStatusLabel({state:'parked',status:'parked',worker:'old'}),'已搁置 · Park')
  assert.equal(app.intentStatusLabel({state:'open',status:'paused',worker:null}),'执行暂停（非 Park）')
  assert.equal(app.legionTaskFinished({steps:[{taskKey:'a',status:'done'}]},'a'),true)
  assert.equal(app.legionTaskFinished({steps:[]},'a'),false)
})


function auditApp(){const context=vm.createContext({console,URLSearchParams,TextDecoder,setTimeout,clearTimeout});vm.runInContext(readFileSync(root+'/static/audit.js','utf8'),context);const app=vm.runInContext('auditPage()',context);app.$nextTick=(f:any)=>f();app.$refs={};return app}

test('audit completion cards use actual failed, paused, cancelled and unknown outcomes, never generic green success',()=>{
  const app=auditApp()
  for(const status of ['failed','unknown','paused','cancelled','completed']){
    app.runs=[{id:'r',status}]
    const event={kind:'run.completed',run_id:'r',exit_code:null}
    assert.equal(app.eventStatus(event),app.runStatusLabel(status))
    assert.equal(app.eventTone(event),status==='completed'?'audit-state-success':status==='failed'?'audit-state-error':'audit-state-warning')
  }
  app.runs=[{id:'r',status:'unknown'}]
  assert.equal(app.eventStatus({kind:'tool.started',run_id:'r'}),'结果待核验')
  assert.equal(app.eventTone({kind:'command.completed',exit_code:1}),'audit-state-error')
  app.selectedRun='one';assert.equal(app.eventVisible({kind:'assistant.message',content:'literal',run_id:'other'}),false)
})

test('Commander log UI consumes native offsets without creating a project Run or mixing global usage into project usage',async()=>{
  const app=auditApp(),requests:string[]=[];app.tasks=[{id:'p',title:'project'}];let page=0
  app.request=async(url:string)=>{requests.push(url);if(url.endsWith('/commander'))return{campaign:{sessionId:'command-a',usage:{inputTokens:7,outputTokens:3}}};return {sessionId:'command-a',available:true,events:[{event_uid:'event-'+(++page),kind:'assistant.message',content:'Native log '+page,task_type:'commander'}],nextOffset:page*100,hasMore:page===1}}
  await app.selectCommander();await app.loadCommanderLog()
  assert.equal(app.selectedScope,'commander');assert.equal(app.selectedTaskId,'');assert.equal(app.runs.length,0);assert.equal(app.taskUsage,null)
  assert.equal(app.events.length,2);assert.match(requests.at(-1)!,/offset=100/);assert.equal(app.commanderTokens(),10)
  app.request=async()=>{throw Error('Recorded Commander Session is missing')};await app.loadCommanderLog()
  assert.match(app.error,/missing/);assert.equal(app.events.length,2)
})

test('project log partial failures are visible and slow old project reads cannot overwrite a newly selected project',async()=>{
  const app=auditApp();const waiting:Array<()=>void>=[]
  app.request=(url:string)=>url.includes('/a/')?new Promise(resolve=>waiting.push(()=>resolve(url.endsWith('/workspace?path=')?{entries:[]}:[]))):Promise.resolve(url.includes('/workspace?')?{entries:[]}:url.endsWith('/usage')?{total:9}:[{id:'b'}])
  const old=app.selectTask('a');await app.selectTask('b');for(const resolve of waiting)resolve();await old
  assert.equal(app.selectedTaskId,'b');assert.equal(app.runs[0].id,'b');assert.equal(app.taskUsage.total,9)
  app.selectedRun='b';app.selectedProvider='soldier';await app.selectTask('b');assert.equal(app.selectedRun,'b');assert.equal(app.selectedProvider,'soldier')
  app.request=async(url:string)=>{if(url.endsWith('/runs'))throw Error('Actual Run read failed');return url.includes('/workspace?')?{entries:[]}:[]}
  await app.selectTask('b');assert.match(app.error,/运行记录读取失败.*Actual Run/)
})

test('retained audit evidence remains bounded, scoped, hash-labelled and explicitly reports read failures',async()=>{
  const app=auditApp(),id='ev-'+'a'.repeat(64),event={event_uid:'e',content:JSON.stringify({evidenceId:id,preview:'summary'})};app.selectedTaskId='proj_001'
  const urls:string[]=[];app.request=async(url:string)=>{urls.push(url);return {content:'proof',offset:0,bytes:5,totalBytes:5,nextOffset:null,sha256:'hash'}}
  await app.readRetainedEvidence(event);assert.equal(app.auditEvidence.content,'proof');assert.equal(app.auditEvidence.meta.sha256,'hash');assert.match(urls[0],/^\/v2\/projects\/proj_001\/evidence\/ev-/)
  app.request=async()=>{throw Error('Evidence missing')};await app.readRetainedEvidence(event);assert.match(app.auditEvidence.error,/missing/)
  app.selectedScope='commander';const count=urls.length;await app.readRetainedEvidence(event);assert.equal(urls.length,count)
})

test('settings keep the draft after revision conflict and explicit reload can be cancelled',async()=>{
  const app=page();app.runtimeSettingsDirty=true;app.runtimeTaskForm.tasks.soldier.timeout=333
  app.api=async()=>{throw Error('worker configuration changed; reload before saving')};await app.saveRuntimeTasks()
  assert.equal(app.runtimeSettingsDirty,true);assert.equal(app.runtimeTaskForm.tasks.soldier.timeout,333);assert.match(app.runtimeSettingsError,/草稿已保留/)
  let loads=0;app.loadWorkerConfig=async()=>{loads++;return null};app.requestDangerConfirm=async()=>false;await app.reloadRuntimeTaskDraft();assert.equal(loads,0)
  app.workerConfig.workers=[{name:'shared',provider:'real',enabled:true,roles:['commander','general','soldier','scout']},{name:'mock',provider:'mock',enabled:true,roles:['commander','soldier']},{name:'disabled',enabled:false,roles:['scout']}]
  assert.equal(app.workerRoleRoutes('commander').length,1);assert.equal(app.workerRoleRoutes('soldier').length,2)
})

test('Commander native read takes no write ownership, preserves paging and surfaces missing materialized sessions',async()=>{
  const {pathToFileURL}=await import('node:url'),{readCommanderLog}=await import(pathToFileURL(root+'/packages/redtrace-engine/compat/legion.mjs').href)
  let created=0,closed=0;const opens:any[]=[],reads:any[]=[],campaign:any={sessionId:'command-read',hasSession:true,workerName:'actual-route'}
  const persistence={create(){created++},stat:async()=>({}),open:async(id:string,access:string)=>{opens.push({id,access});return {read:async(offset:number,limit:number)=>{reads.push({offset,limit});return {events:[{seq:4,ts:'2026-11-11T00:00:00.000Z',type:'assistant/message',data:{message:{content:[{type:'text',text:'literal Commander output'}]}}}]}},close:async()=>{closed++}}}}
  const engine={store:{project:()=>({mode:'benchmark'})},legion:{campaign:()=>campaign}},ctx={get:()=>persistence}
  const page=await readCommanderLog(ctx,engine,4,1)
  assert.equal(opens[0].access,'read');assert.equal(created,0);assert.equal(closed,1);assert.equal(reads[0].offset,4);assert.equal(page.nextOffset,5);assert.equal(page.events[0].task_type,'commander');assert.equal(page.events[0].content,'literal Commander output')
  persistence.stat=async()=>undefined as any;await assert.rejects(readCommanderLog(ctx,engine),/missing/)
  campaign.hasSession=false;const empty=await readCommanderLog(ctx,engine);assert.equal(empty.available,false);assert.equal(created,0)
})


test('native Run state notifications use the existing stream, remain truthful and do not duplicate durable audit rows',async()=>{
  const store=new Store(':memory:');try{
    const p=store.createProject({title:'state stream',origin:'local fixture',goal:'verify'}).project,step=store.addStep(p.id,{description:'work',sourceIds:['origin']}),states:any[]=[]
    store.changes.on('audit',(_id:string,event:any)=>{if(['run.started','run.completed'].includes(event.kind))states.push(event)})
    const run=store.claim(p.id,'execute',worker,step.id);store.saveRun(store.run(run.id));store.finishRun(run.id,'unknown','Unconfirmed execution result')
    await new Promise<void>(resolve=>queueMicrotask(resolve))
    assert.equal(states.map(e=>e.status).join(','),'running,unknown');assert.equal(states[1].error,'Unconfirmed execution result')
    assert.equal(store.db.prepare('SELECT COUNT(*) AS n FROM audit_events').get()!.n,0)
    assert.equal(JSON.parse(String(store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(run.id)!.data)).status,'unknown')
  }finally{store.close()}
})


test('initial project loading cannot clear the loading state or selection of a user-selected Commander scope',async()=>{
  const app=auditApp(),projectReads:Array<(v:any)=>void>=[];let finishLog!:(v:any)=>void
  app.request=async(url:string)=>{
    if(url==='/audit/tasks')return[{id:'p',title:'project'}]
    if(url.endsWith('/commander'))return{campaign:{sessionId:'command-selected'}}
    if(url.startsWith('/v2/legion/session/events'))return new Promise(resolve=>{finishLog=resolve})
    return new Promise(resolve=>projectReads.push(resolve))
  }
  const initial=app.initAudit();await new Promise<void>(resolve=>setImmediate(resolve))
  assert.equal(projectReads.length,5)
  const selected=app.selectCommander();await new Promise<void>(resolve=>setImmediate(resolve))
  for(const resolve of projectReads)resolve([])
  await initial;assert.equal(app.selectedScope,'commander');assert.equal(app.loading,true)
  finishLog({sessionId:'command-selected',available:true,events:[],nextOffset:0,hasMore:false});await selected
  assert.equal(app.loading,false);assert.equal(app.commanderCampaign.sessionId,'command-selected')
})


test('human Goal acceptance selects a captured project evidence list, retains version checks and keeps rejected choices',async()=>{
  const {graphRoutes}=await import('../src/graph-api.ts'),{Readable}=await import('node:stream'),store=new Store(':memory:')
  try{
    const p=store.createProject({title:'Human acceptance',origin:'local fixture scope',goal:'Accept evidence'}).project,f=store.addFact(p.id,'Actual fixture proof'),app=page(),handlers=new Map<string,any>()
    graphRoutes({add:(method:string,url:string,handler:any)=>handlers.set(method+' '+url,handler)} as any,store)
    app.project={project:{id:p.id}};app.fgs=store.graph(p.id);app.fgsSelection={type:'goal',id:'goal'}
    app.$nextTick=(fn:any)=>fn();let closed=0;app.$refs={fgsAcceptanceDialog:{showModal(){},close(){closed++}}}
    await app.setFgsStatus('achieved')
    assert.equal(app.fgsAcceptance.evidence.some((e:any)=>e.id==='origin'),false)
    assert.equal(app.fgsAcceptanceEvidence()[0].id,f.id)
    const version=app.fgsAcceptance.version;app.fgs={facts:[{id:'foreign',description:'Another project'}],findings:[]}
    assert.equal(app.fgsAcceptanceEvidence()[0].id,f.id)
    app.fgsAcceptance.evidenceIds=[f.id];app.loadProject=async()=>{};app.updateGraph=()=>{};app.selectFgsNode=()=>{}
    app.api=async(method:string,url:string,value:any)=>{
      assert.equal(method,'PATCH');assert.equal(url,'/v2/projects/'+p.id+'/goals/goal');assert.equal(value.expectedVersion,version)
      return handlers.get('PATCH /v2/projects/:project/goals/:node')({url:new URL(url,'http://localhost'),params:{project:p.id,node:'goal'},req:Object.assign(Readable.from([Buffer.from(JSON.stringify(value))]),{headers:{'content-type':'application/json'}})})
    }
    await app.submitFgsAcceptance();assert.equal(store.node<any>(p.id,'goal').status,'achieved');assert.equal(closed,1)
    await app.submitFgsAcceptance();assert.ok(app.fgsAcceptance.error);assert.equal(app.fgsAcceptance.evidenceIds[0],f.id);assert.equal(closed,1)
  }finally{store.close()}
})

test('Goal acceptance retains the captured Graph when the user switches task pages',async()=>{const app=page();app.selectedProjectId='p';app.selectedGraphId='B';app.fgsAcceptance={projectId:'p',graphId:'A',goalId:'goal-A',version:1,evidenceIds:['fact-A']};let opened='';app.$refs={fgsAcceptanceDialog:{close(){}}};app.loadProject=async()=>{};app.updateGraph=()=>{};app.selectFgsNode=()=>{};app.openProject=async(_p:string,g:string)=>{opened=g};app.api=async(_method:string,url:string)=>{assert.equal(url,'/v2/projects/p/goals/goal-A?graphId=A')};await app.submitFgsAcceptance();assert.equal(app.fgsAcceptance.error,'');assert.equal(opened,'A')})


test('FGS Todo stays read-only in a compact anchored popover, not a full detail tab',()=>{
  const app=page();assert.equal(app.todoCompleted([{status:'completed'},{status:'in_progress'}]),1);
  assert.equal(app.todoStatus('pending'),'等待前置条件');assert.equal(app.todoStatus('in_progress'),'推进中');assert.equal(app.todoStatus('completed'),'已完成');
  const layout=html.slice(html.indexOf('id="graphLayout"'));
  assert.match(layout,/aria-label="查看阶段计划"/);assert.match(layout,/aria-label="当前任务阶段计划"/);
  const popover=layout.slice(layout.indexOf('<details class="rt-todo"'),layout.indexOf('</details>')+10);
  assert.match(popover,/x-text="todo.content"/);assert.match(popover,/暂无待办/);assert.match(popover,/不代表 Goal 验收/);
  assert.doesNotMatch(popover,/x-model="todo|contenteditable|TodoWrite/);assert.doesNotMatch(layout,/sideTab === 'todos'/);
})
