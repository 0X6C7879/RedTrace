import { generalPlanningContext } from '../src/runner.ts'
import { domainTools } from '../../redtrace-dsh/lib/tool-domains.js'
import { coordinatorRole } from '../../redtrace-dsh/lib/roles.js'
import { platformToolOptions } from './console.mjs'
// Adapted from sapper-v2 7b75e6f docker/commander/{SKILL.md §§2,4.6,5, watchdog.sh}; native DSH replaces tmux.
import { accumulateUsage, eventProjection } from '../../redtrace-dsh/lib/audit.js'
import { chatSlots, conversationWorkers, conversationWorker } from '../src/chat.ts'
import { HttpError } from '../src/types.ts'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mountLegionContext } from './legion-context.mjs'
import { Check, Errors } from 'typebox/value'
import { legionTools } from '../src/legion-tools.ts'
import { LegionStore } from '../src/legion-store.ts'
import { legionMission } from '../src/legion-missions.ts'
import { activateAgent, resolveReasoningEffort } from '../../redtrace-dsh/lib/agent.js'
import { load } from '../../redtrace-dsh/lib/loader.js'

/** Queue != admit. Idle Agents need steer; inject alone cannot wake them. */
export function attachLegionMailbox(ctx, legion, { projectId, actor, sessionId, agent, message, closing = () => false }) {
  const deliver = (project, receiver) => {
    if (receiver !== actor || projectId && project !== projectId || closing()) return
    for (const record of legion.messages(project, actor).filter(m => m.status === 'pending')) {
      const native = message(record.content, { redtraceLegionMessage: { projectId: project, receiver: actor, id: record.id, type: record.type, sender: record.sender } },record.attachments??[])
      try {
        if (agent.status === 'idle') agent.steer(native)
        else agent.inject(native)
        legion.delivery(project, actor, record.id, 'queued')
      } catch (error) {
        legion.delivery(project, actor, record.id, 'uncertain')
        throw error
      }
    }
  }
  const admitted = ctx.on('session/event', (session, event) => {
    if (String(session.id) !== sessionId || event.type !== 'user/message') return
    const ref = event.data?.source?.redtraceLegionMessage
    if (ref?.receiver === actor) legion.delivery(ref.projectId, actor, ref.id, 'admitted')
  })
  legion.store.changes.on('legion-message', deliver)
  try { for (const project of projectId ? [projectId] : legion.store.projects().map(p => p.id)) deliver(project, actor) }
  catch (error) { admitted(); legion.store.changes.off('legion-message', deliver); throw error }
  return () => { admitted(); legion.store.changes.off('legion-message', deliver) }
}


/** Observe the current Commander log through native read ownership, never create or resume it. */
export async function readCommanderLog(ctx, engine, offset = 0, limit = 100, signal, projectId, sessionId) {
  const campaign=engine.legion.campaign(projectId)
  if(sessionId&&sessionId!==campaign.sessionId&&![...(campaign.sessionHistory??[]),campaign.previousSessionId].includes(sessionId))throw new HttpError(404,'Session does not belong to this Project Commander')
  return readNativeLog(ctx,sessionId&&sessionId!==campaign.sessionId?{...campaign,sessionId,hasSession:true,workerName:undefined}:campaign,offset,limit,signal,coordinatorRole(engine.store.project(campaign.projectId).mode))
}

export async function readNativeLog(ctx, campaign, offset = 0, limit = 100, signal, role = 'commander') {
  const { SessionId } = await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
  const persistence = ctx.get('sessionPersistence'), id = SessionId(campaign.sessionId)
  if (!await persistence.stat(id, { signal })) {
    if (campaign.hasSession) throw new HttpError(404, 'Recorded '+(role==='commander'?'Commander':'DSH')+' Session is missing; log continuity is unavailable')
    return { sessionId: campaign.sessionId, available: false, events: [], nextOffset: 0, hasMore: false }
  }
  const handle = await persistence.open(id, 'read', { signal })
  try {
    const page = await handle.read(offset, limit, { signal }), task = { sessionId: campaign.sessionId }
    const events = page.events.filter(event => event.type !== 'assistant/chunk').flatMap(event =>
      eventProjection(task, event).map(row => ({ ...row, task_type: role, worker: campaign.workerName, run_id: campaign.sessionId, source:event.data?.source, attachments:(event.data?.content??[]).filter(b=>b.type==='image'||b.type==='file') })))
    return { sessionId: campaign.sessionId, available: true, events, nextOffset: offset + page.events.length, hasMore: page.events.length === limit }
  } finally { await handle.close() }
}

/** Fold completed patrol input with a logged native surface replacement; retain every raw audit event. */
export function checkpointCommanderPatrol(agent, checkpoint, message, pendingCalls) {
  if(agent.status!=='idle'||pendingCalls.size)return false
  const surface=[...agent.session.surface.nodes]
  const nodes=surface.length&&agent.session.eventAt(surface[0])?.type==='system/message'?surface.slice(1):surface
  if(!nodes.length)return false
  agent.session.append('user/message',message(JSON.stringify(checkpoint),{kind:'redtrace-patrol-checkpoint',redtracePatrolCheckpoint:true}),{surfaceOp:{op:'replace',startSeq:nodes[0],endSeq:nodes.at(-1)},sourceEventSeqs:nodes})
  return true
}

/** One real DSH Commander Session per Project; FGS remains owned by the engine. */
export async function runCommander(ctx, engine, worker, signal, projectId) {
  const { configuration } = engine
  projectId ??= engine.store.projects().length===1 ? engine.store.projects()[0].id : undefined
  if(!projectId)throw new HttpError(422,'Select a Project Commander')
  const store=engine.store.forProject(projectId),legion=new engine.legion.constructor(store,projectId),periodic=store.project(projectId).mode==='benchmark'
  const todos=periodic?undefined:engine.legion.planningTodos(projectId)
  const role=coordinatorRole(store.project(projectId).mode)
  if(!worker?.enabled||worker.backend!=='dsh'||!worker.roles?.includes(role))throw new Error('Commander requires an enabled configured DSH Commander worker')
  if(store.runsByStatus('running').some(run=>run.activity==='decide'))throw new Error('Stop the active Reason execution before Commander takes control')
  signal.throwIfAborted()
  const config=configuration.resolvedSnapshot().config,activeRuns=engine.store.runsByStatus('running'),commands=[...engine.legion.campaigns().filter(c=>c.status==='running'),...chatSlots(store)]
  if(!['active','completed'].includes(store.project(projectId).status))throw new HttpError(409,'Project is not active')
  if(activeRuns.length+commands.length>=config.maxWorkers||activeRuns.filter(r=>r.worker===worker.name).length+commands.filter(c=>c.workerName===worker.name).length>=worker.maxRunning||activeRuns.filter(r=>r.projectId===projectId).length>=config.maxProjectWorkers)throw new HttpError(409,'Commander capacity is full')
  const activeProjects=new Set([...activeRuns.map(r=>r.projectId),...commands.filter(c=>c.projectId).map(c=>c.projectId)])
  if(!activeProjects.has(projectId)&&activeProjects.size>=config.maxRunningProjects)throw new HttpError(409,'Project capacity is full')
  const campaign=legion.claimCommand();legion.saveCampaign({...campaign,workerName:worker.name})
  ctx.logger.info(role+' cycle.started Project='+projectId+' Session='+campaign.sessionId+' Worker='+worker.name)
  const residents=periodic?engine.commanderSessions:undefined,route=worker.name+':'+worker.provider+':'+worker.model+':'+(campaign.reasoning??'configured')
  let resident=residents?.get(projectId)
  if(resident&&(resident.sessionId!==campaign.sessionId||resident.route!==route)){await resident.handle.dispose();residents.delete(projectId);resident=undefined}
  resident??={sessionId:campaign.sessionId,route,pendingCalls:new Set(campaign.pendingTools??[]),accounting:{sessionId:campaign.sessionId,usage:campaign.usage}}
  const cycle={finished:false,failure:undefined,signal};resident.cycle=cycle
  const model=config.providers[worker.provider]?.models.find(m=>m.id===worker.model),pendingCalls=resident.pendingCalls,unread=[]
  const priorAudit=store.db.prepare('SELECT data FROM audit_runs WHERE id=?').get(campaign.sessionId)
  const auditMetadata={id:campaign.sessionId,project_id:projectId,graph_id:periodic?null:store.projectGraphs(projectId)[0].id,task_type:role,worker:worker.name,provider:worker.provider,model:worker.model,session_id:campaign.sessionId,phase:'decide',started_at:(priorAudit?JSON.parse(priorAudit.data).started_at:undefined)??new Date().toISOString()}
  let handle=resident.handle,mailbox
  const cancel=()=>handle?.agent.cancel({kind:'hook',reason:'Commander cancelled or timed out'})
  try{
    const {SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js'),{createUserMessage}=await load('vendor/deepseek-harness/packages/llm/llm/lib/index.js')
    const message=(text,metadata={},attachments=[])=>createUserMessage({content:[{type:'text',text},...attachments],source:{kind:'user',...metadata}})
    const freshActivation=!handle,resume=freshActivation&&!!await ctx.get('sessionPersistence').stat(SessionId(campaign.sessionId))
    if(freshActivation){
      const cwd=path.join(config.workspaceRoot,projectId);await mkdir(cwd,{recursive:true})
      const effort=await resolveReasoningEffort(ctx.get('llm'),{provider:worker.provider,model:worker.model,reasoning:campaign.reasoning??model?.reasoning??'auto_max'})
      const originalTools=legionTools(store,'commander',projectId,config.maxSteps,()=>{resident.cycle.finished=true},config,todos,()=>configuration.resolvedSnapshot().config)
      const setup=async (scoped,agent)=>{
        agent.model.select({provider:worker.provider,model:worker.model,...(effort?{reasoningEffort:effort}:{})})
        const directory=ctx.get('workingDirectory')
        if(directory.get(agent.session)!==cwd)await directory.set(agent,cwd,signal)
        mountLegionContext(scoped,ctx,{store,legion,message,onCommanderCompact:summary=>{legion.checkpointState(projectId,'native-compaction');resident.relaySummary=summary;if(!pendingCalls.size)cancel()}})
        scoped.on('session/event',(_session,event)=>{
          const data=event.data??{}
          const projected=eventProjection(resident.accounting,event)
          if(projected.length)store.audit(auditMetadata,projected)
          if(event.type==='user/message')for(const id of data.source?.redtraceLegionMessages??[])legion.delivery(projectId,'commander',id,'admitted')
          if(event.type==='assistant/message'&&data.usage){accumulateUsage(resident.accounting,event);legion.saveCampaign({...legion.campaign(),usage:resident.accounting.usage})}
          if(event.type==='tool/call')pendingCalls.add(String(data.callId))
          if(event.type==='tool/result'&&data.message?.source?.callId)pendingCalls.delete(String(data.message.source.callId))
          if(event.type==='tool/call'||event.type==='tool/result')legion.saveCampaign({...legion.campaign(),pendingTools:[...pendingCalls]})
          if(resident.relaySummary&&!pendingCalls.size)cancel()
        })
        scoped.on('agent/error',({error})=>{resident.cycle.failure=error})
        scoped.tools.restrict({allow:[]})
        scoped.systemPrompt.section({name:'redtrace:planning-capacity',order:1,text:()=>{const current=configuration.resolvedSnapshot().config;return 'Live planning capacity: '+JSON.stringify(periodic?{...legion.questionCapacity(current.maxBenchmarkTasks??null),maxSteps:current.maxSteps}:store.planningCapacity(projectId,current.maxSteps))}})
        scoped.systemPrompt.section({name:'redtrace:commander',order:0,text:()=>legionMission(role,store.project(projectId).mode)+'\nAssigned Project='+projectId+(periodic?'':'. Read FGS deltas and relevant nodes; query Worker status on demand.')})
        let domainRegistrations=[],domainRevision=''
        const refreshDomains=()=>{const revision=configuration.resolvedSnapshot().revision;if(revision===domainRevision)return;for(const dispose of domainRegistrations)dispose();domainRegistrations=domainTools(originalTools,name=>platformToolOptions(engine,name,role).when()).map(tool=>scoped.tools.register({redtrace:true,name:tool.name,description:tool.description,parameters:JSON.parse(JSON.stringify(tool.parameters)),
          output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>value.content},
          async execute(args,execution){
            if(resident.cycle.finished||resident.cycle.signal.aborted)throw new Error('Commander has stopped')
            if(!Check(tool.parameters,args))throw new Error('Invalid tool arguments for '+tool.name+': '+JSON.stringify([...Errors(tool.parameters,args)].slice(0,6).map(e=>({path:e.instancePath,message:e.message}))))
            const result=await tool.execute(execution.callId??'',args,execution.signal)
            if(result.terminate)execution.concludeTurn?.()
            return result
          }},platformToolOptions(engine,tool.name,role)));domainRevision=revision}
        scoped.on('agent/request',(_request,next)=>{refreshDomains();return next()});refreshDomains()
      }
      handle=await activateAgent(ctx.get('agents'),SessionId(campaign.sessionId),cwd,{agentOptions:{provider:worker.provider,model:worker.model,...(effort?{reasoningEffort:effort}:{})},setup},resume)
      resident.handle=handle;residents?.set(projectId,resident);legion.saveCampaign({...legion.campaign(),hasSession:true})
    }
    signal.addEventListener('abort',cancel,{once:true});signal.throwIfAborted()
    const inbox=periodic?legion.messages(projectId,'commander').filter(m=>m.status==='pending'):[]
    const payload=periodic
      ? {patrol:true,...(freshActivation?{instruction:'Restore scheduling STATE once, then read Board and unprocessed scheduling deltas. Discard legacy attack plans; preserve current ownership and unfinished user instructions.',state:legion.commanderState(),...(campaign.stateScope==='scheduling'&&campaign.nativeCompactionSummary?{nativeSummary:campaign.nativeCompactionSummary}:{})}:{}),...(inbox.length?{messages:inbox}:{}),cursor:campaign.cursors[projectId]?.acknowledged??0}
      : {...generalPlanningContext(store,projectId,resume),...(!resume&&campaign.nativeCompactionSummary?{nativeSummary:campaign.nativeCompactionSummary}:{})}
    if(periodic){let state=legion.commanderState();try{const saved=JSON.parse(state);if(saved.source==='commander-checkpoint')state=saved.notes}catch{}checkpointCommanderPatrol(handle.agent,{instruction:'Continue scheduling using current Board and unprocessed deltas. Prior patrol tools and legacy tactical STATE remain in the audit log, not this request.',state,instructions:legion.messages(projectId,'commander').filter(m=>['human','user','chief','global-assistant'].includes(m.sender)&&(m.eventId?m.eventId>(campaign.cursors[projectId]?.acknowledged??0):m.status!=='admitted')).map(m=>({id:m.id,content:m.content,attachments:m.attachments,createdAt:m.createdAt})),board:legion.boardSummary().lines,cursor:campaign.cursors[projectId]?.acknowledged??0},message,pendingCalls)}
    handle.agent.followup(message(JSON.stringify(payload),{redtraceLegionMessages:inbox.map(m=>m.id)},inbox.flatMap(m=>m.attachments??[])))
    if(!periodic)mailbox=attachLegionMailbox(ctx,legion,{projectId,actor:'commander',sessionId:campaign.sessionId,agent:handle.agent,message,closing:()=>cycle.finished||signal.aborted})
    await handle.agent.whenIdle()
    const stopped=cycle.finished&&store.project(projectId).status==='stopped'
    if(!stopped)signal.throwIfAborted()
    if(cycle.failure&&!resident.relaySummary&&!stopped)throw cycle.failure
    if(!cycle.finished&&!resident.relaySummary)throw new Error(periodic?'Commander ended without legion_wait':'Commander ended without legion_finish and saved STATE')
  }catch(error){
    legion.saveCampaign({...legion.campaign(),status:'stopped',failureCode:signal.aborted?(signal.reason?.name==='TimeoutError'?'TIMEOUT':'ABORTED'):cycle.failure?.code??(handle?'PROCESS_EXIT':undefined),error:error instanceof Error?error.message:String(error)})
    throw error
  }finally{
    signal.removeEventListener('abort',cancel);mailbox?.()
    if(handle){
      let retire=!residents||signal.aborted||cycle.failure||!cycle.finished||resident.relaySummary
      try{if(retire){cancel();await handle.agent.whenIdle();unread.push(...handle.agent.inbox.nextStep.map(m=>m.source?.redtraceLegionMessage).filter(Boolean))}await ctx.get('sessions').flush(handle.agent.session)}
      catch(error){retire=true;legion.saveCampaign({...legion.campaign(),status:'stopped',error:String(error)});throw error}
      finally{if(retire){residents?.delete(projectId);engine.sessionRefresh?.delete(campaign.sessionId);await handle.dispose()}}
    }
  }
  if(resident.relaySummary){const current=legion.campaign();legion.saveCampaign({...current,sessionHistory:[...(current.sessionHistory??(current.previousSessionId?[current.previousSessionId]:[])),current.sessionId],previousSessionId:current.sessionId,sessionId:'command-'+randomUUID(),hasSession:false,nativeCompactionSummary:resident.relaySummary,pendingTools:[],status:'idle'});for(const ref of unread)legion.requeueUnread(ref.projectId,'commander',[ref.id]);store.changes.emit('legion-relay',projectId)}
  else legion.saveCampaign({...legion.campaign(),status:'idle',error:undefined,failureCode:undefined})
  engine.scheduler?.wake()
  ctx.logger.info(role+' cycle.finished Project='+projectId+' Session='+campaign.sessionId)
  return legion.campaign()
}

/** Native write ownership proves the old Session is not executing before a relay. */
export async function recoverLegion(ctx,engine,resumeStopped=false,projectId,includeRunning=true) {
  const {store,legion}=engine,{SessionId}=await load('vendor/deepseek-harness/packages/core/session/lib/index.js'),persistence=ctx.get('sessionPersistence'),recovered=[],unresolved=[]
  const proveStopped=async id=>{const handle=await persistence.open(SessionId(id),'write');await handle.close()}
  for(const campaign of legion.campaigns().filter(c=>!projectId||c.projectId===projectId)) {
  if(includeRunning&&campaign.status==='running'||resumeStopped&&campaign.status==='stopped') {
    try{if(campaign.pendingTools?.length)throw new Error('Commander has unconfirmed tool outcomes');if(!(resumeStopped&&campaign.status==='stopped'&&campaign.hasSession===false&&!await persistence.stat(SessionId(campaign.sessionId))))await proveStopped(campaign.sessionId);legion.saveCampaign({...campaign,status:'idle'});recovered.push(campaign.sessionId)}
    catch(error){legion.saveCampaign({...campaign,status:'stopped',error:String(error)});unresolved.push({actor:campaign.sessionId,reason:String(error)})}
  }
  }
  for(const run of store.runsByStatus('unknown').filter(r=>!projectId||r.projectId===projectId)) {
    if(run.pendingTools.length||run.error!=='Process stopped before run completion'||(!run.stepId&&run.activity!=='plan')||store.project(run.projectId).status!=='active')continue
    const step=store.assignment(run);if(!step?.role||(step.failureCount??0)>=3)continue
    if(run.activity==='plan'){try{await proveStopped(run.id);run.status='paused';run.endedAt=null;store.saveRun(run);step.status='paused';store.savePlanner(step);recovered.push(run.id)}catch(error){unresolved.push({actor:run.id,reason:String(error)})}continue}
    try{await proveStopped(run.id);step.failureCount=(step.failureCount??0)+1;run.status='cancelled';store.saveRun(run);step.status='parked';step.predecessorRunId=run.id;step.handoffPending=true;step.handoff=JSON.stringify({source:'confirmed-stopped-native-session',confirmedState:step.handoff??'',taskKey:step.taskKey,goalId:step.goalId,sourceIds:step.sourceIds,factIds:step.factIds});store.saveNode(step);legion.completeHandoff(run.projectId,step.id);recovered.push(run.id)}
    catch(error){unresolved.push({actor:run.id,reason:String(error)})}
  }
  return{recovered,unresolved}
}

/** Benchmark patrols on a fixed clock; General and all Workers remain event-driven. */
export function createCommanderController(ctx, engine, canRun=()=>true) {
  let closed=true, scheduled=false, cursor=0, watchdogTimer, watchdogWork, checking=false
  const legion=engine.legion, store=engine.store, active=new Map(), timers=new Map(), inspections=new Map(),debounces=new Map(),residents=engine.commanderSessions=new Map()
  let inspectionIntervals={active:60,idle:90}
  let planningLimits
  const needsQuestionRefill=projectId=>{const limit=engine.configuration.resolvedSnapshot().config.maxBenchmarkTasks;return limit!=null && new LegionStore(store,projectId).questionCapacity(limit).taskSlots>0}
  const release=async id=>{const resident=residents.get(id);residents.delete(id);await resident?.handle.dispose()}
  const pending=projectId=>{
    const cursor=Number(store.db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM events WHERE project_id=?').get(projectId).n)
    return cursor>(legion.campaign(projectId).cursors[projectId]?.acknowledged??0)||legion.messages(projectId,'commander').some(m=>m.status==='pending')
  }
  // ARTEX coalesces graph/completion/finding bursts for 800 ms; Benchmark patrol stays on its clock.
  const debounce=projectId=>{
    clearTimeout(debounces.get(projectId))
    debounces.set(projectId,setTimeout(()=>{debounces.delete(projectId);wake(projectId)},800))
    debounces.get(projectId).unref()
  }
  const changed=projectId=>{const project=store.projects().find(p=>p.id===projectId);if(project?.mode==='general'&&project.status==='active')debounce(projectId);else if(project?.mode==='benchmark'&&project.status==='active'&&needsQuestionRefill(projectId)){const c=legion.campaign(projectId);c.nextInspectionAt=Date.now();legion.saveCampaign(c);wake(projectId)}else if(project?.mode!=='benchmark'||project.status!=='active'||!legion.campaign(projectId).hasSession&&!active.has(projectId))wake(projectId)}
  const messaged=projectId=>{if(store.project(projectId).mode==='general')debounce(projectId)}
  const armInspection=(projectId,at)=>{
    clearTimeout(inspections.get(projectId))
    inspections.set(projectId,setTimeout(()=>{inspections.delete(projectId);wake(projectId)},Math.max(0,at-Date.now())))
    inspections.get(projectId).unref()
  }
  const wake=projectId=>{
    if(closed)return
    for(const p of store.projects().filter(p=>p.mode==='benchmark'&&p.status==='active'))legion.completeBenchmark(p.id)
    for(const [id] of residents)if(!active.has(id)&&store.projects().find(p=>p.id===id)?.status!=='active'){clearTimeout(inspections.get(id));inspections.delete(id);clearTimeout(timers.get(id));timers.delete(id);void release(id).catch(error=>ctx.logger.warn(String(error)))}
    for(const [id,task] of active) {
      const project=store.projects().find(p=>p.id===id)
      if(!project||['stopped','deleting'].includes(project.status)||project.mode==='benchmark'&&project.status==='completed')task.abort.abort(new Error('Project stopped or deleted'))
      if(project?.mode!=='benchmark'&&(!projectId||projectId===id))task.dirty=true
    }
    if(scheduled)return
    scheduled=true
    queueMicrotask(()=>{
      scheduled=false
      if(closed||engine.scheduler.maintenance)return
      const projects=store.projects().filter(p=>p.status==='active'&&canRun(p.mode))
      if(!projects.length)return
      const config=engine.configuration.resolvedSnapshot().config
      planningLimits??=config
      inspectionIntervals=config.commanderInspection??{active:60,idle:90}
      for(let i=0;i<projects.length;i++) {
        const project=projects[(cursor+i)%projects.length], campaign=legion.campaign(project.id),periodic=project.mode==='benchmark'
        if(active.has(project.id)||campaign.status!=='idle'||legion.budget(Date.now(),project.id).phase==='ended')continue
        if(periodic){if((campaign.nextInspectionAt??0)>Date.now()){armInspection(project.id,campaign.nextInspectionAt);continue}}
        else if(debounces.has(project.id)||!pending(project.id))continue
        const runs=store.runsByStatus('running'), commands=[...legion.campaigns().filter(c=>c.status==='running'),...chatSlots(store)]
        if(runs.length+commands.length>=config.maxWorkers)break
        if(runs.filter(r=>r.projectId===project.id).length>=config.maxProjectWorkers)continue
        const owners=new Set([...runs.map(r=>r.projectId),...commands.filter(c=>c.projectId).map(c=>c.projectId)])
        if(!owners.has(project.id)&&owners.size>=config.maxRunningProjects)continue
        const selected=campaign.nextWorker?conversationWorker(config,campaign.nextWorker,project.mode):undefined
        const worker=(campaign.nextWorker?(selected?[selected]:[]):conversationWorkers(config,project.mode)).filter(w=>runs.filter(r=>r.worker===w.name).length+commands.filter(c=>c.workerName===w.name).length<w.maxRunning).sort((a,b)=>a.priority-b.priority||a.name.localeCompare(b.name))[0]
        if(!worker)continue
        const task={abort:new AbortController(),dirty:false,completion:undefined}
        active.set(project.id,task)
        clearTimeout(inspections.get(project.id));inspections.delete(project.id)
        task.completion=runCommander(ctx,engine,worker,AbortSignal.any([task.abort.signal,AbortSignal.timeout((config.taskLimits?.[coordinatorRole(project.mode)]?.timeout??config.decideTimeout)*1000)]),project.id).catch(error=>ctx.logger.warn('Commander '+project.id+' stopped: '+String(error))).finally(()=>{
          active.delete(project.id)
          if(closed||!store.projects().some(p=>p.id===project.id&&p.status==='active'))return
          const current=legion.campaign(project.id)
          if(periodic&&current.status==='idle'){
            current.nextInspectionAt=Date.now()+legion.inspectionDelay(project.id,engine.configuration.resolvedSnapshot().config.commanderInspection);legion.saveCampaign(current);armInspection(project.id,current.nextInspectionAt)
          }else if(!periodic&&task.dirty)wake(project.id)
          engine.scheduler.wake()
        })
      }
      if(projects.length)cursor=(cursor+1)%projects.length
    })
  }
  const armDeadline=projectId=>{
    const ids=projectId?[projectId]:store.projects().map(p=>p.id)
    for(const id of ids){clearTimeout(timers.get(id));const deadline=legion.campaign(id).deadline
      if(deadline!==undefined)timers.set(id,setTimeout(()=>{
        timers.delete(id);if(store.projects().find(p=>p.id===id)?.status!=='active')return
        store.setStatus(id,'stopped');active.get(id)?.abort.abort(new Error('Project deadline reached'))
        legion.saveCampaign({...legion.campaign(id),status:'stopped',endgame:'deadline reached; verify submissions and outstanding instances'})
      },Math.max(0,deadline-Date.now())))
    }
  }
  const watchdog=async()=>{
    if(closed||checking||!store.projects().some(p=>canRun(p.mode))||engine.scheduler.maintenance)return
    checking=true
    try{
      engine.scheduler.watchdog()
      for(const project of store.projects().filter(p=>p.status==='active')){
        if(active.has(project.id)||legion.budget(Date.now(),project.id).phase==='ended')continue
        const c=legion.campaign(project.id),resident=residents.get(project.id)
        if(resident&&ctx.get('agents').get(c.sessionId)!==resident.handle.agent){await release(project.id);c.status='stopped';c.failureCode='PROCESS_EXIT';c.error='Native Commander Agent exited';legion.saveCampaign(c)}
        if(c.status==='stopped'&&(c.restarts??0)<3&&['PROCESS_EXIT','UNKNOWN','SERVER','TIMEOUT','TRANSPORT','STREAM_CLOSED','EMPTY_RESPONSE','RATE_LIMIT'].includes(c.failureCode)){
          await release(project.id)
          const result=await recoverLegion(ctx,engine,true,project.id,false)
          if(!result.unresolved.length){const current=legion.campaign(project.id);current.restarts=(c.restarts??0)+1;current.nextInspectionAt=Date.now();legion.saveCampaign(current);if(project.mode==='general')store.event(project.id,'legion.planner_restarted',null,{restarts:current.restarts})}
        }else if(c.status==='idle')await recoverLegion(ctx,engine,false,project.id,false)
      }
      engine.scheduler.wake();wake()
    }finally{checking=false}
  }
  const controller = {
    wake,
    async resume(projectId){
      const result=await recoverLegion(ctx,engine,true,projectId)
      if(result.unresolved.length)return result
      for(const p of store.projects().filter(p=>!projectId||p.id===projectId)){
        if(legion.budget(Date.now(),p.id).phase==='ended')throw new Error('Set a new explicit deadline before resuming')
        if(p.status==='stopped')store.setStatus(p.id,'active')
      }
      engine.scheduler.start();controller.start();wake(projectId);return result
    },
    rescheduleInspections(){
      const config=engine.configuration.resolvedSnapshot().config,next=config.commanderInspection??{active:60,idle:90}
      if(next.active!==inspectionIntervals.active||next.idle!==inspectionIntervals.idle){inspectionIntervals=next;for(const [id] of inspections){const c=legion.campaign(id);c.nextInspectionAt=Date.now()+legion.inspectionDelay(id,config.commanderInspection);legion.saveCampaign(c);armInspection(id,c.nextInspectionAt)}}
      const previous=planningLimits;planningLimits=config
      for(const p of store.projects().filter(p=>p.status==='active')){
        if(!previous||(p.mode==='general'?previous.maxSteps===config.maxSteps:previous.maxBenchmarkTasks===config.maxBenchmarkTasks&&previous.maxSteps===config.maxSteps))continue
        if(p.mode==='benchmark'){const c=legion.campaign(p.id);c.nextInspectionAt=Date.now();legion.saveCampaign(c)}
        store.transaction(()=>store.event(p.id,'planning.capacity_changed',null,{maxSteps:config.maxSteps,maxBenchmarkTasks:p.mode==='benchmark'?config.maxBenchmarkTasks??null:null}))
        if(p.mode==='benchmark')wake(p.id)
      }
    },
    start(){if(!closed)return;closed=false;store.changes.on('change',changed);store.changes.on('legion-message',messaged);store.changes.on('legion-budget',armDeadline);store.changes.on('legion-relay',wake);armDeadline();watchdogTimer=setInterval(()=>{watchdogWork=watchdog().catch(error=>ctx.logger.warn(String(error)))},15_000);watchdogTimer.unref();void recoverLegion(ctx,engine).then(()=>{engine.scheduler.wake();wake()}).catch(error=>ctx.logger.warn(String(error)))},
    async stop(projectId){
      store.project(projectId);clearTimeout(debounces.get(projectId));debounces.delete(projectId);clearTimeout(timers.get(projectId));timers.delete(projectId);clearTimeout(inspections.get(projectId));inspections.delete(projectId)
      const task=active.get(projectId);task?.abort.abort(new Error('Project Commander stopped'));await task?.completion;await release(projectId)
      legion.saveCampaign({...legion.campaign(projectId),status:'stopped'})
    },
    async close(projectId){
      if(projectId){store.project(projectId);store.setStatus(projectId,'stopped');await controller.stop(projectId);await engine.scheduler.stopProject(projectId);return}
      closed=true;clearInterval(watchdogTimer);for(const timer of [...timers.values(),...inspections.values(),...debounces.values()])clearTimeout(timer);timers.clear();inspections.clear();debounces.clear()
      store.changes.off('legion-budget',armDeadline);store.changes.off('legion-relay',wake);store.changes.off('change',changed);store.changes.off('legion-message',messaged)
      for(const task of active.values())task.abort.abort(new Error('Commander lifecycle stopped'))
      await Promise.all([...active.values()].map(t=>t.completion));await watchdogWork;await Promise.all([...residents.keys()].map(release))
    },
  }
  return controller
}
