import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { openIndex } from '../src/knowledge.ts'
import { readVulnerability } from '../src/knowledge-vuln.ts'
import type { EngineConfig } from '../src/types.ts'

test('native FTS rebuild preserves decoded text hashes, catalog privacy and freshness', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-knowledge-'))
  const source = path.join(root, 'skills'), wordlists = path.join(root, 'SecLists'), nuclei = path.join(root, 'nuclei'), filename = path.join(root, 'index.sqlite')
  mkdirSync(path.join(source, 'write-up'), { recursive: true }); mkdirSync(wordlists)
  const binary = path.join(source, 'invalid.txt'), ordinary = path.join(source, 'normal.md')
  writeFileSync(binary, Buffer.from([0x66, 0x6f, 0x80, 0x80, 0x6f]))
  writeFileSync(ordinary, 'Widget ordinary retained text')
  writeFileSync(path.join(source, 'private.md'), 'Widget TSecBench{private-fixture}')
  writeFileSync(path.join(source, 'write-up', 'private.md'), 'Widget hidden writeup')
  writeFileSync(path.join(wordlists, 'names.txt'), 'SECRET_WORDLIST_BODY')
  let db: DatabaseSync | undefined
  try {
    db = openIndex(root, filename, [source], [wordlists], nuclei)
    const rows = db.prepare('SELECT id,path,body FROM docs ORDER BY path').all()
    const decoded = readFileSync(binary, 'utf8'), invalid = rows.find(row => row.path === 'skills/invalid.txt')!
    assert.equal(invalid.body, decoded)
    assert.equal(invalid.id, createHash('sha256').update(decoded).digest('hex'))
    assert.equal(rows.length, 3)
    assert.match(String(rows.find(row => row.path === 'SecLists (catalog)')!.body), /1 files; 20 bytes; filenames and sizes only/)
    assert.doesNotMatch(JSON.stringify(rows), /private-fixture|hidden writeup|SECRET_WORDLIST_BODY/)
    const timestamp = db.prepare("SELECT value FROM index_state WHERE key='updated'").get()!.value
    db.close(); db = undefined
    writeFileSync(ordinary, 'Changed after freshness checkpoint')
    db = openIndex(root, filename, [source], [wordlists], nuclei)
    assert.deepEqual(db.prepare('SELECT id,path,body FROM docs ORDER BY path').all(), rows)
    assert.equal(db.prepare("SELECT value FROM index_state WHERE key='updated'").get()!.value, timestamp)
    db.prepare("UPDATE index_state SET value='0' WHERE key='updated'").run()
    db.close(); db = undefined
    unlinkSync(binary)
    db = openIndex(root, filename, [source], [wordlists], nuclei)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM docs').get()!.n, 2)
    assert.equal(db.prepare("SELECT body FROM docs WHERE path='skills/normal.md'").get()!.body, 'Changed after freshness checkpoint')
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }) }
})

test('native FTS rebuild rolls back documents and state together on persistence failure', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-knowledge-rollback-')), source = path.join(root, 'skills'), filename = path.join(root, 'index.sqlite')
  mkdirSync(source)
  writeFileSync(path.join(source, 'normal.md'), 'Original index body')
  let db: DatabaseSync | undefined
  try {
    db = openIndex(root, filename, [source], [], path.join(root, 'nuclei'))
    db.prepare("UPDATE index_state SET value='0' WHERE key='updated'").run()
    db.exec("CREATE TRIGGER fail_updated BEFORE INSERT ON index_state WHEN NEW.key='updated' BEGIN SELECT RAISE(ABORT,'fixture rollback'); END")
    const rows = db.prepare('SELECT * FROM docs ORDER BY rowid').all(), state = db.prepare('SELECT * FROM index_state ORDER BY key').all()
    db.close(); db = undefined
    writeFileSync(path.join(source, 'normal.md'), 'Changed index body')
    writeFileSync(path.join(source, 'added.md'), 'Additional index body')
    assert.throws(() => openIndex(root, filename, [source], [], path.join(root, 'nuclei')), /fixture rollback/)
    db = new DatabaseSync(filename)
    assert.deepEqual(db.prepare('SELECT * FROM docs ORDER BY rowid').all(), rows)
    assert.deepEqual(db.prepare('SELECT * FROM index_state ORDER BY key').all(), state)
  } finally { db?.close(); rmSync(root, { recursive: true, force: true }) }
})

test('native source reads retain byte paging and hash verification without retaining the complete source', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-source-')), database = path.join(root, 'vuln.sqlite'), filename = path.join(root, 'source.md')
  const bytes = Buffer.from('prefix 中文😀 suffix'), digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  writeFileSync(filename, bytes)
  const db = new DatabaseSync(database)
  db.exec('CREATE TABLE artifacts(id TEXT PRIMARY KEY,path TEXT,sha256 TEXT)')
  db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('source-fixture', 'source.md', digest(bytes)); db.close()
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ databaseSha256: digest(readFileSync(database)) }))
  const config = { workspaceRoot: path.join(root, 'workspaces'), commonEnv: { REDTRACE_VULN_DB: database } } as unknown as EngineConfig
  try {
    for (const [offset, length] of [[0, 8192], [8, 4], [bytes.length, 1], [-2, 1]]) {
      const result = await readVulnerability(config, 'source-fixture', offset, length)
      assert.deepEqual(result, { id: 'source-fixture', path: realpathSync(filename), sha256: digest(bytes), offset, totalBytes: bytes.length, text: bytes.subarray(offset, offset + length).toString('utf8'), nextOffset: offset + length < bytes.length ? offset + length : null })
    }
    assert.equal(await readVulnerability(config, 'missing'), undefined)
    await assert.rejects(readVulnerability(config, 'source-fixture', bytes.length + 1), /Offset is outside the source/)
    writeFileSync(filename, 'Changed source')
    await assert.rejects(readVulnerability(config, 'source-fixture'), /Knowledge source changed; explicitly rebuild the offline index/)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('native source pages are captured during the hash stream', { skip: process.platform === 'win32' }, async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-source-stream-')), database = path.join(root, 'vuln.sqlite'), filename = path.join(root, 'source.pipe')
  const bytes = Buffer.from('single-pass-page-content'), digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex')
  execFileSync('mkfifo', [filename])
  const db = new DatabaseSync(database)
  db.exec('CREATE TABLE artifacts(id TEXT PRIMARY KEY,path TEXT,sha256 TEXT)')
  db.prepare('INSERT INTO artifacts VALUES (?,?,?)').run('source-fixture', 'source.pipe', digest(bytes)); db.close()
  writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ databaseSha256: digest(readFileSync(database)) }))
  const config = { workspaceRoot: path.join(root, 'workspaces'), commonEnv: { REDTRACE_VULN_DB: database } } as unknown as EngineConfig
  let writer: ReturnType<typeof spawn> | undefined
  try {
    writer = spawn(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], Buffer.from(process.argv[2], "base64"))', filename, bytes.toString('base64')], { stdio: 'ignore' })
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      writer!.once('exit', (code, signal) => resolve({ code, signal }))
    })
    const result = await readVulnerability(config, 'source-fixture', 7, 4)
    assert.deepEqual(result, { id: 'source-fixture', path: realpathSync(filename), sha256: digest(bytes), offset: 7, totalBytes: bytes.length, text: 'pass', nextOffset: 11 })
    const exit = await exited
    assert.deepEqual(exit, { code: 0, signal: null })
  } finally { writer?.kill(); rmSync(root, { recursive: true, force: true }) }
})
