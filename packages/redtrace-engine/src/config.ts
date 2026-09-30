import { createHash, createHmac, createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { HttpError, integer, requiredText } from './types.ts'
import type { EngineConfig, Provider, Worker } from './types.ts'
import { JEV_SCENES, jevSceneDefault } from './jev.ts'
import type { JevScenes } from './jev.ts'

type RawModel = { id: string; context_window: number; max_tokens: number; reasoning?: string; reasoning_efforts?: Record<string, string | null> | boolean | null; thinking_format?: string }
type RawProvider = { api: Provider['api']; base_url: string; api_key?: string; api_key_env?: string; models: RawModel[] }
type RawWorker = { name: string; provider: string; model?: string; enabled?: boolean; bootstrap?: boolean; reason?: boolean; explore?: boolean; max_running?: number; priority?: number; backend?: Worker['backend'] }
export interface RawConfig { providers?: Record<string, RawProvider>; workers: RawWorker[]; runtime?: Record<string, unknown>; tasks?: Record<string, { timeout: number; conclude_timeout: number; max_intents?: number }>; common_env?: Record<string, string>; jev?: { scenes?: JevScenes }; [key: string]: unknown }
const secretPattern = /^\$\{REDTRACE_SECRET:([a-f0-9]{32})\}$/
const sensitiveEnvironment = /(?:^|_)(?:KEY|TOKEN|SECRET|PASSWORD)$/
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

export function atomicWrite(filename: string, value: string | Buffer) {
  mkdirSync(path.dirname(filename), { recursive: true })
  const tmp = `${filename}.${randomBytes(8).toString('hex')}.tmp`
  try {
    const fd = openSync(tmp, 'wx', 0o600)
    try { writeFileSync(fd, value); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(tmp, filename)
  } catch (error) { if (existsSync(tmp)) unlinkSync(tmp); throw error }
}
export function decryptSecrets(key: Buffer, encoded: string): Record<string, string> {
  const token = Buffer.from(encoded, 'base64url')
  if (key.length !== 32 || token.length < 73 || token[0] !== 0x80) throw new Error('Invalid secret store')
  const data = token.subarray(0, -32), mac = createHmac('sha256', key.subarray(0, 16)).update(data).digest()
  if (!timingSafeEqual(mac, token.subarray(-32))) throw new Error('Secret store authentication failed')
  const cipher = createDecipheriv('aes-128-cbc', key.subarray(16), token.subarray(9, 25))
  const value = JSON.parse(Buffer.concat([cipher.update(token.subarray(25, -32)), cipher.final()]).toString('utf8'))
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.values(value).some(v => typeof v !== 'string')) throw new Error('Invalid secret store')
  return value
}
export function encryptSecrets(key: Buffer, secrets: Record<string, string>) {
  const header = Buffer.alloc(9); header[0] = 0x80; header.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 1000)), 1)
  const iv = randomBytes(16), cipher = createCipheriv('aes-128-cbc', key.subarray(16), iv)
  const data = Buffer.concat([header, iv, cipher.update(JSON.stringify(secrets)), cipher.final()])
  return Buffer.concat([data, createHmac('sha256', key.subarray(0, 16)).update(data).digest()]).toString('base64url')
}

export class Configuration {
  readonly filename: string
  readonly root: string
  readonly secretRoot: string
  readonly workspaceRoot: string
  constructor(root: string, filename = path.join(root, '.redtrace/redtrace.yaml')) {
    this.root = path.resolve(root); this.filename = path.resolve(filename)
    this.secretRoot = path.join(path.dirname(this.filename), '.redtrace-secrets')
    this.workspaceRoot = path.join(root, 'workspaces')
  }
  initialize(source?: string) {
    if (existsSync(this.filename)) {
      const { raw, revision } = this.read()
      if (Object.values(raw.providers ?? {}).some(provider => provider.api_key && !secretPattern.test(provider.api_key))
        || Object.entries(raw.common_env ?? {}).some(([name, value]) => sensitiveEnvironment.test(name) && !secretPattern.test(value))) this.commit(revision, () => {})
      return
    }
    if (source && existsSync(source)) {
      const sourceSecrets = path.join(path.dirname(path.resolve(source)), '.redtrace-secrets')
      // Copy keys before publishing a configuration that refers to them.
      for (const file of ['master.key', 'worker-config.enc']) if (existsSync(path.join(sourceSecrets, file))) {
        mkdirSync(this.secretRoot, { recursive: true }); copyFileSync(path.join(sourceSecrets, file), path.join(this.secretRoot, file))
      }
      atomicWrite(this.filename, readFileSync(source))
    } else atomicWrite(this.filename, stringify({ providers: {}, workers: [], runtime: { max_workers: 4, max_project_workers: 4, max_running_projects: 1 }, tasks: { reason: { timeout: 300, conclude_timeout: 30, max_intents: 4 }, explore: { timeout: 900, conclude_timeout: 30 }, bootstrap: { timeout: 900, conclude_timeout: 30 } } } satisfies RawConfig))
    this.commit(this.read().revision, () => {})
  }
  read(): { raw: RawConfig; revision: string } {
    const content = readFileSync(this.filename)
    let raw: RawConfig
    try { raw = parse(content.toString('utf8')) } catch { throw new HttpError(503, 'Invalid configuration YAML') }
    if (!raw || !Array.isArray(raw.workers)) throw new HttpError(503, 'Configuration workers must be an array')
    return { raw, revision: hash(content) }
  }
  private secrets(): Record<string, string> {
    const data = path.join(this.secretRoot, 'worker-config.enc')
    if (!existsSync(data)) return {}
    return decryptSecrets(Buffer.from(readFileSync(path.join(this.secretRoot, 'master.key'), 'utf8').trim(), 'base64url'), readFileSync(data, 'utf8'))
  }
  resolve(raw: RawConfig): EngineConfig {
    if (raw.jev?.scenes !== undefined) {
      if (!raw.jev.scenes || typeof raw.jev.scenes !== 'object' || Array.isArray(raw.jev.scenes)) throw new HttpError(422, 'Invalid Jev scenes')
      for (const [scene, enabled] of Object.entries(raw.jev.scenes)) if (!(JEV_SCENES as readonly string[]).includes(scene) || typeof enabled !== 'boolean') throw new HttpError(422, `Invalid Jev scene: ${scene}`)
    }
    const secrets = this.secrets(), providers: Record<string, Provider> = {}
    const resolve = (value: string | undefined) => {
      const match = value?.match(secretPattern)
      if (!match) return value
      if (!(match[1] in secrets)) throw new HttpError(503, 'Missing configured credential')
      return secrets[match[1]]
    }
    for (const [name, p] of Object.entries(raw.providers ?? {})) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) throw new HttpError(422, 'Invalid provider name')
      if (!['openai-completions', 'openai-responses', 'anthropic-messages'].includes(p.api)) throw new HttpError(422, 'Unsupported provider API')
      const url = new URL(p.base_url)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(422, 'Invalid provider URL')
      if (!Array.isArray(p.models) || !p.models.length) throw new HttpError(422, 'Provider requires models')
      providers[name] = { api: p.api, baseUrl: p.base_url, apiKey: resolve(p.api_key), apiKeyEnv: p.api_key_env,
        models: p.models.map(m => ({ id: requiredText(m.id, 'model id'), contextWindow: integer(m.context_window ?? 1000000, 'context_window', 1), maxTokens: integer(m.max_tokens ?? 128000, 'max_tokens', 1), reasoning: m.reasoning ?? 'auto_max', reasoningEfforts: m.reasoning_efforts, thinkingFormat: m.thinking_format ?? 'auto' })) }
    }
    const workers = raw.workers.map(w => {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(w.name)) throw new HttpError(422, 'Invalid worker name')
      if (w.provider !== 'mock' && !providers[w.provider]?.models.some(m => m.id === w.model)) throw new HttpError(422, 'Worker references missing provider or model')
      if (w.backend && !['pi', 'dsh', 'mock'].includes(w.backend)) throw new HttpError(422, 'Invalid backend')
      return { name: w.name, provider: w.provider, model: w.model ?? 'mock', enabled: w.enabled ?? true, reason: w.reason ?? true, explore: w.explore ?? true, bootstrap: w.bootstrap ?? true,
        priority: integer(w.priority ?? 0, 'priority', -2147483648), maxRunning: integer(w.max_running ?? 1, 'max_running', 1), backend: w.provider === 'mock' ? 'mock' as const : w.backend ?? 'pi' }
    })
    if (new Set(workers.map(w => w.name)).size !== workers.length) throw new HttpError(422, 'Worker names must be unique')
    return { workers, providers, commonEnv: Object.fromEntries(Object.entries(raw.common_env ?? {}).map(([name, value]) => { if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string') throw new HttpError(422, 'Invalid common environment'); return [name, resolve(value)!] })), maxWorkers: integer(raw.runtime?.max_workers ?? 4, 'max_workers', 1), maxProjectWorkers: integer(raw.runtime?.max_project_workers ?? 4, 'max_project_workers', 1), maxRunningProjects: integer(raw.runtime?.max_running_projects ?? 1, 'max_running_projects', 1),
      maxSteps: raw.tasks?.reason?.max_intents === undefined ? null : integer(raw.tasks.reason.max_intents, 'max_intents', 1), decideTimeout: integer(raw.tasks?.reason?.timeout ?? 300, 'reason timeout', 1), executeTimeout: integer(raw.tasks?.explore?.timeout ?? 900, 'execute timeout', 1), concludeTimeout: integer(raw.tasks?.explore?.conclude_timeout ?? 30, 'conclude timeout', 1),
      bootstrapTimeout: integer(raw.tasks?.bootstrap?.timeout ?? 900, 'bootstrap timeout', 1), bootstrapConcludeTimeout: integer(raw.tasks?.bootstrap?.conclude_timeout ?? 30, 'bootstrap conclude timeout', 1), workspaceRoot: this.workspaceRoot }
  }
  snapshot() {
    const { raw, revision } = this.read(), config = this.resolve(raw)
    return { revision, engine: config.workers.every(w => w.backend === 'mock') ? 'mock' : 'dsh', execution: 'local', runtime_max_workers: config.maxWorkers,
      runtime: { max_workers: config.maxWorkers, max_project_workers: config.maxProjectWorkers, max_running_projects: config.maxRunningProjects },
      tasks: raw.tasks ?? {}, common_env: Object.entries(config.commonEnv ?? {}).map(([name, value]) => ({ name, value })),
      jev: { api_key_configured: !!process.env.TYPESAFE_API_KEY, scenes: Object.fromEntries(JEV_SCENES.map(scene => [scene, raw.jev?.scenes?.[scene] ?? jevSceneDefault(scene)])) },
      providers: Object.entries(raw.providers ?? {}).map(([name, p]) => ({ name, api: p.api, base_url: p.base_url, api_key_configured: !!p.api_key, api_key_env: p.api_key_env ?? null,
        models: p.models.map(m => ({ ...m, reasoning: m.reasoning ?? 'auto_max', reasoning_efforts: m.reasoning_efforts ?? null, thinking_format: m.thinking_format ?? 'auto' })), referenced: config.workers.some(w => w.provider === name) })),
      workers: config.workers.map(w => ({ name: w.name, type: w.provider === 'mock' ? 'mock' : 'dsh', provider: w.provider, model: w.model, enabled: w.enabled,
        bootstrap: w.bootstrap, reason: w.reason, explore: w.explore, task_types: [w.reason ? 'reason' : '', w.explore ? 'explore' : '', w.bootstrap ? 'bootstrap' : ''].filter(Boolean), priority: w.priority, max_running: w.maxRunning, editable: w.provider !== 'mock' })) }
  }
  commit(expected: string, mutate: (raw: RawConfig) => void) {
    const { raw, revision } = this.read()
    if (!expected || revision !== expected) throw new HttpError(409, 'worker configuration changed; reload before saving')
    mutate(raw); this.resolve(raw)
    const secrets = this.secrets()
    for (const p of Object.values(raw.providers ?? {})) if (p.api_key && !secretPattern.test(p.api_key)) {
      const id = randomBytes(16).toString('hex'); secrets[id] = p.api_key; p.api_key = '${REDTRACE_SECRET:' + id + '}'
    }
    for (const [name, value] of Object.entries(raw.common_env ?? {})) if (sensitiveEnvironment.test(name) && !secretPattern.test(value)) {
      const id = randomBytes(16).toString('hex'); secrets[id] = value; raw.common_env![name] = '${REDTRACE_SECRET:' + id + '}'
    }
    const keyFile = path.join(this.secretRoot, 'master.key')
    if (!existsSync(keyFile)) atomicWrite(keyFile, randomBytes(32).toString('base64url'))
    atomicWrite(path.join(this.secretRoot, 'worker-config.enc'), encryptSecrets(Buffer.from(readFileSync(keyFile, 'utf8'), 'base64url'), secrets))
    // Single engine writer; revision is checked again immediately before the atomic swap.
    if (this.read().revision !== revision) throw new HttpError(409, 'Configuration changed during save')
    atomicWrite(this.filename, stringify(raw)); return this.snapshot()
  }
}
