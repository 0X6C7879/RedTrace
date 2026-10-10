import { chromium, request, type APIRequestContext, type Browser, type BrowserContext, type Page, type Request, type Response } from 'playwright'
import { createHash } from 'node:crypto'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { redactSensitive } from './store.ts'
import { extractOutput } from './result-summary.ts'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TaskContext } from './scheduler.ts'
import type { Fact } from './types.ts'
import { HttpError } from './types.ts'

type Session = { session: string; challenge?: string; identity?: string }
type NetworkItem = { id: string; request?: Request; response?: Response; status?: number; size?: number; method: string; url: string; evidence?: Awaited<ReturnType<typeof archive>>; error?: string; pending?: Promise<void> }
type Entry = { context?: BrowserContext; page?: Page; api: APIRequestContext; queue: Promise<void>; epoch: number; touched: number; hosts: Set<string>; requests: NetworkItem[]; byRequest: WeakMap<Request,NetworkItem>; previousText?: string }
const sessionQueues = new WeakMap<TaskContext['store'], Promise<void>>()
const managers = new WeakMap<TaskContext['store'], Map<string, Entry>>()
let browser: Browser | undefined
let browserPromise: Promise<Browser> | undefined
const contexts = new Set<Entry>()
let serial = 0
const validSession = (value: string) => /^[A-Za-z0-9_.-]{1,96}$/.test(value)

function sessions(context: TaskContext) {
  let result = managers.get(context.store)
  if (!result) { result = new Map(); managers.set(context.store, result) }
  return result
}
function scopedHosts(context: TaskContext) {
  const scope = context.store.node<Fact>(context.run.projectId, 'origin', 'fact').description
  const hosts=new Set(Object.values(context.store.project(context.run.projectId).benchmarkHosts ?? {}).flat())
  for (const value of scope.match(/https?:\/\/[^\s),\]]+/gi) ?? []) {
    try { hosts.add(new URL(value.replace(/[.,;]+$/, '')).host.toLowerCase()) } catch {}
  }
  return hosts
}
function assertScoped(context: TaskContext, value: string) {
  const url = safeUrl(value)
  if (!scopedHosts(context).has(url.host.toLowerCase())) throw new HttpError(403, 'Web target is not present in the project Scope')
  return url
}
async function createEntry(context: TaskContext, args: Session, needsBrowser: boolean) {
  const { session, challenge = context.run.stepId ?? 'decide', identity = 'anonymous' } = args
  if (![session, challenge, identity].every(validSession)) throw new HttpError(422, 'session must be 1-96 letters, digits, dot, underscore or hyphen')
  const entries = sessions(context), key = `${context.run.projectId}:${challenge}:${identity}:${session}`
  let entry = entries.get(key)
  if (entry && Date.now() - entry.touched > 15 * 60_000) { contexts.delete(entry); await entry.queue; await Promise.all(entry.requests.map(item=>item.pending)); await entry.context?.close(); await entry.api.dispose(); entries.delete(key); entry = undefined }
  if (!entry) {
    if (entries.size >= 8) {
      const [oldest, victim] = [...entries.entries()].sort((a, b) => a[1].touched - b[1].touched)[0]
      contexts.delete(victim); await victim.queue; await Promise.all(victim.requests.map(item=>item.pending)); await victim.context?.close(); await victim.api.dispose(); entries.delete(oldest)
    }
    entry = { api: await request.newContext(), queue: Promise.resolve(), epoch: 0, touched: Date.now(), hosts: scopedHosts(context), requests: [], byRequest: new WeakMap() }
    entries.set(key, entry); contexts.add(entry)
  }
  if (needsBrowser && !entry.context) await serialized(entry, async () => {
    if (entry!.context) return
    try {
      browser ??= await (browserPromise ??= chromium.launch({headless:true,...(process.env.REDTRACE_BROWSER_CHANNEL ? {channel:process.env.REDTRACE_BROWSER_CHANNEL} : !existsSync(chromium.executablePath()) && process.platform==='darwin' && existsSync('/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge') ? {channel:'msedge'} : {})}))
      const browserContext = await browser.newContext({ storageState: await entry!.api.storageState() })
      const page = await browserContext.newPage(), created = entry!
      await page.route('**/*', async route => {
        const value = route.request().url()
        if (/^(?:data|blob):/i.test(value)) return route.continue()
        try { if (created.hosts.has(new URL(value).host.toLowerCase())) return route.continue() } catch {}
        await route.abort('blockedbyclient')
      })
      page.on('request', request => {const item={id:`net-${++serial}`,request,method:request.method(),url:request.url()};created.byRequest.set(request,item);created.requests.push(item)})
      page.on('response', response => { const item = created.byRequest.get(response.request()); if (item) { item.response = response; item.status = response.status(); item.size = Number(response.headers()['content-length']) || undefined } })
      const persist = (request: Request, error?: string) => {
        const item = created.byRequest.get(request)
        if (!item) return
        item.pending = (async () => {
          try {
            const response = item.response, body = response ? await response.body() : undefined
            item.evidence = await archive(context, { id:item.id, method: item.method, url: item.url, requestHeaders: await request.allHeaders(), requestBodyBase64: request.postDataBuffer()?.toString('base64') ?? null, status: item.status ?? null, responseHeaders: response ? await response.allHeaders() : {}, responseBodyBase64: body?.toString('base64') ?? null, error: error ?? null })
          } catch (failure) { item.error = String(failure) }
          finally { item.request = undefined; item.response = undefined }
        })()
      }
      page.on('requestfinished', request => persist(request))
      page.on('requestfailed', request => persist(request, request.failure()?.errorText ?? 'unknown'))
      created.context = browserContext; created.page = page
      await created.api.dispose(); created.api = browserContext.request
    } catch (error) { if (!browser) browserPromise = undefined; throw error }
  })
  entry.hosts = scopedHosts(context)
  entry.touched = Date.now()
  return entry
}
function entryFor(context: TaskContext, args: Session, needsBrowser = true) {
  const work = (sessionQueues.get(context.store) ?? Promise.resolve()).then(() => createEntry(context, args, needsBrowser))
  sessionQueues.set(context.store, work.then(() => {}, () => {}))
  return work
}
export async function closeWebSessions(store: TaskContext['store']) {
  const entries = managers.get(store)
  if (entries) {
    await Promise.all([...entries.values()].map(async entry => {
      contexts.delete(entry)
      await entry.queue
      await Promise.all(entry.requests.map(item => item.pending))
      await entry.context?.close().catch(() => {})
      await entry.api.dispose().catch(() => {})
    }))
    entries.clear()
  }
  if (!contexts.size && browser) {
    const current = browser
    browser = undefined; browserPromise = undefined
    await current.close()
  }
}
export async function closeWebChallenge(store: TaskContext['store'], projectId: string, challenge: string) {
  for(const [key,entry] of managers.get(store) ?? []){
    if(!key.startsWith(`${projectId}:${challenge}:`))continue
    await entry.queue;await Promise.all(entry.requests.map(item=>item.pending));await entry.context?.close();await entry.api.dispose().catch(()=>{})
    contexts.delete(entry);managers.get(store)?.delete(key)
  }
  store.db.prepare('DELETE FROM channel_versions WHERE project_id=? AND channel LIKE ?').run(projectId,`${projectId}:${challenge}:%`)
}
function serialized<T>(entry: Entry, action: () => Promise<T>): Promise<T> {
  const work = entry.queue.then(action)
  entry.queue = work.then(() => {}, () => {})
  return work
}
async function noteSessionVersion(context: TaskContext, entry: Entry) {
  const state=await entry.api.storageState()
  const key=[...sessions(context)].find(([,value])=>value===entry)?.[0]
  if (key) context.store.db.prepare('INSERT INTO channel_versions VALUES (?,?,?) ON CONFLICT(project_id,channel) DO UPDATE SET hash=excluded.hash').run(context.run.projectId,key,createHash('sha256').update(JSON.stringify(state)).digest('hex'))
}
async function snapshot(entry: Entry, context: TaskContext) {
  entry.epoch++
  let text = ''
  try { text = await entry.page!.locator('body').ariaSnapshot({ mode: 'ai', depth: 7, timeout: 3_000 }) }
  catch { try { text = await entry.page!.locator('body').innerText({ timeout: 2_000 }) } catch {} }
  const hiddenFields = await entry.page!.locator('input[type="hidden"]').evaluateAll(elements => elements.slice(0, 20).map(element => {
    const input = element as HTMLInputElement
    return { name: input.name.slice(0, 128), valueLength: input.value.length }
  })).catch(() => [])
  const forms = await entry.page!.locator('form').evaluateAll(elements => elements.map(form => ({ action: (form as HTMLFormElement).action, method: (form as HTMLFormElement).method, fields: [...form.querySelectorAll('input,select,textarea')].map(element => ({ name: (element as HTMLInputElement).name, type: (element as HTMLInputElement).type, value: (element as HTMLInputElement).value })) })))
  const evidence = await archive(context, { text, forms })
  const bytes = Buffer.from(text), truncated = bytes.length > 7600
  const changed = entry.previousText === undefined || entry.previousText !== text; entry.previousText = text
  return { changed, snapshotId: entry.epoch, url: entry.page!.url(), title: (await entry.page!.title().catch(() => '')).slice(0, 200), text: bytes.subarray(0, 7600).toString('utf8').replace(/\uFFFD$/, ''), truncated, hiddenFields, evidence }
}
function safeUrl(value: string) {
  let url: URL
  try { url = new URL(value) } catch { throw new HttpError(422, 'A valid absolute URL is required') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new HttpError(422, 'Only credential-free HTTP(S) URLs are supported')
  return url
}
async function archive(context: TaskContext, record: unknown) {
  const raw = Buffer.from(JSON.stringify(record)), id = `ev-${createHash('sha256').update(raw).digest('hex')}`
  const root = context.run.workspaceRoot ?? path.join(context.config.workspaceRoot ?? path.join(os.tmpdir(), 'redtrace-workspaces'), context.run.projectId)
  const directory = path.join(root, '.redtrace-output', 'evidence', context.run.id)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const file = path.join(directory, `${id}.json`)
  await writeFile(file, raw, { mode: 0o600 })
  return { id, bytes: raw.length, sha256: id.slice(3), file }
}
export function webTools(context: TaskContext): AgentTool[] {
  const tools = [
    { name: 'web_open', label: 'web_open', description: 'Open an authorized HTTP(S) page in a project/challenge/identity-isolated persistent Playwright BrowserContext. Returns a compact ARIA snapshot and live session id.', parameters: Type.Object({ url: Type.String({ minLength: 8, maxLength: 4096 }), session: Type.String({ minLength: 1, maxLength: 96 }), challenge: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), identity: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })) }), executionMode: 'sequential', execute: async (_id: string, args: Session & { url: string; session: string }) => {
      assertScoped(context, args.url); const entry = await entryFor(context, args)
      return serialized(entry, async () => { await entry.page!.goto(args.url, { waitUntil: 'domcontentloaded', timeout: 20_000 }); return { session: args.session, ...(await snapshot(entry, context)) } })
    } },
    { name: 'web_snapshot', label: 'web_snapshot', description: 'Read a bounded local ARIA snapshot of the current page. Take a fresh snapshot after every state-changing action.', parameters: Type.Object({ session: Type.String({ minLength: 1, maxLength: 96 }), challenge: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), identity: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), screenshot: Type.Optional(Type.Boolean()), selector: Type.Optional(Type.String({ maxLength:500 })) }), executionMode: 'sequential', execute: async (_id: string, args: Session & { session: string; screenshot?:boolean; selector?:string }) => {
      const entry = await entryFor(context,args); return serialized(entry,async()=>{
        const value=await snapshot(entry,context)
        if (!args.screenshot) return value
        if (!args.selector) throw new Error('A local screenshot requires an explicit selector')
        const locator=entry.page!.locator(args.selector); if (await locator.count()!==1) throw new Error('Screenshot selector must match exactly one element')
        const png=await locator.screenshot({timeout:5000}), evidence=await archive(context,{mimeType:'image/png',bodyBase64:png.toString('base64')})
        return {content:[{type:'text',text:JSON.stringify({...value,screenshotEvidence:evidence})},{type:'image',data:png.toString('base64'),mimeType:'image/png'}],details:value}
      })
    } },
    { name: 'web_act', label: 'web_act', description: 'Perform up to 8 explicit role/name-located browser actions from the latest snapshot. Stale snapshots or ambiguous locators are rejected, never blindly retried.', parameters: Type.Object({ session: Type.String({ minLength: 1, maxLength: 96 }), challenge: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), identity: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), snapshot_id: Type.Integer({ minimum: 1 }), actions: Type.Array(Type.Object({ action: Type.Union(['click','fill','select','press','check','uncheck'].map(value => Type.Literal(value))), role: Type.String({ minLength: 1, maxLength: 32 }), name: Type.String({ minLength: 1, maxLength: 300 }), value: Type.Optional(Type.String({ maxLength: 4096 })) }), { minItems: 1, maxItems: 8 }) }), executionMode: 'sequential', execute: async (_id: string, args: Session & { session: string; snapshot_id: number; actions: { action: string; role: string; name: string; value?: string }[] }) => {
      const entry = await entryFor(context, args)
      return serialized(entry, async () => {
        if (entry.epoch !== args.snapshot_id) throw new Error('Browser snapshot is stale; call web_snapshot before acting')
        entry.epoch++
        const observations = []
        for (const action of args.actions) {
          const locator = entry.page!.getByRole(action.role as never, { name: action.name, exact: true })
          const count = await locator.count()
          if (count !== 1) throw new Error(`Expected one ${action.role} named ${action.name}; found ${count}`)
          if (action.action === 'click') await locator.click({ timeout: 5_000 })
          else if (action.action === 'fill') await locator.fill(action.value ?? '', { timeout: 5_000 })
          else if (action.action === 'select') await locator.selectOption(action.value ?? '', { timeout: 5_000 })
          else if (action.action === 'press') await locator.press(action.value ?? 'Enter', { timeout: 5_000 })
          else if (action.action === 'check') await locator.check({ timeout: 5_000 })
          else await locator.uncheck({ timeout: 5_000 })
          observations.push({ action: action.action, role: action.role, name: action.name })
        }
        return { actions: observations, ...(await snapshot(entry, context)) }
      })
    } },
    { name: 'web_network', label: 'web_network', description: 'List the latest bounded browser network requests or inspect one request/response body on demand. Full details remain available as a local evidence artifact.', parameters: Type.Object({ session: Type.String({ minLength: 1, maxLength: 96 }), challenge: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), identity: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), request_id: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })) }), executionMode: 'sequential', execute: async (_id: string, args: Session & { session: string; request_id?: string }) => {
      const entry = await entryFor(context, args)
      return serialized(entry, async () => {
        if (!args.request_id) return { requests: entry.requests.slice(-40).map(item => ({ id: item.id, method: item.method, url: item.url, status: item.status ?? null, bytes: item.size ?? null, evidence: item.evidence ? { id: item.evidence.id, bytes: item.evidence.bytes } : null, error: item.error ?? null })) }
        const item = entry.requests.find(candidate => candidate.id === args.request_id)
        if (!item) throw new Error('Network request not found')
        await item.pending
        if (!item.evidence) return { id: item.id, status: item.status ?? null, error: item.error ?? 'Request has not completed; inspect again later' }
        const evidence = await archive(context, JSON.parse(await readFile(item.evidence.file, 'utf8')))
        return { id: item.id, method: item.method, url: item.url, status: item.status ?? null, evidence: { id: evidence.id, bytes: evidence.bytes, sha256: evidence.sha256 }, read: 'evidence_read({id})' }

      })
    } },
    { name: 'http_batch', label: 'http_batch', description: 'Send up to 20 explicit HTTP requests without launching a browser; reuse its cookie jar if already open. Serial by default; set parallel only for independent requests. Returns status/timing and compact body diffs, not full response bodies.', parameters: Type.Object({ session: Type.String({ minLength: 1, maxLength: 96 }), challenge: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), identity: Type.Optional(Type.String({ pattern: '^[A-Za-z0-9_.-]{1,96}$' })), requests: Type.Array(Type.Object({ url: Type.String({ minLength: 8, maxLength: 4096 }), method: Type.Optional(Type.Union(['GET','POST','PUT','PATCH','DELETE','HEAD'].map(value => Type.Literal(value)))), headers: Type.Optional(Type.Record(Type.String(), Type.String({ maxLength: 4096 }))), body: Type.Optional(Type.String({ maxLength: 262144 })) }), { minItems: 1, maxItems: 20 }), parallel: Type.Optional(Type.Boolean()) }), executionMode: 'sequential', execute: async (_id: string, args: Session & { session: string; requests: { url: string; method?: string; headers?: Record<string, string>; body?: string }[]; parallel?: boolean }) => {
      for (const item of args.requests) assertScoped(context, item.url)
      const entry = await entryFor(context, args, false)
      return serialized(entry, async () => {
        const run = async (item: typeof args.requests[number], index: number) => {
          const started = Date.now()
          let response
          try {
            response = await entry.api.fetch(item.url, { method: item.method ?? 'GET', headers: item.headers, data: item.body, timeout: 20_000, maxRedirects: 0, maxRetries:0 })
            const body = await response.body(), headers = response.headers()
            const record = { request: item, response: { status: response.status(), headers, bodyBase64: body.toString('base64') } }
            const evidence = await archive(context, record)
            return { index, method: item.method ?? 'GET', url: item.url, status: response.status(), location: headers.location ?? null, durationMs: Date.now() - started, responseBytes: body.length, responseSha256: createHash('sha256').update(body).digest('hex'), extraction:extractOutput(body.toString('utf8'),headers['content-type']), evidence, error:null }
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            const evidence = await archive(context, { request: item, error: message, outcome: 'unknown; never automatically replay' })
            const publicError=Object.entries(item.headers ?? {}).filter(([key])=>/authorization|cookie|token|key/i.test(key)).reduce((text,[,value])=>text.split(value).join('[REDACTED]'),message).slice(0,500)
            return { index, method: item.method ?? 'GET', url: item.url, status: null, location: null, durationMs: Date.now() - started, responseBytes: null, responseSha256: null, evidence, error:publicError }
          } finally { await response?.dispose() }
        }
        const results: Awaited<ReturnType<typeof run>>[] = []
        if (args.parallel) for (let i = 0; i < args.requests.length; i += 4) results.push(...await Promise.all(args.requests.slice(i, i + 4).map((item, j) => run(item, i + j))))
        else for (const [index, item] of args.requests.entries()) results.push(await run(item, index))
        const baseline=results.find(item=>item.error===null), displayed=[]
        let baselineBody: Buffer | undefined
        for(const item of results){
          if(!baseline || item.error){displayed.push({...item,differenceFromFirst:null});continue}
          const sameBody=item.responseSha256===baseline.responseSha256
          let firstDifferentByteOffset: number|null=null
          if(!sameBody){
            baselineBody ??= Buffer.from(JSON.parse(await readFile(baseline.evidence.file,'utf8')).response.bodyBase64,'base64')
            const body=Buffer.from(JSON.parse(await readFile(item.evidence.file,'utf8')).response.bodyBase64,'base64')
            let offset=0;while(offset<baselineBody.length && offset<body.length && baselineBody[offset]===body[offset])offset++
            firstDifferentByteOffset=offset
          }
          displayed.push({...item,differenceFromFirst:{sameStatus:item.status===baseline.status,sameBody,firstDifferentByteOffset}})
        }
        return {results:displayed}

      })
    } },
  ]
  return tools.map(tool=>({...tool,execute:async (...args: Parameters<typeof tool.execute>)=>{
    const input=args[1] as Session,key=`${context.run.projectId}:${input.challenge ?? context.run.stepId ?? 'decide'}:${input.identity ?? 'anonymous'}:${input.session}`
    if(context.signal.aborted)throw new Error('Web operation cancelled before launch')
    const cancel=()=>{
      const entry=sessions(context).get(key)
      if(entry){sessions(context).delete(key);contexts.delete(entry);void entry.context?.close().catch(()=>{});void entry.api.dispose().catch(()=>{})}
      context.store.db.prepare('DELETE FROM channel_versions WHERE project_id=? AND channel=?').run(context.run.projectId,key)
    }
    context.signal.addEventListener('abort',cancel,{once:true})
    try {return redactSensitive(await (tool.execute as (...args:any[])=>Promise<unknown>)(...args))}
    finally {context.signal.removeEventListener('abort',cancel);const entry=sessions(context).get(key);if(entry && !context.signal.aborted)await noteSessionVersion(context,entry)}
  }})) as unknown as AgentTool[]
}
