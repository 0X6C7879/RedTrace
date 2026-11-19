import test from 'node:test'
import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
const source=readFileSync(new URL('../../../static/workbench.js',import.meta.url),'utf8'),html=readFileSync(new URL('../../../static/index.html',import.meta.url),'utf8')
function app(){const context=vm.createContext({window:{},localStorage:{getItem(){return null},setItem(){}},console});vm.runInContext(source,context);return {...context.window.redtraceWorkbench,streamChat(id:string,payload:any){return this.api('POST','/v2/chats/'+id+'/messages',payload)},conversationModels:[],legionProjectId:'p',legionPanel:'commander',legion:{messages:[]},api:async()=>({}),showToast(){},legionStatus:(s:string)=>s}}

test('Worker messages preserve actual instance attribution, Commander direction, centered events and recent running order',()=>{
 const a=app();a.workbench={workers:[{id:'r1',label:'Soldier1'},{id:'r2',label:'Audit1'}],conversations:[{id:'a',title:'a',updatedAt:'2026-01-01',running:false},{id:'b',title:'b',updatedAt:'2025-01-01',running:true}]};a.conversationId='a'
 a.conversationEvents=[{id:1,event_uid:'one',kind:'assistant.message',run_id:'r1',content:'confirmed',timestamp:'1'}];a.conversationMessages=[{id:'m',sender:'commander',receiver:'r1',content:'do this',createdAt:'2',type:'MESSAGE',status:'queued'},{id:'report',sender:'r2',receiver:'commander',content:'report',createdAt:'3',type:'REPORT',status:'admitted'}];a.conversationGraphEvents=[{id:5,type:'step.handoff_ready',createdAt:'4'}]
 const rows=a.conversationRows();assert.equal(rows[0].actor,'Soldier1');assert.equal(rows[0].task_type,'system');assert.equal(rows[1].actor,'Commander');assert.equal(rows[2].actor,'Audit1');assert.equal(rows.length,3);assert.equal(a.workbenchConversations()[0].id,'b')
})
test('incremental Worker history and older pages use independent cursors and never duplicate native rows',async()=>{
 const a=app();a.conversationId='g';a.workbench={conversations:[{id:'g',graphId:'g'}]};const urls:string[]=[];let n=0
 a.api=async(_method:string,url:string)=>{urls.push(url);n++;return {events:[{id:n===1?2:1,event_uid:n===1?'two':'one',kind:'assistant.message'}],messages:[],graphEvents:[],eventCursor:0,cursor:n===1?2:1,before:n===1?2:1,hasMore:n===1}}
 await a.loadConversation();await a.loadConversation(true);assert.equal(a.conversationCursor,2);assert.equal(a.conversationBefore,1);assert.equal(a.conversationEvents.length,2);assert(urls[0].includes('before=9007199254740991'));assert(urls[1].includes('before=2'));await a.loadConversation();assert(urls[2].includes('after=2'));assert.equal(a.conversationEvents.length,2)
})
test('slow previous Project response cannot enter the new conversation',async()=>{
 const a=app();a.conversationId='g';a.workbench={conversations:[{id:'g',graphId:'g'}]};let finish!:(v:unknown)=>void;a.api=()=>new Promise(r=>finish=r);const work=a.loadConversation();a.legionProjectId='new';finish({events:[{id:1,content:'foreign'}],messages:[],graphEvents:[],cursor:1});await work;assert.equal(a.conversationEvents.length,0)
})
test('Commander input remains visibly pending in durable inbox; patrol payloads do not masquerade as human messages',()=>{
 const a=app();a.workbench={workers:[]};a.commanderHistory=[{kind:'user.message',event_uid:'patrol',content:'internal patrol',timestamp:'1'},{kind:'assistant.message',event_uid:'reply',content:'status',timestamp:'3'}];a.legion.messages=[{id:'human',sender:'human',receiver:'commander',type:'MESSAGE',content:JSON.stringify({source:'user',content:'adjust plan'}),createdAt:'2',status:'pending'}];const rows=a.conversationRows();assert.equal(rows.length,3);assert.equal(rows[0].kind,'session.context');assert.equal(rows[1].content,'adjust plan');assert.equal(rows[1].status,'pending');assert.notEqual(rows[0].actor,'你')
})
test('workbench static contract contains both page sets, compact Todo and four FGS tabs, global navigation, readonly Workers and accessibility signals',()=>{
 for(const name of ['Commander','题目总览','经验与复盘','FGS 图','成果与复盘','节点详情','最近 Todo','执行动态','执行成员','发现'])assert(html.includes(name),name)
 const nav=['aria-label="任务"','aria-label="对话"','aria-label="发现"','aria-label="工作空间"','aria-label="WebShell"','aria-label="打开 C2"'].map(s=>html.indexOf(s));assert(nav.every(n=>n>=0));assert.deepEqual([...nav].sort((a,b)=>a-b),nav)
 assert(html.includes('Worker 会话只读'));assert(!html.includes('清单保存在运行时内存中'));assert(!html.includes('其他题目'));assert(!html.includes("sideTab === 'fgs'"))
 const css=readFileSync(new URL('../../../static/workbench.css',import.meta.url),'utf8');for(const signal of ['prefers-reduced-motion','prefers-reduced-transparency','prefers-contrast','focus-visible'])assert(css.includes(signal))
})

test('General Chief is the writable ingress; real Commander and Worker sessions remain read-only',()=>{const a=app();a.workbench={project:{mode:'general'},input:{id:'chief-p'}};a.conversationId='chief';assert(a.canComposeWorkbench());assert.equal(a.conversationTitle(),'会话');a.conversationId='commander';assert(!a.canComposeWorkbench());a.conversationId='r1';assert(!a.canComposeWorkbench());a.workbench.project.mode='benchmark';a.conversationId='commander';assert(a.canComposeWorkbench());assert.match(html,/上传项目文件或图片/);assert.match(html,/上传全局对话文件或图片/);assert.match(html,/pendingAgents/);})
test('attachment receipts and upload links stay in their own conversation',()=>{const a=app();a.chatId='global';a.workbench={input:{id:'chief'}};const file={type:'image',attachment:{attachmentId:'sha256:fixture'}};a.uploadsByChat={global:[{id:'u1',chatId:'global',...file}],chief:[{id:'u2',chatId:'chief',...file}]};assert(a.uploadUrl(file,'global').includes('/global/'));assert(a.uploadUrl(file).includes('/chief/'));a.pendingUploads={global:[{id:'u1'}],chief:[{id:'u2'}]};a.removeUpload('workbench','u2');assert.equal(a.pendingFiles('global').length,1);assert.equal(a.pendingFiles('workbench').length,0);})

test('every Alpine display and action expression parses, including initially hidden Project panels',()=>{for(const match of html.matchAll(/\s(x-(?:show|text|if|for|effect)|:[\w-]+|@[\w.-]+)="([^"]*)"/g)){let value=match[2].replaceAll('&amp;','&').replaceAll('&lt;','<').replaceAll('&gt;','>').replaceAll('&quot;','"').replaceAll('&#39;',"'");if(match[1]==='x-for')value=value.replace(/^[\s\S]*?\s+(?:in|of)\s+/,'');assert.doesNotThrow(()=>new vm.Script('async function binding(){'+((match[1][0]==='@'||match[1]==='x-effect')?value:'return ('+value+');')+'}'),match[1]+': '+value)}})

test('input failures remain visible across refresh and stay scoped to the originating chat',async()=>{const a=app();a.workbench={project:{mode:'general'},input:{id:'chief-p'},chief:{id:'chief-p'}};a.conversationId='chief';a.workbenchCommand='question';a.api=async()=>{throw new Error('provider unavailable')};await a.sendWorkbenchCommand();assert.equal(a.inputErrors['chief-p'],'provider unavailable');a.api=async()=>({events:[],nextOffset:0,hasMore:false});a.uploadsByChat['chief-p']=[];await a.loadConversation();assert.equal(a.inputErrors['chief-p'],'provider unavailable');a.workbench.input.id='chief-other';assert.equal(a.inputErrors[a.composerChatId('workbench')],undefined);})


test('shared palette stays readable and attachment controls use defined theme tokens',()=>{
 const theme=readFileSync(new URL('../../../static/redtrace-theme.css',import.meta.url),'utf8'),css=readFileSync(new URL('../../../static/workbench.css',import.meta.url),'utf8');
 const tokens=Object.fromEntries([...theme.matchAll(/(--rt-[\w-]+):\s*(#[a-f0-9]{6});/g)].map(m=>[m[1],m[2]]));
 const luminance=(hex:string)=>{const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722};
 for(const name of ['--rt-text','--rt-text-secondary','--rt-text-muted'])assert((luminance(tokens[name])+.05)/(luminance(tokens['--rt-surface'])+.05)>=4.5,name);
 for(const m of css.matchAll(/var\((--[\w-]+)\)/g))assert((theme+css).includes(m[1]+':'),m[1]);
 assert.match(html,/:aria-label="createButtonLabel\(\)"/);assert.match(html,/aria-label="返回工作台"/);assert.match(html,/<dialog x-show="showCreate"/);assert.match(theme,/font-family: system-ui/);assert(!css.includes('.benchmark-task-actions{display:none}'));
});


test('dark glass chrome keeps reading surfaces opaque and respects accessibility preferences',()=>{
 const css=readFileSync(new URL('../../../static/redtrace-theme.css',import.meta.url),'utf8');
 assert.match(css,/--rt-bg: #000000/);assert.match(css,/--rt-glass:/);
 assert.match(css,/backdrop-filter: blur\(20px\)/);
 assert.match(css,/@media \(prefers-reduced-transparency: reduce\), \(prefers-contrast: more\)/);
 assert.match(css,/backdrop-filter: none !important/);
 assert.match(css,/dialog\[open\] \.operations-create-modal \{ animation: none/);
});


test('conversation role colors follow real run roles, including specialist Agent names',()=>{const a=app();a.workbench={workers:[{id:'r1',label:'CodeAudit2',role:'soldier'},{id:'r2',label:'General1',role:'general'},{id:'r3',label:'Scout1',role:'scout' as never}]};for(const [actor,role] of [['Commander','commander'],['参谋长','chief'],['你','user'],['CodeAudit2','soldier'],['General1','general'],['Scout1','scout'],['系统','system']])assert.equal(a.conversationRole({actor}),role);assert.equal(a.conversationRole({run_id:'r1'}),'soldier')});
test('model and reasoning choices are scoped to each conversation and sent to both native ingresses',async()=>{const a=app();a.chatId='g';a.chatDraft='hello';a.workbench={project:{mode:'benchmark'},input:{id:'input-p'},workers:[]};a.workbenchCommand='plan';a.modelSelections={g:'route-a','input-p':'route-b'};a.reasoningSelections={g:'low','input-p':'high'};a.loadChat=async()=>{};a.loadLegion=async()=>{};const inputs:any[]=[];a.api=async(method:string,url:string,body:any)=>{inputs.push({method,url,body});return {}};await a.sendChat();await a.sendWorkbenchCommand();assert.equal(inputs[0].body.worker,'route-a');assert.equal(inputs[0].body.reasoning,'low');assert.equal(inputs[1].body.worker,'route-b');assert.equal(inputs[1].body.reasoning,'high');a.conversationModels=[{name:'route-b',model:'b',reasoningEfforts:['low','high']}];assert.deepEqual(Array.from(a.reasoningOptions('workbench')),['','low','high']);a.chooseReasoning('workbench','low');assert.equal(a.reasoningSelections['input-p'],'low');a.changeComposerModel('workbench');assert.equal(a.reasoningSelections['input-p'],'');assert.equal(a.reasoningSelections.g,'low')});
test('composer Enter sends but Shift+Enter and active Chinese composition never submit',()=>{const a=app();let sent=0,prevented=0;const e:any={target:{form:{querySelector(){return {disabled:false}},requestSubmit(){sent++}}},preventDefault(){prevented++}};a.submitComposer({...e,shiftKey:true});a.submitComposer({...e,isComposing:true});a.submitComposer({...e,keyCode:229});assert.equal(sent,0);assert.equal(prevented,0);a.submitComposer(e);assert.equal(sent,1);assert.equal(prevented,1);assert(html.includes('wb-composer-toolbar'));assert(html.includes('wb-reasoning-slider'));assert(html.includes('模型与思考'))});


test('structural black materials stay neutral and avoid large brightness gradients',()=>{const css=readFileSync(new URL('../../../static/redtrace-theme.css',import.meta.url),'utf8');assert.match(css,/--rt-glass: rgba\(8,8,8,.94\)/);for(const match of css.matchAll(/background(?:-color)?:\s*([^;{}]+);/g)){const rgb=[...match[1].matchAll(/rgba\(\s*(\d+),\s*(\d+),\s*(\d+),/g)].map(m=>m.slice(1,4).map(Number));assert(!rgb.some(c=>Math.max(...c)<=43&&new Set(c).size>1),match[0]);}assert(!css.includes('linear-gradient(135deg, rgba(255,255,255,'));});


test('Todo follows the actual planner conversation, clears on switches and refreshes from its Graph',async()=>{
 const a=app();a.workbench={project:{mode:'general'},todos:[{content:'Commander plan',status:'pending'}],conversations:[{id:'r',graphId:'main'}]};
 a.conversationId='commander';assert.equal(a.conversationTodos()[0].content,'Commander plan');
 for(const id of ['chief','r']){a.conversationId=id;assert.equal(a.conversationTodos(),null)}
 a.workbench={project:{mode:'benchmark'},conversations:[{id:'A',graphId:'A'},{id:'B',graphId:'B'}]};a.conversationId='commander';assert.equal(a.conversationTodos(),null);
 a.api=async(_method:string,url:string)=>({todos:[{content:url.includes('graphId=A')?'A route':'B route',status:'pending'}],events:[],messages:[],graphEvents:[],cursor:0,eventCursor:0,before:null,hasMore:false});
 await a.selectConversation('A');assert.equal(a.conversationTodos()[0].content,'A route');
 let release!:(v:any)=>void;a.api=()=>new Promise(r=>release=r);const switching=a.selectConversation('B');assert.equal(a.conversationTodos().length,0);
 release({todos:[{content:'B route',status:'in_progress'}],events:[],messages:[],graphEvents:[],cursor:0,eventCursor:0,before:null,hasMore:false});await switching;assert.equal(a.conversationTodos()[0].content,'B route');
 assert.equal((html.match(/class="rt-todo-panel"/g)||[]).length,2);assert(!html.includes('fgs-todo-item'));assert(!html.includes('<h3>TodoList</h3>'));
 const css=readFileSync(new URL('../../../static/legion.css',import.meta.url),'utf8');assert.match(css,/width:20rem; max-height:20rem/);assert.match(css,/text-decoration:line-through/);assert.match(css,/focus-visible/);
});

test('platform-confirmed completion outranks Park without forging internal Goal acceptance',()=>{
 const status=app().taskGraphStatus
 const graph={id:'G',taskKey:'T',goalId:'goal-G'},project={platform:{T:{is_completed:true}},goals:[{id:'goal-G',status:'open'}],steps:[{graphId:'G',status:'parked'}]}
 assert.equal(status(project,graph),'completed');assert.equal(project.goals[0].status,'open')
 project.platform.T.is_completed=false;assert.equal(status(project,graph),'parked')
 project.goals[0].status='achieved';assert.equal(status(project,graph),'parked');project.steps=[];assert.equal(status(project,graph),'pending')
 const a=app();a.legionProjectId='P';a.legion={projects:[{id:'P',...project}]};a.workbench={graphs:[graph],conversations:[{id:'G',graphId:'G'}],project:{mode:'benchmark',status:'active'},steps:[],goals:[{graphId:'G',status:'achieved'}]};a.conversationId='G'
 assert.equal(a.conversationTaskState().label,'目标已验收')
 assert.equal(a.benchmarkPlatformStatus(a.conversationBenchmarkMetadata()),'平台未完成')
 project.platform.T.is_completed=true;assert.equal(a.conversationTaskState().label,'平台已完成')
 assert.equal(a.benchmarkPlatformStatus(a.conversationBenchmarkMetadata()),'平台已完成')
 assert(!html.includes('aria-label="Graph 执行容量"'));assert(!html.includes('class="wb-control-menu"'));assert(!html.includes('未绑定角色'))
 assert(html.includes('系统上下文'));assert(html.includes('rt-token-dot'));assert(!html.includes('class="wb-token-scope"'))
 assert(!html.includes("conversationWorkers().map(w=>w.label).join(' · ')"),'question heading must not repeat the role roster')
})

test('Benchmark task panel shows counts, zero and missing fields without guessing',()=>{
 const a=app(),meta={correct_flag_count:2,flag_count:3,difficulty:'medium',total_score:90,is_completed:false}
 assert.equal(a.benchmarkMetadataText(meta),'Flag（正确 / 总数） 2 / 3 · 难度 medium · 总分 90')
 assert.equal(a.benchmarkMetadataText({correct_flag_count:0,total_score:0}),'Flag（正确 / 总数） 0 / 未知 · 难度 未知 · 总分 0')
 assert.equal(a.benchmarkPlatformStatus({}),'平台状态未知')
 assert.match(html,/benchmarkMetadataText\(task.platform\)/)
 assert.match(html,/benchmarkMetadataText\(conversationBenchmarkMetadata\(\)\)/)
})
