import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { knowledgeTools } from '../src/knowledge.ts'
import type { EngineConfig, Worker } from '../src/types.ts'

const worker: Worker = { name: 'knowledge-test', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }

test('local FTS search returns five source-hashed snippets and bounded source reads', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-knowledge-')), source = path.join(root, 'skills', 'web'), privateSkill = path.join(root, '.redtrace', 'skills', 'api'), wordlist = path.join(root, 'tools', 'wordlists', 'SecLists', 'Discovery', 'Web-Content')
  mkdirSync(source, { recursive: true }); mkdirSync(path.join(root, 'skills', 'writeup'), { recursive: true })
  mkdirSync(privateSkill, { recursive: true }); mkdirSync(wordlist, { recursive: true })
  const body = '# CSRF\nUse a hidden CSRF token in the form and verify its lifetime.\n'
  writeFileSync(path.join(source,'csrf.md'),body)
  writeFileSync(path.join(source,'sample.md'),'CSRF TSecBench{private-canary}')
  writeFileSync(path.join(privateSkill, 'SKILL.md'), '# API Skill\nSession token refresh procedure.\n')
  writeFileSync(path.join(wordlist, 'names.txt'), 'seclists-privateword-canary\n')
  writeFileSync(path.join(root, 'skills', 'writeup', 'private.md'), 'csrf private forbidden fixture')
  const store = new Store(':memory:'), project = store.createProject({ title: 'Index test', origin: 'Authorized local target', goal: 'Search local knowledge' }).project
  const step = store.addStep(project.id, { description: 'Search docs', sourceIds: ['origin'] }), run = store.claim(project.id, 'execute', worker, step.id)
  try {
    const context = { store, run, worker, config: { workspaceRoot: path.join(root, 'workspaces') } as EngineConfig, signal: new AbortController().signal }
    const tools = knowledgeTools('', context), search = tools.find(tool => tool.name === 'knowledge_search')!, read = tools.find(tool => tool.name === 'knowledge_read')!
    const found = await search.execute('search', { query: 'CSRF hidden token' })
    const results = (found as { details: { results: { id: string; path: string; sha256: string; snippet: string }[] } }).details.results
    assert.ok(results.length <= 5)
    const csrf = results.find(result => result.path === 'skills/web/csrf.md')!
    assert.ok(csrf)
    assert.equal(csrf.sha256, createHash('sha256').update(body).digest('hex'))
    assert.match(csrf.snippet, /hidden CSRF token/)
    const slice = await read.execute('read', { id: csrf.id, offset: 0, length: 12 })
    assert.equal((slice as { details: { text: string } }).details.text, '# CSRF\nUse a')
    const skill = await search.execute('search', { query: 'session refresh' })
    assert.match(JSON.stringify(skill), /\.redtrace\/skills\/api\/SKILL\.md/)
    const catalog = await search.execute('search', { query: 'Web-Content' })
    assert.match(JSON.stringify(catalog), /tools\/wordlists\/SecLists\/Discovery\/Web-Content \(catalog\)/)
    const secret = await search.execute('search', { query: 'privateword canary' })
    assert.doesNotMatch(JSON.stringify(secret),/privateword-canary/)
    assert.doesNotMatch(JSON.stringify(await search.execute('search',{query:'private canary'})),/private-canary/)
    writeFileSync(path.join(source,'csrf.md'),body+'New prerequisite: refreshed session.\n')
    await assert.rejects(read.execute('read',{id:csrf.id}),/Knowledge source changed/)
    const refreshed=await search.execute('search',{query:'CSRF hidden token'})
    assert.notEqual((refreshed as {details:{results:{id:string;path:string}[]}}).details.results.find(row=>row.path==='skills/web/csrf.md')!.id,csrf.id)
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('tool traces are indexed and readable only inside their project', () => {
  const store = new Store(':memory:')
  try {
    const first = store.createProject({ title: 'A', origin: 'Scope', goal: 'Goal' }).project.id
    const other = store.createProject({ title: 'B', origin: 'Scope', goal: 'Goal' }).project.id
    const step = store.addStep(first, { description: 'Inspect', sourceIds: ['origin'] }), run = store.claim(first, 'execute', worker, step.id)
    store.runEvent(run.id, 'tool.started', { name: 'http_get', arguments: { query: 'csrf marker', flag: 'TSecBench{secret}', headers: { authorization: 'Bearer private' }, url: 'http://host.test/?token=private' } })
    const hits = store.traceSearch(first, 'http_get csrf marker')
    assert.equal(hits.length, 1)
    const event = store.traceEvent(first, hits[0]!.runId, hits[0]!.eventId)
    assert.equal(event.type, 'tool.started')
    assert.doesNotMatch(JSON.stringify(event.data), /TSecBench\{secret\}|Bearer private|token=private/)
    assert.deepEqual(store.traceSearch(other, 'http_get csrf marker'), [])
    assert.throws(() => store.traceEvent(other, run.id, hits[0]!.eventId), /Trace event not found/)
  } finally { store.close() }
})
