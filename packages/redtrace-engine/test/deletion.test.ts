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
    const { project } = engine.store.createProject({ title: 'Delete', origin: 'input', goal: 'goal' }), workspace = path.join(engine.configuration.workspaceRoot, project.id)
    mkdirSync(workspace, { recursive: true }); writeFileSync(path.join(workspace, 'evidence.txt'), 'private')
    const session = 'run_delete_fixture', sessionDir = path.join(root, '.redtrace/sessions/project-fixture', session)
    mkdirSync(sessionDir, { recursive: true }); writeFileSync(path.join(sessionDir, 'session.jsonl'), '{}')
    engine.store.db.prepare('INSERT INTO audit_runs(id,project_id,data) VALUES (?,?,?)').run(session, project.id, JSON.stringify({ id: session, session_id: session }))
    const durable = engine.operations.create(project.id, { kind: 'webshell', name: 'keep', actor: 'human' }).resource.id
    const disposable = engine.operations.create(project.id, { kind: 'file', name: 'drop', actor: 'human' }).resource.id
    assert.equal((await call(`/projects/${project.id}`, 'DELETE')).status, 403)
    const token = (await call(`/projects/${project.id}/deletion/confirmation`, 'POST')).data.confirmationToken
    assert.equal((await call(`/projects/${project.id}`, 'DELETE', { confirmation_token: token, actor: 'human-ui' })).status, 202)
    assert.equal((await call(`/projects/${project.id}`, 'DELETE', { confirmation_token: token, actor: 'human-ui' })).status, 403)
    for (let i = 0; i < 100 && (await call(`/projects/${project.id}`)).status !== 404; i++) await new Promise(r => setTimeout(r, 10))
    assert.equal((await call(`/projects/${project.id}`)).status, 404); assert.equal(existsSync(workspace), false); assert.equal(existsSync(sessionDir), false)
    assert.equal(engine.operations.resource(durable).project_id, null)
    assert.throws(() => engine.operations.resource(disposable), /not found/i)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
