import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync,mkdtempSync,rmSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {serveEngine} from '../src/index.ts'
const root=path.resolve(import.meta.dirname,'../../..'),html=readFileSync(root+'/static/index.html','utf8')
function ui(){const c=vm.createContext({window:{},localStorage:{setItem(){}},console});for(const name of ['audit','workbench','console'])vm.runInContext(readFileSync(root+'/static/'+name+'.js','utf8'),c);return c}

test('operator logs preserve system prompts; user-facing global and Chief chats hide native context',()=>{
 const c=ui(),a={...c.window.redtraceWorkbench,workbench:{workers:[{id:'r',label:'Reporter1',role:'reporter'}],conversations:[{id:'g',graphId:'g'}]},legion:{messages:[]},conversationId:'g'}
 a.conversationEvents=[{event_uid:'s',kind:'system.prompt',run_id:'r',content:'prompt',timestamp:'1'},{event_uid:'c',kind:'user.message',run_id:'r',content:'mission',timestamp:'2'}];a.conversationGraphEvents=[{id:1,type:'graph.created'}]
 const rows=a.conversationRows();assert.equal(rows.length,2);assert.equal(rows[0].kind,'system.prompt');assert.equal(rows[0].actor,'Reporter1');assert.equal(rows[0].task_type,'reporter');assert.equal(rows[1].kind,'session.context')
 a.conversationId='commander';a.commanderHistory=[{kind:'system.prompt',content:'command prompt'},{kind:'user.message',content:'native context'}];assert.equal(a.conversationRows()[0].kind,'system.prompt');assert.equal(a.conversationRows()[1].kind,'session.context')
 a.conversationId='chief';a.chiefEvents=[{kind:'system.prompt',content:'chief prompt'}];assert.equal(a.conversationRows().length,0)
 a.chatEvents=[{kind:'system.prompt',content:'global prompt'}];assert.equal(a.globalChatRows().length,0)
})
test('conversation and graph timelines share audit pairing, skill, shell, MCP and thinking rendering',()=>{
 const c=ui(),a=c.runtimeLog(),events=[{id:1,run_id:'r',task_type:'reporter',kind:'tool.started',call_id:'shell',title:'bash',arguments:{command:'printf proof'}},{id:2,run_id:'r',task_type:'reporter',kind:'tool.completed',call_id:'shell',content:'proof'},{id:3,run_id:'r',task_type:'reporter',kind:'tool.started',call_id:'skill',title:'skill',arguments:{name:'sample'}},{id:4,run_id:'r',task_type:'reporter',kind:'tool.started',title:'mcp__example__read'},{id:5,run_id:'r',task_type:'reporter',kind:'thinking.message',content:'reasoning'},{id:6,run_id:'r',task_type:'reporter',kind:'system.prompt',content:'prompt'}]
 a.setRuntimeEvents(events,[{id:'r',role:'reporter',label:'Reporter1'}],'g');assert(!a.eventVisible(events[0]));assert(a.isCommand(events[1]));assert.equal(a.eventCommand(events[1]),'printf proof');assert(a.isSkill(events[2]));assert(a.isTool(events[3]));assert(a.isThinking(events[4]));assert(a.isSystemPrompt(events[5]));a.selectedRun='other';assert.equal(a.visibleEvents().length,0);a.setRuntimeEvents(events,[],'new');assert.equal(a.selectedRun,'all')
 assert.equal((html.match(/id="runtime-log-events"/g)||[]).length,1);assert(!html.includes('aria-label="项目运行态势"'));assert(!html.includes('aria-label="结构化事件记录"'));assert(html.includes("{id:'findings',title:'发现'}"));assert(html.includes('wb-reasoning-slider'))
})
test('workspace roots use task names, isolate identical paths and remove deleted task rows and cache',async()=>{
 const c=ui();let projects=[{id:'proj_001',title:'First'},{id:'proj_002',title:'Second'}],calls:string[]=[]
 c.capabilityRequest=async(_method:string,url:string)=>{calls.push(url);if(url==='/audit/tasks')return projects;return {entries:[{path:'same.txt',name:'same.txt',type:'file'}],nextOffset:null}}
 const a=c.window.filesPage();await a.setActive(true);assert.equal(a.rows.length,2);assert.equal(a.rows[0].name,'First');assert.equal(calls.length,1)
 await a.select(a.rows[0]);await a.select(a.rows.find((e:any)=>e.root&&e.projectId==='proj_002'));const files=a.rows.filter((e:any)=>!e.root);assert.equal(files.length,2);assert.notEqual(files[0].key,files[1].key);assert.equal(a.projectId,'proj_002');projects=projects.slice(0,1);await a.refresh();assert.equal(a.projectId,'');assert(!a.rows.some((e:any)=>e.projectId==='proj_002'));assert(!Object.keys(a.directories).some(k=>k.startsWith('proj_002:')))
 assert(!html.includes('aria-label="工作空间任务"'))
})
test('running and scouting questions precede completed questions, then ordinary sorting applies',()=>{
 const match=html.match(/filteredTaskGraphs\(p\)\{return ([\s\S]*?)\},\n    async openCommander/);assert(match)
 const sort=new Function('p','return '+match[1]),a={benchmarkTaskGraphs:(p:any)=>p.graphs,taskGraphStatus:(_p:any,g:any)=>g.status,graphQuery:'',graphStatusFilter:'',graphSort:'title'}
 const graphs=['pending','completed','running','parked','scouting'].map((status,i)=>({id:status,status,title:String(i),taskKey:String(i)}));assert.deepEqual(sort.call(a,{graphs}).map((g:any)=>g.id),['running','scouting','completed','pending','parked'])
 a.graphStatusFilter='completed';assert.deepEqual(sort.call(a,{graphs}).map((g:any)=>g.id),['completed'])
})
test('project/FGS Finding tabs and token usage stay inside their requested graph',async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'ui-scope-')),e=await serveEngine({root:dir,port:0,autoStart:false}),url='http://127.0.0.1:'+(e.server.address() as {port:number}).port
 try{
 const p=e.store.createProject({mode:'benchmark',title:'one',origin:'local',goal:'verify'}).project,q=e.store.createProject({mode:'benchmark',title:'other',origin:'local',goal:'verify'}).project
 const graphs=[e.store.createGraph(p.id,{taskKey:'a',title:'A',origin:'local',goal:'verify'}),e.store.createGraph(p.id,{taskKey:'b',title:'B',origin:'local',goal:'verify'}),e.store.createGraph(q.id,{taskKey:'c',title:'C',origin:'local',goal:'verify'})]
 for(const [i,g] of graphs.entries()){const project=i===2?q:p,view=e.store.forGraph(project.id,g.id),fact=view.addFact(project.id,'proof');view.addFinding(project.id,{title:g.title,description:'proof',severity:'low',type:'fixture',factIds:[fact.id],assetIds:[],details:{content:'fixture method'}});e.store.audit({id:'r'+i,project_id:project.id,graph_id:g.id,task_type:'soldier',input_tokens:(i+1)*10},[])}
 const get=async(route:string)=>(await fetch(url+route)).json() as Promise<any>
 assert.equal((await get('/console/findings')).length,3);assert.equal((await get('/console/findings?projectId='+p.id)).length,2);assert.equal((await get('/console/findings?projectId='+p.id+'&graphId='+graphs[0].id)).length,1)
 assert.equal((await get('/audit/tasks/'+p.id+'/usage?graphId='+graphs[0].id)).total,10);assert.equal((await get('/audit/tasks/'+p.id+'/usage')).total,30);assert(html.includes('/usage?graphId=${encodeURIComponent(graphId)}'))
 assert.equal((await fetch(url+'/console/findings?projectId='+p.id+'&graphId='+graphs[2].id)).status,404)
 const llm=html.slice(html.indexOf('x-show="appPage === \'llm\'"'),html.indexOf('x-show="appPage === \'settings\'"'));assert(llm.includes('Worker 模型路线'));assert(!html.includes('aria-label="四角色模型路线"'))
 }finally{await e.close();rmSync(dir,{recursive:true,force:true})}
})

test('new native events follow only at the reading edge, and automatic reasoning pins the actual route',()=>{
 const c=ui(),a=c.runtimeLog(),scroller={scrollHeight:500,scrollTop:400,clientHeight:100};a.$el={closest:()=>scroller};a.$nextTick=(fn:()=>void)=>fn();a.setRuntimeEvents([{id:1}],[],'scope');assert.equal(scroller.scrollTop,500);scroller.scrollTop=100;a.setRuntimeEvents([{id:1},{id:2}],[],'scope');assert.equal(scroller.scrollTop,100);a.setRuntimeEvents([{id:0},{id:1},{id:2}],[],'scope');assert.equal(scroller.scrollTop,100)
 const b={...c.window.redtraceWorkbench,chatId:'chat',conversationModels:[{name:'route',reasoningEfforts:['low','high']}]};b.chooseReasoning('global','high');assert.equal(b.modelSelections.chat,'route');assert.equal(b.reasoningSelections.chat,'high')
})

test('both composers paste images through existing attachment uploads and leave ordinary text untouched',async()=>{
 const c=ui(),a=c.window.redtraceWorkbench,calls:any[]=[];a.uploadFiles=async(e:any,target:string)=>calls.push({files:e.target.files,target});let prevented=0;const image={type:'image/png',name:'clipboard.png'},text={type:'text/plain',name:'note.txt'}
 for(const target of ['global','workbench'])await a.pasteImages({clipboardData:{files:[image,text]},preventDefault(){prevented++}},target)
 assert.equal(calls.length,2);assert.equal(calls[0].target,'global');assert.equal(calls[1].target,'workbench');assert.equal(calls[0].files.length,1);assert.equal(calls[0].files[0],image);assert.equal(prevented,2)
 await a.pasteImages({clipboardData:{files:[]},preventDefault(){prevented++}},'workbench');assert.equal(calls.length,2);assert.equal(prevented,2)
 assert.equal((html.match(/@paste="pasteImages/g)||[]).length,2)
 assert(html.includes(":data-side=\"event.kind==='user.message'&&event.actor==='你'?'right':null\""));const css=readFileSync(root+'/static/workbench.css','utf8');assert(css.includes('.wb-messages .audit-event[data-side=right]'))
})

test('pasted images retain the existing upload request, pending attachment and server-error behavior',async()=>{
 const c=ui(),a=c.window.redtraceWorkbench,image={type:'image/png',name:'paste.png'},requests:any[]=[];a.workbench={input:{id:'input-fixture'}};a.uploadsByChat={'input-fixture':[]};a.workbenchCommand='keep draft';c.fetch=async(url:string,options:any)=>{requests.push({url,options});return {ok:true,json:async()=>({id:'u',attachment:{name:'paste.png'}})}}
 await a.pasteImages({clipboardData:{files:[image]},preventDefault(){}},'workbench');assert.equal(requests[0].url,'/v2/chats/input-fixture/attachments');assert.equal(requests[0].options.method,'POST');assert.equal(requests[0].options.body,image);assert.equal(requests[0].options.headers['Content-Type'],'image/png');assert.equal(a.pendingFiles('workbench')[0].id,'u');assert.equal(a.workbenchCommand,'keep draft');assert(!a.uploadingIds['input-fixture'])
 c.fetch=async()=>({ok:false,json:async()=>({detail:'image rejected'})});await a.pasteImages({clipboardData:{files:[image]},preventDefault(){}},'workbench');assert.equal(a.inputErrors['input-fixture'],'image rejected');assert.equal(a.pendingFiles('workbench').length,1);assert(!a.uploadingIds['input-fixture'])
})

test('native conversation streaming grows one bubble, replaces deltas, decodes split UTF-8 and rejects truncated replies',async()=>{
 const c=ui();c.TextDecoder=TextDecoder;const a={...c.window.redtraceWorkbench,liveChatEvents:{},chatId:'g',chatEvents:[]},encoder=new TextEncoder();let finish!:()=>void;
 const rows=[{event_uid:'s',kind:'system.prompt',content:'private prompt'},{event_uid:'u',kind:'user.message',source:{kind:'user'},content:'hello'},{event_uid:'c',kind:'user.message',source:{kind:'runtime-context'},content:'context'},{event_uid:'d1',kind:'assistant.delta',content:'你'},{event_uid:'d2',kind:'assistant.delta',content:'好'}];
 const bytes=encoder.encode(rows.map(e=>JSON.stringify(e)+'\n').join(''));
 c.fetch=async(_url:string,options:any)=>{assert.equal(options.headers.Accept,'application/x-ndjson');return new Response(new ReadableStream({async start(controller){for(let i=0;i<bytes.length;i+=7)controller.enqueue(bytes.slice(i,i+7));await new Promise<void>(r=>finish=r);controller.enqueue(encoder.encode(JSON.stringify({event_uid:'full',kind:'assistant.message',content:'你好'})+'\n'+JSON.stringify({kind:'chat.completed'})+'\n'));controller.close()}}))};
 const pending=a.streamChat('g',{content:'hello'});await new Promise(r=>setImmediate(r));const live=a.globalChatRows();assert.equal(live.length,2);assert.equal(live[1].content,'你好');assert.equal(live[1].kind,'assistant.delta');finish();await pending;assert.equal(a.globalChatRows().length,2);assert.equal(a.globalChatRows()[1].kind,'assistant.message');a.chatEvents=[{event_uid:'full',kind:'assistant.message',content:'你好'}];assert.equal(a.globalChatRows().filter((e:any)=>e.kind==='assistant.message').length,1);
 c.fetch=async()=>new Response('{"kind":"assistant.delta","content":"partial"}\n');await assert.rejects(a.streamChat('other',{}),/中断/);assert.equal(a.liveChatEvents.other[0].content,'partial');
});

test('conversation deletion uses the shared dialog; cancellation leaves all conversation state untouched',async()=>{
 const c=ui();let opened=0,closed=0,removed=0;const a={...c.window.redtraceWorkbench,$refs:{chatDeleteDialog:{showModal(){opened++},close(){closed++}}},chats:[{id:'a',title:'A'},{id:'b',title:'B'}],chatId:'a',chatEvents:[{content:'old'}],chatDraft:'draft',uploadsByChat:{a:[],b:[{id:'keep'}]},pendingUploads:{a:[]},inputErrors:{a:[]},api:async()=>{removed++},selectChat:async()=>{}};c.localStorage.removeItem=()=>{};
 a.requestChatDeletion(a.chats[0]);assert.equal(opened,1);assert.equal(removed,0);assert.equal(a.chatEvents.length,1);assert.equal(a.chatDraft,'draft');await a.deleteChat();assert.equal(removed,1);assert.equal(closed,1);assert.equal(a.chatEvents.length,0);assert.equal(a.chatDraft,'');assert.equal(a.uploadsByChat.a,undefined);assert.equal(a.uploadsByChat.b[0].id,'keep');assert.equal(a.chatDeleting,false);assert(html.includes('aria-labelledby="chat-delete-title"'));assert(!sourceHasNativeConfirm());
 function sourceHasNativeConfirm(){return readFileSync(root+'/static/workbench.js','utf8').includes('confirm(')}
});

test('runtime settings expose both patrol intervals and submit them through the existing revisioned save',()=>{
 const c=ui();
 for(const field of ['inspection_interval','idle_inspection_interval']){assert(html.includes('runtimeTaskForm.tasks.commander.'+field));assert(html.includes(field+':Number(value.tasks.commander.'+field+')'))}
 const css=readFileSync(root+'/static/console.css','utf8');assert(css.includes('grid-template-rows:1fr auto'));assert(css.includes('grid-column:1/-1;align-self:end'));assert(css.includes('.runtime-settings .runtime-task-grid{grid-template-columns:repeat(3,minmax(0,1fr))'));
});
