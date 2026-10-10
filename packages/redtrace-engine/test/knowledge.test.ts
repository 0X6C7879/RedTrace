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
    const tools = knowledgeTools('', context), search = tools.find(tool => tool.name === 'knowledge_search')!, read = tools.find(tool => tool.name === 'knowledge_read')!, match = tools.find(tool => tool.name === 'knowledge_match')!
    const found = await search.execute('search', { query: 'CSRF hidden token' })
    const results = (found as { details: { results: { id: string; path: string; sha256: string; snippet: string }[] } }).details.results
    assert.ok(results.length <= 5)
    const csrf = results.find(result => result.path === 'skills/web/csrf.md')!
    assert.ok(csrf)
    assert.equal(csrf.sha256, createHash('sha256').update(body).digest('hex'))
    assert.match(csrf.snippet, /hidden CSRF token/)
    const slice = await read.execute('read', { id: csrf.id, offset: 0, length: 12 })
    assert.equal((slice as { details: { text: string } }).details.text, '# CSRF\nUse a')
    assert.equal((await match.execute('unknown-protocol', { id: csrf.id, protocol: 'http' }) as any).details.status, 'unknown')
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

test('local Nuclei templates expose CVE and fingerprint metadata with conservative matching', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-nuclei-workspace-')), sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'redtrace-nuclei-source-')), templates = path.join(sourceRoot, 'http', 'cves')
  mkdirSync(templates, { recursive: true })
  const source = path.join(templates, 'CVE-2025-1234.yaml')
  const previousSource = process.env.REDTRACE_NUCLEI_TEMPLATES_DIR
  process.env.REDTRACE_NUCLEI_TEMPLATES_DIR = sourceRoot
  const body = `id: acme-widget-rce
info:
  name: Acme Widget RCE
  severity: high
  tags: cve,cve-2025-1234,rce
  reference:
    - https://example.invalid/CVE-2025-1234
  classification:
    cve-id: CVE-2025-1234
    cwe-id: CWE-78
  metadata:
    vendor: Acme
    product: Widget
    version: 1.2.3
    prerequisites:
      - administrator session
http:
  - method: GET
    path:
      - "{{BaseURL}}/api"
    matchers:
      - type: word
        words:
          - acme-widget-release
`
  writeFileSync(source, body)
  writeFileSync(path.join(templates, 'range.yaml'), body.replace('id: acme-widget-rce', 'id: acme-widget-rce-range').replace('version: 1.2.3', 'version: < 1.3.0'))
  const store = new Store(':memory:'), project = store.createProject({ title: 'Nuclei index', origin: 'Authorized local fixture', goal: 'Index a local template' }).project
  const step = store.addStep(project.id, { description: 'Index fixture', sourceIds: ['origin'] }), run = store.claim(project.id, 'execute', worker, step.id)
  try {
    const tools = knowledgeTools('', { store, run, worker, config: { workspaceRoot: path.join(root, 'workspaces') } as EngineConfig, signal: new AbortController().signal })
    const search = tools.find(tool => tool.name === 'knowledge_search')!, read = tools.find(tool => tool.name === 'knowledge_read')!, match = tools.find(tool => tool.name === 'knowledge_match')!
    const found = await search.execute('search', { query: 'CVE-2025-1234 Acme Widget RCE' }) as { details: { results: any[] } }
    const result = found.details.results.find(item => item.templateId === 'acme-widget-rce')
    assert.ok(result)
    assert.equal(result.path, '@nuclei-templates/http/cves/CVE-2025-1234.yaml')
    assert.equal(result.kind, 'nuclei-template'); assert.equal(result.component, 'Widget'); assert.equal(result.version, '1.2.3')
    assert.deepEqual(result.cves, ['CVE-2025-1234']); assert.deepEqual(result.cwes, ['CWE-78']); assert.deepEqual(result.protocols, ['http'])
    assert.deepEqual(result.prerequisites, ['administrator session']); assert.ok(result.fingerprintIndicators.includes('words: acme-widget-release'))
    assert.equal((await match.execute('match', { id: result.id, component: 'Widget', version: '1.2.3', protocol: 'http', confirmed_prerequisites: ['administrator session'] }) as any).details.status, 'candidate')
    const partial = (await match.execute('partial', { id: result.id, component: 'Widget' }) as any).details
    assert.equal(partial.status, 'unknown'); assert.deepEqual(partial.unresolved, ['version', 'protocol'])
    assert.equal((await match.execute('mismatch', { id: result.id, version: '9.0' }) as any).details.status, 'not_applicable')
    assert.equal((await match.execute('unknown', { id: result.id }) as any).details.status, 'unknown')
    const range = found.details.results.find(item => item.templateId === 'acme-widget-rce-range')
    assert.ok(range); assert.equal(range.version, 'unknown')
    assert.equal((await match.execute('range', { id: range.id, component: 'Widget', version: '1.2.3', protocol: 'http', confirmed_prerequisites: ['administrator session'] }) as any).details.status, 'unknown')
    const content = await read.execute('read', { id: result.id, length: 80 }) as any
    assert.equal(content.details.text, Buffer.from(body).subarray(0, 80).toString('utf8'))
  } finally {
    store.close()
    if (previousSource === undefined) delete process.env.REDTRACE_NUCLEI_TEMPLATES_DIR; else process.env.REDTRACE_NUCLEI_TEMPLATES_DIR = previousSource
    rmSync(root, { recursive: true, force: true }); rmSync(sourceRoot, { recursive: true, force: true })
  }
})

test('Nuclei legacy installer path is discovered and resource availability is returned', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-nuclei-legacy-')), previous = process.env.REDTRACE_NUCLEI_TEMPLATES_DIR
  delete process.env.REDTRACE_NUCLEI_TEMPLATES_DIR
  const templates = path.join(root, 'tools', 'wordlists', 'nuclei-templates', 'http', 'cves')
  mkdirSync(templates, { recursive: true })
  writeFileSync(path.join(templates, 'legacy.yaml'), 'id: legacy-offline-fixture\ninfo:\n  name: Legacy Offline Fixture\n  severity: info\nhttp:\n  - method: GET\n')
  const store = new Store(':memory:'), project = store.createProject({ title: 'Legacy path', origin: 'Local fixture', goal: 'Resolve installed data' }).project
  const step = store.addStep(project.id, { description: 'Index fixture', sourceIds: ['origin'] }), run = store.claim(project.id, 'execute', worker, step.id)
  try {
    const search = knowledgeTools('', { store, run, worker, config: { workspaceRoot: path.join(root, 'workspaces') } as EngineConfig, signal: new AbortController().signal }).find(tool => tool.name === 'knowledge_search')!
    const result = await search.execute('search', { query: 'Legacy Offline Fixture' }) as any
    assert.equal(result.details.results[0].path, '@nuclei-templates/http/cves/legacy.yaml')
    assert.equal(result.details.resources.find((item: any) => item.name === 'nuclei-templates').status, 'available')
    assert.equal(result.details.resources.find((item: any) => item.name === 'nuclei-templates').path, path.join(root, 'tools', 'wordlists', 'nuclei-templates'))
    assert.ok(Array.isArray(result.details.indexWarnings))
  } finally {
    store.close(); rmSync(root, { recursive: true, force: true })
    if (previous === undefined) delete process.env.REDTRACE_NUCLEI_TEMPLATES_DIR; else process.env.REDTRACE_NUCLEI_TEMPLATES_DIR = previous
  }
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
