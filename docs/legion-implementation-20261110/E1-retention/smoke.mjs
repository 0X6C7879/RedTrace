import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
const root = process.argv[2], dependencyRoot = process.argv[3] ?? root
if (!existsSync(root + '/packages/redtrace-engine/src/project-evidence.ts')) { console.log('RETENTION_SUPPORTED=false'); process.exit(0) }
const { ProjectEvidence } = await import(pathToFileURL(root + '/packages/redtrace-engine/src/project-evidence.ts'))
if (!ProjectEvidence.prototype.preflightReset) { console.log('RETENTION_SUPPORTED=false'); process.exit(0) }
const { Store } = await import(pathToFileURL(root + '/packages/redtrace-engine/src/store.ts'))
const { load } = await import(pathToFileURL(dependencyRoot + '/packages/redtrace-dsh/lib/loader.js'))
const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js')
const persistence = await load('vendor/deepseek-harness/packages/session/session-persistence-jsonl/lib/index.js')
const attachments = await load('vendor/deepseek-harness/packages/attachment/attachment-local/lib/index.js')
const { SESSION_FORMAT_VERSION } = await load('vendor/deepseek-harness/packages/core/session/lib/index.js')
const work = mkdtempSync(path.join(tmpdir(), 'legion-native-retention-')), ctx = new Context(), store = new Store(path.join(work, 'engine.db'))
try {
  await ctx.plugin(persistence, { root: path.join(work, 'sessions'), compression: process.argv[4] ?? 'zstd' }).await()
  await ctx.plugin(attachments.default, { dshHome: path.join(work, 'dsh') }).await()
  const services = { sessionPersistence: ctx.get('sessionPersistence'), attachments: ctx.get('attachments') }
  const project = store.createProject({ title: 'native local retention fixture', origin: 'local fixture only', goal: 'retained evidence' }).project
  const cwd = path.join(work, project.id); mkdirSync(cwd)
  const evidence = new ProjectEvidence(store, work)
  const step = store.addStep(project.id, { description: 'fixture producer', sourceIds: ['origin'] })
  const worker = { name: 'fixture', backend: 'dsh', provider: 'fixture', model: 'fixture', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }
  const run = store.claim(project.id, 'execute', worker, step.id)
  const file = await services.attachments.saveFile({ name: 'proof.bin', data: Buffer.from('native DSH file evidence') })
  const sharp = createRequire(dependencyRoot + '/vendor/deepseek-harness/packages/attachment/attachment-local/package.json')('sharp')
  const png = await sharp({ create: { width: 1, height: 1, channels: 4, background: '#ff0000' } }).png().toBuffer()
  const image = await services.attachments.saveImage({ mediaType: 'image/png', data: png })
  const handle = await services.sessionPersistence.create({ version: SESSION_FORMAT_VERSION, id: run.id, createdAt: Date.now(), cwd, isSeeded: false })
  await handle.append([{ type: 'user/message', seq: 0, time: Date.now(), surfaceOp: 'append', data: { id: 'fixture-message', role: 'user', source: { kind: 'legion-retention-fixture' }, content: [{ type: 'file', attachment: file }, { type: 'image', attachment: image }] } }])
  await handle.flush(); await handle.close()
  writeFileSync(path.join(cwd, 'finding.txt'), 'native finding proof')
  const fact = store.addFact(project.id, 'retained fact', { runId: run.id })
  const finding = store.addFinding(project.id, { title: 'retained finding', description: 'fixture', factIds: [fact.id], runId: run.id, details: { proof: { path: 'finding.txt' }, attachment: file } })
  assert.equal((await evidence.preflightReset(project.id, services)).dataReady, false)
  store.finishRun(run.id, 'succeeded'); store.setStatus(project.id, 'stopped')
  const report = await evidence.preflightReset(project.id, services)
  assert.equal(report.dataReady, true, JSON.stringify(report.blockers)); assert.equal(report.cleanupAllowed, false)
  const refs = evidence.retainedReferences(project.id), before = refs.map(ref => evidence.read(project.id, ref.artifactId).sha256)
  assert.equal(refs.length, 4)
  for (const ref of refs) {
    const page = evidence.read(project.id, ref.artifactId)
    assert.equal(createHash('sha256').update(Buffer.from(page.content, page.encoding ?? 'utf8')).digest('hex'), page.sha256)
  }
  const location = (await services.sessionPersistence.list())[0].location.path
  store.transaction(() => {
    for (const change of report.detachments) store.saveNode(change.after)
    store.db.prepare('DELETE FROM runs WHERE project_id=?').run(project.id)
    store.db.prepare('DELETE FROM audit_runs WHERE project_id=?').run(project.id)
    store.db.prepare("DELETE FROM nodes WHERE project_id=? AND kind='step'").run(project.id)
  })
  // Delete only scratch fixture sources, never the repository's runtime or DSH home.
  rmSync(path.dirname(location), { recursive: true }); rmSync(path.join(work, 'dsh'), { recursive: true }); rmSync(path.join(cwd, 'finding.txt'))
  assert.equal((await services.sessionPersistence.list()).length, 0)
  assert.deepEqual(refs.map(ref => evidence.read(project.id, ref.artifactId).sha256), before)
  assert.equal((await evidence.preflightReset(project.id, services)).dataReady, true)
  assert.equal(store.node(project.id, fact.id).stepId, null); assert.equal(store.node(project.id, finding.id).stepId, null)
  assert.ok(store.node(project.id, 'goal'))
  console.log('RETENTION_SUPPORTED=true; native_sessions=1; references=4; deleted_fixture_steps_runs_sessions=true; hashes_unchanged=true; dangling_active_refs=0; cleanupAllowed=false')
} finally { await ctx.fiber.dispose(); store.close(); rmSync(work, { recursive: true, force: true }) }
