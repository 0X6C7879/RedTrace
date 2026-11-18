import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Store } from '../src/store.ts'
import { reportContext } from '../src/runner.ts'

test('Reporter launch contains only the assigned Finding and its supporting Facts', () => {
  const store = new Store(':memory:')
  try {
    for (const mode of ['benchmark', 'general'] as const) {
      const project = store.createProject({ mode, title: 'Reporting fixture', origin: 'Private project scope', goal: 'Private project goal' }).project
      const graph = mode === 'benchmark'
        ? store.createGraph(project.id, { taskKey: 'fixture', title: 'Fixture', origin: 'Private graph scope', goal: 'Private graph goal' })
        : store.projectGraphs(project.id)[0]
      const scoped = store.forGraph(project.id, graph.id)
      const fact = scoped.addFact(project.id, 'Assigned evidence', { creator: 'fixture' })
      const finding = scoped.addFinding(project.id, { title: 'Assigned Finding', description: 'Fixture only', type: 'fixture', severity: 'low', factIds: [fact.id] })
      scoped.addInput(project.id, 'hint', 'Unrelated Hint')
      scoped.addFact(project.id, 'Unrelated Fact', { creator: 'fixture' })
      const step = scoped.requestFindingReport(project.id, finding.id)
      const run = scoped.claim(project.id, 'execute', { name: 'fixture', backend: 'mock' }, step.id)
      const payload = reportContext(store, run, step.sourceIds[0])
      assert.deepEqual(payload, {
        reportTrigger: { tool: 'submit_finding', finding_id: finding.id, finding: scoped.readNode(project.id, finding.id) },
      })
    }
  } finally { store.close() }
})

test('native DSH separates Soldier verification from ARTEX Reporter and traces real retained responses', { timeout: 90000 }, async () => {
  const result = await promisify(execFile)(process.execPath, [new URL('./reporter-runtime.fixture.mjs', import.meta.url).pathname], { maxBuffer: 2 * 1024 * 1024 })
  assert.match(result.stdout, /REPORTER_RUNTIME_OK=true/)
  assert.match(result.stdout, /original_audit_read=true; retained_evidence_read=true/)
  assert.match(result.stdout, /live_model=false/)
})
