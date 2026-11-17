import { FIXED_ROLES, coordinatorRole } from '../../redtrace-dsh/src/roles.ts'
import type { Store } from './store.ts'

/** Disjoint provider buckets, not prices. Campaign usage is the coordinator's lifetime ledger. */
export function tokenUsage(store: Store, projectId?: string, graphId?: string, runId?: string) {
  const roles: Record<string,{input:number;output:number;cacheRead:number;cacheWrite:number;total:number}> = {}
  const empty=()=>({input:0,output:0,cacheRead:0,cacheWrite:0,total:0})
  for(const role of FIXED_ROLES)roles[role]=empty()
  const audits=store.db.prepare('SELECT data FROM audit_runs WHERE (? IS NULL OR project_id=?) AND (? IS NULL OR json_extract(data,\'$.graph_id\')=?) AND (? IS NULL OR id=?)').all(projectId??null,projectId??null,graphId??null,graphId??null,runId??null,runId??null).map(row=>JSON.parse(String(row.data)))
  for(const r of audits){const v=roles[r.task_type]??=empty();v.input+=Number(r.input_tokens??0);v.output+=Number(r.output_tokens??0);v.cacheRead+=Number(r.cache_read_tokens??0);v.cacheWrite+=Number(r.cache_write_tokens??0)}
  if(!graphId&&!runId)for(const project of store.projects().filter(p=>!projectId||p.id===projectId)) {
    const row=store.db.prepare('SELECT data FROM project_campaigns WHERE project_id=?').get(project.id),usage=row&&JSON.parse(String(row.data)).usage
    if(!usage)continue
    const role=coordinatorRole(project.mode)
    // Replace that Project's audit subtotal, never add its campaign twice.
    for(const r of audits.filter(r=>r.project_id===project.id&&r.task_type===role)){roles[role].input-=Number(r.input_tokens??0);roles[role].output-=Number(r.output_tokens??0);roles[role].cacheRead-=Number(r.cache_read_tokens??0);roles[role].cacheWrite-=Number(r.cache_write_tokens??0)}
    roles[role].input+=Number(usage.inputTokens??0);roles[role].output+=Number(usage.outputTokens??0);roles[role].cacheRead+=Number(usage.cacheReadTokens??0);roles[role].cacheWrite+=Number(usage.cacheWriteTokens??0)
  }
  for(const v of Object.values(roles))v.total=v.input+v.output+v.cacheRead+v.cacheWrite
  return {...Object.fromEntries(Object.entries(roles).map(([role,v])=>[role,v.total])),total:Object.values(roles).reduce((sum,v)=>sum+v.total,0),breakdown:roles}
}
