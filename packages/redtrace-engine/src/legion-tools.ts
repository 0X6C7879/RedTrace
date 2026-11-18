import {readRunTrace} from './run-trace.ts'
import { coordinatorRole, executionRole } from '../../redtrace-dsh/src/roles.ts'
import { specialistSchema } from './graph-contracts.ts'
import { workerInstances } from './workbench.ts'
import { TASK_PLANNING_TOOLS, taskTodoOwner, type CommanderTodos } from './legion-todos.ts'
import { LegionExperience } from './legion-experience.ts'
import { ProjectEvidence } from './project-evidence.ts'
import { benchmarkInstance, discoverBenchmarkTasks } from './benchmark.ts'
import type { EngineConfig } from './types.ts'
import { Type } from 'typebox'
import type { TSchema } from 'typebox'
import { Check, Errors } from 'typebox/value'
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
  const tool = (name: string, description: string, parameters: any, execute: (args: any, signal?: AbortSignal) => unknown, terminate = false): AgentTool => ({
    name, label: name, description, parameters, executionMode: 'sequential',
    async execute(_id, args, signal) {
      if (!Check(parameters, args)) throw new HttpError(422, 'Invalid tool arguments for '+name+': '+JSON.stringify([...Errors(parameters,args)].map(e=>({path:e.instancePath,message:e.message}))))
      if(commander) {
        if(!projectId) throw new HttpError(422,'Commander requires its Project')
        for(const key of ['projectId','targetProject']) if((args as Record<string,unknown>)[key]!==undefined && (args as Record<string,unknown>)[key]!==projectId) throw new HttpError(403,'Commander cannot access another Project')
      }
      if (commander && legion.campaign().status !== 'running') throw new HttpError(409, 'Commander is not running')
      if(benchmark&&!commander&&TASK_PLANNING_TOOLS.has(name)&&step&&(!taskTodoOwner(step,store)||store.assignment(store.run(actor))?.status!=='running'))throw new HttpError(409,'Planning ownership transferred to another task Agent')
      const result = await execute(args, signal)
      if(commander&&benchmark&&['legion_spawn','legion_park','legion_reactivate','legion_reassign','legion_commander_model','legion_adjust','legion_transfer'].includes(name))legion.checkpointState(projectId!,name)
      const value = JSON.parse(JSON.stringify(result)); return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value, ...(terminate ? { terminate: true } : {}) } },
  })
  const project = (args: any) => { if (commander) { store.project(projectId!); return projectId! }; return projectId! }
  const scope: Record<string, TSchema> = commander ? { projectId: Type.String() } : {}
  const text = Type.String({ minLength: 1 })
  const experience=()=>{if(!config)throw new Error('Runtime configuration unavailable');return new LegionExperience(commander?store:store.forGraph(projectId!,store.run(actor).graphId!),config.workspaceRoot)}
  const assignment = { specialist:Type.Optional(specialistSchema), escalationReason:Type.Optional(text) }
  const roster = tool('legion_roster','Read real Worker instances, specialist definitions, performance, predecessor and statuses. Use confirmed evidence per elapsed minute and Token to form elite complementary squads or arrange a compact STATE relay; never treat claims as Facts.',Type.Object(commander&&!benchmark?{projectId:text}:{},{additionalProperties:false}),()=>workerInstances(store,projectId!).filter(w=>commander||w.graphId===step?.graphId).slice(-100).map(w=>({runId:w.id,label:w.label,stepId:w.stepId,role:w.role,specialist:w.specialist,taskKey:w.taskKey,status:w.status,worker:w.worker,facts:w.facts,tokens:w.tokens,elapsedMs:w.elapsedMs,predecessorRunId:w.predecessorRunId,error:w.error})))
  const inspection = commander && !benchmark ? [
    tool('legion_evidence_read','Read a hash-verified retained Project artifact. Binary pages specify base64. No producer Run/Session dependency.',Type.Object({...(!benchmark?scope:{}),artifactId:text,offset:Type.Optional(Type.Integer({minimum:0})),length:Type.Optional(Type.Integer({minimum:1,maximum:7600}))},{additionalProperties:false}),args=>{if(!config)throw new Error('Runtime configuration unavailable');return new ProjectEvidence(store,config.workspaceRoot).read(project(args),args.artifactId,args.offset,args.length)}),
    tool('legion_read_run','Read an Audit summary index; query locates keywords, after/before page events, eventId expands one original event. Default excludes Thinking and repeated parameters.',Type.Object({...(!benchmark?scope:{}),runId:text,after:Type.Optional(Type.Integer({minimum:0})),before:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),query:Type.Optional(text),eventId:Type.Optional(Type.Integer({minimum:1})),includeThinking:Type.Optional(Type.Boolean())},{additionalProperties:false}),args=>readRunTrace(store,project(args),args.runId,args,undefined)),
  ] : []
  if(commander&&benchmark) return [roster,...inspection,
    tool('legion_board','Compact campaign Board; taskKey narrows to one task. No FGS bodies.',Type.Object({taskKey:Type.Optional(text)},{additionalProperties:false}),args=>({...legion.boardSummary(args.taskKey),capacity:{...legion.questionCapacity(settings()?.maxBenchmarkTasks ?? null),maxWorkers:settings()?.maxWorkers,maxProjectWorkers:settings()?.maxProjectWorkers,maxRunningProjects:settings()?.maxRunningProjects,runningWorkers:Number(store.db.prepare("SELECT COUNT(*) AS n FROM runs WHERE status='running'").get()!.n),runningCommanders:Number(store.db.prepare("SELECT COUNT(*) AS n FROM project_campaigns WHERE json_extract(data,'$.status')='running'").get()!.n)}})),
    tool('legion_read_changes','Read scheduling deltas only. Page until hasMore=false; acknowledge the processed cursor at legion_wait.',Type.Object({after:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),args=>legion.readCommandChanges(projectId!,args.after,args.limit)),
    tool('legion_inbox','Read unprocessed campaign messages. Delivery is not evidence.',Type.Object({},{additionalProperties:false}),()=>legion.messages(projectId!,'commander').filter(m=>m.status!=='admitted')),
    tool('legion_message','Forward a user instruction verbatim or send resource/ownership notices to a live task owner. Never give attack tactics.',Type.Object({receiver:text,type:Type.Union(['HELP','REPORT','MESSAGE'].map(v=>Type.Literal(v))),content:text},{additionalProperties:false}),args=>legion.message(projectId!,'commander',args.receiver,args.type,args.content)),
    tool('legion_spawn','Dispatch a task Worker through DSH. First dispatch Scout; after its completed evidence-backed verdict dispatch Soldier for easy work or General for complex/unclear work. specialist defines name, responsibility, capability and scope. Task Graph initializes once. reuseTaskKey reuses confirmed sibling intel, never target evidence.',Type.Object({taskKey:text,role:Type.Union(['scout','soldier','general'].map(v=>Type.Literal(v))),mission:text,...assignment,executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')]))},{additionalProperties:false}),args=>{
      let graph=store.projectGraphs(projectId!).find(g=>g.taskKey===args.taskKey)
      graph??=store.createGraph(projectId!,{taskKey:args.taskKey,title:args.taskKey,origin:store.scopeFact(projectId!).description+'\nAssigned task: '+args.taskKey,goal:store.project(projectId!).objective+' · '+args.taskKey})
      return legion.spawn(projectId!,{role:args.role,taskKey:args.taskKey,description:args.mission,graphId:graph.id,sourceIds:[graph.originId],goalId:graph.goalId,executionProfile:args.executionProfile,specialist:args.specialist,escalationReason:args.escalationReason},settings()?.maxBenchmarkTasks ?? null)
    }),
    tool('legion_adjust','Change execution priority or cancel an assigned Worker; never rewrite the task attack plan.',Type.Object({missionId:text,priority:Type.Optional(Type.Number()),cancel:Type.Optional(Type.Boolean())},{additionalProperties:false}),args=>store.updateStep(projectId!,args.missionId,{priority:args.priority,...(args.cancel?{status:'cancelled' as const}:{})})),
    tool('legion_reassign','Change a live Worker to a configured same-role model at a settled boundary.',Type.Object({runId:text,nextWorker:text,summary:text},{additionalProperties:false}),args=>{const run=store.run(args.runId),step=store.assignment(run)!;if(!config?.workers.some(w=>w.enabled&&w.name===args.nextWorker&&w.roles?.includes(executionRole(store.project(projectId!).mode,step.role))))throw new HttpError(422,'Replacement route does not support this role');return legion.requestHandoff(run.id,args.summary,args.nextWorker)}),
    tool('legion_park','Stop a task with its blocker and concrete resume condition.',Type.Object({taskKey:text,reason:text,resumeCondition:text},{additionalProperties:false}),args=>legion.park(projectId!,args.taskKey,args.reason,args.resumeCondition)),
    tool('legion_reactivate','Resume a Parked task after old execution and unknown outcomes settle.',Type.Object({taskKey:text,reason:text},{additionalProperties:false}),args=>legion.reactivate(projectId!,args.taskKey,args.reason)),
    tool('legion_models','Configured role-model routes and capacities; no credentials.',Type.Object({},{additionalProperties:false}),()=>config?.workers.map(w=>({name:w.name,roles:w.roles,enabled:w.enabled,provider:w.provider,model:w.model,maxRunning:w.maxRunning,priority:w.priority}))??[]),
    tool('legion_commander_model','Choose the configured Commander route for the next patrol.',Type.Object({worker:text},{additionalProperties:false}),args=>{if(!config?.workers.some(w=>w.name===args.worker&&w.enabled&&w.roles?.includes(coordinatorRole(benchmark?'benchmark':'general'))))throw new HttpError(422,'Invalid Commander route');const c=legion.campaign();c.nextWorker=args.worker;legion.saveCampaign(c);return{nextWorker:args.worker}}),
    tool('legion_deadline','Set the explicit campaign deadline in epoch milliseconds.',Type.Object({deadline:Type.Integer({minimum:1})},{additionalProperties:false}),args=>legion.setDeadline(args.deadline)),
    tool('legion_platform_list','Refresh platform task outcomes and initialize missing tasks with the existing adapter; return compact Board.',Type.Object({},{additionalProperties:false}),async(_args,signal)=>{if(!config)throw Error('Runtime configuration unavailable');await discoverBenchmarkTasks(store,config,projectId!,signal);return legion.boardSummary()}),
    tool('legion_state','Read scheduling STATE only on handover; summary saves allocation, blockers and unfinished instructions, never solving intel.',Type.Object({summary:Type.Optional(text)},{additionalProperties:false}),args=>args.summary?legion.saveState(projectId,'commander',args.summary):{state:legion.commanderState()}),
    tool('legion_wait','Acknowledge through=last processed changes cursor, then end this patrol in the same persistent Session. Use the prior acknowledged cursor if no changes were processed. Sleep 60 seconds (90 idle); release execution slots.',Type.Object({through:Type.Integer({minimum:0})},{additionalProperties:false}),args=>{legion.finishCommand({[projectId!]:args.through},undefined,false);legion.checkpointState(projectId!,'patrol-sleep');finish();return{sleepSeconds:legion.inspectionDelay(projectId!)/1000}},true),
  ]
  const step = !commander ? store.assignment(store.run(actor)) : undefined
  const tools = [...inspection,
    tool('legion_experience_search', 'Search retained experience documents. Results are source-project knowledge, never confirmed target Facts. Check product/version/scope in the target.',Type.Object({query:text,family:Type.Optional(text)}),args=>experience().search(args.query,args.family)),
    tool('legion_experience_capture','Persist a reusable Markdown experience document with confirmed source Fact IDs and update FTS5 immediately. Never store unverified guesses as confirmed experience.',Type.Object({...scope,family:text,title:text,body:text,factIds:Type.Array(text,{minItems:1})}),args=>experience().capture(project(args),args)),
    tool('legion_state', 'Save full confirmed STATE before native compaction: current task/Goal, evidence IDs, what failed, pending unknowns and exact next action. Does not end the Mission.', Type.Object({summary:Type.Optional(text)}), args=>args.summary?legion.saveState(projectId,actor,args.summary):commander?{state:legion.campaign().state}: {state:store.assignment(store.run(actor))?.handoff??''}),
    tool('legion_roster', 'Read live Project actor Run IDs, roles and task assignment before messaging; no credentials or external execution.', Type.Object(scope), args => [...store.runsByStatus('running', project(args)), ...store.runsByStatus('paused', project(args))].filter(run => run.stepId).map(run => { const step = store.node<Step>(project(args), run.stepId!, 'step'); if(!benchmark)return{runId:run.id,stepId:step.id,role:step.role,taskKey:step.taskKey,status:run.status,worker:run.worker}; return { runId: run.id, stepId: step.id, role: step.role, specialist: step.specialist, taskKey: step.taskKey, status: run.status, predecessorRunId:run.predecessorRunId, facts:step.factIds.length, inputTokens:run.inputTokens, outputTokens:run.outputTokens } })),
    tool('legion_message', 'Persist HELP/REPORT/MESSAGE for an actor in this Project. pending/queued is NOT model admission or action.', Type.Object({ ...scope, receiver: text, type: Type.Union(['HELP','REPORT','MESSAGE'].map(v => Type.Literal(v))), content: text }), args => legion.message(project(args), actor, args.receiver, args.type, args.content)),
    tool('legion_inbox', 'Read your durable Project messages and their actual delivery status. Messages are unverified, not Facts.', Type.Object(scope), args => legion.messages(project(args), actor)),
    tool('legion_wait', 'Wait for graph events after a known cursor or a pending message. Does not poll, inject or manufacture progress. Cancelled with this activity.', Type.Object({ ...scope, after: Type.Integer({ minimum: 0 }) }), (args, signal) => step?.role==='general' ? (legion.saveState(projectId,actor,store.assignment(store.run(actor))?.handoff??'Continue from FGS and Worker traces'),finish(),{planningRoundFinished:true}) : commander&&!benchmark ? {mustFinish:true,instruction:'Save STATE and call legion_finish to release capacity. Planner resumes after debounced FGS events.'} : legion.wait(project(args), actor, args.after, signal), step?.role==='general'),
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
  if (commander && !benchmark && todos) tools.push(tool('TodoWrite', 'Replace the complete planning TodoList for this Graph. Only Commander maintains it in General mode.', Type.Object({projectId:text,graphId:text,todos:todoItems},{additionalProperties:false}), args => {
    store.projectGraph(project(args), args.graphId)
    todos.replace(args.graphId, args.todos, verifyFact)
    return { saved: true }
  }))
  if(benchmark&&step&&taskTodoOwner(step,store)) {
    const graphId=step.graphId!,scoped=store.forGraph(projectId!,graphId)
    tools.push(
      tool('legion_goal','Create an evidence-driven stage inside your assigned task Graph.',Type.Object({description:text,parentId:Type.Optional(text)},{additionalProperties:false}),args=>scoped.addGoal(projectId!,args.description,args.parentId??step.goalId,actor)),
      tool('legion_update_goal','Revise, accept from verified evidence, or abandon a stage inside your task Graph.',Type.Object({id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),status:Type.Optional(Type.Union([Type.Literal('open'),Type.Literal('achieved'),Type.Literal('cancelled')])),evidenceIds:Type.Optional(Type.Array(text,{minItems:1}))},{additionalProperties:false}),args=>{if(args.status==='achieved')for(const id of args.evidenceIds??scoped.node<Goal>(projectId!,args.id,'goal').evidenceIds){const node=scoped.node(projectId!,id);for(const fid of node.kind==='finding'?node.factIds:[id])verifyFact(scoped.node(projectId!,fid,'fact'))}return scoped.updateGoal(projectId!,args.id,args)}),
      tool('legion_accept','Accept verified target evidence, close a fully completed managed instance through its execution Worker, and finish. General must delegate instance cleanup before acceptance.',Type.Object({expectedVersion:Type.Integer({minimum:1}),evidenceIds:Type.Array(text,{minItems:1})},{additionalProperties:false}),async(args,signal)=>{
        for(const id of args.evidenceIds){const node=scoped.node(projectId!,id);for(const factId of node.kind==='finding'?node.factIds:[id])verifyFact(scoped.node(projectId!,factId,'fact'))}
        const current=scoped.node<Goal>(projectId!,step.goalId,'goal')
        if(current.version!==args.expectedVersion)throw new HttpError(409,'Goal version changed; read the current Goal before acceptance')
        const record=store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId!,step.taskKey!)
        if(record&&JSON.parse(String(record.data)).platformCompleted===true&&store.project(projectId!).benchmarkHosts?.[step.taskKey!]?.length){
          if(step.role==='general')throw new HttpError(409,'Assign an execution Worker Step to close this completed task instance before accepting; General cannot operate its lifecycle')
          if(!config)throw new Error('Runtime configuration unavailable')
          await benchmarkInstance(store,config,projectId!,step.taskKey!,'close',signal,actor)
        }
        return store.transaction(()=>{
          const owner=store.assignment(store.run(actor))!;owner.status='done'
          if(owner.role==='general')store.savePlanner(owner as GraphPlanner);else store.saveNode(owner as Step)
          const goal=scoped.updateGoal(projectId!,step.goalId,{status:'achieved',expectedVersion:args.expectedVersion,evidenceIds:args.evidenceIds});finish();return goal
        })
      },true),
      tool('legion_confirm_transfer','Confirm transferred knowledge with Facts from this task.',Type.Object({id:text,factIds:Type.Array(text,{minItems:1})},{additionalProperties:false}),args=>experience().confirm(args.id,projectId!,args.factIds)),
    )
  }
  if (benchmark && step && taskTodoOwner(step,store)) {
    const graphId=step.graphId!, plans=legion.planningTodos(projectId!)
    tools.push(
      tool('legion_todos', 'Read the durable TodoList for your assigned task Graph.',Type.Object({}),()=>plans.list(graphId)),
      tool('TodoWrite', 'Replace your assigned task Graph TodoList. Complete stages only from verified Facts, not Worker or Step termination.',Type.Object({todos:todoItems},{additionalProperties:false}),args=>{plans.replace(graphId,args.todos,verifyFact);return{saved:true}}),
    )
  }
  if(!commander)tools.push(tool('legion_handoff', 'Request a fresh Agent/Run after saving STATE. Old execution must stop and all tool outcomes settle before automatic relay; never replay an unknown action.',Type.Object({summary:text,nextWorker:Type.Optional(text)}),args=>{if(args.nextWorker&&!config?.workers.some(w=>w.enabled&&w.name===args.nextWorker&&w.roles?.includes(executionRole(store.project(projectId!).mode,store.assignment(store.run(actor))?.role))))throw new HttpError(422,'Replacement worker must be enabled and support the same role');return legion.queueHandoff(actor,args.summary,args.nextWorker)}))
  if (benchmark && step?.role === 'general' && taskTodoOwner(step, store)) {
    const scoped=store.forGraph(projectId!,step.graphId!)
    const definition={description:text,sourceIds:Type.Array(text,{minItems:1,uniqueItems:true}),goalId:Type.Optional(text),dependsOn:Type.Optional(Type.Array(text,{uniqueItems:true})),specialist:Type.Optional(specialistSchema),priority:Type.Optional(Type.Integer()),executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')]))}
    const dispatch=(args:any)=>legion.spawn(projectId!,{...args,role:'soldier',graphId:step.graphId!,taskKey:step.taskKey!,parentRunId:actor})
    tools.push(
      tool('legion_step','Queue a Step in this task. After platform completion, delegate only instance cleanup or retained evidence needed for acceptance, never another attack. sourceIds supply evidence; dependsOn holds claim until prerequisite Steps finish with Facts. Never waits for execution.',Type.Object(definition,{additionalProperties:false}),dispatch),
      tool('legion_steps','Atomically queue multiple Steps, including dependency-blocked stages. Max Step limits claims, never batch creation; sourceIds must reference existing evidence.',Type.Object({steps:Type.Array(Type.Object(definition,{additionalProperties:false}),{minItems:1})},{additionalProperties:false}),args=>store.transaction(()=>args.steps.map(dispatch))),
      tool('legion_update_step','Correct, retry or cancel an assigned Worker Step; inspect its trace and output before retry. Never edits another task.',Type.Object({id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),sourceIds:Type.Optional(Type.Array(text,{minItems:1})),status:Type.Optional(Type.Union([Type.Literal('pending'),Type.Literal('cancelled')])),mode:Type.Optional(Type.Union([Type.Literal('amend'),Type.Literal('replace')]))},{additionalProperties:false}),args=>{const target=scoped.node<Step>(projectId!,args.id,'step');if(target.id===step.id)throw new HttpError(422,'Use legion_plan_done to finish a planning round');return scoped.updateStep(projectId!,args.id,args)}),
      tool('legion_read_run','Read an Audit summary index; query locates keywords, after/before page events, eventId expands one original event. Default excludes Thinking and repeated parameters.',Type.Object({runId:text,after:Type.Optional(Type.Integer({minimum:0})),before:Type.Optional(Type.Integer({minimum:1})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100})),query:Type.Optional(text),eventId:Type.Optional(Type.Integer({minimum:1})),includeThinking:Type.Optional(Type.Boolean())},{additionalProperties:false}),args=>readRunTrace(store,projectId!,args.runId,args,step.graphId??undefined)),
      tool('legion_triggers','Page unprocessed Graph events; reading is delivery, not acknowledgement.',Type.Object({after:Type.Optional(Type.Integer({minimum:0})),limit:Type.Optional(Type.Integer({minimum:1,maximum:100}))},{additionalProperties:false}),args=>{const planner=store.assignment(store.run(actor)) as GraphPlanner;if(args.after!==undefined&&args.after>planner.cursor.delivered)throw new HttpError(422,'Cannot skip undelivered events');return store.plannerEvents(planner,args.after,args.limit)}),
      tool('legion_plan_done','Save confirmed STATE and end only this planning round immediately. Workers continue independently; unprocessed events wake the same Planner. Do not wait for Workers.',Type.Object({state:text,through:Type.Integer({minimum:0})},{additionalProperties:false}),args=>{const saved=store.completePlanning(actor,args.through,args.state);finish();return saved},true),

    )
  }
  if(benchmark&&step&&taskTodoOwner(step,store)){const scoped=store.forGraph(projectId!,step.graphId!);tools.push(
      tool('legion_task_stop','End an exhausted task honestly without claiming achievement. Preserve Facts, TodoList and trace; first settle or cancel remaining Workers.',Type.Object({reason:text,state:text},{additionalProperties:false}),args=>{
        if(scoped.nodes<Step>(projectId!,['step']).some(s=>s.id!==step.id&&['pending','running','paused'].includes(s.status))||store.runsByStatus('unknown',projectId!).some(r=>r.graphId===step.graphId))throw new HttpError(409,'Settle remaining task work before stopping')
        legion.saveState(projectId,actor,args.state);const goal=scoped.node<Goal>(projectId!,step.goalId,'goal');const result=scoped.updateGoal(projectId!,goal.id,{status:'cancelled',expectedVersion:goal.version});scoped.event(projectId!,'legion.task_exhausted',null,{reason:args.reason});finish();return result
      },true),
  )}
  if (commander && !benchmark) tools.push(tool('legion_step', 'Create an execution Step in the unique main FGS for the existing Worker Pool. sourceIds reference existing evidence; dependsOn can queue future stages until prerequisite Steps finish with Facts. Independent Steps run concurrently. No Agent creation, delegation or escalation.', Type.Object({projectId:text,description:text,sourceIds:Type.Array(text,{minItems:1}),goalId:Type.Optional(text),dependsOn:Type.Optional(Type.Array(text,{uniqueItems:true})),reportFindingId:Type.Optional(text),priority:Type.Optional(Type.Integer()),executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')]))},{additionalProperties:false}), args => {
    const graph=store.projectGraphs(project(args))[0]
    if(args.reportFindingId && !args.sourceIds.includes(args.reportFindingId))throw new HttpError(422,'Report Step must reference its Finding in sourceIds')
    if(args.reportFindingId)store.node(project(args),args.reportFindingId,'finding')
    return store.forGraph(project(args),graph.id).addStep(project(args),{...args,role:'worker',taskKey:graph.id,creator:'planner'})
  }))
  if (commander) tools.push(
    tool('legion_hint','Associate a user instruction with this Graph as an UNVERIFIED Hint. Then message its assigned Agent and track delivery, or create a Mission. Never broadcast ambiguous hints.',Type.Object({projectId:text,graphId:text,content:text}),args=>store.forGraph(project(args),args.graphId).addInput(project(args),'hint',args.content,'planner')),
    ...(!benchmark ? [
      tool('legion_goal','Create a funded subgoal in the current Project using the existing FGS hierarchy.',Type.Object({projectId:text,graphId:Type.Optional(text),description:text,parentId:Type.Optional(text)}),args=>(args.graphId?store.forGraph(project(args),args.graphId):store).addGoal(project(args),args.description,args.parentId??'goal','planner')),
      tool('legion_update_goal','Amend, replace, cancel or reopen an FGS Goal with its expected version. Acceptance still requires legion_accept and verified evidence.',Type.Object({projectId:text,id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),status:Type.Optional(Type.Union([Type.Literal('open'),Type.Literal('cancelled')])),mode:Type.Optional(Type.Union([Type.Literal('amend'),Type.Literal('replace')]))}),args=>store.updateGoal(args.projectId,args.id,args)),
    ] : []),
    tool('legion_update_step','Revise or cancel an existing Mission with native plan-version/isolation checks; running Workers must sync the changed contract.',Type.Object({projectId:text,id:text,expectedVersion:Type.Integer({minimum:1}),description:Type.Optional(text),sourceIds:Type.Optional(Type.Array(text,{minItems:1})),goalId:Type.Optional(text),priority:Type.Optional(Type.Number()),status:Type.Optional(Type.Union([Type.Literal('pending'),Type.Literal('cancelled')])),executionProfile:Type.Optional(Type.Union([Type.Literal('direct'),Type.Literal('isolated')])),mode:Type.Optional(Type.Union([Type.Literal('amend'),Type.Literal('replace')]))}),args=>store.updateStep(args.projectId,args.id,args)),
    tool('legion_transfer','Transfer confirmed source experience as an UNVERIFIED target Hint. The target must perform its own validation; no Fact is copied.',Type.Object({sourceId:Type.Integer({minimum:1}),targetProject:text,taskKey:text,brief:text}),args=>experience().transfer(args.sourceId,args.targetProject,args.taskKey,args.brief)),
    tool('legion_confirm_transfer','Record actual target-task Fact IDs after re-verifying transferred knowledge in that target.',Type.Object({id:text,projectId:text,factIds:Type.Array(text,{minItems:1})}),args=>experience().confirm(args.id,args.projectId,args.factIds)),
    tool('legion_commander_model', 'Select a configured Commander model route for the next cycle; preserve STATE and let the current cycle settle. No key pool or model fallback is created.',Type.Object({worker:text}),args=>{if(!config?.workers.some(w=>w.name===args.worker&&w.enabled&&w.roles?.includes(coordinatorRole(benchmark?'benchmark':'general'))))throw new HttpError(422,'Invalid Commander route');const c=legion.campaign();c.nextWorker=args.worker;legion.saveCampaign(c);return{nextWorker:args.worker}}),
    tool('legion_models', 'Read configured role-model routes and capacities without credentials. Provider polling remains DSH-owned.',Type.Object({}),()=>config?.workers.map(w=>({name:w.name,roles:w.roles,provider:w.provider,model:w.model,enabled:w.enabled,maxRunning:w.maxRunning,priority:w.priority}))??[]),
    tool('legion_reassign', 'Upgrade/downgrade the MODEL of a running same-role Worker at a confirmed safe tool boundary, using saved STATE and a fresh Run. Cannot replay unresolved calls.',Type.Object({projectId:text,runId:text,nextWorker:text,summary:text}),args=>{const run=store.run(args.runId);if(run.projectId!==args.projectId||!run.stepId)throw new HttpError(403,'Run belongs to another Project');const step=store.node<Step>(args.projectId,run.stepId,'step');if(!config?.workers.some(w=>w.enabled&&w.name===args.nextWorker&&w.roles?.includes(executionRole(store.project(projectId!).mode,step.role))))throw new HttpError(422,'Replacement route does not support this role');return legion.requestHandoff(run.id,args.summary,args.nextWorker)}),
    tool('legion_deadline', 'Set the explicit campaign deadline in epoch milliseconds. No new Missions during final submission phase; no arbitrary guessed budget.', Type.Object({ deadline: Type.Integer({ minimum: 1 }) }), args => legion.setDeadline(args.deadline)),
    tool('legion_board', 'Read the <=100-line Project War Board: HELP, anomalies, active tasks, pending results, then other tasks. Detailed FGS stays on demand.', Type.Object({}), () => legion.boardSummary()),
    ...(!benchmark ? [tool('legion_todos', 'Read one Graph planning TodoList on demand in General mode.', Type.Object({projectId:text,graphId:text}),args=>{store.projectGraph(project(args),args.graphId);return todos?.list(args.graphId)??[]})] : []),
    tool('legion_read_changes', 'Read bounded Project FGS deltas. Only delivered cursors can be acknowledged by legion_finish; reading is not processing.', Type.Object({ projectId: text, graphId:Type.Optional(text), after: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })) }), args => args.graphId ? store.forGraph(project(args),args.graphId).graphDelta(project(args),args.after,args.limit) : legion.readChanges(project(args), args.after, args.limit)),
    tool('legion_read_node', 'Sapper show/doc: read one current FGS summary and linked Fact summaries. detail=doc expands Doc/Evidence/Report references; read Artifact bytes with legion_evidence_read.', Type.Object({ projectId: text, id: text, detail: Type.Optional(Type.Union([Type.Literal('summary'), Type.Literal('doc')])) }), args => store.readNode(args.projectId, args.id, args.detail)),
    tool('legion_accept', 'Accept a Goal only from current verified Fact/Finding evidence and its expected version. Step or message completion is not proof.', Type.Object({ projectId: text, goalId: text, expectedVersion: Type.Integer({ minimum: 1 }), evidenceIds: Type.Array(text, { minItems: 1 }) }), args => store.updateGoal(args.projectId, args.goalId, { status: 'achieved', expectedVersion: args.expectedVersion, evidenceIds: args.evidenceIds })),
    tool('legion_park', 'Park this task with a concrete blocker and resume condition. This requests stopping; it does not prove execution has stopped.', Type.Object({ projectId: text, taskKey: text, reason: text, resumeCondition: text }), args => legion.park(args.projectId, args.taskKey, args.reason, args.resumeCondition)),
    tool('legion_reactivate', 'Reactivate only after old executions and unknown outcomes are confirmed stopped/resolved.', Type.Object({ projectId: text, taskKey: text, reason: text }), args => legion.reactivate(args.projectId, args.taskKey, args.reason)),
    ...(!benchmark && commander ? [tool('legion_stop', 'Stop this Project without claiming success, only when all reasonable directions are exhausted and no work is pending, running, paused, recovering or unknown. Preserve TodoList and FGS; a user Hint or manual resume can continue.', Type.Object({reason:text,state:text},{additionalProperties:false}), args => {
      const steps=store.nodes<Step>(projectId!,['step'])
      if(steps.some(s=>!s.deleted&&(['pending','running','paused'].includes(s.status)||s.handoffPending||s.replacementPending))||store.runsByStatus('unknown',projectId!).length)throw new HttpError(409,'Unsettled work prevents Project stop')
      if(store.runsByStatus('failed',projectId!).some(r=>r.stepId&&!r.pendingTools.length&&['PROCESS_EXIT','UNKNOWN','SERVER','TIMEOUT','TRANSPORT','STREAM_CLOSED','EMPTY_RESPONSE','RATE_LIMIT'].includes(r.failureCode??'')&&(store.node<Step>(projectId!,r.stepId,'step').failureCount??0)<3))throw new HttpError(409,'Recoverable work prevents Project stop')
      legion.saveState(projectId,'commander',args.state)
      legion.saveCampaign({...legion.campaign(),endgame:args.reason})
      store.setStatus(projectId!,'stopped');finish();return{status:'stopped',reason:args.reason}
    },true)] : []),
    tool('legion_finish', 'Save Commander STATE and acknowledge only delivered, processed Project cursors. Finish this command cycle, not the whole campaign.', Type.Object({ processed: Type.Record(Type.String(), Type.Integer({ minimum: 0 })), state: text }), args => { const saved = legion.finishCommand(args.processed, args.state, false); finish(); return saved }, true),
  )
  if(!benchmark) {
    const allowed = new Set(commander ? ['legion_state','legion_roster','legion_message','legion_inbox','legion_wait','TodoWrite','legion_todos','legion_goal','legion_update_goal','legion_step','legion_update_step','legion_hint','legion_evidence_read','legion_read_run','legion_commander_model','legion_models','legion_stop','legion_read_changes','legion_read_node','legion_accept','legion_finish'] : ['legion_state','legion_message','legion_inbox','legion_wait','legion_handoff'])
    return tools.filter(t=>allowed.has(t.name)).map(t=>({...t,description:t.description.replaceAll('Commander','Planner').replaceAll('Sapper show/doc','FGS show/doc')}))
  }
  return tools.filter(t=>step?.role!=='general'||!['legion_experience_capture','legion_experience_search','legion_confirm_transfer'].includes(t.name)).map(t=>t.name==='legion_roster'?roster:t)
}
