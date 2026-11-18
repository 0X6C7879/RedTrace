/** Read the native CURRENT request envelope, never cumulative accounting usage. */
export function mountLegionContext(scoped, ctx, { store, legion, run, task, message, onCommanderCompact }) {
  let warned=false,summary
  let currentAgent
  scoped.on('agent/request',async({agent},next)=>{currentAgent=agent;return next()})
  scoped.on('session/event',async(session,event)=>{
    if(event.type!=='request/header')return
    const header=event.data.header,meter=ctx.get('tokenMeter')
    if(!meter)return
    const info=await ctx.get('llm').resolveModelInfo(header.config.provider,header.config.model),capacity=info.context?.contextWindow
    if(!capacity)return
    const tokens=meter.measure(session,header).totalTokens+(header.config.maxTokens??info.defaultMaxTokens??0),ratio=tokens/capacity
    if(run){const current=store.run(run.id);current.contextPressure={source:'dsh-token-meter',tokens,capacity,ratio};store.saveRun(current)}
    if(ratio<0.75)warned=false
    if(ratio>=0.80&&!warned&&currentAgent?.status==='running'){warned=true;if(!run)legion.checkpointState(store.projectScope,'context-80-percent');currentAgent.inject(message('Native current context pressure is '+Math.round(ratio*100)+'%. Save full confirmed STATE with legion_state now. Preserve unknown outcomes. DSH owns automatic compaction; do not invoke manual compaction.'))}
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
