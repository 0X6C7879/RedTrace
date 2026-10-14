import { createHash } from 'node:crypto'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityPrompt, graphTools } from '../src/runner.ts'
import { Store } from '../src/store.ts'
import type { EngineConfig, Worker, Step } from '../src/types.ts'

test('Reason receives the requested FGS planning role', () => {
  const prompt = activityPrompt('decide')
  assert.match(prompt, /^你是任务的规划者\(Reason\)/)
  for (const rule of [
    /每次新会话先读取当前 FGS/, /read_graph_delta.*不重复全图读取/, /Hint、Observation 和推测.*不能直接作为确认事实/,
    /逐项核对数量、权限、范围/, /引用真实 evidenceIds/, /Step 结束.*不代表 Goal 达成/,
    /只创建前置已满足、尚未覆盖且能够验证结果的 Step/, /planningCapacity.*Worker 和并发限制/,
    /单次失败不能否定整条路线/, /sourceIds.*goalId/, /notify_explore 定向补充/,
    /带版本的 update_step\/update_goal/, /amend.*replace/, /FGS 保存当前有效状态/,
    /manage_evidence.*合并/, /throughEvidenceSeq、throughHintSeq.*acknowledgementBoundary/,
  ]) assert.match(prompt, rule)
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 8000)
})

test('Explore receives the requested evidence-led execution role', () => {
  const prompt = activityPrompt('execute')
  assert.match(prompt, /^你是执行者\(Explore\)/)
  for (const rule of [
    /唯一任务是完成当前 Step/, /复用共享 Fact、扫描结果、凭证及已验证通道/,
    /单次失败、无回显或工具报错不能证明路线无效/, /保存到工作目录的证据文件/,
    /submit_fact 是唤醒 Reason 的决策事件/, /不单独提交 Fact/, /先提交对应 Fact，再用 submit_finding/,
    /离线知识仅用于辅助判断/, /只有 Step 契约版本变化时.*sync_step/,
    /至少一条有真实证据的汇总 Fact，再调用 finish_step/, /不依赖人工接管/,
  ]) assert.match(prompt, rule)
  assert.ok(Buffer.byteLength(prompt, 'utf8') <= 8000)
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

test('new role prompts preserve the Bootstrap body byte for byte', () => {
 const hash=(text:string)=>createHash('sha256').update(text).digest('hex')
 assert.match(activityPrompt('decide'),/人工 Hint.*notify_explore 定向补充/)
 assert.match(activityPrompt('execute'),/notify_explore 只是增量信息.*sync_step/)
 const store=new Store(':memory:')
 try {
  const step=store.createProject({title:'Hash',origin:'Local fixture',goal:'Check',bootstrap:true}).steps[0]
  assert.equal(hash(activityPrompt('execute',step)),'808deb593c8f62f00c5e20149dc2a4f81628967c533433e07b598e74b5d02431')
 } finally {store.close()}
})


test('Explore reports only actionable, verified facts', () => {
  const prompt = activityPrompt('execute')
  for (const rule of [
    /足以影响目标验收、执行前置或后续计划的新结论/,
    /同一 Step、同一目标和环境的多个观察合并为一条阶段 Fact/,
    /结论相互独立且需要不同后续行动时才拆分/,
    /容器启动、目标地址返回.*不单独提交 Fact/,
    /已验证的目标成果.*应立即提交/, /提交 Fact 后.*仍有有效路径.*继续执行/,
    /漏洞或其他可交付成果必须有可复现的实际证据/,
    /验证码等人机验证.*OCR识别.*不依赖人工接管/,
  ]) assert.match(prompt, rule)
})

test('Reason only replans when new information changes the plan', () => {
  const prompt = activityPrompt('decide')
  for (const rule of [
    /每次唤醒只判断新信息是否改变目标验收、可执行前置或现有计划/,
    /没有实质变化时允许不做修改，继续等待 Explore/,
    /处理完已交付的连续证据和 Hint 后调用 finish_decide/,
    /未处理部分留待下一轮/,
  ]) assert.match(prompt, rule)
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
