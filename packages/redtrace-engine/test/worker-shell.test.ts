import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout } from 'node:timers/promises'
import net from 'node:net'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { WorkerShells, workerShellTools } from '../src/worker-shell.ts'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { fixtureAuthorize } from './execution-fixture.ts'

async function waitOutput(shells: WorkerShells, run: string, id: string, pattern: RegExp) {
  for (let i = 0; i < 60; i++) {
    const result = await shells.read(run, id)
    const match = pattern.exec(result.output)
    if (match) return match
    await setTimeout(50)
  }
  throw new Error('Expected actual output not observed')
}

test('tmux retains PID/cwd/env; owns input, redacts secrets, cleans up and reports CLI exit', async () => {
  const shells = new WorkerShells()
  try {
    const { shell_id } = await shells.open('a', ['/bin/sh', '-i'], '/tmp')
    await shells.send('a', shell_id, `cd /tmp; export RT_STATE=kept; printf 'FIRST:%s:%s:%s\\n' "$${'$'}" "$PWD" "$RT_STATE"`)
    const first = await waitOutput(shells, 'a', shell_id, /FIRST:(\d+):\/tmp:kept/)
    await shells.send('a', shell_id, `printf 'SECOND:%s:%s:%s\\n' "$${'$'}" "$PWD" "$RT_STATE"`)
    const second = await waitOutput(shells, 'a', shell_id, /SECOND:(\d+):\/tmp:kept/)
    assert.equal(first[1], second[1])
    console.log(`PERSISTENCE pid=${first[1]} cwd=/tmp env=kept same_pid=true`)
    await assert.rejects(shells.send('b', shell_id, 'wrong'), /owned/)
    assert.deepEqual(await shells.list('b'), { shells: [] })
    await shells.send('a', shell_id, 'credential.+[private]', false, true)
    await setTimeout(100)
    assert.ok(!(await shells.read('a', shell_id)).output.includes('credential.+[private]'))
    await shells.close('a', shell_id); await shells.close('a', shell_id)
    for (let i = 0; i < 50; i++) { try { process.kill(Number(first[1]), 0) } catch { break }; await setTimeout(20) }
    assert.throws(() => process.kill(Number(first[1]), 0), { code: 'ESRCH' })
    const exited = await shells.open('a', ['/bin/sh', '-c', 'exit 7'], '/tmp')
    await setTimeout(150)
    assert.equal((await shells.read('a', exited.shell_id)).process_exit_code, 7)
    await shells.closeRun('a'); assert.deepEqual(await shells.list('a'), { shells: [] })
    await assert.rejects(shells.open('a', ['/bin/sh', '-i'], '/tmp'), /stopped/)
    console.log('CLEANUP owner_empty=true process_exit_code=7 foreign_run_denied=true')
  } finally { await shells.dispose() }
})

test('validation, concurrency, missing CLI, cancellation and stop gate', async () => {
  const shells = new WorkerShells()
  try {
    await assert.rejects(shells.open('x', ['echo bad; touch /tmp/WRONG'], '/tmp'), /Invalid/)
    await assert.rejects(shells.open('x', [], '/tmp'), /Invalid/)
    await assert.rejects(shells.open('x', ['/bin/sh', '-i'], '/not/a/directory'))
    const missing = await shells.open('x', ['/not/a/cli', 'argument'], '/tmp')
    await setTimeout(150)
    assert.equal((await shells.read('x', missing.shell_id)).running, false)
    await shells.close('x', missing.shell_id)
    const opened = await Promise.all(['x', 'y'].map(run => shells.open(run, ['/bin/sh', '-i'], '/tmp')))
    await Promise.all([shells.send('x', opened[0].shell_id, 'printf \"ONE:%s\\n\" 1'), shells.send('x', opened[0].shell_id, 'printf \"TWO:%s\\n\" 2')])
    await waitOutput(shells, 'x', opened[0].shell_id, /TWO:2/)
    shells.enabled = false; await shells.closeAll()
    await assert.rejects(shells.open('z', ['/bin/sh', '-i'], '/tmp'), /stopped/)
    assert.deepEqual(await shells.list('y'), { shells: [] })
    shells.enabled = true
    await shells.open('x', ['/bin/sh', '-i'], '/tmp')
    const signal = AbortSignal.abort()
    await assert.rejects(shells.open('z', ['/bin/sh', '-i'], '/tmp', signal))
  } finally { await shells.dispose() }
})

test('credential tool enforces project authorization and masks password', async () => {
  const store = new Store(':memory:'), operations = new Operations(store, '/tmp'), shells = new WorkerShells()
  try {
    const { project } = store.createProject({ title: 'Shell', origin: 'fixture', goal: 'local credential test' })
    const resource = operations.create(project.id, { kind: 'credential_ref', name: 'local', target: 'loopback', secret: { password: 'local-secret' } }).resource
    const context = { run: { id: 'credentials', projectId: project.id }, worker: { name: 'fixture' }, signal: new AbortController().signal } as any
    const tools = workerShellTools(context, shells, operations, '/tmp')
    const { shell_id } = await shells.open('credentials', ['/bin/sh', '-i'], '/tmp')
    const send = tools.find(t => t.name === 'shell_send')!
    await assert.rejects(send.execute('', { shell_id, credential_id: resource.id }), /authorization/)
    fixtureAuthorize(operations, project.id, resource.id, ['shell.send'])
    await send.execute('', { shell_id, credential_id: resource.id, submit: false })
    await setTimeout(100)
    assert.ok(!(await shells.read('credentials', shell_id)).output.includes('local-secret'))
    await assert.rejects(send.execute('', { shell_id, credential_id: resource.id, text: 'oops' }), /exactly one/)
  } finally { await shells.dispose(); await operations.close(); store.close() }
})

test('real OpenSSH client reuses one authentication and one remote shell process', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  let auth = 0, sessions = 0
  const clients = new Set<any>(), processes = new Set<ReturnType<typeof spawn>>()
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => { if (ctx.method === 'none') { auth++; ctx.accept() } else ctx.reject() })
    client.on('ready', () => client.on('session', accept => {
      const session = accept(); session.on('pty', accept => accept()); session.on('window-change', accept => accept?.())
      session.on('shell', accept => {
        sessions++; const stream = accept(), child = spawn('/bin/sh', ['-i'], { stdio: 'pipe' }); processes.add(child)
        stream.pipe(child.stdin); child.stdout.pipe(stream, { end: false }); child.stderr.pipe(stream.stderr, { end: false })
        child.on('exit', code => { processes.delete(child); stream.exit(code ?? 0); stream.end() })
        stream.on('close', () => child.kill('SIGKILL'))
      })
    }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const shells = new WorkerShells()
  try {
    const port = (server.address() as { port: number }).port
    const { shell_id } = await shells.open('ssh', ['ssh', '-tt', '-p', String(port), '-o', 'StrictHostKeyChecking=no', '-o', 'UserKnownHostsFile=/dev/null', '-o', 'BatchMode=yes', 'fixture@127.0.0.1'], '/tmp')
    await shells.send('ssh', shell_id, `cd /tmp; export RT_STATE=kept; printf 'SSH1:%s:%s:%s\\n' "$${'$'}" "$PWD" "$RT_STATE"`)
    const first = await waitOutput(shells, 'ssh', shell_id, /SSH1:(\d+):\/tmp:kept/)
    await shells.send('ssh', shell_id, `printf 'SSH2:%s:%s:%s\\n' "$${'$'}" "$PWD" "$RT_STATE"`)
    const second = await waitOutput(shells, 'ssh', shell_id, /SSH2:(\d+):\/tmp:kept/)
    assert.equal(first[1], second[1]); assert.equal(auth, 1); assert.equal(sessions, 1)
    console.log(`OPENSSH authentications=${auth} remote_shells=${sessions} same_pid=true cwd=/tmp env=kept`)
  } finally {
    await shells.dispose(); for (const child of processes) child.kill('SIGKILL'); for (const client of clients) client.end()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

const penelope = path.resolve('.redtrace/runtime/tools/bin/penelope')
for (const mode of ['bind', 'reverse']) test(`real Penelope ${mode} CLI retains remote PID/cwd/env`, { skip: !existsSync(penelope) }, async () => {
  const sockets = new Set<net.Socket>(), processes = new Set<ReturnType<typeof spawn>>()
  const attach = (socket: net.Socket) => {
    sockets.add(socket); const child = spawn('/bin/sh', ['-i']); processes.add(child)
    socket.pipe(child.stdin); child.stdout.pipe(socket, { end: false }); child.stderr.pipe(socket, { end: false })
    socket.on('error', () => {}); child.stdin.on('error', () => {})
    socket.on('close', () => { sockets.delete(socket); child.kill('SIGKILL') })
    child.on('exit', () => { processes.delete(child); socket.end() })
  }
  const server = net.createServer(mode === 'bind' ? attach : undefined)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as net.AddressInfo).port
  if (mode === 'reverse') await new Promise<void>(resolve => server.close(() => resolve()))
  const shells = new WorkerShells()
  try {
    const { shell_id } = await shells.open('penelope', [penelope, mode === 'bind' ? '-c' : '-i', '127.0.0.1', '-p', String(port), '-U', '-L', '-S'], '/tmp')
    if (mode === 'reverse') {
      await waitOutput(shells, 'penelope', shell_id, /Listening/)
      const socket = net.connect(port, '127.0.0.1'); await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject) }); attach(socket)
    }
    await waitOutput(shells, 'penelope', shell_id, /Interacting with session/)
    await shells.send('penelope', shell_id, `cd /tmp; export RT_STATE=kept; printf 'PEN1:%s:%s:%s\\n' "$${'$'}" "$PWD" "$RT_STATE"`)
    const first = await waitOutput(shells, 'penelope', shell_id, /PEN1:(\d+):\/tmp:kept/)
    await shells.send('penelope', shell_id, `printf 'PEN2:%s:%s:%s\\n' "$${'$'}" "$PWD" "$RT_STATE"`)
    const second = await waitOutput(shells, 'penelope', shell_id, /PEN2:(\d+):\/tmp:kept/)
    assert.equal(first[1], second[1])
    console.log(`PENELOPE mode=${mode} same_pid=true cwd=/tmp env=kept upgrade=disabled`)
  } finally {
    await shells.dispose(); for (const child of processes) child.kill('SIGKILL'); for (const socket of sockets) socket.destroy()
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
