import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Store } from './store.ts'
import type { EngineConfig } from './types.ts'
import type { TaskContext } from './scheduler.ts'
import { toolEnvironment } from './shell.ts'

const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const caches = new WeakMap<Store, Map<string, Promise<VulnerabilityPage>>>()
const verifiedIndexes = new Map<string, Promise<void>>()
export async function verifyKnowledgeIndex(database: string) {
  const file = realpathSync(database), state = statSync(file), manifestFile = path.join(path.dirname(file), 'manifest.json')
  if (!existsSync(manifestFile)) throw new Error('Offline index provenance manifest missing; rebuild/import the data package')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  const key = JSON.stringify([file, state.size, state.mtimeMs, manifest.databaseSha256])
  let verified = verifiedIndexes.get(key)
  if (!verified) {
    verified = (async () => {
      const digest = createHash('sha256')
      for await (const chunk of createReadStream(file)) digest.update(chunk)
      if (digest.digest('hex') !== manifest.databaseSha256) throw new Error('Offline index SHA256 mismatch; no online repair attempted')
    })()
    verifiedIndexes.set(key, verified); if (verifiedIndexes.size > 16) verifiedIndexes.delete(verifiedIndexes.keys().next().value!)
    verified.catch(() => verifiedIndexes.delete(key))
  }
  await verified
}
export type VulnerabilityEntry = { id?: string; candidateId: string; kind: 'vulnerability'; name: string; cves: string[]; status: 'candidate' | 'not_applicable' | 'unknown'; sources: { id?: string; path?: string; source: string; sha256?: string; [key: string]: unknown }[]; [key: string]: unknown }
export type VulnerabilityPage = { results: VulnerabilityEntry[]; total: number; nextOffset: number | null; generation?: string; partial?: boolean; diagnostics: unknown[]; database?: string; dataRoot?: string; sources?: unknown[] }
export type VulnerabilityQuery = { query?: string; candidate_id?: string; component?: string; vendor?: string; version?: string; cpe?: string; version_scheme?: string; offset?: number; limit?: number; include_excluded?: boolean }

export function knowledgeEnvironment(config: EngineConfig) { return { ...process.env, ...config.commonEnv } }
export function knowledgeRepository(config: EngineConfig) { return config.workspaceRoot ? path.dirname(path.resolve(config.workspaceRoot)) : installRoot }
export function knowledgeData(config: EngineConfig) {
  const env = knowledgeEnvironment(config), repository = knowledgeRepository(config)
  const root = path.resolve(repository, env.REDTRACE_DATA_DIR ?? '.redtrace/data/knowledge')
  if (env.REDTRACE_VULN_DB) return { root, database: path.resolve(repository, env.REDTRACE_VULN_DB) }
  const manifest = path.join(root, 'current.json')
  if (!existsSync(manifest)) return { root }
  const value = JSON.parse(readFileSync(manifest, 'utf8')) as { generation: string; created?: number; partial?: boolean }
  if (!/^[A-Za-z0-9_-]+$/.test(value.generation)) throw new Error('Invalid offline data generation')
  return { root, database: path.join(root, 'generations', value.generation, 'vuln.sqlite'), manifest: value }
}

async function nativeJson<T>(executable: string, args: string[], input: unknown, config: EngineConfig, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('Knowledge operation cancelled')); return }
    const env = toolEnvironment(config.commonEnv)
    for (const key of Object.keys(env)) if (/key|token|secret|password|credential/i.test(key)) delete env[key]
    const child = spawn(executable, args, { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    let stdout = '', stderr = '', failure: Error | undefined
    const kill = (error: Error) => { failure = error; child.kill('SIGKILL') }
    const abort = () => kill(new Error('Knowledge operation cancelled'))
    const timer = setTimeout(() => kill(new Error('Offline knowledge helper timed out')), 30_000)
    signal?.addEventListener('abort', abort, { once: true })
    child.stdin.on('error', () => {}); child.stdin.end(JSON.stringify(input))
    child.stdout.on('data', (data: Buffer) => { stdout += data.toString('utf8'); if (Buffer.byteLength(stdout) > 16 * 1024 * 1024) kill(new Error('Offline helper output exceeded 16 MiB')) })
    child.stderr.on('data', (data: Buffer) => { stderr = (stderr + data.toString('utf8')).slice(-8192) })
    child.on('error', error => { failure = error })
    child.on('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort)
      if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`Offline helper exit ${code}: ${stderr}`))
      else { try { resolve(JSON.parse(stdout) as T) } catch { reject(new Error('Invalid offline helper JSON output')) } }
    })
  })
}
function python(config: EngineConfig) { return knowledgeEnvironment(config).REDTRACE_KNOWLEDGE_PYTHON ?? path.join(installRoot, '.redtrace/runtime/knowledge', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python') }

export async function vulnerabilitySearch(_evidenceRoot: string, context: TaskContext, args: VulnerabilityQuery): Promise<VulnerabilityPage> {
  let data: ReturnType<typeof knowledgeData>
  try { data = knowledgeData(context.config) } catch (error) { return { results: [], total: 0, nextOffset: null, diagnostics: [{ status: 'corrupt', error: String(error) }] } }
  const location = { dataRoot: data.root, database: data.database }
  if (!data.database || !existsSync(data.database)) return { ...location, results: [], total: 0, nextOffset: null, diagnostics: [{ status: 'missing', action: 'Explicitly import/build the offline data package; runtime never downloads' }] }
  if (!args.query && !args.component && !args.cpe) throw new Error('Provide query, component or cpe')
  const state = statSync(data.database), key = hash(JSON.stringify([data.database, state.size, state.mtimeMs, args]))
  let cache = caches.get(context.store)
  if (!cache) { cache = new Map(); caches.set(context.store, cache) }
  let result = cache.get(key)
  if (!result) {
    result = verifyKnowledgeIndex(data.database).then(() => nativeJson<VulnerabilityPage>(python(context.config), [path.join(installRoot, 'tools/knowledge/knowledge.py'), 'query', '--database', data.database!], args, context.config, context.signal))
      .then(value => {
        for (const item of value.results) item.id = item.candidateId.startsWith('CVE-') ? item.candidateId : item.sources.find(source => source.id)?.id
        return { ...value, ...location }
      })
    cache.set(key, result); if (cache.size > 128) cache.delete(cache.keys().next().value!)
    result.catch(() => cache!.delete(key))
  }
  try { return structuredClone(await result) }
  catch (error) { return { ...location, results: [], total: 0, nextOffset: null, diagnostics: [{ status: 'unavailable', error: String(error), action: 'Repair the local runtime/index; no online fallback was attempted' }] } }
}

export async function readVulnerability(config: EngineConfig, id: string, offset = 0, length = 8192) {
  const data = knowledgeData(config)
  if (!data.database || !existsSync(data.database)) return undefined
  await verifyKnowledgeIndex(data.database)
  const db = new DatabaseSync(data.database, { readOnly: true })
  try {
    if (/^CVE-\d{4}-\d{4,}$/i.test(id)) {
      const row = db.prepare('SELECT * FROM cves WHERE id=?').get(id.toUpperCase()) as { id: string; description: string; configurations: string; status: string; modified: string } | undefined
      if (!row) return undefined
      const body = Buffer.from(JSON.stringify({ ...row, configurations: JSON.parse(row.configurations), reference: `https://nvd.nist.gov/vuln/detail/${row.id}`, database: data.database }))
      if (offset > body.length) throw new Error('Offset is outside the entry')
      return { id: row.id, path: data.database, offset, totalBytes: body.length, text: body.subarray(offset, offset + length).toString('utf8'), nextOffset: offset + length < body.length ? offset + length : null }
    }
    const row = db.prepare('SELECT path,sha256 FROM artifacts WHERE id=?').get(id) as { path: string; sha256: string } | undefined
    if (!row) return undefined
    const root = realpathSync(path.dirname(data.database)), file = realpathSync(path.join(root, row.path))
    if (!file.startsWith(root + path.sep)) throw new Error('Knowledge source is outside the offline generation')
    const bytes = readFileSync(file)
    if (hash(bytes) !== row.sha256) throw new Error('Knowledge source changed; explicitly rebuild the offline index')
    if (offset > bytes.length) throw new Error('Offset is outside the source')
    return { id, path: file, sha256: row.sha256, offset, totalBytes: bytes.length, text: bytes.subarray(offset, offset + length).toString('utf8'), nextOffset: offset + length < bytes.length ? offset + length : null }
  } finally { db.close() }
}
