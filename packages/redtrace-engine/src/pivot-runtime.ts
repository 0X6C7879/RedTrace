import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import type { Operations } from './operations.ts'
import { ExecutionError } from './execution-result.ts'

interface PivotRecord { resourceId: string; process: ChildProcess; output: string }
export class PivotRuntime {
  private readonly records = new Map<string, PivotRecord>()
  private readonly operations: Operations
  private readonly root: string
  constructor(operations: Operations, root: string) { this.operations = operations; this.root = root }
  async closeAll() { await Promise.all([...this.records].map(([id]) => this.close(id))) }
  open(project: string | null, input: any) {
    const provider = String(input.provider ?? 'chisel'), source = input.source_session_id ? this.operations.resource(String(input.source_session_id)) : undefined
    let executable = '', args: string[] = []
    if (provider === 'ssh-forward') {
      if (!source) throw new ExecutionError('PROTOCOL_ERROR', 'ssh-forward requires source_session_id')
      const metadata = JSON.parse(source.metadata_json), secret = JSON.parse(source.secret_json), bind = String(input.bind ?? '127.0.0.1:1080'), [host, port] = bind.split(':')
      executable = metadata.executable || 'ssh'; args = ['-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=accept-new', '-D', `${host}:${Number(port)}`, ...(metadata.port ? ['-p', String(metadata.port)] : []), ...(secret.private_key_path ? ['-i', secret.private_key_path] : []), `${secret.username || metadata.username || ''}@${source.target}`]
    } else if (provider === 'chisel') {
      executable = path.join(this.root, 'tools/bin/chisel'); if (!existsSync(executable)) throw new ExecutionError('CAPABILITY_UNSUPPORTED', 'Managed chisel binary is unavailable')
      if (input.mode === 'server') args = ['server', '--host', String(input.bind_host ?? '127.0.0.1'), '--port', String(input.bind_port ?? 0), ...(input.reverse ? ['--reverse'] : [])]
      else { if (!input.server || !input.remote) throw new ExecutionError('PROTOCOL_ERROR', 'chisel client requires server and remote'); args = ['client', String(input.server), String(input.remote)] }
    } else if (provider === 'ligolo') {
      executable = path.join(this.root, `tools/bin/ligolo-ng_proxy_${process.platform === 'darwin' ? 'darwin' : 'linux'}_${process.arch === 'arm64' ? 'arm64' : 'amd64'}`)
      if (!existsSync(executable)) throw new ExecutionError('CAPABILITY_UNSUPPORTED', 'Managed ligolo proxy binary is unavailable for this host')
      args = ['-selfcert', '-laddr', String(input.bind ?? '127.0.0.1:11601')]
    } else throw new ExecutionError('CAPABILITY_UNSUPPORTED', `Unknown pivot provider: ${provider}`)
    const resource = this.operations.create(project, { kind: 'proxy', name: input.name || `${provider}:${input.bind ?? input.server ?? ''}`, target: String(input.target_scope ?? ''), status: 'offline', summary: `Managed ${provider} route`,
      metadata: { provider, direction: input.direction ?? 'forward', protocols: input.protocols ?? ['tcp'], source_resource_id: source?.id ?? null, target_scope: input.target_scope ?? '', dependencies: source ? [source.id] : [], command: [executable, ...args] }, actor_type: input.actor_type ?? 'worker', actor: input.actor ?? 'unknown', parent_resource_id: source?.id ?? null }).resource
    const child = spawn(executable, args, { cwd: this.root, env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: false }), record: PivotRecord = { resourceId: resource.id, process: child, output: '' }
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { record.output = (record.output + chunk.toString()).slice(-65536) })
    child.once('spawn', () => this.operations.updateResource(resource.id, { status: 'available', last_seen_at: new Date().toISOString() }))
    child.once('error', error => this.operations.updateResource(resource.id, { status: 'degraded', summary: error.message.slice(0, 1000) }))
    child.once('exit', code => { this.records.delete(resource.id); try { this.operations.updateResource(resource.id, { status: 'offline', summary: `${provider} exited ${code ?? 'unknown'}: ${record.output.slice(-500)}` }) } catch {} })
    this.records.set(resource.id, record)
    return { route: this.operations.publicResource(this.operations.resource(resource.id)), pid: child.pid ?? null }
  }
  async validate(id: string, input: any) {
    const resource = this.operations.resource(id), metadata = JSON.parse(resource.metadata_json), host = String(input.host ?? '127.0.0.1'), port = Number(input.port)
    if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new ExecutionError('PROTOCOL_ERROR', 'validate requires a TCP port')
    await new Promise<void>((resolve, reject) => { const socket = net.createConnection({ host, port }); const timer = setTimeout(() => socket.destroy(new Error('validation timeout')), Math.max(1, Math.min(30, Number(input.timeout ?? 5))) * 1000); socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve() }); socket.once('error', reject) })
    metadata.verified_at = new Date().toISOString(); metadata.verified_endpoint = `${host}:${port}`; this.operations.updateResource(id, { status: 'available', metadata_json: JSON.stringify(metadata), last_seen_at: metadata.verified_at }); return { route_id: id, reachable: true, endpoint: metadata.verified_endpoint }
  }
  paths(project: string | null, target: string) {
    const resources = this.operations.store.db.prepare("SELECT * FROM shared_resources WHERE kind IN ('proxy','c2_session') AND status='available' AND (project_id IS NULL OR project_id IS ?)").all(project) as any[]
    const routes = resources.filter(row => row.kind === 'proxy').filter(row => { const metadata = JSON.parse(row.metadata_json); return !target || String(metadata.target_scope ?? row.target).includes(target) || target.startsWith(String(metadata.target_scope ?? row.target)) })
      .sort((a, b) => { const am = JSON.parse(a.metadata_json), bm = JSON.parse(b.metadata_json); return Number(Boolean(bm.verified_at)) - Number(Boolean(am.verified_at)) || String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')) })
    return routes.map(row => ({ id: row.id, source_resource_id: JSON.parse(row.metadata_json).source_resource_id ?? null, target_scope: JSON.parse(row.metadata_json).target_scope ?? row.target, protocols: JSON.parse(row.metadata_json).protocols ?? ['tcp'], verified_at: JSON.parse(row.metadata_json).verified_at ?? null }))
  }
  async close(id: string) { const record = this.records.get(id); if (!record) return false; this.records.delete(id); record.process.kill('SIGTERM'); await new Promise(resolve => setTimeout(resolve, 50)); if (!record.process.killed) record.process.kill('SIGKILL'); try { this.operations.updateResource(id, { status: 'offline' }) } catch {}; return true }
}
