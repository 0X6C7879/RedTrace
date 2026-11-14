import { Store } from './store.ts'
import { LegionStore } from './legion-store.ts'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { toolEnvironment } from './shell.ts'
import { HttpError } from './types.ts'
import type { EngineConfig } from './types.ts'
const execFileAsync=promisify(execFile)
/** Only this adapter knows the TSecBench SDK; other benchmarks keep manual task graphs. */
export function benchmarkAdapter(store:Store,projectId:string) {
  store.project(projectId)
  const origin=store.scopeFact(projectId)
  const description='description'in origin?origin.description:''
  const tsec=/(?:tsecbench|tsec[\s-]*benchmark)/i.test(description)
  return {kind:tsec?'tsecbench':/(?:tpctf|ctfy)/i.test(description)?'tpctf':'manual',instanceApi:tsec,submissionApi:tsec}
}
async function tpctfQuery(config:EngineConfig,args:string[],signal?:AbortSignal) {
  const script=path.join(path.dirname(config.workspaceRoot),'.redtrace','skills','tpctf-api','scripts','tpctf.py')
  let stdout:string
  try { stdout=(await execFileAsync(process.env.REDTRACE_BENCHMARK_PYTHON||'python3',[script,...args],{cwd:path.dirname(script),env:toolEnvironment(config.commonEnv),signal,timeout:45_000,maxBuffer:2*1024*1024})).stdout }
  catch(error) { const output=(error as {stdout?:string}).stdout;if(!output)throw error;stdout=output }
  const response=JSON.parse(stdout)
  if(response?.ok===false)throw new HttpError(502,String(response.detail??response.code??'TPCTF API failure'),response)
  return response
}
export function recordBenchmarkSubmission(store:Store,projectId:string,taskKey:string,response:any) {
  const row=store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey)
  const data={...(row?JSON.parse(String(row.data)):{}),submissionAttemptedAt:new Date().toISOString(),submissionAccepted:response?.correct===true}
  store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,taskKey,JSON.stringify(data))
  store.event(projectId,'legion.submission',null,{taskKey,accepted:data.submissionAccepted})
}
export async function tsecbenchQuery(config: EngineConfig, args: string[], signal?: AbortSignal) {
  const script = path.join(path.dirname(config.workspaceRoot), '.redtrace', 'skills', 'tsecbench-api', 'scripts', 'tsecbench.py')
  try {
    const { stdout } = await execFileAsync(process.env.REDTRACE_BENCHMARK_PYTHON || 'python3', [script, ...args], {
      cwd: path.dirname(script), env: toolEnvironment(config.commonEnv), signal, timeout: 45_000, maxBuffer: 2 * 1024 * 1024,
    })
    const response = JSON.parse(stdout)
    if (response?.ok === false) throw new HttpError(502, response.message ?? response.error ?? 'TSecBench SDK failure', response)
    return response?.[args[0]] ?? response
  } catch (error) {
    if (error instanceof HttpError) throw error
    const failure = error as { stdout?: string; stderr?: string; code?: string; killed?: boolean; message?: string }
    for (const text of [failure.stderr, failure.stdout]) {
      try { const parsed = JSON.parse(text ?? ''); throw new HttpError(502, parsed.message ?? parsed.error ?? 'TSecBench SDK failure', parsed) } catch (parsedError) { if (parsedError instanceof HttpError) throw parsedError }
    }
    throw new HttpError(502, failure.killed ? 'TSecBench query timed out; execution outcome may be unknown' : 'TSecBench query failed', { code: failure.code ?? null, message: failure.message ?? null })
  }
}


/** Platform discovery only supplies task parameters; FGS ownership remains generic. */
export async function discoverBenchmarkTasks(store:Store,config:EngineConfig,projectId:string,signal?:AbortSignal){
  const adapter=benchmarkAdapter(store,projectId)
  if(adapter.kind==='tpctf') {
    const response=await tpctfQuery(config,['challenges'],signal)
    store.transaction(()=>{
      for(const challenge of response.items??[]) {
        const taskKey=challenge.id
        if(typeof taskKey!=='string'||!taskKey)throw new HttpError(502,'Challenge is missing id')
        const row=store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey)
        const data={...(row?JSON.parse(String(row.data)):{}),platformCompleted:challenge.my_team_fully_solved===true}
        store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,taskKey,JSON.stringify(data))
        if(store.project(projectId).mode!=='benchmark'||challenge.my_team_fully_solved||challenge.closed||challenge.my_team_authored||challenge.scoring!=='scored'||store.projectGraphs(projectId).some(g=>g.taskKey===taskKey))continue
        store.createGraph(projectId,{taskKey,title:challenge.title??taskKey,origin:store.scopeFact(projectId).description+'\nPlatform task: '+JSON.stringify(challenge),goal:(store.project(projectId).objective??'Complete the authorized task')+' · '+taskKey})
      }
    })
    return response
  }
  if(adapter.kind==='manual')return {adapter,challenges:store.projectGraphs(projectId).filter(g=>g.type==='benchmark_task').map(g=>({unique_code:g.taskKey,title:g.title}))}
  const response=await tsecbenchQuery(config,['list'],signal)
  if(store.project(projectId).mode==='benchmark'&&Array.isArray(response.challenges)) {
    store.transaction(()=>{
      for(const challenge of response.challenges){
        const taskKey=challenge.unique_code
        if(typeof taskKey!=='string'||!taskKey)throw new HttpError(502,'Challenge is missing unique_code')
        const row=store.db.prepare('SELECT data FROM legion_tasks WHERE project_id=? AND task_key=?').get(projectId,taskKey)
        const data=row?JSON.parse(String(row.data)):{}
        data.platformCompleted=challenge.is_completed===true
        store.db.prepare('INSERT INTO legion_tasks VALUES (?,?,?) ON CONFLICT(project_id,task_key) DO UPDATE SET data=excluded.data').run(projectId,taskKey,JSON.stringify(data))
        if(challenge.is_completed)continue
        if(store.projectGraphs(projectId).some(g=>g.taskKey===taskKey))continue
        store.createGraph(projectId,{taskKey,title:challenge.title??challenge.name??taskKey,origin:store.scopeFact(projectId).description+'\nPlatform task: '+JSON.stringify(challenge),goal:(store.project(projectId).objective??'Complete the authorized task')+' · '+taskKey})
      }
    })
  }
  return response
}

export async function benchmarkInstance(store:Store,config:EngineConfig,projectId:string,code:string,action:'start'|'close',signal?:AbortSignal) {
  const adapter=benchmarkAdapter(store,projectId)
  if(!adapter.instanceApi)return {supported:false,adapter:adapter.kind,action,taskKey:code}
  const legion=new LegionStore(store)
  if(action==='close')legion.assertInstanceClose(projectId,code)
  const response=await tsecbenchQuery(config,[action,code],signal)
  if(action==='start') {
    if(response.unique_code!==code||!Array.isArray(response.container_addr)||!response.container_addr.length)throw new HttpError(502,'Platform returned an invalid challenge or target list')
    const hosts=response.container_addr.map((value:unknown)=>{if(typeof value!=='string')throw new HttpError(502,'Invalid target address');const url=new URL(/^https?:/.test(value)?value:'http://'+value);if(url.username||url.password)throw new HttpError(502,'Credential-bearing target rejected');return url.host.toLowerCase()})
    store.setBenchmarkHosts(projectId,code,hosts)
    const graph=store.projectGraphs(projectId).find(g=>g.taskKey===code)
    const scoped=graph?store.forGraph(projectId,graph.id):store
    scoped.addInput(projectId,'observation','Platform started '+code+'; authorized targets: '+response.container_addr.join(', '),'commander')
  }else { if(response?.closed!==true)throw new HttpError(502,'Platform close is unconfirmed; retain instance state and verify before retry',response);store.setBenchmarkHosts(projectId,code) }
  legion.platformEvent(projectId,code,action,response);return response
}
