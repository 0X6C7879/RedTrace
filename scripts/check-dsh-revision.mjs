import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const expected = 'b150a551b8d465e31e418e1b2eaf5e79bbb7d28e'
const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const actual = execFileSync(
  'git',
  ['-C', resolve(root, 'vendor/deepseek-harness'), 'rev-parse', 'HEAD'],
  { encoding: 'utf8' },
).trim()

if (actual !== expected) {
  throw new Error(`DSH revision mismatch: expected ${expected}, got ${actual}`)
}
console.log(actual)
