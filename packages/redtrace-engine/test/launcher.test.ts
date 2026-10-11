import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'

test('platform launchers use the native DSH host without Python', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  for (const name of ['start-redtrace.cmd', 'start-redtrace.sh']) {
    const source = readFileSync(path.join(root, name), 'utf8')
    assert.match(source, /Node\.js 24\.15/)
    assert.match(source, /(?:run-redtrace-node\.mjs|\$RUN_SCRIPT)["']? --root/)
    assert.doesNotMatch(source, /\b(?:python|uv run|uv sync)\b/i)
  }
  const shell = readFileSync(path.join(root, 'start-redtrace.sh'), 'utf8')
  assert.match(shell, /REDTRACE_DSH_ROOT/)
  assert.match(shell, /ENGINE_RUNTIME=.*packages\/redtrace-engine/)
  assert.match(shell, /REDTRACE_SOURCE_ROOT/)
  assert.match(shell, /REDTRACE_DATA_ROOT/)
  const launcher = readFileSync(path.join(root, 'scripts/run-redtrace-node.mjs'), 'utf8')
  assert.match(launcher, /database: path\.join\(managed, 'engine\.db'\)/)
  assert.match(launcher, /RedTrace ready at/)
  assert.doesNotMatch(launcher, /if \(!values\.compat\)/)
  assert.match(readFileSync(path.join(root, 'packages/redtrace-engine/src/cli.ts'), 'utf8'), /run-redtrace-node\.mjs/)
  const cordis = readFileSync(path.join(root, 'packages/redtrace-engine/compat/cordis.mjs'), 'utf8')
  assert.match(cordis, /database: options\.database/)
  assert.match(cordis, /sessionRoot: path\.join\(managed, 'sessions'\)/)
})
