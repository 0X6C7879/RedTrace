import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from '../src/store.ts'
import { knowledgeTools } from '../src/knowledge.ts'
import { vulnerabilitySearch } from '../src/knowledge-vuln.ts'
import type { TaskContext } from '../src/scheduler.ts'
import type { EngineConfig, Worker } from '../src/types.ts'

const install = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const python = path.join(install, '.redtrace/runtime/knowledge/bin/python')
const worker: Worker = { name: 'offline-test', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0, backend: 'mock' }
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-offline-unit-'))
  for (const directory of ['nuclei', 'edb/exploits', 'nvd']) mkdirSync(path.join(root, directory), { recursive: true })
  const cves = []
  for (let index = 1; index <= 8; index++) {
    const id = `CVE-2025-${10000 + index}`
    writeFileSync(path.join(root, `nuclei/${index}.yaml`), `id: ${id}\ninfo:\n  name: Widget ${index}\n  severity: high\n  classification:\n    cve-id: ${id}\n  metadata:\n    vendor: acme\n    product: widget\nhttp:\n  - method: GET\n    path: ["{{BaseURL}}/test"]\n`)
    writeFileSync(path.join(root, `edb/exploits/${index}.py`), `# Fixture PoC ${index}; NEVER EXECUTED\n`)
    cves.push({ cve: { id, vulnStatus: 'Analyzed', descriptions: [{ lang: 'en', value: `Widget fixture ${index}` }], configurations: [{ nodes: [{ operator: 'OR', cpeMatch: [{ vulnerable: true, criteria: 'cpe:2.3:a:acme:widget:*:*:*:*:*:*:*:*', versionStartIncluding: '1.0', versionEndExcluding: '2.0' }, { vulnerable: true, criteria: 'cpe:2.3:a:acme:widget:*:*:*:*:*:*:*:*', versionStartIncluding: '3.0', versionEndExcluding: '4.0' }] }] }] } })
  }
  const rows = ['id,file,description,codes', ...Array.from({ length: 8 }, (_, index) => `${index + 1},exploits/${index + 1}.py,"Widget ${index + 1}, test",CVE-2025-${10001 + index}`)]
  rows.push(rows[1]); writeFileSync(path.join(root, 'edb/files_exploits.csv'), rows.join('\n'))
  writeFileSync(path.join(root, 'nvd/fixture.json'), JSON.stringify({ vulnerabilities: cves }))
  execFileSync(python, [path.join(install, 'tools/knowledge/knowledge.py'), 'build', '--root', path.join(root, 'data'), '--nuclei', path.join(root, 'nuclei'), '--exploitdb', path.join(root, 'edb'), '--nvd', path.join(root, 'nvd'), '--allow-partial'])
  const store = new Store(':memory:'), project = store.createProject({ title: 'Offline fixture', origin: 'http://127.0.0.1:9000', goal: 'Match offline fixtures' }).project
  const step = store.addStep(project.id, { description: 'Offline query', sourceIds: ['origin'] }), run = store.claim(project.id, 'execute', worker, step.id)
  const config = { workspaceRoot: path.join(root, 'workspaces'), commonEnv: { REDTRACE_DATA_DIR: path.join(root, 'data'), REDTRACE_KNOWLEDGE_PYTHON: python } } as unknown as EngineConfig
  const context = { store, run, worker, config, signal: new AbortController().signal } as TaskContext
  const component = { asset: 'http://127.0.0.1:9000', component: 'Widget', product: 'widget', vendor: 'acme', part: 'a', version: '1.5', confidence: 'observed', evidenceRefs: ['fixture-evidence'], challenge: 'lab', identity: 'anonymous' } as const
  return { root, store, project, context, component, close() { store.close(); rmSync(root, { recursive: true, force: true }) } }
}

test('offline CVE ranges, deduplicated real source paths, pagination and bounded PoC reads (fixtures)', async () => {
  const f = fixture()
  try {
    const tools = knowledgeTools('', f.context), search = tools.find(item => item.name === 'knowledge_search')!, read = tools.find(item => item.name === 'knowledge_read')!
    const args = { component: 'Widget', vendor: 'acme', version: '1.5', cpe: 'cpe:2.3:a:acme:widget:1.5:*:*:*:*:*:*:*' }
    const first = (await search.execute('first', args) as any).details
    assert.equal(first.total, 8); assert.equal(first.results.length, 5); assert.equal(first.nextOffset, 5)
    assert.equal(first.results[0].status, 'candidate'); assert.equal(first.results[0].validated, false)
    assert.deepEqual(new Set(first.results[0].sources.map((source: any) => source.source)), new Set(['nvd', 'nuclei', 'exploitdb']))
    const second = (await search.execute('second', { ...args, offset: 5 }) as any).details
    assert.equal(second.results.length, 3); assert.equal(second.nextOffset, null)
    assert.equal(new Set([...first.results, ...second.results].map((item: any) => item.candidateId)).size, 8)
    const poc = first.results[0].sources.find((item: any) => item.source === 'exploitdb')
    assert.equal((await read.execute('poc', { id: poc.id, length: 9 }) as any).details.text, '# Fixture')
    const body = readFileSync(poc.path); writeFileSync(poc.path, '# changed')
    await assert.rejects(read.execute('changed', { id: poc.id }), /source changed/); writeFileSync(poc.path, body)
    const excluded = await vulnerabilitySearch('', f.context, { component: 'Widget', vendor: 'acme', version: '2.5', include_excluded: true })
    assert.ok(excluded.results.every(item => item.status === 'not_applicable'))
    const unknown = await vulnerabilitySearch('', f.context, { component: 'Widget' })
    assert.ok(unknown.results.every(item => item.status === 'unknown'))
    assert.equal(f.store.project(f.project.id).evidenceSeq, 0)
  } finally { f.close() }
})

test('model-facing CVE/component/version queries need no target evidence and never subscribe to Fact events (fixtures)', async () => {
  const f = fixture()
  try {
    const before = f.store.changes.listenerCount('change')
    const tools = knowledgeTools('', f.context), search = tools.find(item => item.name === 'knowledge_search')!, read = tools.find(item => item.name === 'knowledge_read')!, match = tools.find(item => item.name === 'knowledge_match')!
    assert.match(search.description, new RegExp(f.root))
    assert.doesNotMatch(JSON.stringify(search.parameters), /evidence_ids|fact_ids|nmap|asset/)
    const exact = (await search.execute('cve', { query: 'cve-2025-10001 Widget' }) as any).details
    assert.equal(exact.total, 1); assert.equal(exact.results[0].candidateId, 'CVE-2025-10001')
    assert.equal(exact.database, path.join(f.root, 'data/generations', exact.generation, 'vuln.sqlite'))
    assert.equal((await search.execute('component', { query: 'Widget' }) as any).details.total, 8)
    assert.equal((await search.execute('component-version', { query: 'Widget 2.5' }) as any).details.total, 0)
    const versions = (await search.execute('version', { component: 'Widget', version: '1.5' }) as any).details
    assert.ok(versions.results.every((item: any) => item.versionMatch === 'affected'))
    assert.ok(versions.results.every((item: any) => item.affectedVersions[0].versionEndExcluding === '2.0'))
    const detail = (await read.execute('detail', { id: 'CVE-2025-10001' }) as any).details
    assert.match(detail.text, /versionEndExcluding/)
    const matched = (await match.execute('match', { candidate_id: 'CVE-2025-10001', component: 'Widget', version: '2.5' }) as any).details
    assert.equal(matched.versionMatch, 'not_affected')
    f.store.addFact(f.project.id, 'User supplied observation', { evidence: [] })
    assert.equal(f.store.changes.listenerCount('change'), before)
    assert.equal(f.store.graph(f.project.id).findings.length, 0)
  } finally { f.close() }
})

test('index corruption and missing data return explicit local diagnostics, without online repair (fixtures)', async () => {
  const f = fixture()
  try {
    const manifest = JSON.parse(readFileSync(path.join(f.root, 'data/current.json'), 'utf8'))
    const database = path.join(f.root, 'data/generations', manifest.generation, 'vuln.sqlite')
    writeFileSync(database, 'damaged sqlite fixture')
    const corrupted = await vulnerabilitySearch('', f.context, { query: 'Widget' })
    assert.equal(corrupted.total, 0); assert.match(JSON.stringify(corrupted.diagnostics), /SHA256 mismatch/)
    rmSync(path.join(f.root, 'data/current.json'))
    const missing = await vulnerabilitySearch('', f.context, { query: 'Widget' })
    assert.match(JSON.stringify(missing.diagnostics), /runtime never downloads/)
  } finally { f.close() }
})

test('offline package export/import preserves callable CVE records and source hashes (fixtures)', async () => {
  const f = fixture()
  try {
    const archive = path.join(f.root, 'knowledge.tar.gz'), imported = path.join(f.root, 'imported')
    execFileSync(process.execPath, [path.join(install, 'scripts/knowledge.mjs'), 'export', '--root', path.join(f.root, 'data'), '--output', archive])
    execFileSync(python, [path.join(install, 'tools/knowledge/knowledge.py'), 'import', '--root', imported, '--package', archive, '--allow-partial'])
    f.context.config.commonEnv = { ...f.context.config.commonEnv, REDTRACE_DATA_DIR: imported }
    const tools = knowledgeTools('', f.context), search = tools.find(item => item.name === 'knowledge_search')!, read = tools.find(item => item.name === 'knowledge_read')!
    const result = (await search.execute('roundtrip', { query: 'CVE-2025-10001' }) as any).details
    assert.equal(result.total, 1)
    assert.ok(result.database.startsWith(imported + path.sep))
    const source = result.results[0].sources.find((item: any) => item.source === 'exploitdb')
    assert.match((await read.execute('roundtrip-read', { id: source.id }) as any).details.text, /Fixture PoC/)
  } finally { f.close() }
})
