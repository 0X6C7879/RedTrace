import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { serveEngine } from '../src/index.ts'

test('single-use deletion removes only project data and keeps durable shared resources', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-delete-')), engine = await serveEngine({ root, port: 0, autoStart: false })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const call = async (route: string, method = 'GET', data?: unknown) => {
    const response = await fetch(url + route, { method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any }
  }
  try {
    const { project } = engine.store.createProject({ mode:'general',title: 'Delete', origin: 'input', goal: 'goal' }), workspace = path.join(engine.configuration.workspaceRoot, project.id)
    mkdirSync(workspace, { recursive: true }); writeFileSync(path.join(workspace, 'evidence.txt'), 'private')
    const session = 'run_delete_fixture', sessionDir = path.join(root, '.redtrace/sessions/project-fixture', session)
    mkdirSync(sessionDir, { recursive: true }); writeFileSync(path.join(sessionDir, 'session.jsonl'), '{}')
    engine.store.db.prepare('INSERT INTO audit_runs(id,project_id,data) VALUES (?,?,?)').run(session, project.id, JSON.stringify({ id: session, session_id: session }))
    const chief=engine.chats.chief(project.id),chiefDir=path.join(root,'.redtrace/sessions/project-fixture',chief.sessionId);mkdirSync(chiefDir,{recursive:true});writeFileSync(path.join(chiefDir,'session.jsonl'),'{}');const global=engine.chats.create('keep global'),globalDir=path.join(root,'.redtrace/sessions/project-fixture',global.sessionId);mkdirSync(globalDir,{recursive:true});writeFileSync(path.join(globalDir,'session.jsonl'),'{}')
    const durable = engine.operations.create(project.id, { kind: 'webshell', name: 'keep', actor: 'human' }).resource.id
    const disposable = engine.operations.create(project.id, { kind: 'file', name: 'drop', actor: 'human' }).resource.id
    assert.throws(() => engine.operations.create(project.id, { kind: 'http_session', name: 'retired', actor: 'human' }), /Unsupported resource kind/)
    assert.equal((await call(`/projects/${project.id}`, 'DELETE')).status, 403)
    await call(`/projects/${project.id}/deletion/confirmation`, 'POST')
    const token = (await call(`/projects/${project.id}/deletion/confirmation`, 'POST')).data.confirmationToken
    assert.equal((await call(`/projects/${project.id}`, 'DELETE', { confirmation_token: token, actor: 'human-ui' })).status, 202)
    assert.equal((await call(`/projects/${project.id}`, 'DELETE', { confirmation_token: token, actor: 'human-ui' })).status, 403)
    for (let i = 0; i < 100 && (await call(`/projects/${project.id}`)).status !== 404; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal((await call(`/projects/${project.id}`)).status, 404); assert.equal(existsSync(workspace), false); assert.equal(existsSync(sessionDir), false);assert.equal(existsSync(chiefDir),false);assert.equal(existsSync(globalDir),true);assert.throws(()=>engine.chats.get(chief.id),/not found/);assert.equal(engine.chats.get(global.id).id,global.id)
    assert.equal(engine.operations.resource(durable).project_id, null)
    assert.throws(() => engine.operations.resource(disposable), /not found/i)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})

test('concurrent confirmations share cleanup and stale results cannot change a reused project', async t => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-delete-race-'))
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  const releases = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>()
  t.after(async () => {
    for (const release of releases.values()) release.resolve()
    await engine.close()
    rmSync(root, { recursive: true, force: true })
  })
  const { deletion, store } = engine
  const create = (title: string) => store.createProject({ title, origin: 'fixture', goal: 'retain evidence' }).project
  const remove = (id: string) => deletion.request(id, deletion.confirmation(id).confirmationToken, 'human-ui')!
  let stops = 0
  const entered = Promise.withResolvers<void>()
  deletion.stopRuntime = async id => { stops++; entered.resolve(); await releases.get(id)?.promise }
  const first = create('original'), independent = create('independent')
  releases.set(first.id, Promise.withResolvers<void>())
  const original = remove(first.id)
  assert.equal(remove(first.id), original)
  await entered.promise
  assert.equal(stops, 1)
  assert.equal(await deletion.complete(independent.id, remove(independent.id), true), true)
  releases.get(first.id)!.resolve()
  assert.equal(await deletion.complete(first.id, original, true), true)

  const replacement = create('replacement')
  assert.equal(replacement.id, first.id)
  releases.set(replacement.id, Promise.withResolvers<void>())
  const current = remove(replacement.id)
  assert.notEqual(current, original)
  assert.equal(await deletion.complete(replacement.id, original, true), false)
  assert.equal(await deletion.complete(replacement.id, original, false, 'late failure'), false)
  assert.equal(deletion.status(replacement.id)?.state, 'pending')
  assert.equal(store.project(replacement.id).title, 'replacement')
  releases.get(replacement.id)!.resolve()
  assert.equal(await deletion.complete(replacement.id, current, true), true)
})

test('project ids reuse the smallest free number and deletion leaves no counter or session residue', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-numbering-')), engine = await serveEngine({ root, port: 0, autoStart: false })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const call = async (route: string, method = 'GET', data?: unknown) => {
    const response = await fetch(url + route, { method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any }
  }
  const counterRows = (scope: string) => Number((engine.store.db.prepare('SELECT count(*) c FROM counters WHERE scope=?').get(scope) as { c: number }).c)
  const counterTotal = () => Number((engine.store.db.prepare('SELECT count(*) c FROM counters').get() as { c: number }).c)
  const create = async () => (await call('/v2/projects', 'POST', { mode:'general', title: 'T', origin: 'o', goal: 'g' })).data.project.id as string
  const remove = async (id: string) => {
    const token = (await call(`/projects/${id}/deletion/confirmation`, 'POST')).data.confirmationToken
    assert.equal((await call(`/projects/${id}`, 'DELETE', { confirmation_token: token, actor: 'human-ui' })).status, 202)
    for (let i = 0; i < 100 && (await call(`/projects/${id}`)).status !== 404; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal((await call(`/projects/${id}`)).status, 404)
  }
  try {
    const [first, second, third] = [await create(), await create(), await create()]
    assert.deepEqual([first, second, third], ['proj_001', 'proj_002', 'proj_003'])
    await call(`/v2/projects/${second}/hints`, 'POST', { content: 'consume a counter', creator: 'human' })
    assert.equal(counterRows(second) > 0, true)
    const session = 'run_numbering_fixture', sessionDir = path.join(root, '.redtrace/sessions/--workspace-proj_002--', session)
    mkdirSync(sessionDir, { recursive: true }); writeFileSync(path.join(sessionDir, 'session.jsonl'), '{}')
    engine.store.db.prepare('INSERT INTO audit_runs(id,project_id,data) VALUES (?,?,?)').run(session, second, JSON.stringify({ id: session, session_id: session }))
    await remove(second)
    assert.equal(counterRows(second), 0)
    assert.equal(existsSync(sessionDir), false)
    assert.equal(existsSync(path.join(root, '.redtrace/sessions/--workspace-proj_002--')), false)
    assert.equal(await create(), 'proj_002')
    await remove(third); await remove(first); await remove('proj_002')
    assert.equal(await create(), 'proj_001')
    assert.equal(counterTotal(), 0)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
