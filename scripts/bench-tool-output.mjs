import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { createRequire, registerHooks } from 'node:module'
import { performance } from 'node:perf_hooks'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const repository = fileURLToPath(new URL('../', import.meta.url))
const moduleUrl = pathToFileURL(realpathSync(path.join(process.env.REDTRACE_CODE_ROOT ?? repository, 'packages/redtrace-dsh/lib/spill.js'))).href
const source = execFileSync('git', ['show', '42d6b795:packages/redtrace-dsh/src/spill.ts'], { cwd: repository, encoding: 'utf8' })
const baselineUrl = moduleUrl + '?original'
registerHooks({ load(url, context, next) {
  return url === baselineUrl ? { source, format: 'module-typescript', shortCircuit: true } : next(url, context)
} })
const { compactToolText: original } = await import(baselineUrl)
const binding = createRequire(import.meta.url)('../packages/redtrace-engine/src/native/redtrace_native.node')
const native = text => binding.compactToolTexts([text])[0] ?? text
const compact = process.argv.includes('--original-output') ? original : native
const emitted = execFileSync(process.execPath, ['-e', 'process.stdout.write("progress record: local fixture unchanged\\n".repeat(18000))'], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024 })
const clue = 'unique observation 中文 😀\r\nlocal proof retained\n'
const corpus = [emitted, emitted + clue + emitted, Array.from({ length: 6000 }, (_, i) => `unique local record ${i} 中文\n`).join(''), 'x'.repeat(900000), 'a\n'.repeat(12000), 'Unicode 😀 progress kept\r\n'.repeat(18000)]
const expected = corpus.map(original)
assert.deepEqual(corpus.map(native), expected)
const outputSha256 = createHash('sha256').update(JSON.stringify(expected)).digest('hex')
for (let i = 0; i < 3; i++) for (const text of corpus) compact(text)
let outputUnits = 0, peakHeapBytes = 0
const iterations = 300, cpuStart = process.cpuUsage(), start = performance.now()
for (let i = 0; i < iterations; i++) {
  for (const text of corpus) outputUnits += compact(text).length
  peakHeapBytes = Math.max(peakHeapBytes, process.memoryUsage().heapUsed)
}
const elapsedMs = performance.now() - start, cpu = process.cpuUsage(cpuStart)
assert.equal(outputUnits, expected.reduce((sum, text) => sum + text.length, 0) * iterations)
console.log(JSON.stringify({ implementation: compact === original ? 'original' : 'rust', calls: corpus.length * iterations, elapsedMs, cpuMs: (cpu.user + cpu.system) / 1000, peakHeapBytes, peakRssBytes: process.resourceUsage().maxRSS * 1024, outputUnits, outputSha256 }))
