import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import test from 'node:test'
import assert from 'node:assert/strict'

const source = readFileSync(new URL('../../../static/audit.js', import.meta.url), 'utf8')
const context = vm.createContext({ TextDecoder, Uint8Array })
vm.runInContext(`${source}\nglobalThis.createAuditPage = auditPage`, context)
const page = (context as typeof context & { createAuditPage: () => any }).createAuditPage()

test('audit timeline shows paired tool names, full commands, and result text', () => {
  const started = { kind: 'tool.started', title: 'glob', call_id: 'g1', run_id: 'r1', arguments: '{"pattern":"**/*"}' }
  const completed = { kind: 'tool.completed', call_id: 'g1', run_id: 'r1', content: 'src/index.ts' }
  page.events = [started, completed]
  assert.equal(page.eventAction(completed), 'glob')
  assert.equal(page.eventPayload(completed), 'src/index.ts')

  const shell = { kind: 'tool.started', title: 'bash', call_id: 's1', run_id: 'r1', arguments: '{"command":"git status --short"}' }
  const shellResult = { kind: 'tool.completed', call_id: 's1', run_id: 'r1', content: ' M static/audit.js' }
  page.events = [shell, shellResult]
  assert.equal(page.eventCommand(shellResult), 'git status --short')
  assert.equal(page.eventPayload(shellResult), ' M static/audit.js')
})

test('completed tool without text output renders an explicit placeholder', () => {
  assert.match(page.eventPayload({ kind: 'tool.completed' }), /未返回可显示的文本输出/)
})
