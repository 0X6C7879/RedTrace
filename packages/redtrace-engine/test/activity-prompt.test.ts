import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityPrompt } from '../src/runner.ts'
import { Store } from '../src/store.ts'

test('Reason keeps planning, evidence maintenance and completion contracts', () => {
  const prompt = activityPrompt('decide')
  assert.match(prompt, /^你是 Reason/)
  for (const rule of [
    /Scope.*授权/, /活跃状态.*连续增量/, /Fact\/Finding evidenceIds/, /不等于达成/,
    /有突破优先深入/, /前置已满足/, /同一题默认一个主 Explore/, /不同题目/,
    /单次失败不等于证伪/, /中断.*确认进度/, /副作用不明.*不重放/,
    /sourceIds.*goalId/, /requires\/plugins/, /Subgoal.*可验收.*复用/,
    /remote\.command/, /update_step\/update_goal.*版本/, /amend.*replace/,
    /manage_evidence.*合并.*归档.*恢复/, /修复活跃引用/,
    /新 Fact\/Finding.*关键事件.*不等 Step 结束/, /Worker.*add_step.*限制/,
    /只读工具.*扣分提示.*确认/, /finish_decide.*throughEvidenceSeq.*完整读取并处理.*连续边界/,
  ]) assert.match(prompt, rule)
})

test('Explore keeps resources and safe execution while adding local autonomy', () => {
  const prompt = activityPrompt('execute')
  assert.match(prompt, /^你是 Explore/)
  for (const rule of [
    /Scope.*授权/, /当前 Step.*goalId/, /Skills.*执行工具.*任务插件/,
    /不把每次尝试拆成新 Step/, /一次失败不代表方向无效/, /实质不同的方法/,
    /副作用不明.*不重放/, /权限边界.*Reason/, /Step 外线索.*不自行扩展/,
    /Scope、Fact、Hint.*凭证.*即使尚无通道/, /通道验证后登记.*匹配通道/,
    /submit_fact.*真实证据.*增量/, /成功、失败和限制.*确认事实/,
    /Hint、Observation.*不是事实/, /submit_finding.*引用 Fact/,
    /read_graph\/read_graph_delta.*sync_step.*当前版本/, /旧调用树不得继续外部操作/,
    /验证码.*授权题目.*局部截图.*当前模型/, /不依赖人工接管或承诺通用通过/,
    /finish_step.*不代表 Goal\/Subgoal 达成/,
  ]) assert.match(prompt, rule)
})

test('Bootstrap is opt-in, solves directly and keeps its confirmed Fact gate', () => {
  const store = new Store(':memory:')
  try {
    const input = { title: 'Prompt fixture', origin: 'Authorized local fixture', goal: 'Verified result' }
    const direct = store.createProject(input)
    assert.equal(direct.project.bootstrap, false)
    assert.equal(direct.steps.length, 0)
    const explicit = store.createProject({ ...input, bootstrap: true })
    const prompt = activityPrompt('execute', explicit.steps[0])
    assert.match(prompt, /^你是 Bootstrap.*显式启用.*Scope、Goal 和 Hints.*直接解题/)
    assert.match(prompt, /得到一条 Fact 不是停止理由/)
    assert.match(prompt, /真实 Fact.*finish_step.*成功且返回 Fact 后 Reason 才会启动/s)
    assert.match(prompt, /不伪造 Fact.*宣称已交接/)
    assert.doesNotMatch(activityPrompt('decide'), /必须.*Bootstrap|等待 Bootstrap/)
  } finally { store.close() }
})

test('Jev remains independently gated for both execution roles and absent in Reason', () => {
  const store = new Store(':memory:')
  try {
    const step = store.createProject({ title: 'Jev fixture', origin: 'Local fixture', goal: 'Verified result', bootstrap: true }).steps[0]
    for (const choice of [false, true]) for (const readiness of [false, true]) {
      assert.doesNotMatch(activityPrompt('decide', undefined, choice, readiness), /jev_choose|jev_assess_attack/)
      for (const current of [undefined, step]) {
        const prompt = activityPrompt('execute', current, choice, readiness)
        assert.equal(prompt.includes('jev_choose'), choice)
        assert.equal(prompt.includes('jev_assess_attack'), readiness)
        assert.equal(prompt.includes('Jev 只给建议'), choice || readiness)
      }
    }
  } finally { store.close() }
})
