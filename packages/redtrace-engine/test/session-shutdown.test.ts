import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('concurrent native shutdown drains Commander session data without a disposed sessions lookup', { timeout: 20000 }, () => {
  execFileSync(process.execPath, [fileURLToPath(new URL('./session-shutdown.fixture.mjs', import.meta.url))], { timeout: 15000, stdio: 'pipe' })
})
