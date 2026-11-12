import {mkdtempSync,mkdirSync,writeFileSync,symlinkSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {serveEngine} from '/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/index.ts'
import {LegionStore} from '/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-store.ts'
import {LegionExperience} from '/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-experience.ts'
const root=mkdtempSync(path.join(os.tmpdir(),'redtrace-console-ui-'))
symlinkSync('/Users/lxy/Downloads/RedTrace/static',root+'/static')
mkdirSync(root+'/.redtrace');
writeFileSync(root+'/.redtrace/redtrace.yaml','workers:\n  - {name: current, provider: mock, roles: [soldier], max_running: 4, priority: 0}\n  - {name: alternate, provider: mock, roles: [soldier], max_running: 4, priority: 1}\n  - {name: scout-only, provider: mock, roles: [scout], max_running: 1, priority: 0}\n  - {name: disabled, provider: mock, roles: [soldier], enabled: false, max_running: 1, priority: 0}\n')
const e=await serveEngine({root,port:0,autoStart:false}),store=e.store,legion=new LegionStore(store),experience=new LegionExperience(store,root+'/workspaces')
const project=title=>{const p=store.createProject({title,origin:'仅限隔离本地 UI 夹具，无外部目标',goal:'核验迁移后的控制台交互'}).project;mkdirSync(root+'/workspaces/'+p.id,{recursive:true});return p}
const source=project('经验来源 · 算术验证'),target=project('目标项目 · 独立复验')
const worker={name:'current',provider:'mock',model:'mock',backend:'mock',enabled:true,maxRunning:10,priority:0}
const step=(p,key,description)=>legion.spawn(p.id,{role:'soldier',taskKey:key,description,sourceIds:['origin']})
const proof=(p,key,description,text)=>{const s=step(p,key,description),r=store.claim(p.id,'execute',worker,s.id),f=store.addFact(p.id,text,{runId:r.id});store.finishRun(r.id,'succeeded');return f}
const sf=proof(source,'source','确认来源算术结果','已实际验证：5 + 7 = 12'),tf=proof(target,'target','重新验证目标题目','已实际验证：6 + 8 = 14')
proof(target,'unrelated','无关题目，不能用于目标复验','这不是目标题目的复验证据')
const doc=experience.capture(source.id,{family:'arithmetic',title:'算术求和验证方法',body:('Independent arithmetic validation. Recheck product, version and prerequisites in target.\n').repeat(120),factIds:[sf.id]})
const transfer=experience.transfer(doc.id,target.id,'target','目标输入不同，必须独立计算，不得复用来源结论。')
step(target,'parked','等待新的入口证据');legion.park(target.id,'parked','缺少新入口证据','新增入口证据并核验旧执行停止')
const unknownStep=step(target,'unknown','工具执行结果尚未确认'),unknown=store.claim(target.id,'execute',worker,unknownStep.id);store.finishRun(unknown.id,'unknown');legion.park(target.id,'unknown','需要核验工具结果','确认实际执行结果')
const pausedStep=step(target,'paused','执行暂停，不能冒充 Park'),paused=store.claim(target.id,'execute',worker,pausedStep.id);store.finishRun(paused.id,'paused')
const liveStep=step(target,'live','保持执行会话，用于测试同角色交接'),live=store.claim(target.id,'execute',worker,liveStep.id)
for(const status of ['pending','queued','admitted','uncertain']){const m=legion.message(target.id,'commander','commander','REPORT','隔离夹具消息：'+status);if(status!=='pending'){legion.delivery(target.id,'commander',m.id,'queued');if(status!=='queued')legion.delivery(target.id,'commander',m.id,status)}}
const c=legion.campaign();legion.saveCampaign({...c,status:'stopped',state:'隔离 UI 夹具，无模型执行。已保存来源与目标证据；Park、暂停、未知执行需分别核验。',hasSession:false})
const state={root,url:'http://127.0.0.1:'+e.server.address().port,source:source.id,target:target.id,sourceFact:sf.id,targetFact:tf.id,transfer:transfer.id,liveRun:live.id}
console.log(JSON.stringify(state));writeFileSync('/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/frontend-console-20261111/UI-FIXTURE.json',JSON.stringify(state,null,2))
process.on('SIGTERM',async()=>{await e.close();process.exit(0)})
