import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

test('native build fingerprints included resources, source paths and a clean checkout', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-build-'))
  const native = path.join(root, 'packages/redtrace-engine/src/native'), sources = path.join(native, 'src/runtime')
  const script = path.join(root, 'scripts/build-native.mjs'), preload = path.join(root, 'compiler.cjs'), calls = path.join(root, 'compiler-calls.jsonl')
  mkdirSync(sources, { recursive: true }); mkdirSync(path.dirname(script))
  copyFileSync(new URL('../../../scripts/build-native.mjs', import.meta.url), script)
  for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs']) writeFileSync(path.join(native, file), file)
  writeFileSync(path.join(native, 'src/lib.rs'), 'mod runtime;')
  const module = path.join(sources, 'domains.rs'), catalog = path.join(sources, 'catalog.json')
  writeFileSync(module, 'const CATALOG: &str = include_str!("catalog.json");')
  writeFileSync(catalog, '{"action":"original"}')
  // Only the compiler and native loader are external dependencies; fingerprinting and publication run unchanged.
  writeFileSync(preload, `
const fs = require('node:fs'), path = require('node:path'), child = require('node:child_process');
child.spawnSync = (command, args) => {
  if (command !== 'cargo') throw new Error('Unexpected compiler command: ' + command);
  fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify(args) + '\\n');
  const target = args[args.indexOf('--target-dir') + 1];
  const library = process.platform === 'win32' ? 'redtrace_native.dll' : 'libredtrace_native.' + (process.platform === 'darwin' ? 'dylib' : 'so');
  fs.mkdirSync(path.join(target, 'release'), {recursive: true});
  fs.writeFileSync(path.join(target, 'release', library), 'fixture native binary');
  return {status: 0};
};
require('node:module').syncBuiltinESMExports();
require.extensions['.node'] = module => {
  module.exports = {projectAuditEvents: () => '[]', compactToolTexts: () => []};
  if (!process.env.FIXTURE_OLD_ABI) {
    for (const name of ['rebuildKnowledgeIndex', 'readKnowledgeArtifact', 'rewriteToolNames',
      'legionMission', 'activityPrompt', 'NativePlanGuard', 'NativeGraphNotice']) {
      module.exports[name] = () => { throw new Error('The build must not execute a runtime export: ' + name); };
    }
  }
};
`)
  const run = (args: string[], oldAbi = false) => spawnSync(process.execPath, ['--require', preload, script, ...args], {
    encoding: 'utf8', env: { ...process.env, CARGO_TARGET_DIR: path.join(root, 'target'), FIXTURE_CALLS: calls, FIXTURE_OLD_ABI: oldAbi ? '1' : '' },
  })
  const build = (...args: string[]) => {
    const result = run(args)
    assert.equal(result.status, 0, result.stderr || String(result.error))
    return readFileSync(path.join(native, 'build.sha256'), 'utf8')
  }
  const compilations = () => existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0
  try {
    assert.equal(existsSync(path.join(native, 'redtrace_native.node')), false)
    const first = build()
    assert.match(first, /^[a-f0-9]{64}$/); assert.equal(compilations(), 1)
    assert.equal(build(), first); assert.equal(compilations(), 1)
    writeFileSync(module, 'const CATALOG: &str = include_str!("catalog.json");\n// changed module')
    const changedModule = build()
    assert.notEqual(changedModule, first); assert.equal(compilations(), 2)
    writeFileSync(catalog, '{"action":"changed"}')
    const changedCatalog = build()
    assert.notEqual(changedCatalog, changedModule); assert.equal(compilations(), 3)
    renameSync(module, path.join(sources, 'renamed.rs'))
    const changedPath = build()
    assert.notEqual(changedPath, changedCatalog); assert.equal(compilations(), 4)
    rmSync(path.join(native, 'build.sha256'))
    assert.equal(build('--prebuilt'), changedPath); assert.equal(compilations(), 4)
    writeFileSync(catalog, '{"action":"new ABI"}')
    const stale = run(['--prebuilt'], true)
    assert.notEqual(stale.status, 0)
    assert.match(stale.stderr, /Native runtime self-check failed/)
    assert.equal(readFileSync(path.join(native, 'build.sha256'), 'utf8'), changedPath)
    rmSync(path.join(native, 'build.sha256'))
    assert.notEqual(run(['--prebuilt'], true).status, 0)
    assert.equal(existsSync(path.join(native, 'build.sha256')), false)
    assert.equal(compilations(), 4)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
