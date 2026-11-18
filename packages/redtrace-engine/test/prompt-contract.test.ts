import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync, readdirSync} from 'node:fs'
import {legionMission, reportWorkflowPrompt} from '../src/legion-missions.ts'
import {domainTools} from '../../redtrace-dsh/src/tool-domains.ts'
import {frontmatter} from '../src/capabilities.ts'

for (const role of ['general','soldier'] as const) test(`${role}: localized Benchmark evidence and recovery contract`, () => {
  const text = legionMission(role, 'benchmark')
  for (const rule of [/FGS 独占/, /只增不减/, /不删除\/合并 Fact\/Finding/, /旧错不作前提/, /nextOffset=null/, /不重读已知历史/, /80%/, /不手动压缩/, /不重放未知动作/, /不可信/, /Project cwd\/隔离/, /平台\/评分设施/]) assert.match(text, rule)
  for (const rule of [/完整持久 TodoList/, /planningTodos/, /首次执行前/, /每真实阶段一项/, /acceptance\/stepIds\/factIds/, /留存 Fact 实际满足验收/, /并发执行，非终身尝试/, /Running\/预留 Paused\/Unknown/, /完成释槽/, /dependsOn=已有前置 Step ID/, /独立方向并发/]) assert.match(text, rule)
})

test('General-mode planning, pure Executors and report-only delivery stay distinct', () => {
  const general = legionMission('general','general')
  for (const rule of [/唯一 Planner/, /不执行任务/, /不另建 Planner\/编队/, /800 ms/, /15 秒本地 watchdog/, /不等 Worker\/不重放未知动作/, /legion_finish/, /原 Worker\/Session/, /不自动触发报告/]) assert.match(general, rule)
  for (const mode of ['benchmark','general'] as const) {
    const executor = legionMission('soldier',mode,false)
    for (const rule of [/Step Executor/, /taskPlanner.receiver/, /不用 legion_inspect \(action=roster\)/, /仅指定 Planner 维护 Todo\/验收/, /不委派\/全局调度/, /job_output\(wait:true\)/]) assert.match(executor, rule)
    assert.doesNotMatch(executor, /action=write|action=accept/)
  }
  for (const rule of [/不是 Reporter 角色/, /不重新探测/, /run_id\+event_id/, /expectedVersion/, /report-only Step 保存后结束/, /原 Worker 继续其他任务/, /## 摘要/, /## 内容/]) assert.match(reportWorkflowPrompt, rule)
})

test('domain descriptions do not restate required fields; action schemas enforce them', async () => {
  const called:unknown[] = []
  const tools = domainTools([{name:'legion_step',description:'单项',parameters:{type:'object',properties:{description:{type:'string'}},required:['description']},execute:(args:unknown)=>{called.push(args)}}])
  assert.equal(tools.length,1)
  assert.deepEqual(tools[0].parameters.required,['action','description'])
  assert.doesNotMatch(tools[0].description,/step\(description\)/)
  assert.throws(()=>tools[0].execute({action:'step'}),/Invalid arguments/)
  tools[0].execute({action:'step',description:'literal target output'})
  assert.deepEqual(called,[{description:'literal target output'}])
})

test('enabled Skill catalog descriptions are Chinese; local workflow examples use the current FGS contract', () => {
  const root = new URL('../../../skills/',import.meta.url)
  for (const entry of readdirSync(root,{withFileTypes:true}).filter(e=>e.isDirectory()&&!e.name.startsWith('.'))) {
    const text = readFileSync(new URL(entry.name+'/SKILL.md',root),'utf8')
    assert.match(frontmatter(text).description,/[\u4e00-\u9fff]/,entry.name)
    assert.doesNotMatch(text,/仅 General 可通过 legion_task \(action=spawn\)|没有既有证据分类的题目保持未分配|Goal 是否达成由 Commander/,entry.name)
    assert.doesNotMatch(text,/fgs_publish\(\{action:"fact",description|fgs_publish\(\{action:"finding",title,description/,entry.name)
  }
})
