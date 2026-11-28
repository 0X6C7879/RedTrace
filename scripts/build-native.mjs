import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const directory = fileURLToPath(new URL('../packages/redtrace-engine/src/native/', import.meta.url))
const binary = path.join(directory, 'redtrace_native.node')
const stamp = path.join(directory, 'build.sha256')
const hash = createHash('sha256').update(`${process.platform}-${process.arch}`)
const sources = readdirSync(path.join(directory, 'src'), { recursive: true }).map(file => path.join('src', file)).filter(file => statSync(path.join(directory, file)).isFile()).sort()
for (const file of ['Cargo.toml', 'Cargo.lock', 'build.rs', ...sources]) hash.update(file).update(readFileSync(path.join(directory, file)))
const fingerprint = hash.digest('hex')
if (!existsSync(binary) || !existsSync(stamp) || readFileSync(stamp, 'utf8') !== fingerprint) {
  if (!process.argv.includes('--prebuilt')) {
    const target = path.resolve(process.env.CARGO_TARGET_DIR ?? path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), '.cache'), 'redtrace', 'cargo'))
    const result = spawnSync('cargo', ['build', '--release', '--locked', '--manifest-path', path.join(directory, 'Cargo.toml'), '--target-dir', target], { stdio: 'inherit' })
    if (result.error) throw new Error('Building RedTrace requires Rust 1.88+ and a C linker; install https://rustup.rs', { cause: result.error })
    if (result.status !== 0) process.exit(result.status ?? 1)
    const library = process.platform === 'win32' ? 'redtrace_native.dll' : `libredtrace_native.${process.platform === 'darwin' ? 'dylib' : 'so'}`
    const staging = path.join(directory, `.build-${process.pid}.node`)
    try {
      copyFileSync(path.join(target, 'release', library), staging)
      renameSync(staging, binary)
    } finally { rmSync(staging, { force: true }) }
  }
  const native = createRequire(import.meta.url)(binary)
  const exports = ['projectAuditEvents', 'compactToolTexts', 'rebuildKnowledgeIndex', 'readKnowledgeArtifact', 'rewriteToolNames', 'legionMission', 'activityPrompt', 'NativePlanGuard', 'NativeGraphNotice']
  if (exports.some(name => typeof native[name] !== 'function') || native.projectAuditEvents([]) !== '[]' || JSON.stringify(native.compactToolTexts([])) !== '[]') throw new Error('Native runtime self-check failed')
  writeFileSync(stamp, fingerprint)
}
