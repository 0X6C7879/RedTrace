import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtempSync, symlinkSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
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
let api, projectId, child, logs = '', ended = false
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
    const b = JSON.parse(raw), names = (b.tools ?? []).map(t => t.function.name)
    requests.push(b)
    const system = b.messages.filter(m => m.role === 'system').map(m => m.content).join('\n')
    const role = ['COMMANDER','GENERAL','SCOUT','SOLDIER'].find(role => system.includes('You are ' + role))
    if (!role) throw new Error('Missing Legion Mission: ' + system.slice(0,300))
    roles.add(role)
    const calls = b.messages.flatMap(m => m.tool_calls ?? []).map(c => c.function.name), last = calls.at(-1)
    const g = await (await fetch(api + '/v2/projects/' + projectId)).json()
    const scope = role === 'COMMANDER' ? { projectId } : {}
    const spawnMission = (role, description) => ({ ...scope, role, taskKey: 'fixture-a', description, sourceIds: ['origin'], goalId: 'goal' })
    const admittedText = b.messages.filter(m=>m.role==='user').map(m=>JSON.stringify(m.content)).join('\n')
    let name, args
    if (role === 'COMMANDER') {
      if(last==='legion_board')assert.ok(lastOutput(b).projects?.some(p=>p.id===projectId),'Native Commander must receive a lossless JSON board, not a tool output error')
      assert.ok(!names.includes('bash') && !names.includes('submit_fact') && !names.includes('finish_decide'))
      if (!calls.includes('legion_board')) { name = 'legion_board'; args = {} }
      else if (!g.steps.some(s => s.description === 'fixture-scout')) { name = 'legion_spawn'; args = spawnMission('scout', 'fixture-scout') }
      else if (g.steps.find(s => s.description === 'fixture-scout').status === 'done' && !calls.includes('legion_classify')) {name='legion_classify';args={projectId,taskKey:'fixture-a',difficulty:'hard',factIds:[g.facts.find(f=>f.id!=='origin').id]}}
      else if (g.steps.find(s => s.description === 'fixture-scout').status === 'done' && !g.steps.some(s => s.role === 'general')) { name = 'legion_spawn'; args = spawnMission('general', 'fixture-general') }
      else if (g.steps.some(s => s.role === 'general' && s.status === 'running') && admittedText.includes('General needs') && !calls.includes('legion_message')) {
        if (last === 'legion_roster') { const general = lastOutput(b).find?.(a=>a.role==='general'); if(general){name='legion_message';args={projectId,receiver:general.runId,type:'MESSAGE',content:'COMMANDER_TACTICAL_ACK: verify both specialist Facts before reporting.'}}else{name='legion_read_changes';args={projectId}} }
        else {name='legion_roster';args={projectId}}
      }
      else if (g.steps.some(s => s.role === 'general' && s.status === 'done') && g.project.status !== 'completed') {
        assert.equal(g.steps.filter(s => s.parentStepId).length, 2)
        assert.ok(g.steps.filter(s => s.parentStepId).every(s => s.status === 'done'))
        name = 'legion_accept'; args = { projectId, goalId: 'goal', expectedVersion: g.goals.find(n => n.id === 'goal').version, evidenceIds: g.facts.filter(f => f.id !== 'origin').map(f => f.id) }
      }
      else if (g.project.status === 'completed' && last === 'legion_read_changes') { name = 'legion_finish'; args = { processed: { [projectId]: lastOutput(b).cursor }, state: 'Fixture accepted: Scout classification -> General -> two specialist Soldiers -> shared FGS -> Commander verified Goal.' } }
      else if (last === 'legion_read_changes' && g.project.status !== 'completed') { name = 'legion_wait'; args = { projectId, after: lastOutput(b).cursor } }
      else { name = 'legion_read_changes'; args = { projectId } }
    } else if (role === 'GENERAL') {
      if (calls.filter(c => c === 'legion_spawn').length < 2) { name = 'legion_spawn'; args = spawnMission('soldier', calls.includes('legion_spawn') ? 'specialist-b verify alternative evidence' : 'specialist-a verify primary evidence') }
      else if (!admittedText.includes('COMMANDER_TACTICAL_ACK')) {
        if (!calls.includes('legion_message')) {name='legion_message';args={receiver:'commander',type:'HELP',content:'General needs the tactical acceptance order for both specialist results.'}}
        else if(last==='read_graph_delta'){name='legion_wait';args={after:lastOutput(b).cursor}}
        else {name='read_graph_delta';args={}}
      }
      else if (!g.steps.filter(s => s.parentStepId).every(s => s.status === 'done')) {
        if (last === 'read_graph_delta') { name = 'legion_wait'; args = { after: lastOutput(b).cursor } }
        else { name = 'read_graph_delta'; args = {} }
      } else if (!calls.includes('submit_fact')) { name = 'submit_fact'; args = { title: 'General verified', description: 'General verified both specialist Facts in shared FGS', evidence: [{ description: 'Two completed specialist Steps with confirmed fixture Facts' }] } }
      else if (!calls.includes('legion_message')) { name = 'legion_message'; args = { receiver: 'commander', type: 'REPORT', content: 'General verified both specialist results; ready for Commander acceptance.' } }
      else { name = 'finish_step'; args = { summary: 'General shared-FGS integration complete' } }
    } else {
      assert.ok(!names.includes('legion_spawn'), 'Scout/Soldier cannot delegate')
      if (!calls.includes('submit_fact')) { name = 'submit_fact'; args = { title: 'Fixture verified', description: role === 'SCOUT' ? 'Scout verified local fixture category: hard coordination' : 'Soldier verified its assigned local fixture evidence', evidence: [{ description: 'Deterministic authorized local protocol fixture; not live-target proof' }] } }
      else if (!calls.includes('legion_message')) { name = 'legion_message'; args = { receiver: 'commander', type: 'REPORT', content: role + ' completed its evidence-backed fixture mission.' } }
      else { name = 'finish_step'; args = { summary: role + ' fixture done' } }
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
    raw.workers = ['commander','general','soldier','scout'].map(role => ({ name: role, roles: [role], provider: 'fixture', model: 'fixture', reason: false, explore: false, bootstrap: false, max_running: role === 'soldier' ? 2 : 1 }))
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
  const graph=await call('/v2/projects',{mode:'general',title:'Legion native protocol fixture',origin:'Only authorized local deterministic fixture, no real target',goal:'Verify four-role collaboration',bootstrap:false}); projectId=graph.project.id
  const acceptedDeadline=Date.now()+45000
  while(Date.now()<acceptedDeadline){const board=await call('/v2/legion?projectId='+projectId);if(board.campaign.status==='stopped')throw Error(JSON.stringify(board.campaign));if(board.projects[0]?.status==='completed'&&board.campaign.status==='idle')break;await delay(20)}
  const result=(await call('/v2/legion?projectId='+projectId)).campaign
  assert.equal(result.status,'idle');assert.ok(result.state.includes('Fixture accepted'))
  const g=await call('/v2/projects/'+projectId), runs=await call('/v2/projects/'+projectId+'/runs')
  assert.equal(g.project.status,'completed');assert.equal(g.steps.length,4);assert.ok(g.steps.every(s=>s.status==='done'));assert.ok(runs.every(r=>r.status==='succeeded')); for (const run of runs) assert.equal(run.worker, g.steps.find(s=>s.id===run.stepId).role)
  assert.deepEqual([...roles].sort(),['COMMANDER','GENERAL','SCOUT','SOLDIER'])
  const resumed=await call('/v2/legion/command',{projectId,worker:'commander'});assert.equal(resumed.sessionId,result.sessionId);assert.equal(resumed.status,'idle');assert.equal((await call('/v2/projects/'+projectId)).steps.length,4)
  const usage=await call('/audit/usage');assert.ok(usage.commander>0,'Global Commander usage must come from actual native assistant messages');assert.ok(usage.total>=usage.commander)
  const logPage = await call('/v2/legion/session/events?projectId='+projectId+'&offset=0&limit=100')
  assert.equal(logPage.sessionId,result.sessionId);assert.equal(logPage.available,true);assert.ok(logPage.nextOffset<=100)
  assert.ok(logPage.events.some(event=>event.task_type==='commander'&&['tool.started','assistant.message','user.message'].includes(event.kind)))
  const repeated=await call('/v2/legion/session/events?projectId='+projectId+'&offset=0&limit=100');assert.deepEqual(repeated.events.map(e=>e.timestamp),logPage.events.map(e=>e.timestamp),'Historical Commander timestamps must not change when reread');assert.ok(logPage.events.some(e=>e.kind==='system.prompt'),'Current native system/message must be visible')
  const nextPage=await call('/v2/legion/session/events?projectId='+projectId+'&offset='+logPage.nextOffset+'&limit=100');assert.ok(nextPage.nextOffset>=logPage.nextOffset)
  assert.equal((await fetch(api+'/v2/legion/session/events?projectId='+projectId+'&limit=0')).status,422)
  if(process.argv[4]==='--hold') { console.log('UI_READY '+JSON.stringify({api,work,projectId,commanderSessionId:result.sessionId}));await new Promise(resolve=>process.once('SIGTERM',resolve)) }
  child.kill('SIGTERM'); await closed
  const { Store }=await import(pathToFileURL(root+'/packages/redtrace-engine/src/store.ts'));const store=new Store(work+'/.redtrace/engine.db')
  try {
    const messages=store.db.prepare('SELECT data FROM legion_messages').all().map(row=>JSON.parse(row.data))
    assert.ok(messages.length>=4);assert.ok(messages.some(m=>m.status==='admitted'),'real native inbox admission was not recorded'); assert.ok(messages.some(m=>m.type==='HELP'&&m.status==='admitted')); assert.ok(messages.some(m=>m.content.includes('COMMANDER_TACTICAL_ACK')&&m.status==='admitted'))
    assert.equal(store.run(runs[0].id).pendingTools.length,0)
    const campaign=JSON.parse(store.db.prepare('SELECT data FROM project_campaigns WHERE project_id=?').get(projectId).data)
    assert.ok(campaign.cursors[projectId].acknowledged>0)
    console.log('LEGION_RUNTIME_SUPPORTED=true; roles=Commander,Scout,General,Soldier; specialist_workers=2; shared_fgs=true; commander_acceptance=true; native_message_admission=true; state_and_cursor_persisted=true; commander_native_resume=true; help_reply_admitted=true; model=local-protocol-fixture; commander_native_log_read=true')
  } finally { store.close() }
} catch (error) {
  if (existsSync(work+'/.redtrace/engine.db')) { const { DatabaseSync }=await import('node:sqlite'); const db=new DatabaseSync(work+'/.redtrace/engine.db',{readOnly:true});try { console.error(db.prepare("SELECT data FROM project_campaigns").all()) } finally {db.close()} }
  console.error(logs); throw error }
finally { if(child&&!ended){child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve))}for(const res of pending)res.destroy();await new Promise(resolve=>model.close(resolve));rmSync(work,{recursive:true,force:true}) }
