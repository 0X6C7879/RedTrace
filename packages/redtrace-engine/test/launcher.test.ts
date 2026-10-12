import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { parse } from 'yaml'

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

test('CI builds the native DSH runtime before Engine checks and tests', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const steps = parse(readFileSync(path.join(root, '.github/workflows/dsh-mainline.yml'), 'utf8')).jobs.test.steps
  const runs = steps.map((step: { run?: string }) => step.run)
  const requirements = runs.indexOf('python -m pip install -r tools/knowledge/requirements.txt')
  assert.ok(requirements >= 0 && requirements < runs.indexOf('npm test --prefix packages/redtrace-engine'))
  assert.equal(steps.find((step: { run?: string }) => step.run === 'npm test --prefix packages/redtrace-engine').env.REDTRACE_KNOWLEDGE_PYTHON, '${{ steps.python.outputs.python-path }}')
  const install = runs.indexOf('npm run dsh:install'), build = runs.indexOf('npm run dsh:build')
  assert.ok(install >= 0 && build > install, 'DSH must install before building')
  for (const command of ['npm run check --prefix packages/redtrace-engine', 'npm test --prefix packages/redtrace-engine', 'npm run dsh:test']) {
    assert.ok(runs.indexOf(command) > build, `${command} must run after DSH build`)
  }
})
