import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { httpTools, closeHttpSessions, closeRunHttpSessions } from '../src/http-tools.ts'
import { graphTools } from '../src/runner.ts'
import type { TaskContext } from '../src/scheduler.ts'
import type { EngineConfig, Worker } from '../src/types.ts'
const { snapshotJsonValue } = await import(new URL('../../../vendor/deepseek-harness/packages/util/values/lib/index.js', import.meta.url).href)

test('HTTP Resource: optional session, Run-owned cookies/restart, isolation, replay, concurrent batches and no Browser', async () => {
  const seen: string[] = []
  const server = createServer((req, res) => {
    seen.push(req.url!)
    if (req.url === '/clues') { res.writeHead(403, { 'X-Clue': 'fixture-header', 'Set-Cookie': 'secret=fixture; Path=/' }); res.end('Payload: %00../secret\nError: at /target/probe:7\nflag{fixture_middle}'); return }
    if (req.url === '/broken') { req.socket.destroy(); return }
    if (req.url === '/set') res.setHeader('Set-Cookie', 'identity=fixture; Path=/')
    let body = '';req.on('data', chunk => body += chunk)
    req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ cookie: req.headers.cookie ?? 'anonymous', method: req.method, body, url: req.url, auth: req.headers.authorization ?? null })) })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`, root = mkdtempSync(path.join(tmpdir(), 'redtrace-http-')), store = new Store(':memory:'), operations = new Operations(store, root)
  const worker: Worker = { name: 'fixture', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }
  const project = store.createProject({ title: 'HTTP', origin: 'No tool-selection keywords', goal: 'fixture', bootstrap: false }).project
  const context = (pid = project.id): TaskContext => {
    const step = store.addStep(pid, { description: 'Inspect', sourceIds: ['origin'] }), run = store.claim(pid, 'execute', worker, step.id)
    run.workspaceRoot = path.join(root, pid)
    return { store, operations, run, worker, config: { workspaceRoot: root } as EngineConfig, signal: new AbortController().signal }
  }
  const first = context(), tools = httpTools(first), batch = tools.find(t => t.name === 'http_batch')!, replay = tools.find(t => t.name === 'http_replay')!
  const read = (result: any) => JSON.parse(readFileSync(result.evidence.file, 'utf8'))
  try {
    const graph = graphTools(first, () => {})
    assert.ok(graph.some(t => t.name === 'http_batch'))
    assert.equal(graph.some(t => ['web_open','web_snapshot','web_act','web_network'].includes(t.name)), false)
    const clues: any = await batch.execute('clues', { requests: [{ url: url + '/clues' }] })
    assert.equal(clues.results[0].status, 403)
    assert.equal(clues.results[0].headers['x-clue'], 'fixture-header')
    assert.match(clues.results[0].headers['set-cookie'], /secret=fixture/)
    assert.match(clues.results[0].body, /flag\{fixture_middle\}/)
    assert.equal(Buffer.from(read(clues.results[0]).response.bodyBase64, 'base64').toString(), clues.results[0].body)
    await closeHttpSessions(store, project.id, true)
    const initial: any = await batch.execute('set', { requests: [{ url: url + '/set' }] })
    const afterLogin: any = await batch.execute('after-login', { requests: [{ url }] })
    assert.ok(snapshotJsonValue(initial)); assert.match(initial.session, /^http_/)
    assert.equal(JSON.parse(Buffer.from(read(afterLogin.results[0]).response.bodyBase64, 'base64').toString()).cookie, 'identity=fixture')
    for (let i = 0; i < 10; i++) await batch.execute('extra', { session: 'extra-' + i, requests: [{ url }] })
    const second = context(), next = httpTools(second).find(t => t.name === 'http_batch')!
    const shared: any = await next.execute('shared', { requests: [{ url }] })
    assert.notEqual(shared.session, initial.session)
    assert.equal(JSON.parse(Buffer.from(read(shared.results[0]).response.bodyBase64, 'base64').toString()).cookie, 'anonymous')
    await assert.rejects(next.execute('cross-run', {session:initial.session,requests:[{url}]}), /another Run/)
    assert.throws(()=>operations.available(operations.resource(initial.session),{actor_type:'worker',actor:worker.name,run_id:second.run.id}), /another Run/)
    await closeRunHttpSessions(store.forProject(project.id), first.run.id)
    const stillIndependent:any=await next.execute('peer-alive',{requests:[{url}]})
    assert.equal(stillIndependent.session,shared.session)
    const restored: any = await batch.execute('restart', { session: initial.session, requests: [{ url }] })
    assert.equal(JSON.parse(Buffer.from(read(restored.results[0]).response.bodyBase64, 'base64').toString()).cookie, 'identity=fixture')
    const foreign = store.createProject({ title: 'Other', origin: 'scope', goal: 'fixture', bootstrap: false }).project
    await assert.rejects(httpTools(context(foreign.id)).find(t=>t.name==='http_batch')!.execute('foreign', { session: initial.session, requests: [{ url }] }), /not found in this Project/)
    const anonymous: any = await next.execute('identity', { identity: 'bob', requests: [{ url }] })
    assert.equal(JSON.parse(Buffer.from(read(anonymous.results[0]).response.bodyBase64, 'base64').toString()).cookie, 'anonymous')
    const captured: any = await batch.execute('capture', { requests: [{ url: url + '/post?csrf=one', method: 'POST', headers: { Authorization: 'Bearer fixture' }, body: 'retained-body' }] })
    const before = seen.length
    const replayed: any = await replay.execute('replay', { session: initial.session, request_id: captured.results[0].request_id, variants: Array.from({length: 5}, (_, i) => [{ name: 'token', value: String(i) }]) })
    assert.equal(seen.length - before, 5)
    assert.equal(replayed.results.length, 5)
    const replayBody = JSON.parse(Buffer.from(read(replayed.results[0]).response.bodyBase64, 'base64').toString())
    assert.equal(replayBody.method, 'POST'); assert.equal(replayBody.body, 'retained-body'); assert.equal(replayBody.auth, 'Bearer fixture')
    const many: any = await batch.execute('many', { requests: Array.from({length: 25}, () => ({ url })), parallel: true })
    assert.equal(many.results.length, 25)
    const broken: any = await batch.execute('broken', { requests: [{url: url + '/broken',method:'POST',body:'unknown'}] })
    assert.equal(broken.results[0].status, null); assert.match(read(broken.results[0]).outcome, /never automatically replay/)
    const count = seen.length
    for (const args of [{session: 123,requests:[{url}]},{requests:[{url:'file:///etc/passwd'}]},{requests:[{url: 'invalid'}]}]) await assert.rejects(batch.execute('invalid', args as any))
    assert.equal(seen.length, count)
    operations.updateResource(initial.session, {worker_paused: 1})
    await assert.rejects(batch.execute('paused', {session: initial.session,requests:[{url}]}), /paused/)
  } finally { await closeHttpSessions(store); await operations.close(); store.close(); server.closeAllConnections(); await new Promise<void>(r=>server.close(()=>r())); rmSync(root,{recursive:true,force:true}) }
})
