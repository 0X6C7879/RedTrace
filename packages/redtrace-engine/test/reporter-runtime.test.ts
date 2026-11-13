import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

test('native DSH separates Soldier verification from ARTEX Reporter and traces real retained responses', { timeout: 90000 }, async () => {
  const result = await promisify(execFile)(process.execPath, [new URL('./reporter-runtime.fixture.mjs', import.meta.url).pathname], { maxBuffer: 2 * 1024 * 1024 })
  assert.match(result.stdout, /REPORTER_RUNTIME_OK=true/)
  assert.match(result.stdout, /original_audit_read=true; retained_evidence_read=true/)
  assert.match(result.stdout, /live_model=false/)
})
