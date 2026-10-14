import { request, type APIRequestContext } from 'playwright'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Type } from 'typebox'
import { Check } from 'typebox/value'
import { HttpError } from './types.ts'
import { extractOutput } from './result-summary.ts'
import type { AgentTool } from './tool-types.ts'
import type { TaskContext } from './scheduler.ts'

type Session = { session?: string; challenge?: string; identity?: string }
type RequestInput = { url: string; method?: string; headers?: Record<string, string>; body?: string }
type Entry = { api: APIRequestContext; queue: Promise<void>; resourceId: string; stateFile: string }
const managers = new WeakMap<TaskContext['store'], Map<string, Entry>>()
const openings = new WeakMap<TaskContext['store'], Promise<void>>()
const sessionSchema = { session: Type.Optional(Type.String({ minLength: 1, maxLength: 96 })), challenge: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), identity: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })) }
const requestSchema = Type.Object({ url: Type.String({ minLength: 8, maxLength: 4096 }), method: Type.Optional(Type.Union(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].map(value => Type.Literal(value)))), headers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 4096 }))), body: Type.Optional(Type.String({ maxLength: 262144 })) })

function safeUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new HttpError(422, 'A valid absolute URL is required') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(422, 'Only credential-free HTTP(S) URLs are supported')
  return url
}
function sessions(context: TaskContext) {
  let entries = managers.get(context.store)
  if (!entries) { entries = new Map(); managers.set(context.store, entries) }
  return entries
}
async function entryFor(context: TaskContext, args: Session) {
  const ops = context.operations
  if (!ops) throw new Error('HTTP Resource service is unavailable')
  let result!: Entry
  const opening = (openings.get(context.store) ?? Promise.resolve()).then(async () => {
    const key = JSON.stringify([args.identity ?? 'anonymous', args.challenge ?? '', args.session ?? 'default'])
    let resource: any = args.session?.startsWith('http_') ? ops.ownedResource(context.run.projectId, args.session) : context.store.db.prepare("SELECT * FROM shared_resources WHERE project_id=? AND kind='http_session' AND json_extract(metadata_json,'$.session_key')=?").get(context.run.projectId, key)
    if (!resource) resource = ops.resource(ops.create(context.run.projectId, { kind: 'http_session', name: args.session ?? 'default', target: '', metadata: { session_key: key, identity: args.identity ?? 'anonymous', requests: {} }, actor_type: 'worker', actor: context.worker.name, worker: context.worker.name, intent_id: context.run.stepId }).resource.id)
    if (resource.kind !== 'http_session') throw new HttpError(422, 'Not an HTTP session Resource')
    ops.available(resource, { actor_type: 'worker', actor: context.worker.name })
    if (resource.status !== 'available') throw new HttpError(409, `HTTP session is ${resource.status}`)
    let entry = sessions(context).get(resource.id)
    if (!entry) {
      const stateFile = path.join(ops.outputRoot, 'http', 'sessions', `${resource.id}.json`)
      let state: Awaited<ReturnType<APIRequestContext['storageState']>> | undefined
      try { state = JSON.parse(await readFile(stateFile, 'utf8')) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      entry = { resourceId: resource.id, stateFile, queue: Promise.resolve(), api: await request.newContext({ ...(state ? { storageState: state } : {}) }) }
      sessions(context).set(resource.id, entry)
    }
    result = entry
  })
  openings.set(context.store, opening.catch(() => {})); await opening
  return result
}
async function persist(entry: Entry) {
  const state = await entry.api.storageState()
  await mkdir(path.dirname(entry.stateFile), { recursive: true, mode: 0o700 })
  const temporary = `${entry.stateFile}.${randomUUID()}.tmp`
  try { await writeFile(temporary, JSON.stringify(state), { mode: 0o600 }); await rename(temporary, entry.stateFile) }
  finally { await rm(temporary, { force: true }) }
}
export async function disposeHttpResource(store: TaskContext['store'], id: string, destroy = false) {
  const entry = managers.get(store)?.get(id)
  if (!entry) return
  if (!destroy) await persist(entry)
  managers.get(store)?.delete(id); await entry.api.dispose()
  await entry.queue
  if (destroy) await rm(entry.stateFile, { force: true })
}
export async function closeHttpSessions(store: TaskContext['store'], projectId?: string, destroy = false) {
  for (const [id, entry] of managers.get(store) ?? []) {
    const resource = store.db.prepare('SELECT project_id FROM shared_resources WHERE id=?').get(id)
    if (projectId && resource?.project_id !== projectId) continue
    await entry.queue
    if (!destroy && resource) await persist(entry)
    await entry.api.dispose(); managers.get(store)?.delete(id)
    if (destroy) await rm(entry.stateFile, { force: true })
  }
}
async function archive(context: TaskContext, record: unknown) {
  const bytes = Buffer.from(JSON.stringify(record)), sha256 = createHash('sha256').update(bytes).digest('hex'), id = `ev-${sha256}`
  const root = context.run.workspaceRoot ?? path.join(context.config.workspaceRoot ?? path.join(os.tmpdir(), 'redtrace-workspaces'), context.run.projectId)
  const directory = path.join(root, '.redtrace-output', 'evidence', context.run.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${id}.json`); await writeFile(file, bytes, { mode: 0o600 })
  return { id, bytes: bytes.length, sha256, file }
}
function changedFields(left: Buffer, right: Buffer): string[] | null {
  try {
    const flatten = (value: unknown, prefix = '$', output = new Map<string, string>()) => {
      if (value !== null && typeof value === 'object') for (const [key, child] of Object.entries(value)) flatten(child, Array.isArray(value) ? `${prefix}[${key}]` : `${prefix}.${key}`, output)
      else output.set(prefix, JSON.stringify(value))
      return output
    }
    const before = flatten(JSON.parse(left.toString())), after = flatten(JSON.parse(right.toString()))
    return [...new Set([...before.keys(), ...after.keys()])].filter(key => before.get(key) !== after.get(key)).slice(0, 20)
  } catch { return null }
}
async function batch(context: TaskContext, entry: Entry, requests: RequestInput[], parallel = false) {
  const ops = context.operations!
  const send = async (item: RequestInput, index: number) => {
    if (context.signal.aborted) throw new Error('HTTP operation cancelled; no automatic replay')
    const resource = ops.ownedResource(context.run.projectId, entry.resourceId)
    ops.available(resource, { actor_type: 'worker', actor: context.worker.name })
    if (resource.status !== 'available') throw new HttpError(409, `HTTP session is ${resource.status}`)
    const started = Date.now(), requestId = `req-${randomUUID()}`
    let response
    try {
      response = await entry.api.fetch(item.url, { method: item.method ?? 'GET', headers: item.headers, data: item.body, timeout: 20_000, maxRedirects: 0, maxRetries: 0 })
      const body = await response.body(), headers = response.headers(), evidence = await archive(context, { request: item, response: { status: response.status(), headers, bodyBase64: body.toString('base64') } })
      const row = ops.ownedResource(context.run.projectId, entry.resourceId), metadata = JSON.parse(row.metadata_json)
      metadata.requests ??= {}
      metadata.requests[requestId] = { file: evidence.file, sha256: evidence.sha256, run_id: context.run.id }
      ops.updateResource(entry.resourceId, { metadata_json: JSON.stringify(metadata) })
      return { index, request_id: requestId, method: item.method ?? 'GET', url: item.url, status: response.status(), location: headers.location ?? null, durationMs: Date.now() - started, responseBytes: body.length, responseSha256: createHash('sha256').update(body).digest('hex'), extraction: extractOutput(body.toString(), headers['content-type']), evidence, error: null }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error), evidence = await archive(context, { request: item, error: message, outcome: 'unknown; never automatically replay' })
      const publicError = Object.entries(item.headers ?? {}).filter(([key]) => /authorization|cookie|token|key/i.test(key)).reduce((text, [, value]) => text.split(value).join('[REDACTED]'), message).slice(0, 500)
      return { index, request_id: requestId, method: item.method ?? 'GET', url: item.url, status: null, location: null, durationMs: Date.now() - started, responseBytes: null, responseSha256: null, evidence, error: publicError }
    } finally { await response?.dispose() }
  }
  const results: Awaited<ReturnType<typeof send>>[] = []
  if (parallel) for (let i = 0; i < requests.length; i += 4) results.push(...await Promise.all(requests.slice(i, i + 4).map((item, j) => send(item, i + j))))
  else for (const [index, item] of requests.entries()) results.push(await send(item, index))
  const baseline = results.find(item => item.error === null)
  const baselineBody = baseline ? Buffer.from(JSON.parse(await readFile(baseline.evidence.file, 'utf8')).response.bodyBase64, 'base64') : undefined
  const displayed = []
  for (const item of results) {
    if (!baseline || !baselineBody || item.error) { displayed.push({ ...item, differenceFromFirst: null }); continue }
    const body = Buffer.from(JSON.parse(await readFile(item.evidence.file, 'utf8')).response.bodyBase64, 'base64'), sameBody = item.responseSha256 === baseline.responseSha256
    let offset = 0
    if (!sameBody) while (offset < baselineBody.length && offset < body.length && baselineBody[offset] === body[offset]) offset++
    displayed.push({ ...item, differenceFromFirst: { sameStatus: item.status === baseline.status, sameBody, firstDifferentByteOffset: sameBody ? null : offset, jsonChangedFields: changedFields(baselineBody, body) } })
  }
  return { session: entry.resourceId, resource_id: entry.resourceId, results: displayed }
}
export function httpTools(context: TaskContext): AgentTool[] {
  const tools = [
    { name: 'http_batch', label: 'http_batch', description: 'Send explicit HTTP requests without a browser. Project Resource cookies persist across Steps and restart. Session is optional; return its Resource id for reuse. Serial by default; parallel uses bounded groups of four. Full evidence is archived, failures are not automatically replayed.', parameters: Type.Object({ ...sessionSchema, requests: Type.Array(requestSchema, { minItems: 1 }), parallel: Type.Optional(Type.Boolean()) }), execute: async (_id: string, args: Session & { requests: RequestInput[]; parallel?: boolean }, entry: Entry) => batch(context, entry, args.requests, args.parallel) },
    { name: 'http_replay', label: 'http_replay', description: 'Explicitly replay an archived http_batch Request ID in its Project HTTP Resource. Uses the original method/body/headers and current cookies; supports query variants and explicit overrides. No hidden baseline request or automatic retry. Token names are not a permission gate.', parameters: Type.Object({ ...sessionSchema, request_id: Type.String({ minLength: 1, maxLength: 64 }), variants: Type.Array(Type.Array(Type.Object({ name: Type.String({ minLength: 1, maxLength: 128 }), value: Type.String({ maxLength: 4096 }) })), { minItems: 1 }), method: requestSchema.properties.method, body: requestSchema.properties.body, headers: requestSchema.properties.headers }), execute: async (_id: string, args: Session & { request_id: string; variants: { name: string; value: string }[][]; method?: string; body?: string; headers?: Record<string, string> }, entry: Entry) => {
      const record = JSON.parse(context.operations!.ownedResource(context.run.projectId, entry.resourceId).metadata_json).requests[args.request_id]
      if (!record) throw new Error('HTTP Request ID not found in this Project Resource')
      const bytes = await readFile(record.file)
      if (createHash('sha256').update(bytes).digest('hex') !== record.sha256) throw new Error('HTTP request evidence hash mismatch')
      const captured = JSON.parse(bytes.toString()).request as RequestInput
      const requests = args.variants.map(variant => {
        const url = safeUrl(captured.url)
        for (const field of variant) url.searchParams.set(field.name, field.value)
        return { ...captured, url: url.href, ...(args.method ? { method: args.method } : {}), ...(args.body !== undefined ? { body: args.body } : {}), ...(args.headers ? { headers: args.headers } : {}) }
      })
      return { request_id: args.request_id, ...await batch(context, entry, requests) }
    } },
  ]
  return tools.map(tool => ({ ...tool, executionMode: 'sequential', execute: async (_id: string, args: any) => {
    if (!Check(tool.parameters, args)) throw new HttpError(422, 'Invalid HTTP tool arguments')
    if (context.signal.aborted) throw new Error('HTTP operation cancelled before launch')
    if ('requests' in args) for (const item of args.requests) safeUrl(item.url)
    const entry = await entryFor(context, args)
    const work = entry.queue.then(async () => {
      if (context.signal.aborted) throw new Error('HTTP operation cancelled before launch')
      if (sessions(context).get(entry.resourceId) !== entry) throw new Error('HTTP session was closed or cancelled before this queued call; no request was executed')
      const cancel = () => { sessions(context).delete(entry.resourceId); void entry.api.dispose() }
      context.signal.addEventListener('abort', cancel, { once: true })
      try { return await (tool.execute as (id: string, args: any, entry: Entry) => Promise<unknown>)(_id, args, entry) }
      finally { context.signal.removeEventListener('abort', cancel); if (!context.signal.aborted && sessions(context).get(entry.resourceId) === entry) await persist(entry) }
    })
    entry.queue = work.then(() => {}, () => {}); return work
  } })) as unknown as AgentTool[]
}
