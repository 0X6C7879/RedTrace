import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

test('staged runtime loads both DSH and adapter code without redirecting source assets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'redtrace-loader-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const source = path.join(root, 'source'), code = path.join(root, 'code')
  const vendor = 'vendor/deepseek-harness/fixture.mjs'
  const adapter = 'packages/redtrace-dsh/lib/fixture.mjs'
  const asset = 'plugins/fixture.mjs'
  for (const base of [source, code]) {
    for (const relative of [vendor, adapter, asset]) {
      const filename = path.join(base, relative)
      await mkdir(path.dirname(filename), { recursive: true })
      await writeFile(filename, `export default ${JSON.stringify(base)}`)
    }
  }
  const previous = [process.env.REDTRACE_SOURCE_ROOT, process.env.REDTRACE_CODE_ROOT]
  process.env.REDTRACE_SOURCE_ROOT = source
  process.env.REDTRACE_CODE_ROOT = code
  let loader
  try { loader = await import('../lib/loader.js?split-roots') }
  finally {
    for (const [index, key] of ['REDTRACE_SOURCE_ROOT', 'REDTRACE_CODE_ROOT'].entries()) {
      if (previous[index] === undefined) delete process.env[key]
      else process.env[key] = previous[index]
    }
  }
  assert.equal((await loader.load(vendor)).default, code)
  assert.equal((await loader.load(adapter)).default, code)
  assert.equal((await loader.load(asset)).default, source)
  assert.equal(loader.repoRoot, source)
})
