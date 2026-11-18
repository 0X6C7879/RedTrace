import {domainFixtureRequest} from './domain-fixture.mjs'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, symlinkSync, rmSync, existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
const root = process.argv[2] ?? path.resolve(import.meta.dirname, '../../..')
if (!existsSync(root + '/packages/redtrace-engine/compat/legion.mjs')) { console.log('LEGION_RUNTIME_SUPPORTED=false'); process.exit(0) }
const dependencyRoot = process.argv[3] ?? root
const { Configuration } = await import(pathToFileURL(root + '/packages/redtrace-engine/src/config.ts'))
const work = mkdtempSync(path.join(os.tmpdir(), 'redtrace-legion-loop-'))
symlinkSync(path.join(dependencyRoot, 'static'), path.join(work, 'static'))
mkdirSync(work+'/skills/console-native',{recursive:true});writeFileSync(work+'/skills/console-native/SKILL.md','---\nname: console-native\ndescription: Local native catalog test\n---\nroot-catalog-native-proof\n')
let api, projectId, child, logs = '', ended = false, liveSchemaChecked = false
const requests = [], roles = new Set(), pending = new Set()
const lastOutput = b => {
  const tool = b.messages.filter(m => m.role === 'tool').at(-1)
  if (!tool) return {}
  try { return JSON.parse(typeof tool.content === 'string' ? tool.content : tool.content.filter(p => p.type === 'text').map(p => p.text).join('')) } catch { return {} }
}
const model = createServer(async (req, res) => {
  pending.add(res); res.on('close', () => pending.delete(res))
  try {
    let raw = ''; for await (const chunk of req) raw += chunk
    const b = domainFixtureRequest(JSON.parse(raw),res), names = (b.tools ?? []).map(t => t.function.name)
    if(names.includes('legion_roster')){const live=await(await fetch(api+'/console/tools')).json();assert(!names.includes('legion_board'));assert(live.tools.some(t=>t.name==='legion_inspect'&&t.roles.includes('general')));assert(live.runs.some(r=>r.visibleSchemas===b.wireTools.length),'Run visible count must match the actual provider Tool Schema list');liveSchemaChecked=true}
    requests.push(b)
    const system = b.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
    const role = ['GENERAL','SOLDIER'].find(role => system.includes('你是 ' + role))
    if (!role) throw new Error('Missing Legion Mission: ' + system.slice(0,300))
    roles.add(role)
    const textOf=m=>typeof m.content==='string'?m.content:(m.content??[]).map(b=>b.text??'').join('')
    const boundary=b.messages.findLastIndex(m=>m.role==='user'&&(()=>{try{return !!(JSON.parse(textOf(m)).instruction||JSON.parse(textOf(m)).frontier)}catch{return false}})())
    const current=role==='GENERAL'?b.messages.slice(boundary+1):b.messages
    const calls=current.flatMap(m=>m.tool_calls??[]).map(c=>c.function.name),last=calls.at(-1)
    const g=await(await fetch(api+'/v2/projects/'+projectId)).json()
    const admittedText=b.messages.filter(m=>m.role==='user').map(textOf).join('\n')
    let name,args
    if(role==='GENERAL'){
      for(const forbidden of ['submit_fact','legion_spawn','legion_reassign'])assert(!names.includes(forbidden))
      const inbox=await(await fetch(api+'/v2/legion?projectId='+projectId)).json()
      const unanswered=inbox.messages.find(m=>m.type==='HELP'&&!inbox.messages.some(reply=>reply.receiver===m.sender&&reply.content==='PLANNER_ACK'))
      const tasks=['entry-a','entry-b'],unfinished=g.steps.filter(s=>s.status!=='done')
      if(!calls.includes('legion_roster')){name='legion_roster';args={projectId}}
      else if(!calls.includes('legion_read_changes')){name='legion_read_changes';args={projectId}}
      else if(unanswered){name='legion_message';args={projectId,receiver:unanswered.sender,type:'MESSAGE',content:'PLANNER_ACK'}}
      else if(tasks.some(title=>!g.steps.some(s=>s.description===title))){name='legion_step';args={projectId,description:tasks.find(title=>!g.steps.some(s=>s.description===title)),sourceIds:['origin']}}
      else if(g.steps.length===2&&!unfinished.length){name='legion_step';args={projectId,description:'dependent integration',sourceIds:g.facts.filter(f=>f.id!=='origin').map(f=>f.id),dependsOn:g.steps.map(s=>s.id)}}
      else if(g.steps.length===3&&!unfinished.length&&g.project.status!=='completed'){name='legion_accept';args={projectId,goalId:'goal',expectedVersion:g.goals.find(n=>n.id==='goal').version,evidenceIds:g.facts.filter(f=>f.id!=='origin').map(f=>f.id)}}
      else {
        const delta=current.filter(m=>m.role==='tool').map(m=>{try{return JSON.parse(textOf(m))}catch{return null}}).find(v=>v?.cursor!==undefined)
        name='legion_finish';args={processed:{[projectId]:delta.cursor},state:g.project.status==='completed'?'Fixture accepted: Planner/Worker shared FGS, independent parallel Steps then dependent integration.':'Waiting for verified Worker evidence; no duplicate Steps.'}
      }
    }else{
      for(const forbidden of ['legion_spawn','legion_step','legion_goal','legion_accept','TodoWrite','legion_todos','legion_experience_capture'])assert(!names.includes(forbidden),'Worker has no planning or squad tool: '+forbidden)
      if(!calls.includes('skill')){name='skill';args={name:'console-native'}}
      else if(!calls.includes('bash')){name='bash';args={command:"printf '%s\\n' 'Deterministic authorized local protocol fixture; not live-target proof' > proof.txt",description:'Write local fixture evidence'}}
      else if(!calls.includes('submit_fact')){name='submit_fact';args={title:'Worker verified',description:'Worker verified its assigned local fixture evidence',evidence:[{path:'proof.txt',description:'Deterministic authorized local protocol fixture; not live-target proof'}]}}
      else if(!calls.includes('legion_message')){name='legion_message';args={receiver:'commander',type:'HELP',content:'Worker needs Planner acknowledgement of the verified fixture evidence.'}}
      else if(!admittedText.includes('PLANNER_ACK')){
        if(last==='read_graph_delta'){name='legion_wait';args={after:lastOutput(b).cursor}}
        else{name='read_graph_delta';args={}}
      }else{name='finish_step';args={summary:'Worker completed assigned Step with verified evidence'}}
    }
    assert.ok(names.includes(name), role + ' missing tool ' + name)
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: ' + JSON.stringify({ id: 'legion-fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call-' + requests.length, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 12, completion_tokens: 8 } }) + '\n\n')
    res.end('data: [DONE]\n\n')
  } catch (error) { logs += '\nMODEL FIXTURE: ' + error.stack; res.writeHead(500); res.end(String(error)) }
})
try {
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const config = new Configuration(work); config.initialize(); config.commit(config.read().revision, raw => {
    raw.providers = { fixture: { api: 'openai-completions', base_url: 'http://127.0.0.1:' + model.address().port + '/v1', api_key: 'fixture-not-a-secret', models: [{ id: 'fixture', context_window: 50000, max_tokens: 2000, reasoning: 'off', reasoning_efforts: false }] } }
    raw.workers = ['commander','soldier'].map(role => ({ name: role, roles: [role==='commander'?'general':role], provider: 'fixture', model: 'fixture', reason: false, explore: false, bootstrap: false, max_running: role === 'soldier' ? 2 : 1 }))
    raw.runtime = { max_workers: 4, max_project_workers: 4, max_running_projects: 1 }
    raw.tasks = { commander: { timeout: 45, conclude_timeout: 5 }, general: { timeout: 30, conclude_timeout: 5 }, soldier: { timeout: 30, conclude_timeout: 5 }, scout: { timeout: 20, conclude_timeout: 5 } }
  })
  const reservation = createServer(); await new Promise(resolve => reservation.listen(0,'127.0.0.1',resolve)); const port=reservation.address().port; await new Promise(resolve => reservation.close(resolve)); api = 'http://127.0.0.1:' + port
  child = spawn(process.execPath, [root + '/scripts/run-redtrace-node.mjs','--root',work,'--host','127.0.0.1','--port',String(port)], { cwd: root, env: { ...process.env, DSH_HOME: work + '/.dsh', REDTRACE_SOURCE_ROOT: root, REDTRACE_CODE_ROOT: dependencyRoot, REDTRACE_DSH_ROOT: dependencyRoot, REDTRACE_DATA_ROOT: work + '/.redtrace' }, stdio: ['ignore','pipe','pipe'] })
  const closed = new Promise(resolve => child.once('close', () => { ended = true; resolve() }))
  for (const stream of [child.stdout,child.stderr]) stream.on('data', b => { logs = (logs + b).slice(-80000) })
  const deadline = Date.now()+20000
  while (Date.now()<deadline) { try { if ((await fetch(api+'/runtime/config')).ok) break } catch {} if(ended)throw new Error(logs); await delay(50) }
  const call = async (route, body) => { const r=await fetch(api+route,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{}); const v=await r.json();assert.ok(r.ok,JSON.stringify(v)+'\n'+logs);return v }
  const graph=await call('/v2/projects',{mode:'general',title:'Legion native protocol fixture',origin:'Only authorized local deterministic fixture, no real target',goal:'Verify Planner/Worker collaboration',bootstrap:false}); projectId=graph.project.id
  const acceptedDeadline=Date.now()+45000
  while(Date.now()<acceptedDeadline){const board=await call('/v2/legion?projectId='+projectId);if(board.campaign.status==='stopped')throw Error(JSON.stringify(board.campaign));if(board.projects[0]?.status==='completed'&&board.campaign.status==='idle')break;await delay(20)}
  const inventory=await call('/console/tools')
  assert(liveSchemaChecked,'Model and UI both observe the active Commander registry')
  assert(inventory.tools.some(t=>t.name==='legion_inspect'&&t.scopes.length===0),'Real Schema stays listed after session disposal without retaining the disposed scope')
  const result=(await call('/v2/legion?projectId='+projectId)).campaign
  assert.equal(result.status,'idle');assert.ok(result.state.includes('Fixture accepted'))
  const g=await call('/v2/projects/'+projectId), runs=await call('/v2/projects/'+projectId+'/runs')
  assert.equal(g.project.status,'completed');assert.equal(g.steps.length,3);assert.ok(g.steps.every(s=>s.status==='done'));assert.ok(runs.every(r=>r.status==='succeeded')); for (const run of runs) assert.equal(run.worker, g.steps.find(s=>s.id===run.stepId).role)
  assert(g.facts.filter(f=>f.id!=='origin').every(f=>f.evidence.some(e=>e.artifactId)),'Goal acceptance must use retained fixture bytes, not description-only claims')
  assert.deepEqual([...roles].sort(),['GENERAL','SOLDIER'])
  const resumed=await call('/v2/legion/command',{projectId,worker:'commander'});assert.equal(resumed.sessionId,result.sessionId);assert.equal(resumed.status,'idle');assert.equal((await call('/v2/projects/'+projectId)).steps.length,3)
  const usage=await call('/audit/usage');assert.ok(usage.general>0,'Global Commander usage must come from actual native assistant messages');assert.ok(usage.total>=usage.general)
  const logPage = await call('/v2/legion/session/events?projectId='+projectId+'&offset=0&limit=100')
  assert.equal(logPage.sessionId,result.sessionId);assert.equal(logPage.available,true);assert.ok(logPage.nextOffset<=100)
  assert.ok(logPage.events.some(event=>event.task_type==='general'&&['tool.started','assistant.message','user.message'].includes(event.kind)))
  const repeated=await call('/v2/legion/session/events?projectId='+projectId+'&offset=0&limit=100');assert.deepEqual(repeated.events.map(e=>e.timestamp),logPage.events.map(e=>e.timestamp),'Historical Commander timestamps must not change when reread');assert.ok(logPage.events.some(e=>e.kind==='system.prompt'),'Current native system/message must be visible')
  const nextPage=await call('/v2/legion/session/events?projectId='+projectId+'&offset='+logPage.nextOffset+'&limit=100');assert.ok(nextPage.nextOffset>=logPage.nextOffset)
  assert.equal((await fetch(api+'/v2/legion/session/events?projectId='+projectId+'&limit=0')).status,422)
  const pidFile=work+'/mcp-pids',serverFile=work+'/hot-mcp.mjs'
  writeFileSync(serverFile,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';appendFileSync(${JSON.stringify(pidFile)},process.pid+'\\n');createInterface({input:process.stdin}).on('line',line=>{const q=JSON.parse(line);if(q.id===undefined)return;const result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'hot',version:'1'}}:q.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{}}}]}:{};console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}))});`)
  const mcp={command:process.execPath,args:[serverFile],transport:'stdio',failOnStartupError:true}
  await call('/capabilities/mcp',{name:'hot',config:mcp})
  const pids=()=>existsSync(pidFile)?readFileSync(pidFile,'utf8').trim().split('\n').map(Number):[]
  const waitFor=async predicate=>{const until=Date.now()+10000;while(!predicate()&&Date.now()<until)await delay(20);assert(predicate(),'MCP config watcher did not apply saved configuration')}
  await waitFor(()=>pids().length===1)
  const response=await fetch(api+'/capabilities/mcp/hot',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:{...mcp,env:{HOT_RELOAD_FIXTURE:'updated'}}})});assert(response.ok)
  await waitFor(()=>pids().length===2)
  const stopped=pid=>{try{process.kill(pid,0);return false}catch(error){assert.equal(error.code,'ESRCH');return true}}
  await waitFor(()=>stopped(pids()[0]))
  const disabled=await fetch(api+'/capabilities/mcp/hot/enabled',{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:false})});assert(disabled.ok)
  await waitFor(()=>stopped(pids()[1]))
  console.log('MCP_CONFIG_WATCH=true; saved_create_update_disable_without_catalog_poll=true')
  if(process.argv[4]==='--hold') { console.log('UI_READY '+JSON.stringify({api,work,projectId,commanderSessionId:result.sessionId}));await new Promise(resolve=>process.once('SIGTERM',resolve)) }
  child.kill('SIGTERM'); await closed
  const { Store }=await import(pathToFileURL(root+'/packages/redtrace-engine/src/store.ts'));const store=new Store(work+'/.redtrace/engine.db')
  try {
    const audit=store.db.prepare('SELECT data FROM audit_events').all().map(row=>JSON.parse(row.data));assert(audit.filter(e=>e.kind==='tool.started'&&e.title==='skill'&&JSON.stringify(e.arguments).includes('console-native')).length>=2,'Skill audit is preserved independently of tool inventory')
    const messages=store.db.prepare('SELECT data FROM legion_messages').all().map(row=>JSON.parse(row.data))
    assert.ok(messages.length>=4);assert.ok(messages.some(m=>m.status==='admitted'),'real native inbox admission was not recorded'); assert.ok(messages.some(m=>m.type==='HELP'&&m.status==='admitted')); assert.ok(messages.some(m=>m.content.includes('PLANNER_ACK')&&m.status==='admitted'))
    assert.equal(store.run(runs[0].id).pendingTools.length,0)
    const campaign=JSON.parse(store.db.prepare('SELECT data FROM project_campaigns WHERE project_id=?').get(projectId).data)
    assert.ok(campaign.cursors[projectId].acknowledged>0)
    console.log('RUN_VISIBLE_SCHEMAS='+JSON.stringify(Object.fromEntries(['GENERAL','SOLDIER'].map(role=>[role,[...new Set(requests.filter(b=>b.messages.some(m=>m.role==='system'&&String(m.content).includes('你是 '+role))).map(b=>b.wireTools?.length??b.tools.length))]]))));
  console.log('LEGION_RUNTIME_SUPPORTED=true; roles=Planner,Worker; specialist_workers=0; worker_has_no_plan_tools=true; serial_dependencies=true; shared_fgs=true; commander_acceptance=true; native_message_admission=true; state_and_cursor_persisted=true; commander_native_resume=true; help_reply_admitted=true; model=local-protocol-fixture; commander_native_log_read=true')
  } finally { store.close() }
} catch (error) {
  if (existsSync(work+'/.redtrace/engine.db')) { const { DatabaseSync }=await import('node:sqlite'); const db=new DatabaseSync(work+'/.redtrace/engine.db',{readOnly:true});try { console.error(db.prepare("SELECT data FROM project_campaigns").all()) } finally {db.close()} }
  console.error(logs); throw error }
finally { if(child&&!ended){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve))}for(const res of pending)res.destroy();await new Promise(resolve=>model.close(resolve));rmSync(work,{recursive:true,force:true}) }
