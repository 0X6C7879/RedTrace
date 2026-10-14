import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityPrompt, graphTools } from '../src/runner.ts'
import { Store } from '../src/store.ts'
import type { EngineConfig, Worker, Step } from '../src/types.ts'

test('Reason keeps planning, evidence maintenance and completion contracts', () => {
  const prompt = activityPrompt('decide')
  assert.match(prompt, /^你是 Reason/)
  for (const rule of [
    /Scope.*授权/, /本次触发.*活跃 Step.*连续增量/, /Fact\/Finding evidenceIds/, /不等于达成/,
    /有突破优先深入/, /前置已满足/, /同一题默认一个主 Explore/, /不同题目/,
    /单次失败不等于证伪/, /中断.*确认进度/, /副作用不明.*不重放/,
    /sourceIds.*goalId/, /工具由 Explore 自主选择/, /Subgoal.*可验收.*复用/,
    /remote\.command/, /update_step\/update_goal.*版本/, /amend.*replace/,
    /FGS 是当前工作状态/, /manage_evidence.*合并.*删除/, /不留备份、不可恢复，无需检查历史/, /修复活跃引用/,
    /新 Fact\/Finding.*关键事件.*不等 Step 结束/, /planningCapacity.*满额.*add_step.*Worker.*限制/,
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

test('directed guidance changes preserve the Bootstrap body byte for byte', () => {
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
 assert.match(activityPrompt('decide'),/notify_explore.*不微观管理或重复通知/)
 assert.match(activityPrompt('execute'),/Reason 通知.*不代表契约变更/)
 const store=new Store(':memory:')
 try {
  const step=store.createProject({title:'Hash',origin:'Local fixture',goal:'Check',bootstrap:true}).steps[0]
  assert.equal(hash(activityPrompt('execute',step)),'808deb593c8f62f00c5e20149dc2a4f81628967c533433e07b598e74b5d02431')
 } finally {store.close()}
})


test('Explore consolidates decision events without delaying handoffs or losing evidence', () => {
  const prompt = activityPrompt('execute')
  for (const rule of [
    /submit_fact 是唤醒 Reason 的决策事件，不是执行日志/,
    /同 Step、同目标同环境.*多个观察合并为一条/,
    /彼此独立.*不同后续行动.*拆分/,
    /不按固定数量或时间攒 Fact/,
    /容器已启动.*单个指纹.*一次失败.*不单独 submit_fact/,
    /原始输出.*持续保存到本地证据文件/,
    /资源\/通道仍及时登记/,
    /授权目标变化或不一致先停下核对/,
    /目标成果.*其他 Step.*关键前置.*实证阻塞立即提交/,
    /不为凑更多观察延迟交接/,
    /提交 Fact 不代表 Step 结束/,
    /预算\/超时收尾.*合并提交/,
    /阶段结论.*不能为少报 Fact 让规划停摆/,
    /每个 Step 完成前必须主动 submit_fact 至少一条有真实证据/,
    /Step 已完成或阻塞无法自行解除.*submit_fact.*至少一条.*finish_step/,
    /纯文本总结.*不算完成/,
    /直接调用原生工具 submit_fact、finish_step/,
  ]) assert.match(prompt, rule)
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 8000)
})

test('Reason treats events as checks, acknowledges increments and avoids idle planning', () => {
  const prompt = activityPrompt('decide')
  for (const rule of [
    /只按需展开.*证据.*不必全量重读或重新规划/,
    /事件是检查信号，不是增派任务的义务/,
    /未改变目标验收、可执行前置或计划.*不新增 Step、不重复通知/,
    /处理连续增量后尽快 finish_decide/,
    /没有 pending\/running 工作.*前置已满足.*可验证方向/,
    /无可执行方向.*具体阻塞.*不虚构任务/,
    /throughEvidenceSeq.*完整读取并处理.*连续边界/,
  ]) assert.match(prompt, rule)
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 8000)
})


test('ordinary Explore must explicitly submit a Fact before structured completion', async () => {
  const store = new Store(':memory:')
  const worker: Worker = { name: 'explore', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }
  const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 1, maxProjectWorkers: 1, maxRunningProjects: 1, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: process.cwd() }
  try {
    const id = store.createProject({ title: 'Completion gate', origin: 'Local fixture', goal: 'Verified result' }).project.id
    const step = store.addStep(id, { description: 'Verify fixture completion', sourceIds: ['origin'] })
    const run = store.claim(id, 'execute', worker, step.id)
    let completed = false
    const tools = graphTools({ store, run, worker, config, signal: new AbortController().signal }, () => { completed = true })
    const finish = tools.find(tool => tool.name === 'finish_step')!
    await assert.rejects(finish.execute('empty', { summary: 'Plain text is not evidence' }), /Explore must submit at least one Fact/)
    assert.equal(completed, false)
    assert.equal(store.node<Step>(id, step.id, 'step').factIds.length, 0)
    await tools.find(tool => tool.name === 'submit_fact')!.execute('fact', { description: 'Fixture verified the completion boundary', evidence: [{ description: 'Local assertion passed' }] })
    await finish.execute('finish', { summary: 'Structured result saved' })
    assert.equal(completed, true)
    assert.equal(store.finishRun(run.id, 'succeeded').status, 'succeeded')
    const bypass = store.addStep(id, { description: 'Empty completion attempt', sourceIds: ['origin'] })
    const empty = store.claim(id, 'execute', worker, bypass.id)
    const ended = store.finishRun(empty.id, 'succeeded')
    assert.equal(ended.status, 'failed')
    assert.match(ended.error!, /Explore must return at least one Fact/)
    assert.equal(store.node<Step>(id, bypass.id, 'step').status, 'blocked')
    assert.equal(store.node<Step>(id, bypass.id, 'step').factIds.length, 0)
  } finally { store.close() }
})
