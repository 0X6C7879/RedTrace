import {readFileSync}from'node:fs'
import test from'node:test'
import assert from'node:assert/strict'
import{legionMission}from'../src/legion-missions.ts'
import{activityPrompt,graphTools}from'../src/runner.ts'
import{Store}from'../src/store.ts'
import type{EngineConfig,Step}from'../src/types.ts'
for(const role of ['commander','general','soldier','scout'] as const)test(role+' loads its native Mission and shared evidence/isolation doctrine',()=>{const prompt=legionMission(role);assert.match(prompt,new RegExp('You are '+role.toUpperCase()));for(const rule of [/FGS is the only/,/untrusted data/,/HELP\/REPORT.*never Facts/,/Step completion does not prove Goal/,/never replay an unknown action/])assert.match(prompt,rule)})
test('Commander owns classification, evidence-based escalation, instance lifecycle, acceptance and Family Transfer',()=>{const p=legionMission('commander');for(const rule of [/NEVER run recon/,/WAIT until the Scout Step is done/,/legion_classify/,/at most two/,/legion_accept/,/evidence stagnation, not total runtime/,/last 20 minutes/i,/target-task Fact re-verification/])assert.match(p,rule)})
test('Soldier initial Mission is not a separate role or planner',()=>{const p=activityPrompt('execute',{role:'soldier',bootstrap:true} as Step,'general');assert.match(p,/You are SOLDIER/);assert.match(p,/Commander owns planning and acceptance/);assert.doesNotMatch(p,/You are BOOTSTRAP|You are REASON/)})
test('every Worker must explicitly publish confirmed evidence before structured completion',async()=>{const store=new Store(':memory:');try{const p=store.createProject({title:'fixture',origin:'local',goal:'verify'}).project;const worker={name:'soldier',backend:'mock' as const,provider:'mock',model:'mock',enabled:true,maxRunning:1,priority:0};const step=store.addStep(p.id,{description:'work',sourceIds:['origin']}),run=store.claim(p.id,'execute',worker,step.id),tools=graphTools({store,run,worker,config:{workspaceRoot:'/tmp',maxSteps:null} as EngineConfig,signal:new AbortController().signal},()=>{});await assert.rejects(tools.find(t=>t.name==='finish_step')!.execute('empty',{summary:'no Fact'}),/at least one Fact/);assert.equal(store.finishRun(run.id,'succeeded').status,'failed');assert.throws(()=>store.claim(p.id,'decide',worker),/replaced by Commander/)}finally{store.close()}})
test('compact benchmark Skill retains tool routes, scoring, lifecycle and business errors', () => {
  const skill = readFileSync(new URL('../../../skills/tsecbench-api/SKILL.md', import.meta.url), 'utf8')
  assert.ok(Buffer.byteLength(skill, 'utf8') < 6000)
  for (const command of ['config', 'vpn', 'list', 'submit']) assert.ok(skill.includes('`' + command) || skill.includes('tsecbench_' + command))
  for (const field of ['BENCHMARK_TOKEN', 'BENCHMARK_BASE_URL', 'confirmScorePenalty=true', 'correct_flag_count/total_flag_count', 'cumulative_score', 'is_completed', 'container_addr[]', 'closed']) assert.ok(skill.includes(field), field)
  for (const code of ['task_not_found', 'challenge_not_found', 'invalid_state', 'duplicate', 'resource_unavailable', 'internal_error', '422']) assert.ok(skill.includes(code), code)
  assert.match(skill, /http:\/\/10\.0\.100\.58.*status=ok/)
  assert.match(skill, /Commander 不提交 flag、不执行侦察或利用、不发布 Fact/)
  assert.match(skill, /任务已结束才停止整轮，不能将所有 409 都当超时/)
  assert.match(skill, /未解决题默认保留实例/)
  assert.match(skill, /不得让新题 Worker 代管旧题清理，不添加专门清理 Agent/)
})
