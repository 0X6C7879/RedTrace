import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import ssh2 from 'ssh2'
import { executeOperation } from '../src/operation-execution.ts'
import { Store } from '../src/store.ts'
import { Operations } from '../src/operations.ts'
import { dispatchVerb } from '../src/capability-verbs.ts'
import { fixtureAuthorize } from './execution-fixture.ts'

test('local SFTP transport handles binary, empty, Unicode, no-clobber, listing and hashes', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const files = new Map<string, Buffer>(), clients = new Set<any>()
  const { STATUS_CODE: status, OPEN_MODE: flags } = ssh2.utils.sftp
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'local-only' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', accept => {
      const session = accept()
      session.on('exec', (accept, _reject, info) => { if (!info.command.includes('version=1')) return; const stream = accept(); stream.exit(0); stream.end('version=1\nos=Linux\narch=x64\nuser=fixture\ncwd=/fixture\nhostname=fixture\n') })
      session.on('sftp', accept => {
      const sftp = accept(), handles = new Map<string, string>(); let next = 0
      const attrs = (name: string) => ({ mode: 0o100644, uid: 0, gid: 0, size: files.get(name)!.length, atime: 1, mtime: 1 })
      sftp.on('OPEN', (id, name, mode) => {
        if (files.has(name) && mode & flags.EXCL || !files.has(name) && !(mode & flags.CREAT)) return sftp.status(id, status.FAILURE)
        if (!files.has(name) || mode & flags.TRUNC) files.set(name, Buffer.alloc(0))
        const handle = Buffer.from(String(next++)); handles.set(handle.toString('hex'), name); sftp.handle(id, handle)
      })
      sftp.on('WRITE', (id, handle, offset, data) => {
        const name = handles.get(Buffer.from(handle).toString('hex')); if (!name) return sftp.status(id, status.FAILURE)
        const old = files.get(name)!, value = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(value); data.copy(value, offset)
        files.set(name, value); sftp.status(id, status.OK)
      })
      sftp.on('READ', (id, handle, offset, length) => {
        const name = handles.get(Buffer.from(handle).toString('hex')); if (!name) return sftp.status(id, status.FAILURE)
        const data = files.get(name)!.subarray(offset, offset + length); data.length ? sftp.data(id, data) : sftp.status(id, status.EOF)
      })
      sftp.on('CLOSE', (id, handle) => { handles.delete(Buffer.from(handle).toString('hex')); sftp.status(id, status.OK) })
      sftp.on('STAT', (id, name) => files.has(name) ? sftp.attrs(id, attrs(name)) : sftp.status(id, status.NO_SUCH_FILE))
      sftp.on('REALPATH', (id, name) => sftp.name(id, [{ filename: name === '.' ? '/fixture' : name, longname: name, attrs: { mode: 0o040755, uid: 0, gid: 0, size: 0, atime: 1, mtime: 1 } }]))
      sftp.on('FSTAT', (id, handle) => { const name = handles.get(Buffer.from(handle).toString('hex')); name && files.has(name) ? sftp.attrs(id, attrs(name)) : sftp.status(id, status.FAILURE) })
      sftp.on('OPENDIR', (id, name) => { const handle = Buffer.from(String(next++)); handles.set(handle.toString('hex'), 'directory:' + name); sftp.handle(id, handle) })
      sftp.on('READDIR', (id, handle) => {
        const dir = handles.get(Buffer.from(handle).toString('hex')); if (!dir) return sftp.status(id, status.EOF)
        handles.delete(Buffer.from(handle).toString('hex'))
        sftp.name(id, [...files.keys()].map(name => ({ filename: name.split('/').pop()!, longname: name, attrs: attrs(name) })))
      })
      sftp.on('RENAME', (id, source, destination) => {
        if (!files.has(source) || files.has(destination)) return sftp.status(id, status.FAILURE)
        files.set(destination, files.get(source)!); files.delete(source); sftp.status(id, status.OK)
      })
      sftp.on('REMOVE', (id, name) => sftp.status(id, files.delete(name) ? status.OK : status.NO_SUCH_FILE))
      })
    }))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const resource = { id: 'local-sftp-fixture', kind: 'c2_session', target: '127.0.0.1', metadata_json: JSON.stringify({ connection_type: 'direct', shell_type: 'ssh', port: (server.address() as { port: number }).port }), secret_json: JSON.stringify({ username: 'fixture', password: 'local-only' }) }
  const run = (action: string, args: object) => executeOperation(resource, { action, input_json: JSON.stringify({ ...args, timeout: 3 }) }, '.', new AbortController().signal)
  const artifactRoot = mkdtempSync(path.join(os.tmpdir(), 'redtrace-sftp-artifact-')), operationsRoot = mkdtempSync(path.join(os.tmpdir(), 'redtrace-sftp-operations-'))
  try {
    const name = "/fixture/空 '文件.bin", bytes = Buffer.from([0, 255, 10, 128])
    assert.equal((await run('write_file', { path: name, content_base64: bytes.toString('base64') })).exit_code, 0)
    assert.deepEqual(files.get(name), bytes)
    await assert.rejects(run('write_file', { path: name, content_base64: '' })); assert.deepEqual(files.get(name), bytes)
    assert.equal((await run('read_file', { path: name })).stdout, bytes.toString('base64'))
    assert.equal((await run('hash_file', { path: name })).stdout, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(JSON.parse((await run('stat_file', { path: name })).stdout!).size, 4)
    assert.equal(JSON.parse((await run('list_files', { path: '/fixture' })).stdout!)[0].name, "空 '文件.bin")
    await run('create_file', { path: '/fixture/empty' }); assert.equal(files.get('/fixture/empty')!.length, 0)
    await assert.rejects(run('move_file', { path: name, destination: '/fixture/empty' })); assert.deepEqual(files.get(name), bytes)
    await run('write_file', { path: name, content_base64: '', overwrite: true }); assert.equal(files.get(name)!.length, 0)
    await run('move_file', { path: name, destination: '/fixture/moved' }); assert.equal(files.has(name), false)
    await run('delete_file', { path: '/fixture/moved' }); assert.equal(files.has('/fixture/moved'), false)
    const source = path.join(artifactRoot, 'source.bin'), upload = Buffer.from('resumable-中文-binary\0\xff')
    writeFileSync(source, upload)
    const uploadHash = createHash('sha256').update(upload).digest('hex'), destination = '/fixture/upload.bin', partial = `${destination}.redtrace-${uploadHash.slice(0, 16)}.part`
    files.set(partial, upload.subarray(0, 5))
    const uploaded = JSON.parse((await run('upload_file', { path: destination, _source_path: source })).stdout!)
    assert.equal(uploaded.resumed_from, 5); assert.equal(uploaded.sha256, uploadHash); assert.deepEqual(files.get(destination), upload)
    const downloaded = await run('download_file', { path: destination, _artifact_directory: artifactRoot }), details = JSON.parse(downloaded.combined_output)
    assert.equal(details.sha256, uploadHash); assert.deepEqual(readFileSync(String(downloaded.execution_context.artifact_path)), upload)
    const probe = await run('probe_info', {})
    assert.equal(probe.execution_context.file_protocol, 'sftp')
    files.set('/fixture/shared.bin', Buffer.from('shared-artifact-\0\xff'))
    const store = new Store(':memory:'), operations = new Operations(store, operationsRoot)
    try {
      const { project } = store.createProject({ title: 'Shared artifacts', origin: 'local SFTP fixture', goal: 'Reuse a verified File across Workers' })
      const channel = operations.create(project.id, { kind: 'c2_session', name: 'local SFTP', target: '127.0.0.1', status: 'available', metadata: { connection_type: 'direct', shell_type: 'ssh', port: (server.address() as { port: number }).port, runtime_verified: true, verified_capabilities: ['remote.file.download', 'remote.file.upload'] }, secret: { username: 'fixture', password: 'local-only' } }).resource
      fixtureAuthorize(operations, project.id, channel.id, ['download_file', 'upload_file'])
      const signal = new AbortController().signal
      const downloaded = await dispatchVerb({ operations }, 'remote.file.download', { via: channel.id, path: '/fixture/shared.bin' }, { projectId: project.id, worker: 'worker-a', stepId: null, runId: 'run-a', signal })
      assert.equal(downloaded.status, 'succeeded')
      const fileId = downloaded.result.execution_context.file_resource_id
      assert.equal(operations.resource(fileId).kind, 'file')
      assert.equal(operations.resource(fileId).project_id, project.id)
      const uploaded = await dispatchVerb({ operations }, 'remote.file.upload', { via: channel.id, artifact_id: fileId, path: '/fixture/shared-copy.bin' }, { projectId: project.id, worker: 'worker-b', stepId: null, runId: 'run-b', signal })
      assert.equal(uploaded.status, 'succeeded')
      assert.deepEqual(files.get('/fixture/shared-copy.bin'), files.get('/fixture/shared.bin'))
    } finally { await operations.close(); store.close() }
  } finally { for (const client of clients) client.end(); await new Promise<void>(r => server.close(() => r())); rmSync(artifactRoot, { recursive: true, force: true }); rmSync(operationsRoot, { recursive: true, force: true }) }
})
