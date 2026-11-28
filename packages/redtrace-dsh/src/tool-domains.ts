import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'

const require = createRequire(import.meta.url)
let loaded: {rewriteToolNames(text: string): string} | undefined
const native = () => loaded ??= require('../../redtrace-engine/src/native/redtrace_native.node') as {rewriteToolNames(text: string): string}

/** Domain aggregation changes model-facing names; original action bodies retain their contracts. */
export const TOOL_DOMAINS: Record<string, Record<string,string>> = JSON.parse(readFileSync(new URL('../../redtrace-engine/src/native/src/runtime/domain-catalog.json', import.meta.url), 'utf8'))
const domainActions = new Map(Object.entries(TOOL_DOMAINS).flatMap(([domain, actions]) => Object.entries(actions).map(([action, original]) => [original, {domain, action}] as const)))
export const domainAction = (name:string) => {
  const mapped = domainActions.get(name)
  return mapped ? {...mapped} : undefined
}
export const originalTool = (name:string,action:unknown) => typeof action==='string'?TOOL_DOMAINS[name]?.[action]:undefined
export const rewriteToolNames = (text: string): string => native().rewriteToolNames(text)
const descriptions:Record<string,string>={
 webshell_manage:'test 探测已知端点；register 共享已验证配置。注册≠连接成功，不猜凭据。',
 c2_manage:'listener 创建；session 注册直连；credential/profile 存储；kinds 列类型。注册≠认证成功，保留来源证据。',
 c2_payload:'oneliner 命令；build Go beacon；external adapter Payload。仅用分配且授权的 listener/目标。',
 fgs_query:'overview 分页摘要/单节点（detail=doc 展开证据）；changes 增量元数据，读取≠确认处理。',
 fgs_publish:'fact 增量确证，含实测否定；finding 本目标已验证且有 Fact ID 支撑的漏洞。API/工具故障不是攻击 Fact。',
 legion_inspect:'仅用所列调度/FGS action；Run 先摘要/搜索/分页，按需原文。读取不确认处理。',
 legion_task:'spawn 派任务；adjust 调整/取消；reassign 结清后换模型；park/reactivate 停止/结清后恢复。',
 legion_plan:'step/steps 单个/原子批量排队；update_step 修订/取消；goal/update_goal 阶段；accept 凭证验收；done 存 STATE/确认已处理事件；stop 止损；report 按需交付；hint 未验证输入。Max Step 仅限 claim 的执行。',
 legion_todo:'读/替换完整任务 TodoList；仅所属 Planner 可写，完成须验收标准及留存 Fact 证据。',
 legion_messages:'read 持久收件箱；send 向授权 actor 发 HELP/REPORT/MESSAGE；wait 结束 Planner 巡检/等事件。送达≠处理/证据。',
 legion_models_manage:'list 配置内模型；select 选下轮路由，不改 provider/推理配置。',
 legion_platform:'list 刷新任务/结果；hint 须明确确认扣分才可购买。',
 legion_experience:'search/capture 确证源经验；transfer 为目标未验证情报；confirm 须实际目标 Fact。',
 knowledge_query:'search 离线 CVE/模板；match 组件/版本/前提；read 按 ID/字节分页读原文。匹配≠漏洞确证。',
 resource_manage:'list/get 本 Project 共享资源；register 有已知配置/来源证据的通道/材料。secret 留服务端，不批量猜凭据。',
 remote_files:'经已建立授权通道操作远程文件；源/目的范围及风险检查不变。',
 pivot_manage:'socks 创建；validate 验路径；paths 列表；close 停止。复用授权会话，能力检查不变。'
}
type Tool = {name:string;description:string;parameters:any;execute:(...args:any[])=>any}
/** Validate only the selected action; unrelated union branches are not repair instructions. */
export function actionParameters(parameters: any, input: any): any {
  const branch = parameters.anyOf?.find((schema: any) => schema.properties?.action?.const === input?.action || schema.properties?.action?.enum?.includes(input?.action))
  if (!branch) return parameters
  const { anyOf, ...root } = parameters
  return { ...root, properties: Object.fromEntries(Object.entries(branch.properties).map(([key, value]) => [key, { ...parameters.properties[key], ...value as object }])), required: [...new Set([...(parameters.required ?? []), ...(branch.required ?? [])])] }
}
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
    for(const {action,tool} of members){const fields=Object.fromEntries(Object.entries(tool.parameters.properties??{}).map(([k,v])=>[k,conflicts.has(k)?v:{}])),required=(tool.parameters.required??[]).filter((key:string)=>!common.includes(key)),key=JSON.stringify([fields,required]);const branch=branches.get(key);if(branch)branch.actions.push(action);else branches.set(key,{actions:[action],properties:fields,required})}
    const anyOf=[...branches.values()].map(branch=>({type:'object',additionalProperties:false,properties:{action:branch.actions.length===1?{const:branch.actions[0]}:{enum:branch.actions},...branch.properties},...(branch.required.length?{required:branch.required}:{})}))
    const parameters={type:'object',properties,required:['action',...common],additionalProperties:false,...(branches.size>1||conflicts.size?{anyOf}:{})}
    result.push({...members[0].tool,name,label:name,parameters,
      description: (descriptions[name] ?? '') + '\n' + members.map(({action,tool}) => {
        const required = new Set(tool.parameters.required ?? [])
        const fields = Object.keys(tool.parameters.properties ?? {}).map(key => key + (required.has(key) ? '' : '?')).join(',')
        return action + '(' + fields + ')'
      }).join('; '),
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
