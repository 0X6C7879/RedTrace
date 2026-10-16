import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { activityPrompt, graphTools } from '../src/runner.ts'
import { Store } from '../src/store.ts'
import type { EngineConfig, Worker, Step } from '../src/types.ts'

test('Reason receives the requested FGS planning role', () => {
  const prompt = activityPrompt('decide')
  assert.match(prompt, /^你是任务的规划者\(Reason\)/)
  assert.match(prompt, /不得在没有依据时限制 Step 的行动及方法选择/)
  for (const rule of [
    /每次新会话先读取当前 FGS/, /read_graph_delta.*不重复全图读取/, /Hint、Observation 和推测.*不能直接作为确认事实/,
    /逐项核对数量、权限、范围/, /引用真实 evidenceIds/, /Step 结束.*不代表 Goal 达成/,
    /依赖未取得的能力或权限时等待，不提前派发后续行动/, /planningCapacity.*Worker 和并发限制/,
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
    /唯一任务是完成当前 Step/, /复用Fact、扫描结果、凭证及已验证通道/,
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

test('shared efficiency rules avoid full graph reads and conflicting benchmark work', () => {
  const reason = activityPrompt('decide'), explore = activityPrompt('execute')
  assert.match(reason, /不用保持最大 Step 数/)
  assert.match(reason, /同一题目也可以分给多个 Step 协作完成/)
  assert.match(reason, /如果难以分出边界依旧采用单Worker执行/)
  assert.match(reason, /平台活跃容器上限为 3/)
  assert.doesNotMatch(reason, /尽量保持最大 Step 数/)
  assert.match(explore, /只读取当前 Step 的引用证据，不默认读取全图和完整题库/)
  assert.match(explore, /持续受阻时重新评估假设/)
  assert.match(explore, /每次只处理一道题目/)
  assert.match(explore, /题目未解决时默认保留容器/)
})


test('shared challenge cleanup follows completion, Reason switching and timeout boundaries', () => {
  const reason = activityPrompt('decide'), explore = activityPrompt('execute')
  assert.match(reason, /同题多 Step 协作不指定固定的容器负责人/)
  assert.match(reason, /先停止或调整旧题相关 Step/)
  assert.match(reason, /由执行新题的 Explore 先关闭旧题、确认槽位释放，再启动新题，无须另建专门的清理 Step/)
  assert.match(explore, /同一道题允许多个 Step 协作。复用已启动的实例和已验证地址，避免重复启动/)
  assert.match(explore, /不因自身 Step 完成、失败、放弃或超时而自行关闭/)
  assert.match(explore, /Reason 在当前 Step 中明确要求关闭旧题.*先关闭指定旧题、确认槽位释放，再启动新题/)
  assert.doesNotMatch(explore, /结束当前题目并关闭其实例后，再开始下一题/)
  const host = readFileSync(new URL('../compat/cordis.mjs', import.meta.url), 'utf8')
  assert.ok(host.includes('已进入超时收尾，必须调用 submit_fact 提交至少一条已有证据支持的汇总结论，再调用 finish_step。题目未解决时保留容器；没有成功成果时如实提交已验证的失败、限制或阻塞，禁止伪造事实。'))
  assert.doesNotMatch(host, /Execution timed out; only summarize and submit existing evidence/)
  assert.doesNotMatch(explore, /收到收尾指令时，停止新的外部操作/)
  const skill = readFileSync(new URL('../../../skills/tsecbench-api/SKILL.md', import.meta.url), 'utf8')
  assert.equal(skill, readFileSync(new URL('../../../.redtrace/skills/tsecbench-api/SKILL.md', import.meta.url), 'utf8'))
  assert.match(skill, /题目完成后 `close`.*检查 `closed` 或复核实例已停止/)
  assert.doesNotMatch(skill, /当前题完成、失败、放弃、超时或任务结束时都调用|一个 Worker 只管理自己当前认领的 Challenge 生命周期|即使 Exploit\/Agent 抛错，也要尽最大努力执行关闭/)
})


test('compact benchmark Skill retains tool routes, scoring, lifecycle and business errors', () => {
  const skill = readFileSync(new URL('../../../skills/tsecbench-api/SKILL.md', import.meta.url), 'utf8')
  assert.ok(Buffer.byteLength(skill, 'utf8') < 6000)
  for (const command of ['config', 'vpn', 'list', 'start', 'submit', 'hint', 'close']) assert.ok(skill.includes('`' + command) || skill.includes('tsecbench_' + command))
  for (const field of ['BENCHMARK_TOKEN', 'BENCHMARK_BASE_URL', 'confirm_score_penalty=true', 'correct_flag_count/total_flag_count', 'cumulative_score', 'is_completed', 'container_addr[]', 'closed']) assert.ok(skill.includes(field), field)
  for (const code of ['task_not_found', 'challenge_not_found', 'invalid_state', 'duplicate', 'resource_unavailable', 'internal_error', '422']) assert.ok(skill.includes(code), code)
  assert.match(skill, /http:\/\/10\.0\.100\.58.*status=ok/)
  assert.match(skill, /Reason 不启动\/关闭实例、不提交 flag、不发布 Fact/)
  assert.match(skill, /任务已结束才停止整轮，不能将所有 409 都当超时/)
  assert.match(skill, /题目未解决默认保留容器/)
  assert.match(skill, /由执行新题的 Explore 先关闭、确认槽位释放，再启动新题，不另建专门清理 Step/)
})


test('Reason and Explore match the requested replacement byte for byte', () => {
  const hash = (text: string) => createHash('sha256').update(text).digest('hex')
  assert.equal(hash(activityPrompt('decide')), 'da90e59beafbe339b1a5d854b72afd6e8291ec25a77ca4c48c5b36d23fe67cdd')
  assert.equal(hash(activityPrompt('execute')), '33bb80e53f554c8322c3a8a913661294efdf05b927a82a36c49dbf7593be36af')
})
