import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createHash, randomBytes } from 'node:crypto'
import { runShell, toolEnvironment } from '../src/shell.ts'
import { Configuration, decryptSecrets, encryptSecrets } from '../src/config.ts'

test('native shell captures output, cancels process trees and protects provider environment', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-shell-'))
  process.env.REDTRACE_TEST_API_KEY = 'private-model-key'
  try {
    assert.equal(toolEnvironment().REDTRACE_TEST_API_KEY, undefined)
    const result = await runShell(process.platform === 'win32' ? "[Console]::Write('shell-ok')" : "printf 'shell-ok'", root)
    const raw = readFileSync(result.outputPath)
    assert.equal(result.exitCode, 0); assert.match(result.text, /shell-ok/); assert.match(raw.toString(), /shell-ok/)
    assert.equal(result.bytes, raw.length); assert.equal(result.sha256, createHash('sha256').update(raw).digest('hex'))
    if (process.platform !== 'win32') {
      const failure = await runShell("printf error >&2; exit 7", root), failedOutput = readFileSync(failure.outputPath)
      assert.equal(failure.exitCode, 7); assert.equal(failure.text, 'error'); assert.equal(failure.bytes, 5)
      assert.equal(failure.sha256, createHash('sha256').update(failedOutput).digest('hex'))
    }
    const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 400)
    const start = Date.now()
    try { await assert.rejects(runShell(process.platform === 'win32' ? 'Start-Sleep -Seconds 60' : 'sleep 60', root, { signal: abort.signal }), /cancelled/); assert.ok(Date.now() - start < 15000) }
    finally { clearTimeout(timer) }
  } finally { delete process.env.REDTRACE_TEST_API_KEY; rmSync(root, { recursive: true, force: true }) }
})

test('authenticated secrets and revision conflicts preserve independent configuration copies', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-config-')), key = randomBytes(32)
  try {
    const encoded = encryptSecrets(key, { fixture: 'private' })
    assert.deepEqual(decryptSecrets(key, encoded), { fixture: 'private' })
    const tampered = Buffer.from(encoded, 'base64url'); tampered[30] ^= 1
    assert.throws(() => decryptSecrets(key, tampered.toString('base64url')), /authentication/)
    const c = new Configuration(root); c.initialize(); const before = c.read().revision
    c.commit(before, raw => { raw.providers = { fixture: { api: 'openai-completions', base_url: 'http://127.0.0.1:1234/v1', api_key: 'private-model-key', models: [{ id: 'fixture', context_window: 10000, max_tokens: 1000 }] } }; raw.workers = [{ name: 'fixture', provider: 'fixture', model: 'fixture' }] })
    assert.ok(!readFileSync(c.filename, 'utf8').includes('private-model-key'))
    assert.ok(!JSON.stringify(c.snapshot()).includes('private-model-key'))
    assert.equal(c.resolve(c.read().raw).providers.fixture.apiKey, 'private-model-key')
    assert.throws(() => c.commit(before, raw => { raw.workers = [] }), /changed/)
    const copy = new Configuration(root, path.join(root, 'copy/redtrace.yaml')); copy.initialize(c.filename)
    copy.commit(copy.read().revision, raw => { raw.workers[0].enabled = false })
    assert.equal(c.resolve(c.read().raw).workers[0].enabled, true)
    assert.equal(copy.resolve(copy.read().raw).providers.fixture.apiKey, 'private-model-key')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('shell retains stdout and stderr separately as well as the ordered full log', async()=>{
 const root=mkdtempSync(path.join(os.tmpdir(),'redtrace-streams-'))
 try {
  const output=await runShell('printf "fixture-out"; printf "fixture-error" >&2; exit 7',root)
  assert.equal(output.exitCode,7)
  assert.equal(readFileSync(output.stdoutPath,'utf8'),'fixture-out')
  assert.equal(readFileSync(output.stderrPath,'utf8'),'fixture-error')
  assert.equal(createHash('sha256').update(readFileSync(output.outputPath)).digest('hex'),output.sha256)
 } finally {rmSync(root,{recursive:true,force:true})}
})
