import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { vulnerabilitySearch } from '../src/knowledge-vuln.ts'
import type { TaskContext } from '../src/scheduler.ts'

test('offline helper transport is network-capable; proxy configuration survives secret filtering', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'knowledge-network-')), store = new Store(':memory:')
  let hits = 0
  const server = createServer((_req, res) => { hits++; res.end('reachable') })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const endpoint = `http://127.0.0.1:${(server.address() as {port:number}).port}`
  try {
    const generation = path.join(root, 'generations', 'fixture'); mkdirSync(generation, { recursive: true })
    const database = Buffer.from('transport fixture; actual CVE parsing is covered by knowledge-offline.test.ts')
    writeFileSync(path.join(generation, 'vuln.sqlite'), database)
    writeFileSync(path.join(generation, 'manifest.json'), JSON.stringify({ databaseSha256: createHash('sha256').update(database).digest('hex') }))
    writeFileSync(path.join(root, 'current.json'), JSON.stringify({ generation: 'fixture' }))
    const helper = path.join(root, 'helper')
    writeFileSync(helper, `#!${process.execPath}\nconst http=require('node:http');require('node:readline').createInterface({input:process.stdin}).on('line',input=>{http.get('${endpoint}',r=>{r.resume();r.on('end',()=>console.log(JSON.stringify({result:{results:[],total:0,nextOffset:null,diagnostics:[{query:JSON.parse(input).query,proxy:process.env.HTTP_PROXY,secret:process.env.FIXTURE_SECRET??null,pid:process.pid}]}})))}).on('error',e=>{console.error(e.message);process.exitCode=1})})`, { mode: 0o755 })
    const context = { store, config: { commonEnv: { REDTRACE_DATA_DIR: root, REDTRACE_KNOWLEDGE_PYTHON: helper, HTTP_PROXY: endpoint, FIXTURE_SECRET: 'not-for-helper' } }, signal: new AbortController().signal } as unknown as TaskContext
    const result = await vulnerabilitySearch('', context, { query: 'CVE-2025-10001' })
    assert.equal(hits, 1)
    const first = result.diagnostics[0] as any
    assert.deepEqual(first, { query: 'CVE-2025-10001', proxy: endpoint, secret: null, pid: first.pid })
    await new Promise(resolve => setTimeout(resolve, 1100))
    const second = await vulnerabilitySearch('', context, { query: 'another-uncached-query' })
    assert.equal(hits, 2); assert.equal(second.diagnostics.length, 1)
    assert.equal((second.diagnostics[0] as any).pid, first.pid, 'uncached queries reuse the helper process')
    const abort = new AbortController(); abort.abort()
    const cancelled = await vulnerabilitySearch('', { ...context, signal: abort.signal }, { query: 'different-uncached-query' })
    assert.match(JSON.stringify(cancelled.diagnostics), /cancelled/)
    assert.equal(hits, 2)
  } finally { store.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
})
