import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { dispatchVerb } from '../src/capability-verbs.ts'
import { fixtureAuthorize } from './execution-fixture.ts'

test('persistent SSH terminal is dispatchable and reusable across Worker Runs with fenced leases', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' }), clients = new Set<any>()
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'local-only' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept())
      session.on('window-change', accept => accept?.())
      session.on('signal', accept => accept?.())
      session.on('shell', accept => {
        const stream = accept(); stream.write('READY\n')
        stream.on('data', (data: Buffer) => { const value = data.toString(); stream.write(`ECHO:${value}`); if (value.includes('exit')) stream.end() })
      })
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-terminal-')), store = new Store(':memory:'), operations = new Operations(store, root)
  try {
    const { project } = store.createProject({ title: 'Terminal', origin: 'local fixture', goal: 'Verify terminal lifecycle' })
    const source = operations.create(project.id, { kind: 'c2_session', name: 'local SSH', target: '127.0.0.1', metadata: { connection_type: 'direct', shell_type: 'ssh', port: (server.address() as { port: number }).port, runtime_verified: true, verified_capabilities: ['remote.command'] }, secret: { username: 'fixture', password: 'local-only' } }).resource
    fixtureAuthorize(operations, project.id, source.id, ['terminal.open'])
    const originalLease = operations.lease.bind(operations)
    operations.lease = (() => { throw new Error('fixture lease failure') }) as typeof operations.lease
    await assert.rejects(operations.terminals.open(project.id, source.id, { actor_type: 'worker', actor: 'worker-a' }), /fixture lease failure/)
    operations.lease = originalLease
    const failedTerminal: any = store.db.prepare("SELECT id,status FROM shared_resources WHERE kind='terminal' ORDER BY created_at DESC LIMIT 1").get()
    assert.equal(failedTerminal.status, 'offline')
    assert.throws(() => operations.terminals.read(failedTerminal.id), /not live/)
    const signal = new AbortController().signal, first = { projectId: project.id, worker: 'worker-a', stepId: 'step-a', runId: 'run-a', signal }
    const opened = await dispatchVerb({ operations }, 'remote.terminal.open', { via: source.id }, first)
    assert.equal(opened.terminal.kind, 'terminal'); assert.equal(opened.terminal.metadata.runtime_verified, true)
    const terminal = opened.terminal.id, token = opened.lease.fencing_token
    fixtureAuthorize(operations, project.id, terminal, ['terminal.send', 'terminal.expect', 'terminal.read', 'terminal.claim', 'terminal.release', 'terminal.resize', 'terminal.signal', 'terminal.close'])
    await dispatchVerb({ operations }, 'remote.terminal.send', { via: terminal, data: 'hello\n', fencing_token: token }, first)
    const matched = await dispatchVerb({ operations }, 'remote.terminal.expect', { via: terminal, text: 'ECHO:hello', timeout: 2 }, first)
    assert.equal(matched.matched, true)
    operations.releaseRunLeases('run-a')
    const second = { projectId: project.id, worker: 'worker-b', stepId: 'step-b', runId: 'run-b', signal }
    const claimed = await dispatchVerb({ operations }, 'remote.terminal.claim', { via: terminal }, second)
    assert.ok(claimed.lease.fencing_token > token)
    await assert.rejects(dispatchVerb({ operations }, 'remote.terminal.send', { via: terminal, data: 'stale\n', fencing_token: token }, first), /fencing token/)
    await dispatchVerb({ operations }, 'remote.terminal.send', { via: terminal, data: 'next\n', fencing_token: claimed.lease.fencing_token }, second)
    assert.equal((await dispatchVerb({ operations }, 'remote.terminal.expect', { via: terminal, text: 'ECHO:next', timeout: 2 }, second)).matched, true)
    assert.equal((await dispatchVerb({ operations }, 'remote.terminal.close', { via: terminal, fencing_token: claimed.lease.fencing_token }, second)).closed, true)
    assert.equal(operations.resource(terminal).status, 'offline')
  } finally {
    await operations.close(); store.close(); rmSync(root, { recursive: true, force: true }); for (const client of clients) client.end(); await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
