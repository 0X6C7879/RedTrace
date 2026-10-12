import test from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync, readdirSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Store } from '../src/store.ts'
import { projectFgs } from '../src/fgs.ts'
import { graphTools } from '../src/runner.ts'
import { serveEngine } from '../src/index.ts'
import type { Fact, Finding, Step, EngineConfig } from '../src/types.ts'

const worker = { name: 'fixture', backend: 'mock' as const, provider: 'mock', model: '', enabled: true, reason: true, explore: true, bootstrap: true, maxRunning: 4, priority: 0 }
const config: EngineConfig = { workers: [worker], providers: {}, maxWorkers: 4, maxProjectWorkers: 4, maxRunningProjects: 2, maxSteps: null, decideTimeout: 30, executeTimeout: 30, concludeTimeout: 5, bootstrapTimeout: 30, bootstrapConcludeTimeout: 5, workspaceRoot: os.tmpdir() }
const project = (s: Store) => s.createProject({ title: 'Current FGS', origin: 'Local fixture', goal: 'Verified result' }).project.id
const remove = (s: Store, id: string, node: { id: string; version?: number }) => s.manageEvidence(id, { operation: 'delete', id: node.id, expectedVersion: node.version!, reason: 'No longer needed' })
const merge = (s: Store, id: string, target: Fact | Finding, source: Fact | Finding) => s.manageEvidence(id, { operation: 'merge', id: target.id, expectedVersion: target.version!, sourceIds: [source.id], sourceVersions: { [source.id]: source.version! }, reason: 'Same confirmed result' })

test('removed bodies disappear from SQL, delta pages and Reason tools while evidence and current content survive', async t => {
  const s = new Store(':memory:')
  try {
    const id = project(s), run = s.claim(id, 'decide', worker), marker = 'REMOVED_BODY_' + 'x'.repeat(12000)
    const a = s.addFact(id, 'Canonical', { evidence: [{ description: 'First tool proof', toolCallId: 'one' }] })
    const b = s.addFact(id, marker, { evidence: [{ description: 'Second tool proof', toolCallId: 'two' }] })
    const c = s.addFact(id, marker + 'deleted')
    const bytes = () => Number(s.db.prepare('SELECT SUM(length(data)) AS n FROM nodes').get()!.n) + Number(s.db.prepare('SELECT SUM(length(data)) AS n FROM events').get()!.n)
    const before = bytes(), count = s.nodeCount(id, 'fact'), responseBefore = Buffer.byteLength(JSON.stringify(s.graph(id)))
    let target = merge(s, id, a, b) as Fact
    remove(s, id, c)
    const d = s.addFact(id, 'Third proof'); target = merge(s, id, target, d) as Fact
    assert.equal(s.nodeCount(id, 'fact'), count - 2); assert.equal(target.evidence.length, 2)
    let cursor = run.deliveredGraphCursor!, page
    const events = []
    do {
      page = s.graphDelta(id, cursor, 1, run.id); cursor = page.cursor; events.push(...page.events)
      assert.ok(page.nodes.every(node => ![b.id, c.id, d.id].includes(node.id)))
      assert.ok(!JSON.stringify(page).includes('REMOVED_BODY_'))
    } while (page.hasMore)
    assert.ok(events.some(e => e.type === 'fact.deleted' && e.nodeId === c.id))
    assert.ok(events.some(e => e.type === 'fact.merged' && (e.payload as any).targetId === a.id))
    s.acknowledgeEvidence(run.id, s.project(id).evidenceSeq!)
    const tools = graphTools({ store: s, run, worker, config, signal: new AbortController().signal }, () => {})
    for (const name of ['read_graph', 'read_graph_delta']) {
      const output = await tools.find(tool => tool.name === name)!.execute('fixture', name === 'read_graph' ? { full: true } : { after: run.deliveredGraphCursor })
      assert.ok(!JSON.stringify(output).includes('REMOVED_BODY_'))
    }
    assert.ok(!JSON.stringify(s.db.prepare('SELECT data FROM nodes UNION ALL SELECT data FROM events').all()).includes('REMOVED_BODY_'))
    assert.ok(bytes() < before / 4)
    const responseAfter = Buffer.byteLength(JSON.stringify(s.graph(id)))
    assert.ok(responseAfter < responseBefore / 4)
    t.diagnostic(`FGS stored JSON bytes ${before} -> ${bytes()}; graph response bytes ${responseBefore} -> ${responseAfter}; Fact rows ${count} -> ${s.nodeCount(id, 'fact')}`)
  } finally { s.close() }
})

test('Finding and achieved Goal block deletion until Reason repairs their evidence', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), fact = s.addFact(id, 'Supporting proof'), finding = s.addFinding(id, { title: 'Result', description: 'Verified', factIds: [fact.id] })
    const goal = s.addGoal(id, 'Subgoal'); s.updateGoal(id, goal.id, { status: 'achieved', evidenceIds: [finding.id] })
    assert.throws(() => remove(s, id, fact), (e: any) => e.status === 409 && e.details.blockers[0].id === finding.id)
    assert.throws(() => remove(s, id, finding), (e: any) => e.status === 409 && e.details.blockers[0].id === goal.id)
    s.updateGoal(id, goal.id, { status: 'open' }); remove(s, id, finding); remove(s, id, fact)
    assert.deepEqual(s.graph(id).goals.find(n => n.id === goal.id)!.evidenceIds, [])
    assert.deepEqual(projectFgs(s.graph(id)).missingReferences, [])
  } finally { s.close() }
})

test('merge defaults preserve target content and invalid content rolls back all reference changes', () => {
  const s = new Store(':memory:')
  try {
    const id = project(s), a = s.addFact(id, 'Keep target'), b = s.addFact(id, 'Source'), step = s.addStep(id, { description: 'Depends on source', sourceIds: [b.id] })
    const revision = s.project(id).revision
    const input = { operation: 'merge' as const, id: a.id, expectedVersion: a.version!, sourceIds: [b.id], sourceVersions: { [b.id]: b.version! }, reason: 'Confirmed equivalent' }
    for (const invalid of [{ description: ' ' }, { details: { findingOnly: true } }]) {
      assert.throws(() => s.manageEvidence(id, { ...input, ...invalid }), (e: any) => e.status === 422)
      assert.equal(s.project(id).revision, revision); assert.deepEqual(s.node<Step>(id, step.id).sourceIds, [b.id])
      assert.equal(s.node(id, b.id).id, b.id)
    }
    assert.equal((s.manageEvidence(id, input) as Fact).description, 'Keep target')
    assert.equal(s.node<Step>(id, step.id).planVersion, 2)
  } finally { s.close() }
})

test('schema 2 migration redirects merge chains, cleans stale bodies and preserves event and Run boundaries', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-current-fgs-')), file = path.join(root, 'engine.db')
  let s = new Store(file)
  try {
    const id = project(s), a = s.addFact(id, 'Live proof'), b = s.addFact(id, 'OLD_BODY'), c = s.addFact(id, 'OLD_BODY_CHAIN'), archived = s.addFact(id, 'OLD_BODY_ARCHIVED')
    const gone = s.addFact(id, 'OLD_BODY_DELETED'), step = s.addStep(id, { description: 'Producer', sourceIds: ['origin'] }), run = s.claim(id, 'execute', worker, step.id)
    const output = s.addFact(id, 'Actual output', { runId: run.id }); s.finishRun(run.id, 'succeeded')
    const dependent = s.addStep(id, { description: 'Follow proof', sourceIds: [a.id] }), liveRun = s.claim(id, 'execute', worker, dependent.id)
    const finding = s.addFinding(id, { title: 'Live result', description: 'Current', factIds: [a.id], details: { valid: true } })
    const beforeProject = s.project(id), beforeEvents = s.events(id), beforeRun = s.run(run.id)
    const write = (node: any) => s.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify(node), id, node.id)
    write({ ...a, lifecycle: 'active', mergedFromIds: [b.id, c.id], producerStepIds: [step.id] })
    write({ ...b, lifecycle: 'merged', mergedInto: a.id }); write({ ...c, lifecycle: 'merged', mergedInto: b.id })
    write({ ...archived, lifecycle: 'archived' }); write({ ...gone, deleted: true })
    write({ ...s.node(id, step.id), sourceIds: [c.id, archived.id], factIds: [output.id, gone.id] })
    write({ ...s.node(id, dependent.id), sourceIds: [c.id] })
    write({ ...finding, factIds: [b.id], sourceDetails: [{ id: b.id, details: { old: 'OLD_BODY' } }] })
    s.db.prepare('UPDATE events SET data=? WHERE id=?').run(JSON.stringify({ ...beforeEvents[1].payload as object, nodeSnapshot: b, description: 'OLD_BODY', initialNodes: [b] }), beforeEvents[1].id)
    s.db.prepare('DELETE FROM metadata WHERE key=?').run('fgs-current-only')
    s.close(); s = new Store(file)
    assert.deepEqual(s.project(id), beforeProject); assert.deepEqual(s.run(run.id), beforeRun)
    assert.deepEqual(s.node<Step>(id, step.id).sourceIds, [a.id]); assert.deepEqual(s.node<Step>(id, step.id).factIds, [output.id])
    assert.deepEqual(s.node<Finding>(id, finding.id).factIds, [a.id]); assert.deepEqual(s.node<Finding>(id, finding.id).details, { valid: true })
    assert.equal(s.node<Step>(id, dependent.id).planVersion, 2); assert.equal(s.run(liveRun.id).boundStepVersion, 1)
    assert.deepEqual(s.syncStep(liveRun.id, 2).dependencies.map(n => n.id), [a.id])
    assert.deepEqual(s.events(id).map(e => [e.id, e.revision, e.type, e.nodeId]), beforeEvents.map(e => [e.id, e.revision, e.type, e.nodeId]))
    assert.deepEqual(s.events(id).map(e => (e.payload as any).evidenceSeq), beforeEvents.map(e => (e.payload as any).evidenceSeq))
    assert.ok(!JSON.stringify(s.db.prepare('SELECT data FROM nodes UNION ALL SELECT data FROM events').all()).includes('OLD_BODY'))
    assert.equal(s.db.prepare("SELECT value FROM metadata WHERE key='schema'").get()!.value, '2')
    assert.deepEqual(projectFgs(s.graph(id)).missingReferences, [])
    const current = s.graph(id), events = s.events(id)
    s.close(); s = new Store(file); assert.deepEqual(s.graph(id), current); assert.deepEqual(s.events(id), events)
    assert.ok(s.addFact(id, 'New evidence').id > gone.id)
    assert.ok(readdirSync(root).every(name => /^engine\.db(?:-wal|-shm)?$/.test(name)))
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('invalid merge chains and lost active dependencies roll back migration across projects', () => {
  for (const kind of ['cycle', 'missing', 'active-reference', 'wrong-kind']) {
    const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-fgs-rollback-')), file = path.join(root, 'engine.db'), s = new Store(file)
    const id = project(s), valid = s.addFact(id, 'Archived safe'), other = project(s), fact = s.addFact(other, 'Must survive failed migration')
    s.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify({ ...valid, lifecycle: 'archived' }), id, valid.id)
    if (kind === 'active-reference') s.addStep(other, { description: 'Active dependency', sourceIds: [fact.id] })
    const legacy = { ...fact, lifecycle: kind === 'active-reference' ? 'archived' : 'merged', mergedInto: kind === 'cycle' ? fact.id : kind === 'wrong-kind' ? 'goal' : 'absent' }
    s.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify(legacy), other, fact.id)
    s.db.prepare('DELETE FROM metadata WHERE key=?').run('fgs-current-only')
    const before = s.db.prepare('SELECT * FROM nodes ORDER BY project_id,id').all(); s.close()
    try {
      assert.throws(() => new Store(file), new RegExp(`FGS migration ${other}/`))
      const db = new DatabaseSync(file)
      try {
        assert.deepEqual(db.prepare('SELECT * FROM nodes ORDER BY project_id,id').all(), before)
        assert.equal(db.prepare("SELECT value FROM metadata WHERE key='fgs-current-only'").get(), undefined)
      } finally { db.close() }
    } finally { rmSync(root, { recursive: true, force: true }) }
  }
})

test('a merged chain ending in archived evidence can be removed when no active dependency remains', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-fgs-archived-chain-')), file = path.join(root, 'engine.db')
  let s = new Store(file)
  try {
    const id = project(s), a = s.addFact(id, 'Archived target'), b = s.addFact(id, 'Merged source')
    for (const node of [{ ...a, lifecycle: 'archived' }, { ...b, lifecycle: 'merged', mergedInto: a.id }]) s.db.prepare('UPDATE nodes SET data=? WHERE project_id=? AND id=?').run(JSON.stringify(node), id, node.id)
    s.db.prepare('DELETE FROM metadata WHERE key=?').run('fgs-current-only'); s.close(); s = new Store(file)
    assert.equal(s.nodeCount(id, 'fact'), 1)
  } finally { s.close(); rmSync(root, { recursive: true, force: true }) }
})

test('HTTP maintenance, current snapshots and delta endpoints never expose deleted source bodies', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-fgs-api-')), engine = await serveEngine({ root, port: 0, autoStart: false })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const call = async (route: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + route, { method, ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    const text = await response.text()
    return { status: response.status, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : text }
  }
  try {
    const id = project(engine.store), base = `/v2/projects/${id}`
    const a = (await call(base + '/facts', 'POST', { description: 'Target', evidence: [] })).data
    const b = (await call(base + '/facts', 'POST', { description: 'REMOVED_API_BODY', evidence: [] })).data
    const mergeRequest = { operation: 'merge', id: a.id, expectedVersion: a.version, sourceIds: [b.id], sourceVersions: { [b.id]: b.version }, reason: 'Same fact', description: 'Final fact' }
    const combined = await call(base + '/evidence/manage', 'POST', mergeRequest)
    assert.equal(combined.status, 200); assert.equal(combined.data.description, 'Final fact')
    assert.equal((await call(base + '/nodes/' + b.id)).status, 404)
    const f = engine.store.addFinding(id, { title: 'Result', description: 'Source proof', factIds: [a.id], details: { current: true } })
    const other = engine.store.addFinding(id, { title: 'Old result', description: 'REMOVED_API_BODY', factIds: [a.id], details: { old: 'REMOVED_API_BODY' } })
    const result = await call(base + '/evidence/manage', 'POST', { operation: 'merge', id: f.id, expectedVersion: f.version, sourceIds: [other.id], sourceVersions: { [other.id]: other.version }, reason: 'Same deliverable', title: 'Final result', details: null })
    assert.equal(result.status, 200); assert.equal(result.data.title, 'Final result'); assert.equal(result.data.details, null)
    for (const route of [base + '/graph', base + '/graph/delta', `/projects/${id}/export?format=yaml`]) {
      const response = await call(route); assert.equal(response.status, 200); assert.ok(!response.text.includes('REMOVED_API_BODY'))
      assert.ok(!response.text.includes('sourceDetails')); assert.ok(!response.text.includes('initialNodes'))
    }
    assert.equal((await call(base + '/evidence/manage', 'POST', { operation: 'delete', id: a.id, expectedVersion: combined.data.version, reason: 'Still referenced' })).status, 409)
    const deleted = await call(base + '/evidence/manage', 'POST', { operation: 'delete', id: f.id, expectedVersion: result.data.version, reason: 'Unneeded' })
    assert.equal(deleted.status, 200); assert.deepEqual(deleted.data, { id: f.id, deleted: true })
    assert.equal((await call(base + '/evidence/manage', 'POST', { operation: 'delete', id: a.id, expectedVersion: combined.data.version, reason: 'Unneeded' })).status, 200)
    assert.equal((await call(base + '/nodes/' + a.id)).status, 404)
    assert.equal((await call(base + '/facts?revision=1')).status, 422)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
