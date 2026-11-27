import { recoverableModelFailure } from './model-recovery.ts'
import {readRunTrace} from './run-trace.ts'
import { coordinatorRole, executionRole } from '../../redtrace-dsh/src/roles.ts'
import { specialistSchema } from './graph-contracts.ts'
import { workerInstances } from './workbench.ts'
import { TASK_PLANNING_TOOLS, taskTodoOwner, type CommanderTodos } from './legion-todos.ts'
import { LegionExperience } from './legion-experience.ts'
import { ProjectEvidence } from './project-evidence.ts'
import { benchmarkAdapter, benchmarkInstance, discoverBenchmarkTasks } from './benchmark.ts'
import type { EngineConfig } from './types.ts'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { validateToolArguments } from './tool-validation.ts'
import type { AgentTool } from './tool-types.ts'
import type { Store } from './store.ts'
import type { Step, Goal, GraphPlanner } from './types.ts'
import { HttpError } from './types.ts'
import { LegionStore } from './legion-store.ts'

export function legionTools(store: Store, actor: string, projectId: string | undefined, maxSteps: number | null, finish: () => void, config?: EngineConfig, todos?: CommanderTodos, currentConfig?: () => EngineConfig): AgentTool[] {
  if(projectId)store=store.forProject(projectId)
  const legion = new LegionStore(store,projectId), commander = actor === 'commander', benchmark = !!projectId && store.project(projectId).mode === 'benchmark'
  const settings = () => currentConfig ? currentConfig() : config
  const stepLimit = () => currentConfig ? currentConfig().maxSteps : maxSteps
  if(commander&&!benchmark)todos ??= legion.planningTodos(projectId!)
  const tool = (name: string, description: string, parameters: any, execute: (args: any, signal?: AbortSignal) => unknown, terminate: boolean | ((args: any) => boolean) = false): AgentTool => ({
    name, label: name, description, parameters, executionMode: 'sequential',
    async execute(_id, args, signal) {
      validateToolArguments(name, parameters, args)
      if(commander) {
        if(!projectId) throw new HttpError(422,'Commander requires its Project')
        for(const key of ['projectId','targetProject']) if((args as Record<string,unknown>)[key]!==undefined && (args as Record<string,unknown>)[key]!==projectId) throw new HttpError(403,'Commander cannot access another Project')
      }
      if (commander && legion.campaign().status !== 'running') throw new HttpError(409, 'Commander is not running')
      if(benchmark&&!commander&&TASK_PLANNING_TOOLS.has(name)&&step&&(!taskTodoOwner(step,store)||store.assignment(store.run(actor))?.status!=='running'))throw new HttpError(409,'Planning ownership transferred to another task Agent')
      const result = await execute(args, signal)
      if(commander&&benchmark&&['legion_spawn','legion_park','legion_reactivate','legion_reassign','legion_commander_model','legion_adjust','legion_transfer'].includes(name))legion.checkpointState(projectId!,name)
      const value = JSON.parse(JSON.stringify(result)); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...((typeof terminate === 'function' ? terminate(args) : terminate) ? { terminate: true } : {}) } },
  })
  const project = (args: any) => { if (commander) { store.project(projectId!); return projectId! }; return projectId! }
  const scope: Record<string, TSchema> = commander ? { projectId: Type.String() } : {}
  const text = Type.String({ minLength: 1 })
  const experience=()=>{if(!config)throw new Error('Runtime configuration unavailable');return new LegionExperience(commander?store:store.forGraph(projectId!,store.run(actor).graphId!),config.workspaceRoot)}
  const assignment = { specialist:Type.Optional(specialistSchema), escalationReason:Type.Optional(text) }
  const roster = tool('legion_roster',"读真实 Worker Run、specialist、性能、前任和状态；按每分钟/Token 的确证成效互补编队或 STATE 接力，不把自述作 Fact。",Type.Object(commander&&!benchmark?{projectId:text}:{},{additionalProperties:false}),()=>workerInstances(store,projectId!).filter(w=>commander||w.graphId===step?.graphId).slice(-100).map(w=>({runId:w.id,label:w.label,stepId:w.stepId,role:w.role,specialist:w.specialist,taskKey:w.taskKey,status:w.status,worker:w.worker,facts:w.facts,tokens:w.tokens,elapsedMs:w.elapsedMs,predecessorRunId:w.predecessorRunId,error:w.error})))
  const inspection = commander && !benchmark ? [
    tool('legion_evidence_read',"分页读本 Project 留存且校验 hash 的 Artifact；二进制为 base64，不依赖 producer Run/Session。",Type.Object({...(!benchmark?scope:{}),artifactId:text,offset:Type.Optional(Type.Integer({minimum:0})),length:Type.Optional(Type.Integer({minimum:1,maximum:7600}))},{additionalProperties:false}),args=>{if(!config)throw new Error('Runtime configuration unavailable');return new ProjectEvidence(store,config.workspaceRoot).read(project(args),args.artifactId,args.offset,args.length)}),
    tool('legion_read_run',"先读 Audit 摘要索引；query 搜索，after/before 分页，eventId 展开单条原文。默认不含 Thinking/重复参数。",Type.Object({...(!benchmark?scope:{}),runId:text,after:Type.Optional(Type.Integer({minimum:0})),before:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),query:Type.Optional(text),eventId:Type.Optional(Type.Integer({minimum:1})),includeThinking:Type.Optional(Type.Boolean())},{additionalProperties:false}),args=>readRunTrace(store,project(args),args.runId,args,undefined)),
  ] : []
  if(commander&&benchmark) return [roster,...inspection,
    tool('legion_board',"精简 Board；taskKey 聚焦单题，不含 FGS 正文。",Type.Object({taskKey:Type.Optional(text)},{additionalProperties:false}),args=>({...legion.boardSummary(args.taskKey),capacity:{...legion.questionCapacity(settings()?.maxBenchmarkTasks ?? null),maxProjectWorkers:settings()?.maxProjectWorkers,maxRunningProjects:settings()?.maxRunningProjects,runningWorkers:Number(store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'").get()!.n),runningCommanders:Number(store.db.prepare("SELECT COUNT(*) AS n FROM project_campaigns WHERE json_extract(data,'$.status')='running'").get()!.n)}})),
    tool('legion_read_changes',"分页读调度增量至 hasMore=false；处理后在 legion_wait 确认 cursor。",Type.Object({after:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),args=>legion.readCommandChanges(projectId!,args.after,args.limit)),
    tool('legion_inbox',"读未处理持久消息；送达不等于证据。",Type.Object({},{additionalProperties:false}),()=>legion.messages(projectId!,'commander').filter(m=>m.status!=='admitted')),
    tool('legion_message',"原文转发用户指令，或给活动任务所有者发资源/归属通知；不提供攻击策略。",Type.Object({receiver:text,type:Type.Union(['HELP','REPORT','MESSAGE'].map(v=>Type.Literal(v))),content:text},{additionalProperties:false}),args=>legion.message(projectId!,'commander',args.receiver,args.type,args.content)),
    tool('legion_spawn',"按平台 flag_count 派 DSH Worker：>1→General Planner，1/未知→自主 Soldier。specialist 定义名称/职责/能力/范围；Graph 仅初始化一次，升级沿用 FGS/TodoList。",Type.Object({taskKey:text,role:Type.Union(['soldier','general'].map(v=>Type.Literal(v))),mission:text,...assignment,executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')]))},{additionalProperties:false}),args=>{
      let graph=store.projectGraphs(projectId!).find(g=>g.taskKey===args.taskKey)
      graph??=store.createGraph(projectId!,{taskKey:args.taskKey,title:args.taskKey,origin:store.scopeFact(projectId!).description+'\nAssigned task: '+args.taskKey,goal:store.project(projectId!).objective+' · '+args.taskKey})
      return legion.spawn(projectId!,{role:args.role,taskKey:args.taskKey,description:args.mission,graphId:graph.id,sourceIds:[graph.originId],goalId:graph.goalId,executionProfile:args.executionProfile,specialist:args.specialist,escalationReason:args.escalationReason},settings()?.maxBenchmarkTasks ?? null)
    }),
    tool('legion_adjust',"调整 Worker 优先级或取消，不改任务攻击计划。",Type.Object({missionId:text,priority:Type.Optional(Type.Number()),cancel:Type.Optional(Type.Boolean())},{additionalProperties:false}),args=>store.updateStep(projectId!,args.missionId,{priority:args.priority,...(args.cancel?{status:'cancelled' as const}:{})})),
    tool('legion_reassign',"结果结清后切换活动 Worker 至配置内同角色模型。",Type.Object({runId:text,nextWorker:text,summary:text},{additionalProperties:false}),args=>{const run=store.run(args.runId),step=store.assignment(run)!;if(!config?.workers.some(w=>w.enabled&&w.name===args.nextWorker&&w.roles?.includes(executionRole(store.project(projectId!).mode,step.role))))throw new HttpError(422,'Replacement route does not support this role');return legion.requestHandoff(run.id,args.summary,args.nextWorker)}),
    tool('legion_park',"记录阻塞和明确恢复条件，停止任务并 Park。",Type.Object({taskKey:text,reason:text,resumeCondition:text},{additionalProperties:false}),args=>legion.park(projectId!,args.taskKey,args.reason,args.resumeCondition)),
    tool('legion_reactivate',"旧执行/未知结果结清后恢复 Park 任务。",Type.Object({taskKey:text,reason:text},{additionalProperties:false}),args=>legion.reactivate(projectId!,args.taskKey,args.reason)),
    tool('legion_models',"列出配置内角色模型/容量，不含凭据。",Type.Object({},{additionalProperties:false}),()=>config?.workers.map(w=>({name:w.name,roles:w.roles,enabled:w.enabled,provider:w.provider,model:w.model,maxRunning:w.maxRunning,priority:w.priority}))??[]),
    tool('legion_commander_model',"选择下轮巡检的配置内 Commander 模型。",Type.Object({worker:text},{additionalProperties:false}),args=>{if(!config?.workers.some(w=>w.name===args.worker&&w.enabled&&w.roles?.includes(coordinatorRole(benchmark?'benchmark':'general'))))throw new HttpError(422,'Invalid Commander route');const c=legion.campaign();c.nextWorker=args.worker;legion.saveCampaign(c);return{nextWorker:args.worker}}),
    tool('legion_deadline',"显式设置 epoch 毫秒截止时间。",Type.Object({deadline:Type.Integer({minimum:1})},{additionalProperties:false}),args=>legion.setDeadline(args.deadline)),
    tool('legion_platform_list',"刷新平台并初始化任务；CTFy 未绑定时返回比赛列表，按用户目标传 competition_id 再调用，选择保存在当前 Project。",Type.Object({competition_id:Type.Optional(Type.String({minLength:1,maxLength:128,pattern:'^[A-Za-z0-9_-]+$'}))},{additionalProperties:false}),async(args,signal)=>{
      const runtime=settings()
      if(!runtime)throw Error('Runtime configuration unavailable')
      const discovery=await discoverBenchmarkTasks(store,runtime,projectId!,signal,args.competition_id)
      const adapter=benchmarkAdapter(store,projectId!)
      return {...legion.boardSummary(),adapter,...(discovery.selectionRequired?discovery:adapter.kind==='tpctf'?{competition_id:store.project(projectId!).ctfyCompetitionId}:{}),...(adapter.kind==='manual'?{notice:'本 Project Scope 无匹配的平台 adapter；仅列本地任务 Graph，非远端平台清单。'}:{})}
    }),
    tool('legion_state',"仅交接时读调度 STATE；summary 保存分配、阻塞、未完指令，不存解题情报。",Type.Object({summary:Type.Optional(text)},{additionalProperties:false}),args=>args.summary?legion.saveState(projectId,'commander',args.summary):{state:legion.commanderState()}),
    tool('legion_wait',"through=已处理增量 cursor；无新增沿用已确认值。结束本轮，保留 Session；60 秒后巡检（空闲 90 秒），释放执行槽。",Type.Object({through:Type.Integer({minimum:0})},{additionalProperties:false}),args=>{legion.finishCommand({[projectId!]:args.through},undefined,false);legion.checkpointState(projectId!,'patrol-sleep');finish();return{sleepSeconds:legion.inspectionDelay(projectId!)/1000}},true),
  ]
  const step = !commander ? store.assignment(store.run(actor)) : undefined
  const tools = [...inspection,
    tool('legion_experience_search', "查留存源项目经验；非目标 Fact，须在目标核对产品/版本/范围。",Type.Object({query:text,family:Type.Optional(text)}),args=>experience().search(args.query,args.family)),
    tool('legion_experience_capture',"以确证源 Fact ID 保存可复用 Markdown 经验并立即更新 FTS5；不将猜测写成确证。",Type.Object({...scope,family:text,title:text,body:text,factIds:Type.Array(text,{minItems:1})}),args=>experience().capture(project(args),args)),
    tool('legion_state', "原生压缩前保存完整确证 STATE：任务/Goal、证据 ID、失败、待结未知结果、精确下一步；不结束 Mission。", Type.Object({summary:Type.Optional(text)}), args=>args.summary?legion.saveState(projectId,actor,args.summary):commander?{state:legion.campaign().state}: {state:store.assignment(store.run(actor))?.handoff??''}),
    tool('legion_roster', "发消息前查本 Project 活动 Run ID、角色、任务；不含凭据/外部执行。", Type.Object(scope), args => [...store.runsByStatus('running', project(args)), ...store.runsByStatus('paused', project(args))].filter(run => run.stepId).map(run => { const step = store.node<Step>(project(args), run.stepId!, 'step'); if(!benchmark)return{runId:run.id,stepId:step.id,role:step.role,taskKey:step.taskKey,status:run.status,worker:run.worker}; return { runId: run.id, stepId: step.id, role: step.role, specialist: step.specialist, taskKey: step.taskKey, status: run.status, predecessorRunId:run.predecessorRunId, facts:step.factIds.length, inputTokens:run.inputTokens, outputTokens:run.outputTokens } })),
    tool('legion_message', "向本 Project actor 持久发送 HELP/REPORT/MESSAGE；pending/queued≠模型接收/行动。", Type.Object({ ...scope, receiver: text, type: Type.Union(['HELP','REPORT','MESSAGE'].map(v => Type.Literal(v))), content: text }), args => legion.message(project(args), actor, args.receiver, args.type, args.content)),
    tool('legion_inbox', "读本人的持久消息及实际投递状态；消息未验证，不是 Fact。", Type.Object(scope), args => legion.messages(project(args), actor)),
    tool('legion_wait', "General：确认 after 以内已处理事件并结束本轮，不等 Worker；其他角色：从已知 cursor 等图事件/待收消息，随本活动取消。", Type.Object({ ...scope, after: Type.Integer({ minimum: 0 }) }), (args, signal) => step?.role==='general' ? (store.completePlanning(actor,args.after,store.assignment(store.run(actor))?.handoff??'从 FGS/Worker Trace 继续'),finish(),{planningRoundFinished:true}) : commander&&!benchmark ? {mustFinish:true,instruction:'存 STATE 并 legion_finish 释放容量；FGS 事件防抖后恢复规划。'} : legion.wait(project(args), actor, args.after, signal), step?.role==='general'),
  ]
  const todoItems=Type.Array(Type.Object({content:Type.String(),status:Type.Union(['pending','in_progress','completed'].map(s=>Type.Literal(s))),acceptance:Type.Optional(text),stepIds:Type.Optional(Type.Array(text,{uniqueItems:true})),factIds:Type.Optional(Type.Array(text,{uniqueItems:true}))},{additionalProperties:false}))
  const verifyFact = (fact: import('./types.ts').Fact) => {
    if (fact.id === 'origin' || fact.id.startsWith('origin-graph-')) throw new HttpError(422,'Scope is not Goal evidence')
    const retained = fact.evidence.filter(e => e.artifactId)
    if (retained.length) {
      if (!config) throw new HttpError(409, 'Evidence storage configuration unavailable')
      const evidence = new ProjectEvidence(store.forGraph(projectId!, fact.graphId!), config.workspaceRoot)
      for (const source of retained) evidence.read(projectId!, source.artifactId!)
      return
    }
    if (!fact.evidence.some(e => e.runId && e.toolCallId && store.db.prepare("SELECT 1 FROM audit_events WHERE project_id=? AND run_id=? AND json_extract(data,'$.graph_id')=? AND json_extract(data,'$.kind')='tool.completed' AND (json_extract(data,'$.tool_call_id')=? OR json_extract(data,'$.call_id')=?)").get(projectId!,e.runId,fact.graphId!,e.toolCallId,e.toolCallId))) throw new HttpError(422, 'Fact '+fact.id+' has no retained evidence or real tool result; publish a linked correction with evidence.path or runId+toolCallId before acceptance')
  }
  const verifyGoalEvidence = (scoped: Store, ids: string[]) => {
    for (const id of ids) {
      const node = scoped.node(projectId!, id)
      for (const factId of node.kind === 'finding' ? node.factIds : [id]) verifyFact(scoped.node(projectId!, factId, 'fact'))
    }
  }
  if (commander && !benchmark && todos) tools.push(tool('TodoWrite', "替换本 Graph 完整 TodoList；General 模式仅 Planner 维护。", Type.Object({projectId:text,graphId:text,todos:todoItems},{additionalProperties:false}), args => {
    store.projectGraph(project(args), args.graphId)
    todos.replace(args.graphId, args.todos, verifyFact)
    return { saved: true }
  }))
  if(commander&&!benchmark)tools.push(tool('legion_report',"按需请求确证 Finding 报告，优先原 Worker/Session；上下文不可用才增 report-only Soldier。确需独立整合才用 independent=true。",Type.Object({projectId:text,findingId:text,independent:Type.Optional(Type.Boolean())},{additionalProperties:false}),args=>store.requestFindingReport(project(args),args.findingId,args.independent)))
  if(benchmark&&step&&taskTodoOwner(step,store)) {
    const graphId=step.graphId!,scoped=store.forGraph(projectId!,graphId)
    const accept = async(args: {expectedVersion:number;evidenceIds:string[]}, signal?:AbortSignal) => {
        verifyGoalEvidence(scoped,args.evidenceIds)
        const current=scoped.node<Goal>(projectId!,step.goalId,'goal')
        if(current.version!==args.expectedVersion)throw new HttpError(409,'Goal version changed; read the current Goal before acceptance')
        if(benchmarkAdapter(store,projectId!).instanceApi){
          if(!config)throw new Error('Runtime configuration unavailable')
          await discoverBenchmarkTasks(store,config,projectId!,signal)
        }
        const record=store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId!,step.taskKey!)
        const task=record?JSON.parse(String(record.data)):undefined
        const instanceOpen=task?.platformInstance?task.platformInstance.status!=='stopped':store.project(projectId!).benchmarkHosts?.[step.taskKey!]?.length
        if(task?.platformCompleted===true&&instanceOpen){
          if(step.role==='general')throw new HttpError(409,'Confirm managed instance cleanup before accepting; General cannot operate its lifecycle')
          if(!config)throw new Error('Runtime configuration unavailable')
          await benchmarkInstance(store,config,projectId!,step.taskKey!,'close',signal,actor)
        }
        return store.transaction(()=>{
          const owner=store.assignment(store.run(actor))!;owner.status='done'
          if(owner.role==='general')store.savePlanner(owner as GraphPlanner);else store.saveNode(owner as Step)
          const goal=scoped.updateGoal(projectId!,step.goalId,{status:'achieved',expectedVersion:args.expectedVersion,evidenceIds:args.evidenceIds});finish();return goal
        })
      }
    tools.push(
      tool('legion_accept',"验收本任务根 Goal 并结束；先留证据/结清同伴，由本任务释放已完成实例。只传 expectedVersion,evidenceIds。",Type.Object({expectedVersion:Type.Integer({minimum:1}),evidenceIds:Type.Array(text,{minItems:1})},{additionalProperties:false}),accept,true),
      tool('legion_goal',"在分配的任务 Graph 内新建证据驱动阶段 Goal。",Type.Object({description:text,parentId:Type.Optional(text)},{additionalProperties:false}),args=>scoped.addGoal(projectId!,args.description,args.parentId??step.goalId,actor)),
      tool('legion_update_goal',"修订/验收本任务阶段 Goal；根 Goal 达成自动走 accept 的收尾，不取消自身。",Type.Object({id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),status:Type.Optional(Type.Union([Type.Literal('open'),Type.Literal('achieved'),Type.Literal('cancelled')])),evidenceIds:Type.Optional(Type.Array(text,{minItems:1}))},{additionalProperties:false}),async(args,signal)=>{if(args.id===step.goalId&&args.status==='achieved'){const goal=scoped.node<Goal>(projectId!,args.id,'goal');if(args.description!==undefined&&args.description!==goal.description)throw new HttpError(422,'Root goal description is immutable');return accept({expectedVersion:args.expectedVersion,evidenceIds:args.evidenceIds??goal.evidenceIds},signal)}if(args.status==='achieved')verifyGoalEvidence(scoped,args.evidenceIds??scoped.node<Goal>(projectId!,args.id,'goal').evidenceIds);return scoped.updateGoal(projectId!,args.id,args)},args=>args.id===step.goalId&&args.status==='achieved'),
      tool('legion_confirm_transfer',"用本任务 Fact 确认已重验的转移经验。",Type.Object({id:text,factIds:Type.Array(text,{minItems:1})},{additionalProperties:false}),args=>experience().confirm(args.id,projectId!,args.factIds)),
    )
  }
  if (benchmark && step && taskTodoOwner(step,store)) {
    const graphId=step.graphId!, plans=legion.planningTodos(projectId!)
    tools.push(
      tool('legion_todos', "读本任务 Graph 持久 TodoList。",Type.Object({}),()=>plans.list(graphId)),
      tool('TodoWrite', "替换本任务 Graph 完整 TodoList；阶段完成须 Fact 验证，不凭 Worker/Step 结束。",Type.Object({todos:todoItems},{additionalProperties:false}),args=>{plans.replace(graphId,args.todos,verifyFact);return{saved:true}}),
    )
  }
  if(!commander)tools.push(tool('legion_handoff', "存 STATE 后请求新 Agent/Run；旧执行停止、工具结果全结清才自动接力，不重放未知动作。",Type.Object({summary:text,nextWorker:Type.Optional(text)}),args=>{if(args.nextWorker&&!config?.workers.some(w=>w.enabled&&w.name===args.nextWorker&&w.roles?.includes(executionRole(store.project(projectId!).mode,store.assignment(store.run(actor))?.role))))throw new HttpError(422,'Replacement worker must be enabled and support the same role');return legion.queueHandoff(actor,args.summary,args.nextWorker)}))
  if (benchmark && step?.role === 'general' && taskTodoOwner(step, store)) {
    const scoped=store.forGraph(projectId!,step.graphId!)
    const definition={description:text,sourceIds:Type.Array(text,{minItems:1,uniqueItems:true}),goalId:Type.Optional(text),dependsOn:Type.Optional(Type.Array(text,{uniqueItems:true})),specialist:Type.Optional(specialistSchema),priority:Type.Optional(Type.Integer()),executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')]))}
    const dispatch=(args:any)=>legion.spawn(projectId!,{...args,role:'soldier',graphId:step.graphId!,taskKey:step.taskKey!,parentRunId:actor})
    tools.push(
      tool('legion_step',"本任务排队 Step：sourceIds 为已有证据，dependsOn 等前置 Step 完成并有 Fact 才 claim，不等执行。平台完成后仅派实例清理/验收所需留存证据，不再攻击。",Type.Object(definition,{additionalProperties:false}),dispatch),
      tool('legion_steps',"原子批量排 Step，可含依赖阻塞阶段；Max Step 限 claim 不限创建，sourceIds 仅用已有证据。",Type.Object({steps:Type.Array(Type.Object(definition,{additionalProperties:false}),{minItems:1})},{additionalProperties:false}),args=>store.transaction(()=>args.steps.map(dispatch))),
      tool('legion_update_step',"修订、重试或取消本任务 Worker Step；重试前检查 Trace/输出，不改其他任务。",Type.Object({id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),sourceIds:Type.Optional(Type.Array(text,{minItems:1})),status:Type.Optional(Type.Union([Type.Literal('pending'),Type.Literal('cancelled')])),mode:Type.Optional(Type.Union([Type.Literal('amend'),Type.Literal('replace')]))},{additionalProperties:false}),args=>{const target=scoped.node<Step>(projectId!,args.id,'step');if(target.id===step.id)throw new HttpError(422,'Use legion_plan_done to finish a planning round');return scoped.updateStep(projectId!,args.id,args)}),
      tool('legion_read_run',"先读 Audit 摘要索引；query 搜索，after/before 分页，eventId 展开单条原文。默认不含 Thinking/重复参数。",Type.Object({runId:text,after:Type.Optional(Type.Integer({minimum:0})),before:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),query:Type.Optional(text),eventId:Type.Optional(Type.Integer({minimum:1})),includeThinking:Type.Optional(Type.Boolean())},{additionalProperties:false}),args=>readRunTrace(store,projectId!,args.runId,args,step.graphId??undefined)),
      tool('legion_triggers',"分页读未处理 Graph 事件；读取仅交付，不确认处理。",Type.Object({after:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),args=>{const planner=store.assignment(store.run(actor)) as GraphPlanner;if(args.after!==undefined&&args.after>planner.cursor.delivered)throw new HttpError(422,'Cannot skip undelivered events');return store.plannerEvents(planner,args.after,args.limit)}),
      tool('legion_plan_done',"保存确证 STATE 并立即结束本轮；Worker 独立继续，未处理事件唤醒原 Planner，不等 Worker。",Type.Object({state:text,through:Type.Integer({minimum:0})},{additionalProperties:false}),args=>{const saved=store.completePlanning(actor,args.through,args.state);finish();return saved},true),

    )
  }
  if(benchmark&&step&&taskTodoOwner(step,store)){const scoped=store.forGraph(projectId!,step.graphId!);tools.push(
      tool('legion_task_stop',"方向耗尽时如实止损，不宣称达成；先结清/取消其他 Worker，保留 Fact/TodoList/Trace。",Type.Object({reason:text,state:text},{additionalProperties:false}),args=>{
        if(scoped.nodes<Step>(projectId!,['step']).some(s=>s.id!==step.id&&['pending','running','paused'].includes(s.status))||store.runsByStatus('unknown',projectId!).some(r=>r.graphId===step.graphId))throw new HttpError(409,'Settle remaining task work before stopping')
        legion.saveState(projectId,actor,args.state);const goal=scoped.node<Goal>(projectId!,step.goalId,'goal');const result=scoped.updateGoal(projectId!,goal.id,{status:'cancelled',expectedVersion:goal.version});scoped.event(projectId!,'legion.task_exhausted',null,{reason:args.reason});finish();return result
      },true),
  )}
  if (commander && !benchmark) tools.push(tool('legion_step', "在唯一主 FGS 向既有 Pool 创建 Step：sourceIds 为已有证据，dependsOn 等前置 Step 完成并有 Fact 才 claim，可预排未来阶段；独立 Step 并发。specialist 为沿用 Soldier 工具的自定义 Executor，不增 Planner/编队。", Type.Object({projectId:text,description:text,sourceIds:Type.Array(text,{minItems:1}),goalId:Type.Optional(text),dependsOn:Type.Optional(Type.Array(text,{uniqueItems:true})),specialist:Type.Optional(specialistSchema),reportFindingId:Type.Optional(text),priority:Type.Optional(Type.Integer()),executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')]))},{additionalProperties:false}), args => {
    const graph=store.projectGraphs(project(args))[0]
    if(args.reportFindingId && !args.sourceIds.includes(args.reportFindingId))throw new HttpError(422,'Report Step must reference its Finding in sourceIds')
    if(args.reportFindingId)store.node(project(args),args.reportFindingId,'finding')
    return store.forGraph(project(args),graph.id).addStep(project(args),{...args,role:'soldier',taskKey:graph.id,creator:'general'})
  }))
  if (commander) tools.push(
    tool('legion_hint',"将用户指令写成本 Graph 未验证 Hint，再通知所属 Agent 并跟踪送达或建 Mission；不广播含糊 Hint。",Type.Object({projectId:text,graphId:text,content:text}),args=>store.forGraph(project(args),args.graphId).addInput(project(args),'hint',args.content,'planner')),
    ...(!benchmark ? [
      tool('legion_goal',"沿既有 FGS 层级在本 Project 创建子 Goal。",Type.Object({projectId:text,graphId:Type.Optional(text),description:text,parentId:Type.Optional(text)}),args=>(args.graphId?store.forGraph(project(args),args.graphId):store).addGoal(project(args),args.description,args.parentId??'goal','planner')),
      tool('legion_update_goal',"用实际 expectedVersion 修订/替换/取消/重开 Goal；验收仍须 legion_accept 及确证。",Type.Object({projectId:text,id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),status:Type.Optional(Type.Union([Type.Literal('open'),Type.Literal('cancelled')])),mode:Type.Optional(Type.Union([Type.Literal('amend'),Type.Literal('replace')]))}),args=>store.updateGoal(args.projectId,args.id,args)),
    ] : []),
    tool('legion_update_step',"沿原生版本/隔离检查修订或取消 Mission；运行 Worker 须 sync_step 新契约。",Type.Object({projectId:text,id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),sourceIds:Type.Optional(Type.Array(text,{minItems:1})),goalId:Type.Optional(text),priority:Type.Optional(Type.Number()),status:Type.Optional(Type.Union([Type.Literal('pending'),Type.Literal('cancelled')])),executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')])),mode:Type.Optional(Type.Union([Type.Literal('amend'),Type.Literal('replace')]))}),args=>store.updateStep(args.projectId,args.id,args)),
    tool('legion_transfer',"将确证源经验转为目标未验证 Hint；目标独立重验，不复制 Fact。",Type.Object({sourceId:Type.Integer({minimum:1}),targetProject:text,taskKey:text,brief:text}),args=>experience().transfer(args.sourceId,args.targetProject,args.taskKey,args.brief)),
    tool('legion_confirm_transfer',"目标重验转移经验后记录该任务实际 Fact ID。",Type.Object({id:text,projectId:text,factIds:Type.Array(text,{minItems:1})}),args=>experience().confirm(args.id,args.projectId,args.factIds)),
    tool('legion_commander_model', "选下轮配置内 Commander 模型，存 STATE 并等本轮结清；不建 key 池/模型 fallback。",Type.Object({worker:text}),args=>{if(!config?.workers.some(w=>w.name===args.worker&&w.enabled&&w.roles?.includes(coordinatorRole(benchmark?'benchmark':'general'))))throw new HttpError(422,'Invalid Commander route');const c=legion.campaign();c.nextWorker=args.worker;legion.saveCampaign(c);return{nextWorker:args.worker}}),
    tool('legion_models', "读配置内角色模型/容量，不含凭据；provider 轮询仍由 DSH 管。",Type.Object({}),()=>config?.workers.map(w=>({name:w.name,roles:w.roles,provider:w.provider,model:w.model,enabled:w.enabled,maxRunning:w.maxRunning,priority:w.priority}))??[]),
    tool('legion_reassign', "在确证安全工具边界按 STATE 将活动 Worker 换为同角色模型/新 Run，不重放未决调用。",Type.Object({projectId:text,runId:text,nextWorker:text,summary:text}),args=>{const run=store.run(args.runId);if(run.projectId!==args.projectId||!run.stepId)throw new HttpError(403,'Run belongs to another Project');const step=store.node<Step>(args.projectId,run.stepId,'step');if(!config?.workers.some(w=>w.enabled&&w.name===args.nextWorker&&w.roles?.includes(executionRole(store.project(projectId!).mode,step.role))))throw new HttpError(422,'Replacement route does not support this role');return legion.requestHandoff(run.id,args.summary,args.nextWorker)}),
    tool('legion_deadline', "显式设 epoch 毫秒截止时间，不猜预算；最后提交阶段不建 Mission。", Type.Object({ deadline: Type.Integer({ minimum: 1 }) }), args => legion.setDeadline(args.deadline)),
    tool('legion_board', "读≤100 行 Board：HELP、异常、活动任务、待结结果、其他任务；FGS 详情按需读。", Type.Object({}), () => legion.boardSummary()),
    ...(!benchmark ? [tool('legion_todos', "General 模式按需读单 Graph TodoList。", Type.Object({projectId:text,graphId:text}),args=>{store.projectGraph(project(args),args.graphId);return todos?.list(args.graphId)??[]})] : []),
    tool('legion_read_changes', "分页读 Project FGS 增量；legion_finish 仅可确认已交付 cursor，读取≠处理。", Type.Object({ projectId: text, graphId:Type.Optional(text), after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), args => args.graphId ? store.forGraph(project(args),args.graphId).graphDelta(project(args),args.after,args.limit) : legion.readChanges(project(args), args.after, args.limit)),
    tool('legion_read_node', "读当前 FGS 节点/关联 Fact 摘要；detail=doc 展开 Doc/Evidence/Report 引用，legion_evidence_read 读原字节。", Type.Object({ projectId: text, id: text, detail: Type.Optional(Type.Union([Type.Literal('summary'), Type.Literal('doc')])) }), args => store.readNode(args.projectId, args.id, args.detail)),
    tool('legion_accept', "以当前确证 Fact/Finding 和实际 expectedVersion 验收 Goal；Step/消息完成不是证明。", Type.Object({ projectId: text, goalId: text, expectedVersion: Type.Integer({ minimum: 1 }), evidenceIds: Type.Array(text, { minItems: 1 }) }), args => {verifyGoalEvidence(store,args.evidenceIds);return store.updateGoal(args.projectId, args.goalId, { status: 'achieved', expectedVersion: args.expectedVersion, evidenceIds: args.evidenceIds })}),
    tool('legion_park', "以明确阻塞/恢复条件 Park 任务；只请求停止，不证明已停。", Type.Object({ projectId: text, taskKey: text, reason: text, resumeCondition: text }), args => legion.park(args.projectId, args.taskKey, args.reason, args.resumeCondition)),
    tool('legion_reactivate', "仅旧执行已停、未知结果已结清后恢复任务。", Type.Object({ projectId: text, taskKey: text, reason: text }), args => legion.reactivate(args.projectId, args.taskKey, args.reason)),
    ...(!benchmark && commander ? [tool('legion_stop', "合理方向耗尽且无 pending/running/paused/恢复中/unknown 工作才停止 Project，不宣称成功；保留 TodoList/FGS，用户 Hint/手动恢复可继续。", Type.Object({reason:text,state:text},{additionalProperties:false}), args => {
      const steps=store.nodes<Step>(projectId!,['step'])
      if(steps.some(s=>!s.deleted&&(['pending','running','paused'].includes(s.status)||s.handoffPending||s.replacementPending))||store.runsByStatus('unknown',projectId!).length)throw new HttpError(409,'Unsettled work prevents Project stop')
      if(store.runsByStatus('failed',projectId!).some(r=>r.stepId&&!r.pendingTools.length&&recoverableModelFailure(r.failureCode)))throw new HttpError(409,'Recoverable work prevents Project stop')
      legion.saveState(projectId,'commander',args.state)
      legion.saveCampaign({...legion.campaign(),endgame:args.reason})
      store.setStatus(projectId!,'stopped');finish();return{status:'stopped',reason:args.reason}
    },true)] : []),
    tool('legion_finish', "保存 STATE，仅确认已交付且处理的 Project cursor；结束本轮，不结束整个 campaign。", Type.Object({ processed: Type.Record(Type.String(), Type.Integer({ minimum: 0 })), state: text }), args => { const saved = legion.finishCommand(args.processed, args.state, false); finish(); return saved }, true),
  )
  if(!benchmark) {
    const allowed = new Set(commander ? ['legion_state','legion_roster','legion_experience_search','legion_experience_capture','legion_message','legion_inbox','legion_wait','TodoWrite','legion_todos','legion_goal','legion_update_goal','legion_step','legion_report','legion_update_step','legion_hint','legion_evidence_read','legion_read_run','legion_commander_model','legion_models','legion_stop','legion_read_changes','legion_read_node','legion_accept','legion_finish'] : ['legion_state','legion_message','legion_inbox','legion_wait','legion_handoff'])
    return tools.filter(t=>allowed.has(t.name)).map(t=>({...t,description:t.description.replaceAll('Commander','Planner').replaceAll('Sapper show/doc','FGS show/doc')}))
  }
  return tools.filter(t=>step?.role==='general' || t.name==='legion_experience_search'&&!!step&&taskTodoOwner(step,store) || !['legion_experience_capture','legion_experience_search','legion_confirm_transfer','legion_roster'].includes(t.name)).map(t=>t.name==='legion_roster'?roster:t)
}
