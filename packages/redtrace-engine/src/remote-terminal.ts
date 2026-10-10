import { readFileSync } from 'node:fs'
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2'
import type { Operations } from './operations.ts'
import { ExecutionError } from './execution-result.ts'

interface TerminalRecord { id: string; client: Client; stream: ClientChannel; buffer: string; base: number; eof: boolean; exitCode: number | null; createdAt: string }
export class RemoteTerminalManager {
  private readonly sessions = new Map<string, TerminalRecord>()
  private readonly operations: Operations
  constructor(operations: Operations) { this.operations = operations }
  async closeAll() { await Promise.all([...this.sessions].map(([id]) => this.close(id, 'runtime shutdown'))) }
  async open(project: string | null, sourceId: string, input: any) {
    const source = this.operations.resource(sourceId), metadata = JSON.parse(source.metadata_json), secret = JSON.parse(source.secret_json)
    if (source.project_id !== null && source.project_id !== project) throw new ExecutionError('AUTH_FAILED', 'SSH session belongs to another project')
    if (source.kind !== 'c2_session' || metadata.connection_type !== 'direct' || metadata.shell_type !== 'ssh' || metadata.runtime_verified !== true || !metadata.verified_capabilities?.includes('remote.command')) throw new ExecutionError('CAPABILITY_UNSUPPORTED', 'Persistent remote terminals require a runtime-verified direct SSH session')
    const privateKey = secret.private_key_path ? readFileSync(secret.private_key_path) : secret.private_key
    const config: ConnectConfig = { host: source.target, port: Number(metadata.port ?? 22), username: secret.username || metadata.username || process.env.USER || '', password: secret.password || secret.value, privateKey,
      readyTimeout: Math.max(1000, Number(metadata.connect_timeout ?? 20) * 1000), hostHash: 'sha256', hostVerifier: metadata.host_fingerprint ? (hash: string) => hash === metadata.host_fingerprint : undefined }
    const opened = await new Promise<{ client: Client; stream: ClientChannel }>((resolve, reject) => {
      const client = new Client(), fail = (error: Error) => { client.end(); reject(error) }
      client.once('ready', () => client.shell({ term: input.term ?? 'xterm-256color', rows: Number(input.rows ?? 24), cols: Number(input.cols ?? 80) }, (error, stream) => error ? fail(error) : resolve({ client, stream })))
      client.once('error', fail); client.connect(config)
    })
    const resource = this.operations.create(project, { kind: 'terminal', name: input.name || `terminal:${source.name}`, target: source.target, summary: 'Persistent SSH terminal', status: 'available',
      metadata: { protocol: 'ssh', stateful: true, interactive: true, pty: true, parent_session_id: source.id, host_id: metadata.host_id ?? null, route_id: metadata.route_id ?? null, network_context: metadata.network_context ?? 'local', conflict_key: `terminal:${source.id}:${crypto.randomUUID()}`, verified_capabilities: ['remote.terminal.read', 'remote.terminal.claim', 'remote.terminal.release', 'remote.terminal.send', 'remote.terminal.expect', 'remote.terminal.resize', 'remote.terminal.signal', 'remote.terminal.close'], runtime_verified: true, verified_at: new Date().toISOString() }, actor_type: 'system', actor: 'remote-terminal', parent_resource_id: source.id }).resource
    const record: TerminalRecord = { id: resource.id, ...opened, buffer: '', base: 0, eof: false, exitCode: null, createdAt: new Date().toISOString() }
    opened.stream.on('data', (chunk: Buffer) => { record.buffer += chunk.toString('utf8'); if (record.buffer.length > 1024 * 1024) { const drop = record.buffer.length - 1024 * 1024; record.buffer = record.buffer.slice(drop); record.base += drop } })
    const offline = (code?: number) => { record.eof = true; record.exitCode = code ?? null; this.sessions.delete(record.id); try { this.operations.updateResource(record.id, { status: 'offline' }) } catch {} }
    opened.stream.on('close', offline); opened.client.on('close', () => offline(record.exitCode ?? undefined))
    this.sessions.set(resource.id, record)
    try {
      const lease = this.operations.lease(this.operations.resource(resource.id), { owner_type: input.actor_type, owner: input.actor, run_id: input.run_id, ttl_seconds: input.ttl_seconds })
      return { terminal: this.operations.publicResource(this.operations.resource(resource.id)), lease }
    } catch (error) {
      this.sessions.delete(resource.id); opened.stream.end(); opened.client.end()
      this.operations.updateResource(resource.id, { status: 'offline', summary: 'Terminal closed because its write lease could not be acquired' })
      throw error
    }
  }
  read(id: string, cursor = 0, limit = 65536) {
    const record = this.record(id), from = Math.max(record.base, Number(cursor)), start = from - record.base, data = record.buffer.slice(start, start + Math.max(1, Math.min(262144, Number(limit))))
    return { terminal_id: id, cursor: from, next_cursor: from + data.length, dropped_before: record.base, data, eof: record.eof, exit_code: record.exitCode }
  }
  send(id: string, input: any) { const record = this.record(id); this.operations.checkLease(this.operations.resource(id), input); if (record.eof) throw new ExecutionError('TRANSPORT_ERROR', 'Terminal is closed'); record.stream.write(String(input.data ?? '')); return this.read(id, input.cursor ?? record.base + record.buffer.length, 1) }
  resize(id: string, input: any) { const record = this.record(id); this.operations.checkLease(this.operations.resource(id), input); record.stream.setWindow(Number(input.rows), Number(input.cols), 0, 0); return { terminal_id: id, rows: Number(input.rows), cols: Number(input.cols) } }
  signal(id: string, input: any) { const record = this.record(id); this.operations.checkLease(this.operations.resource(id), input); record.stream.signal(String(input.signal)); return { terminal_id: id, signal: input.signal } }
  async expect(id: string, input: any) {
    const timeout = Math.max(1, Math.min(300, Number(input.timeout ?? 30))) * 1000, deadline = Date.now() + timeout, cursor = Number(input.cursor ?? 0), needle = String(input.text)
    while (Date.now() < deadline) { const value = this.read(id, cursor, 262144), index = value.data.indexOf(needle); if (index >= 0) return { ...value, matched: true, match_cursor: value.cursor + index }; if (value.eof) return { ...value, matched: false, reason: 'EOF' }; await new Promise(resolve => setTimeout(resolve, 50)) }
    return { ...this.read(id, cursor, 262144), matched: false, reason: 'TIMEOUT' }
  }
  async close(id: string, reason = 'requested', input?: any) { const record = this.sessions.get(id); if (!record) return false; if (input) this.operations.checkLease(this.operations.resource(id), input); this.sessions.delete(id); record.stream.end(); record.client.end(); try { this.operations.updateResource(id, { status: 'offline', summary: `Terminal closed: ${reason}` }) } catch {}; return true }
  private record(id: string) { const value = this.sessions.get(id); if (!value) throw new ExecutionError('TRANSPORT_ERROR', 'Remote terminal is not live'); return value }
}
