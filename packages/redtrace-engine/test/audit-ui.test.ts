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

test('standalone PTC completions display code and terminal arguments without a start row', () => {
  page.events = []
  const code = { kind: 'tool.completed', title: 'run_code', call_id: 'code', arguments: { code: 'console.log("hello")' }, content: 'hello' }
  assert.equal(page.isCommand(code), true)
  assert.equal(page.eventCommand(code), code.arguments.code)
  assert.equal(page.eventPayload(code), 'hello')
  const terminal = { kind: 'tool.completed', title: 'terminal_send', arguments: { sessionId: 't1', text: 'pwd' }, content: '/workspace' }
  assert.equal(page.isCommand(terminal), true)
  assert.equal(page.eventCommand(terminal), 'pwd')
  assert.equal(page.eventCommand({ ...terminal, title: 'terminal_read', arguments: { sessionId: 't1' } }), 'terminal_read t1')
  assert.match(page.eventPayload({ ...code, content: '' }), /未返回可显示的文本输出/)
})

test('legacy output envelopes unwrap but ordinary JSON and Skill presentation stay intact', () => {
  const shell = { kind: 'tool.completed', title: 'shell_read', content: '{"output":"hello","running":true}' }
  assert.equal(page.eventPayload(shell), 'hello')
  const envelope = { evidenceId: `ev-${'a'.repeat(64)}`, preview: 'large output', read: 'evidence_read({id})' }
  assert.equal(page.eventPayload({ kind: 'tool.completed', content: JSON.stringify(envelope) }), 'large output')
  const business = { kind: 'tool.completed', title: 'read_graph', content: '{"output":"a graph field"}' }
  assert.equal(page.eventPayload(business), business.content)
  const skill = { kind: 'tool.completed', title: 'skill', arguments: { name: 'ctf-web' }, content: 'private skill body' }
  assert.equal(page.isSkill(skill), true)
  assert.equal(page.isTool(skill), false)
  assert.equal(page.displaySkillName(skill), 'ctf-web')
})

test('native file metadata appears in the existing tool payload', () => {
  const event = { kind: 'tool.completed', title: 'edit', content: 'File edited', meta: { diffs: [{ path: 'file.txt', oldText: 'before', newText: 'after' }] } }
  assert.equal(page.eventPayload(event), 'File edited\n\nfile.txt\n- before\n+ after')
  assert.equal(page.eventPayload({ ...event, meta: { diffs: [null] } }), 'File edited')
})
