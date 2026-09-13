import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Configuration, serveEngine } from '../src/index.ts'

test('HTTP graph compatibility and atomic conclude survive reopening the database', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-api-'))
  let engine = await serveEngine({ root, port: 0, autoStart: false })
  const request = async (pathname: string, method = 'GET', body?: unknown) => {
    const address = engine.server.address() as { port: number }
    const response = await fetch(`http://127.0.0.1:${address.port}${pathname}`, { method, ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any }
  }
  try {
    assert.equal((await request('/projects', 'POST', { title: '' })).status, 422)
    const created = await request('/projects', 'POST', { title: 'Test', origin: 'Input', goal: 'Verified result' })
    assert.equal(created.status, 201); const id = created.data.project.id, base = `/projects/${id}`
    const step = await request(`${base}/intents`, 'POST', { from: ['origin'], description: 'Check input', creator: 'human', capabilities: ['common'] })
    assert.equal(step.status, 201)
    assert.equal((await request(`${base}/intents/${step.data.id}/claim`, 'POST', { worker: 'w1' })).status, 200)
    assert.equal((await request(`${base}/intents/${step.data.id}/conclude`, 'POST', { worker: 'w2', description: 'Invalid owner' })).status, 409)
    assert.equal((await request(base)).data.facts.length, 2)
    const concluded = await request(`${base}/intents/${step.data.id}/conclude`, 'POST', { worker: 'w1', description: 'Input checked' })
    assert.equal(concluded.status, 200); assert.equal(concluded.data.intent.to, concluded.data.fact.id)
    assert.equal((await request(`${base}/complete`, 'POST', { from: [concluded.data.fact.id], description: 'Result verified', worker: 'w1' })).data.to, 'goal')
    assert.equal((await request(`${base}/hints`, 'POST', { content: 'Review later', creator: 'human' })).status, 201)
    const reopened = await request(`${base}/reopen`, 'POST', { description: 'One more check', creator: 'human' })
    assert.equal(reopened.status, 200); assert.deepEqual(reopened.data.intent.from, ['goal'])
    const graph = (await request(`/v2${base}/graph`)).data
    assert.equal(graph.goals[0].kind, 'goal'); assert.equal(graph.facts.some((f: any) => f.id === 'goal'), false)
    const replayed = (await request(`/v2${base}/graph?revision=${graph.project.revision}`)).data
    for (const kind of ['nodes', 'edges', 'steps', 'goals', 'facts', 'findings']) assert.deepEqual(replayed[kind], graph[kind], `${kind} must replay the recorded state`)
    assert.ok(graph.nodes.every((n: any) => ['scope', 'fact', 'finding', 'subgoal', 'goal'].includes(n.nodeType)))
    const initial = (await request(`/v2${base}/graph?revision=1`)).data
    assert.equal(initial.nodes.length, 2); assert.equal(initial.goals[0].status, 'open'); assert.equal(initial.steps.length, 0)
    assert.equal((await request(`/v2${base}/graph?revision=999999`)).status, 422)
    const runs = (await request(`/v2${base}/steps/${step.data.id}/runs`)).data
    assert.equal(runs.length, 1)
    engine.store.runEvent(runs[0].id, 'assistant.message', { content: 'Traceable execution' })
    const logs = (await request(`/v2${base}/runs/${runs[0].id}/events`)).data
    assert.ok(logs.some((event: any) => JSON.stringify(event).includes('Traceable execution')))
    const other = (await request('/v2/projects', 'POST', { title: 'Other', origin: 'Other scope', goal: 'Other goal' })).data.project.id
    assert.equal((await request(`/v2/projects/${other}/runs/${runs[0].id}/events`)).status, 404)
    assert.equal((await request(`${base}/blackboard/path?source=origin&target=${concluded.data.fact.id}`)).data.found, true)
    await engine.close(); engine = await serveEngine({ root, port: 0, autoStart: false })
    assert.deepEqual((await request(`/v2${base}/graph`)).data, graph)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})

test('standalone mock closes the whole HTTP project without Python or DSH', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-loop-')), config = new Configuration(root)
  config.initialize(); config.commit(config.read().revision, raw => { raw.workers = [{ name: 'mock', provider: 'mock', max_running: 4 }] })
  const engine = await serveEngine({ root, port: 0 })
  try {
    const address = engine.server.address() as { port: number }, url = `http://127.0.0.1:${address.port}`
    const response = await fetch(`${url}/v2/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Mock', origin: 'Fixture', goal: 'Produce verified finding' }) })
    const { project } = await response.json() as any
    for (let i = 0; i < 200 && engine.store.project(project.id).status !== 'completed'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const graph = engine.store.graph(project.id)
    assert.equal(graph.project.status, 'completed'); assert.equal(graph.findings.length, 1)
    assert.ok(engine.store.runs(project.id).every(r => r.status === 'succeeded'))
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
