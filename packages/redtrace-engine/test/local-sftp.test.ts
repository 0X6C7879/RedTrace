import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import ssh2 from 'ssh2'
import { executeOperation } from '../src/operation-execution.ts'

test('local SFTP transport handles binary, empty, Unicode, no-clobber, listing and hashes', async () => {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' })
  const files = new Map<string, Buffer>(), clients = new Set<any>()
  const { STATUS_CODE: status, OPEN_MODE: flags } = ssh2.utils.sftp
  const server = new ssh2.Server({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client))
    client.on('authentication', ctx => ctx.method === 'password' && ctx.password === 'local-only' ? ctx.accept() : ctx.reject())
    client.on('ready', () => client.on('session', accept => accept().on('sftp', accept => {
      const sftp = accept(), handles = new Map<string, string>(); let next = 0
      const attrs = (name: string) => ({ mode: 0o100644, uid: 0, gid: 0, size: files.get(name)!.length, atime: 1, mtime: 1 })
      sftp.on('OPEN', (id, name, mode) => {
        if (files.has(name) && mode & flags.EXCL || !files.has(name) && !(mode & flags.CREAT)) return sftp.status(id, status.FAILURE)
        if (!files.has(name) || mode & flags.TRUNC) files.set(name, Buffer.alloc(0))
        const handle = Buffer.from(String(next++)); handles.set(handle.toString(), name); sftp.handle(id, handle)
      })
      sftp.on('WRITE', (id, handle, offset, data) => {
        const name = handles.get(handle.toString()); if (!name) return sftp.status(id, status.FAILURE)
        const old = files.get(name)!, value = Buffer.alloc(Math.max(old.length, offset + data.length)); old.copy(value); data.copy(value, offset)
        files.set(name, value); sftp.status(id, status.OK)
      })
      sftp.on('READ', (id, handle, offset, length) => {
        const name = handles.get(handle.toString()); if (!name) return sftp.status(id, status.FAILURE)
        const data = files.get(name)!.subarray(offset, offset + length); data.length ? sftp.data(id, data) : sftp.status(id, status.EOF)
      })
      sftp.on('CLOSE', (id, handle) => { handles.delete(handle.toString()); sftp.status(id, status.OK) })
      sftp.on('STAT', (id, name) => files.has(name) ? sftp.attrs(id, attrs(name)) : sftp.status(id, status.NO_SUCH_FILE))
      sftp.on('FSTAT', (id, handle) => { const name = handles.get(handle.toString()); name && files.has(name) ? sftp.attrs(id, attrs(name)) : sftp.status(id, status.FAILURE) })
      sftp.on('OPENDIR', (id, name) => { const handle = Buffer.from(String(next++)); handles.set(handle.toString(), 'directory:' + name); sftp.handle(id, handle) })
      sftp.on('READDIR', (id, handle) => {
        const dir = handles.get(handle.toString()); if (!dir) return sftp.status(id, status.EOF)
        handles.delete(handle.toString())
        sftp.name(id, [...files.keys()].map(name => ({ filename: name.split('/').pop()!, longname: name, attrs: attrs(name) })))
      })
      sftp.on('RENAME', (id, source, destination) => {
        if (!files.has(source) || files.has(destination)) return sftp.status(id, status.FAILURE)
        files.set(destination, files.get(source)!); files.delete(source); sftp.status(id, status.OK)
      })
      sftp.on('REMOVE', (id, name) => sftp.status(id, files.delete(name) ? status.OK : status.NO_SUCH_FILE))
    })))
  })
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r))
  const resource = { id: 'local-sftp-fixture', kind: 'c2_session', target: '127.0.0.1', metadata_json: JSON.stringify({ connection_type: 'direct', shell_type: 'ssh', port: (server.address() as { port: number }).port }), secret_json: JSON.stringify({ username: 'fixture', password: 'local-only' }) }
  const run = (action: string, args: object) => executeOperation(resource, { action, input_json: JSON.stringify({ ...args, timeout: 3 }) }, '.', new AbortController().signal)
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
  } finally { for (const client of clients) client.end(); await new Promise<void>(r => server.close(() => r())) }
})
