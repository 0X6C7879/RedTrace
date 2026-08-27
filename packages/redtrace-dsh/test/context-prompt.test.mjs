import assert from 'node:assert/strict'
import test from 'node:test'

import { graphDeltaMessage, hintMessage, taskPrompt } from '../lib/context.js'

const project = {
  project: { id: 'p1', title: '演示项目', bootstrap_enabled: true, status: 'active' },
  blackboard_revision: 7,
  facts: [
    { id: 'origin', description: '某 CTF 比赛环境入口' },
    { id: 'goal', description: '拿到最终 flag' },
    { id: 'f001', description: '发现 /admin 登录页' },
    { id: 'f002', description: 'SQL 注入点已确认' },
  ],
  intents: [
    { id: 'i001', from: ['origin'], description: 'bootstrap', creator: 'dispatcher.bootstrap', state: 'concluded', to: 'f001', created_at: '2026-01-01T00:00:00Z' },
    { id: 'i002', from: ['f001'], description: '测试后台弱口令', creator: 'reason', state: 'open', created_at: '2026-01-01T00:00:00Z' },
    { id: 'i003', from: ['f002'], description: '已放弃的方向', creator: 'reason', state: 'dropped', created_at: '2026-01-01T00:00:00Z' },
  ],
  hints: [{ id: 'h001', content: '优先检查 /admin,不要继续进行子域名枚举。', creator: 'human', created_at: '2026-01-01T00:00:00Z' }],
}

const resources = [
  { id: 'r001', kind: 'credential', name: '后台账号', target: 'admin:admin', summary: '有效凭据', status: 'ready' },
]

const task = type => ({ type, projectId: 'p1', worker: 'w1', committed: false })

test('reason launch prompt carries the full graph exactly once', () => {
  const prompt = taskPrompt(task('reason'), project)
  assert.match(prompt, /## Origin\n某 CTF 比赛环境入口/)
  assert.ok(!prompt.includes('本 session 只对下方 Current Intent 负责'))
  assert.match(prompt, /## Goal\n拿到最终 flag/)
  assert.match(prompt, /## Facts\n- \[f001\] 发现 \/admin 登录页\n- \[f002\] SQL 注入点已确认/)
  assert.match(prompt, /## Intents\(最多创建 4 个活跃 Intent\)/)
  assert.match(prompt, /\[i002\] open: 测试后台弱口令\(from: \[f001\]\)/)
  assert.match(prompt, /\[i001\] concluded: bootstrap\(from: \[origin\] → f001\)/)
  assert.match(prompt, /## Hints\n- \[h001\] 优先检查 \/admin/)
  // every intent state stays visible — reason reads the unfiltered graph; no resources for reason
  assert.match(prompt, /\[i003\] dropped: 已放弃的方向\(from: \[f002\]\)/)
  assert.ok(!prompt.includes('Resources'))
})

test('reason maxIntents override reaches the prompt', () => {
  const prompt = taskPrompt({ ...task('reason'), maxIntents: 2 }, project)
  assert.match(prompt, /最多创建 2 个活跃 Intent/)
})

test('reason continuation prompt carries only ordered graph changes', () => {
  const prompt = graphDeltaMessage(task('reason'), '演示项目', 7, 10, [
    { revision: 8, kind: 'fact', node_id: 'f003', action: 'added', node: { id: 'f003', description: '拿到后台凭据' } },
    { revision: 9, kind: 'intent', node_id: 'i002', action: 'claimed', node: { ...project.intents[1], worker: 'explorer', state: 'working' } },
    { revision: 10, kind: 'hint', node_id: 'h002', action: 'added', node: { id: 'h002', content: '检查导出接口' } },
  ])
  assert.match(prompt, /Graph Delta\(项目「演示项目」,修订版本 7 → 10\)/)
  assert.match(prompt, /\[r8\] fact f003 added: 拿到后台凭据/)
  assert.match(prompt, /\[r9\] intent i002 claimed: working: 测试后台弱口令/)
  assert.match(prompt, /\[r10\] hint h002 added: 检查导出接口/)
  assert.ok(!prompt.includes('某 CTF 比赛环境入口'))
  assert.ok(!prompt.includes('SQL 注入点已确认'))
})

test('bootstrap launch prompt carries Origin/Goal/Hints only', () => {
  const prompt = taskPrompt(task('bootstrap'), project)
  assert.match(prompt, /## Origin\n某 CTF 比赛环境入口/)
  assert.ok(!prompt.includes('本 session 只对下方 Current Intent 负责'))
  assert.match(prompt, /## Goal\n拿到最终 flag/)
  assert.match(prompt, /## Hints\n- \[h001\] 优先检查 \/admin/)
  assert.ok(!prompt.includes('## Facts'))
  assert.ok(!prompt.includes('## Intents'))
  assert.ok(!prompt.includes('## Resources'))
  assert.ok(!prompt.includes('测试后台弱口令'))
})

test('explore launch prompt carries the Intent local context', () => {
  const intent = project.intents[1]
  const prompt = taskPrompt(task('explore'), project, intent, resources)
  assert.match(prompt, /## Origin\n某 CTF 比赛环境入口/)
  assert.match(prompt, /## Goal\n拿到最终 flag/)
  assert.match(prompt, /本 session 只对下方 Current Intent 负责/)
  assert.match(prompt, /## Source Facts\n- \[f001\] 发现 \/admin 登录页/)
  assert.match(prompt, /## Current Intent\n- \[i002\] open: 测试后台弱口令\(from: \[f001\]\)/)
  assert.match(prompt, /## Resources\n- \[credential\] 后台账号 \(admin:admin\) — 有效凭据 <id: r001>/)
  // lineage-foreign facts and other intents stay out
  assert.ok(!prompt.includes('SQL 注入点已确认'))
  assert.ok(!prompt.includes('bootstrap'))
})

test('explore launch prompt omits empty sections', () => {
  const intent = project.intents[1]
  const prompt = taskPrompt(task('explore'), project, intent, [])
  assert.ok(!prompt.includes('## Resources'))
})

test('runtime hint injection lists only the new hints', () => {
  const message = hintMessage([{ id: 'h002', content: '换一个方向。' }])
  assert.equal(message, 'RedTrace 新增 Hint:\n- [h002] 换一个方向。')
})
