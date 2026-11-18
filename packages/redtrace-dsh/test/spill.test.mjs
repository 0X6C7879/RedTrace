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
