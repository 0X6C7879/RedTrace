/** Read the native CURRENT request envelope, never cumulative accounting usage. */
export function mountLegionContext(scoped, ctx, { store, legion, run, task, message, onCommanderCompact }) {
  let warned=false,summary
  let currentAgent,capacity,reservedOutputTokens=0
  scoped.on('agent/request',async({agent},next)=>{currentAgent=agent;return next()})
  scoped.on('session/event',async(session,event)=>{
    if(event.type!=='request/header'&&event.type!=='assistant/message')return
    const meter=ctx.get('tokenMeter')
    if(!meter)return
    let inputTokens,sample
    if(event.type==='request/header'){
      const header=event.data.header,info=await ctx.get('llm').resolveModelInfo(header.config.provider,header.config.model)
      capacity=info.context?.contextWindow
      reservedOutputTokens=header.config.maxTokens??info.defaultMaxTokens??0
      inputTokens=meter.measure(session,header).totalTokens;sample='request-header'
    }else{
      const pressure=meter.contextPressure(session)
      inputTokens=pressure.pressureTokens;capacity=pressure.contextWindow??capacity;sample='provider-usage'
    }
    if(inputTokens===undefined)return
    if(!capacity)return
    const tokens=inputTokens+reservedOutputTokens,ratio=tokens/capacity
    if(run){const current=store.run(run.id);current.contextPressure={source:'dsh-token-meter',tokens,inputTokens,reservedOutputTokens,capacity,ratio,sample,sampledAt:new Date().toISOString()};store.saveRun(current)}
    if(ratio<0.75)warned=false
    if(ratio>=0.80&&!warned&&currentAgent?.status==='running'){warned=true;if(!run)legion.checkpointState(store.projectScope,'context-80-percent');currentAgent.inject(message('当前上下文压力 '+Math.round(ratio*100)+'%。立即用 legion_state 存完整确证 STATE，保留未知结果；DSH 管自动压缩，不手动压缩。'))}
  })
  scoped.on('session/event',(session,event)=>{
    if(event.type==='compaction/summary')summary=event.data?.summary?.filter(b=>b.type==='text').map(b=>b.text).join('\n')
    if(event.type!=='compaction/end'||event.data?.error||!summary)return
    warned=false
    if(run){
      if(run.activity==='plan'){legion.saveState(run.projectId,run.id,summary);summary=undefined;return}
      const step=store.node(run.projectId,run.stepId,'step')
      const state=JSON.stringify({source:'native-compaction',stepId:step.id,goalId:step.goalId,taskKey:step.taskKey,summary,predecessorRunId:run.id,sourceIds:step.sourceIds,factIds:step.factIds})
      legion.queueHandoff(run.id,state);legion.settleHandoff(run.id)
    }else onCommanderCompact?.(summary)
    summary=undefined
  })
}
