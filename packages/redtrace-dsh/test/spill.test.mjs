import test from 'node:test'
import assert from 'node:assert/strict'
import { compactToolText } from '../lib/spill.js'

test('only exact adjacent lines fold; counts, CRLF and unique attack clues remain', () => {
  const line='unchanged progress indicator: completed 42 of 100\r\n'
  const clue='HTTP/1.1 403\nSet-Cookie: secret=fixture\nPayload: %00../secret\nflag{middle}\nError: at /target/probe:7\n'
  const text=line.repeat(100)+clue+line.repeat(100)
  const compact=compactToolText(text)
  assert.ok(compact.includes(clue));assert.equal((compact.match(/上一行另重复 99 次/g)??[]).length,2)
  assert.ok(compact.startsWith(line));assert.ok(compact.length<text.length/10)
  for(const exact of ['a\n','a\na\n','prefix-x\nx\nx\n','Payload: repeated without newline','unique\r\nHTTP/1.1 500\n', 'x'.repeat(100000)])assert.equal(compactToolText(exact),exact)
  assert.equal(compactToolText('a\n'.repeat(3)),'a\n'.repeat(3),'do not expand small output')
})

function originalCompact(text) {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) ?? [], result = []
  for (let i = 0; i < lines.length;) {
    let end = i + 1
    while (end < lines.length && lines[end] === lines[i]) end++
    const original = lines.slice(i, end).join('')
    const folded = lines[i] + '[上一行另重复 ' + (end - i - 1) + ' 次]\n'
    result.push(end - i >= 3 && folded.length < original.length ? folded : original)
    i = end
  }
  return result.join('')
}

test('Rust folding matches original UTF-16 semantics for mixed line groups and exact savings boundaries', () => {
  let seed = 923847
  const next = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
  const cases = ['', '\n'.repeat(50), 'progress 😀 中文\r\n'.repeat(9), 'x\u0000record\n'.repeat(7), 'record next\n'.repeat(4)]
  for (let size = 0; size < 30; size++) for (let repeats = 1; repeats < 10; repeats++) cases.push(('x'.repeat(size) + '\n').repeat(repeats))
  for (let i = 0; i < 700; i++) {
    const groups = []
    for (let j = 0; j < next() % 20; j++) {
      const line = Array.from({ length: 1 + next() % 30 }, () => String.fromCharCode(next() & 0xffff)).join('') + (next() % 2 ? '\r\n' : '\n')
      groups.push(line.repeat(1 + next() % 10))
    }
    cases.push(groups.join('') + (next() % 2 ? 'last line without newline' : ''))
  }
  for (const text of cases) assert.equal(compactToolText(text), originalCompact(text))
})
