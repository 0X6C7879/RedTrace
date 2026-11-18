/** Domain aggregation changes only model-facing names; original action bodies retain their contracts. */
export const TOOL_DOMAINS: Record<string, Record<string,string>> = {
  webshell_manage: {test:'webshell_test',register:'webshell_register'},
  c2_manage: {listener:'c2_listener_create',session:'c2_session_create',credential:'c2_credential_create',profile:'c2_profile_create',kinds:'c2_listener_kinds'},
  c2_payload: {oneliner:'c2_payload_oneliner',build:'c2_payload_build',external:'c2_payload_external'},
  fgs_query: {overview:'read_graph',changes:'read_graph_delta'},
  fgs_publish: {fact:'submit_fact',finding:'submit_finding'},
  legion_inspect: {board:'legion_board',roster:'legion_roster',run:'legion_read_run',changes:'legion_read_changes',node:'legion_read_node',triggers:'legion_triggers'},
  legion_task: {spawn:'legion_spawn',adjust:'legion_adjust',reassign:'legion_reassign',park:'legion_park',reactivate:'legion_reactivate'},
  legion_plan: {step:'legion_step',steps:'legion_steps',update_step:'legion_update_step',goal:'legion_goal',update_goal:'legion_update_goal',accept:'legion_accept',done:'legion_plan_done',stop:'legion_task_stop',report:'legion_report',hint:'legion_hint'},
  legion_todo: {read:'legion_todos',write:'TodoWrite'},
  legion_messages: {read:'legion_inbox',send:'legion_message',wait:'legion_wait'},
  legion_models_manage: {list:'legion_models',select:'legion_commander_model'},
  legion_platform: {list:'legion_platform_list',hint:'legion_platform_hint'},
  legion_experience: {search:'legion_experience_search',capture:'legion_experience_capture',transfer:'legion_transfer',confirm:'legion_confirm_transfer'},
  knowledge_query: {search:'knowledge_search',match:'knowledge_match',read:'knowledge_read'},
  resource_manage: {list:'resource_list',get:'resource_get',register:'resource_register'},
  remote_files: Object.fromEntries(['read','write','list','mkdir','touch','stat','hash','move','delete','upload','download'].map(action=>[action,'remote_file_'+action])),
  pivot_manage: {socks:'pivot_socks',validate:'pivot_validate',paths:'pivot_paths',close:'pivot_close'},
}
export const domainAction = (name:string) => {
  for(const [domain,actions] of Object.entries(TOOL_DOMAINS))for(const [action,original] of Object.entries(actions))if(original===name)return{domain,action}
}
export const originalTool = (name:string,action:unknown) => typeof action==='string'?TOOL_DOMAINS[name]?.[action]:undefined
export function rewriteToolNames(text:string):string {
  for(const [domain,actions] of Object.entries(TOOL_DOMAINS))for(const [action,name] of Object.entries(actions)) {
    text=text.replace(new RegExp('\\b'+name+'\\(\\{','g'),domain+'({action:"'+action+'",')
    text=text.replace(new RegExp('\\b'+name+'\\b','g'),domain+' (action='+action+')')
  }
  return text
}
const descriptions:Record<string,string>={
 webshell_manage:'test: probe a known endpoint; register: share verified configuration. Registration is not connection success. Never guess credentials.',
 c2_manage:'listener: create; session: register direct access; credential/profile: store; kinds: list listener types. Registration is not authentication success; retain source evidence.',
 c2_payload:'oneliner: command stager; build: Go beacon; external: adapter payload. Use the assigned authorized listener and target.',
 fgs_query:'overview: paginated FGS summaries or one node (detail=doc expands evidence); changes: incremental metadata, not processing acknowledgement.',
 fgs_publish:'fact: verified incremental evidence, including tested negatives; finding: target-verified vulnerability supported by Fact IDs. API/tool failures are not attack Facts.',
 legion_inspect:'Read only the advertised scheduling/FGS actions. Run reads are summary/search/pages; original detail is on demand. Reads never acknowledge processing.',
 legion_task:'spawn: task actor; adjust: revise/cancel mission; reassign: settled model handoff; park/reactivate: stop/resume a task after outcomes settle.',
 legion_plan:'step/steps: queue one/atomic batch; update_step: revise/cancel; goal/update_goal: stages; accept: evidence-backed acceptance; done: save STATE and acknowledge processed triggers; stop: exhausted task; hint: unverified input. Max Step counts claimed execution only.',
 legion_todo:'read/write the complete task TodoList. Only its Planner may write; completion requires acceptance criteria and retained Fact evidence.',
 legion_messages:'read: durable inbox; send: HELP/REPORT/MESSAGE to an authorized actor; wait: end Planner patrol or wait for events. Delivery is not processing or evidence.',
 legion_models_manage:'list configured model routes; select route for the next cycle. No provider or reasoning configuration is changed.',
 legion_platform:'list: refresh tasks/outcomes; hint: paid hint only with explicit score-penalty confirmation.',
 legion_experience:'search/capture confirmed source experience; transfer as unverified target intel; confirm using actual target Facts.',
 knowledge_query:'search offline CVE/templates; match component/version prerequisites; read full source by ID with byte pagination. Candidate matches are not vulnerability proof.',
 resource_manage:'list/get shared Project resources; register established channels or materials with known configuration and source evidence. Secrets remain server-side; no speculative credential batches.',
 remote_files:'Read/write/list/mkdir/touch/stat/hash/move/delete/upload/download through an existing authorized channel. Source and destination scope and risk checks remain enforced.',
 pivot_manage:'socks: create; validate: verify path; paths: list; close: stop. Reuse existing authorized sessions; capability checks remain enforced.'
}
type Tool = {name:string;description:string;parameters:any;execute:(...args:any[])=>any}
/** Shared fields are serialized once; branches retain action-specific required fields and types. */
export function domainTools<T extends Tool>(tools:T[], allowed:(name:string)=>boolean=()=>true):T[] {
  const remaining=new Map(tools.map(t=>[t.name,t])),result:T[]=[]
  for(const [name,actions] of Object.entries(TOOL_DOMAINS)) {
    const members=Object.entries(actions).flatMap(([action,original])=>{const tool=remaining.get(original);if(!tool)return[];remaining.delete(original);return allowed(original)?[{action,tool}]:[]})
    if(!members.length)continue
    const properties:Record<string,any>={action:{type:'string',enum:members.map(m=>m.action)}},conflicts=new Set<string>()
    for(const {tool} of members)for(const [key,value] of Object.entries(tool.parameters.properties??{})) {
      if(key==='action')throw new Error('Domain action conflicts with '+tool.name)
      if(properties[key]&&JSON.stringify(properties[key])!==JSON.stringify(value))conflicts.add(key)
      else properties[key]=value
    }
    for(const key of conflicts) {
      const variants=[...new Map(members.filter(m=>m.tool.parameters.properties?.[key]).map(m=>{const schema=m.tool.parameters.properties[key];return[JSON.stringify(schema),schema]})).values()]
      properties[key]={anyOf:variants}
    }
    const common=(members[0].tool.parameters.required??[]).filter((key:string)=>members.every(m=>(m.tool.parameters.required??[]).includes(key)))
    const branches=new Map<string,{actions:string[];properties:Record<string,any>;required:string[]}>()
    for(const {action,tool} of members){const fields=Object.fromEntries([...conflicts].filter(k=>tool.parameters.properties?.[k]).map(k=>[k,tool.parameters.properties[k]])),required=(tool.parameters.required??[]).filter((key:string)=>!common.includes(key)),key=JSON.stringify([fields,required]);const branch=branches.get(key);if(branch)branch.actions.push(action);else branches.set(key,{actions:[action],properties:fields,required})}
    const anyOf=[...branches.values()].map(branch=>({properties:{action:branch.actions.length===1?{const:branch.actions[0]}:{enum:branch.actions},...branch.properties},...(branch.required.length?{required:branch.required}:{})}))
    const parameters={type:'object',properties,required:['action',...common],additionalProperties:false,...(branches.size>1||conflicts.size?{anyOf}:{})}
    result.push({...members[0].tool,name,label:name,parameters,
      description:(descriptions[name]??'')+'\n'+members.map(({action,tool})=>action+'('+((tool.parameters.required??[]).join(',')||'no required fields')+')').join('; '),
      execute(...args:any[]){
        const input=typeof args[0]==='string'?args[1]:args[0],{action,...values}=input
        const member=members.find(m=>m.action===action)
        if(!member||!allowed(member.tool.name))throw new Error('Tool action is disabled or unavailable: '+name+'.'+action)
        if(Object.keys(values).some(k=>!Object.hasOwn(member.tool.parameters.properties??{},k))||(member.tool.parameters.required??[]).some((k:string)=>values[k]===undefined))throw new Error('Invalid arguments for '+name+'.'+action+'; required: '+(member.tool.parameters.required??[]).join(',')+'; allowed: '+Object.keys(member.tool.parameters.properties??{}).join(','))
        if(typeof args[0]==='string')return member.tool.execute(args[0],values,...args.slice(2))
        return member.tool.execute(values,...args.slice(1))
      }} as T)
  }
  return [...[...remaining.values()].filter(t=>allowed(t.name)).map(t=>({...t,description:rewriteToolNames(t.description)})),...result]
}
