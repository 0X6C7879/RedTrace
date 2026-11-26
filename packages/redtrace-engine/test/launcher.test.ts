import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'

test('platform launchers use the native DSH host without Python', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  for (const name of ['start-redtrace.cmd', 'start-redtrace.sh']) {
    const source = readFileSync(path.join(root, name), 'utf8')
    assert.match(source, /Node\.js 24\.11/)
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

test('Node version checks accept newer majors without a Node 24 ceiling', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  for (const filename of ['package.json', 'packages/redtrace-engine/package.json']) {
    const manifest = JSON.parse(readFileSync(path.join(root, filename), 'utf8'))
    const lock = JSON.parse(readFileSync(path.join(root, filename.replace('package.json', 'package-lock.json')), 'utf8'))
    assert.equal(manifest.engines.node, lock.packages[''].engines.node)
    assert.match(manifest.engines.node, /^\^24\.11\.0 \|\| >=26\.0\.0$/)
  }
  for (const filename of ['scripts/run-redtrace-node.mjs', 'packages/redtrace-engine/src/index.ts']) {
    const source = readFileSync(path.join(root, filename), 'utf8')
    const guard = source.match(/const \[major, minor\] = process\.versions\.node[^\n]+\n\s*if \([^\n]+/)
    assert.ok(guard, `${filename} must check the runtime minimum`)
    for (const node of ['24.11.0', '24.15.0', '26.0.0', '26.13.1', '28.0.0']) {
      assert.doesNotThrow(() => runInNewContext(guard[0], { process: { versions: { node } } }), `${filename}: ${node}`)
    }
    for (const node of ['20.19.0', '22.23.5', '24.10.0', '25.0.0']) {
      assert.throws(() => runInNewContext(guard[0], { process: { versions: { node } } }), /24\.11/)
    }
  }
})

test('Unix launcher accepts newer Node majors', { skip: process.platform === 'win32' }, () => {
  const source = readFileSync(path.resolve(import.meta.dirname, '../../../start-redtrace.sh'), 'utf8')
  const check = source.match(/node_is_supported\(\) \{[\s\S]*?\n\}/)
  assert.ok(check)
  const cases: Array<[string, string]> = [['20.19.0', 'no'], ['22.23.5', 'no'], ['24.10.0', 'no'], ['24.11.0', 'yes'], ['25.0.0', 'no'], ['26.0.0', 'yes'], ['26.13.1', 'yes']]
  for (const [version, expected] of cases) {
    const result: string = execFileSync('bash', ['-c', `${check[0]}\nnode_version="$1"\nnode() { printf 'v%s\\n' "$node_version"; }\nif node_is_supported node; then printf yes; else printf no; fi`, 'node-version-test', version], { encoding: 'utf8' })
    assert.equal(result, expected, version)
  }
})

test('DSH package manager runs without a global Corepack command', () => {
  const root = path.resolve(import.meta.dirname, '../../..')
  const expected = JSON.parse(readFileSync(path.join(root, 'vendor/deepseek-harness/package.json'), 'utf8')).packageManager.split('@')[1]
  const version = execFileSync(process.execPath, [path.join(root, 'scripts/dsh-pnpm.mjs'), '--version'], {
    env: { ...process.env, PATH: path.dirname(process.execPath) }, encoding: 'utf8',
  })
  assert.equal(version.trim(), expected)
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
