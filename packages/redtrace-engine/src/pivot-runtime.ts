import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
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
      executable = metadata.executable || 'ssh'; args = ['-N','-o','BatchMode=yes','-o','ExitOnForwardFailure=yes', '-o', 'StrictHostKeyChecking=accept-new', '-D', `${host}:${Number(port)}`, ...(metadata.port ? ['-p', String(metadata.port)] : []), ...(secret.private_key_path ? ['-i', secret.private_key_path] : []), `${secret.username || metadata.username || ''}@${source.target}`]
    } else if (provider === 'chisel') {
      executable = path.join(this.root, 'tools/bin/chisel'); if (!existsSync(executable)) throw new ExecutionError('CAPABILITY_UNSUPPORTED', 'Managed chisel binary is unavailable')
      if (input.mode === 'server') args = ['server','--socks5','--host', String(input.bind_host ?? '127.0.0.1'), '--port', String(input.bind_port ?? 0), ...(input.reverse ? ['--reverse'] : [])]
      else { if (!input.server || !input.remote) throw new ExecutionError('PROTOCOL_ERROR', 'chisel client requires server and remote'); args = ['client', String(input.server), String(input.remote)] }
    } else throw new ExecutionError('CAPABILITY_UNSUPPORTED', `Provider ${provider} is not route-validated; Ligolo remains disabled`)
    const resource = this.operations.create(project, { kind: 'proxy', name: input.name || `${provider}:${input.bind ?? input.server ?? ''}`, target: String(input.target_scope ?? ''), status: 'offline', summary: `Managed ${provider} route`,
      metadata: { provider, socks_endpoint: input.socks_endpoint ?? (provider === 'ssh-forward' ? input.bind ?? '127.0.0.1:1080' : null), direction: input.direction ?? 'forward', protocols: input.protocols ?? ['tcp'], source_resource_id: source?.id ?? null, target_scope: input.target_scope ?? '', dependencies: source ? [source.id] : [], command: [executable, ...args] }, actor_type: input.actor_type ?? 'worker', actor: input.actor ?? 'unknown', parent_resource_id: source?.id ?? null }).resource
    const child = spawn(executable, args, { cwd: this.root, env: {}, stdio: ['ignore', 'pipe', 'pipe'], detached: false }), record: PivotRecord = { resourceId: resource.id, process: child, output: '' }
    for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk: Buffer) => { record.output = (record.output + chunk.toString()).slice(-65536) })
    child.once('spawn', () => this.operations.updateResource(resource.id, { status: 'available', last_seen_at: new Date().toISOString() }))
    child.once('error', error => this.operations.updateResource(resource.id, { status: 'degraded', summary: error.message.slice(0, 1000) }))
    child.once('exit', code => { this.records.delete(resource.id); try { this.operations.updateResource(resource.id, { status: 'offline', summary: `${provider} exited ${code ?? 'unknown'}: ${record.output.slice(-500)}` }) } catch {} })
    this.records.set(resource.id, record)
    return { route: this.operations.publicResource(this.operations.resource(resource.id)), pid: child.pid ?? null }
  }
  async validate(id: string, input: any) {
    const resource = this.operations.resource(id), metadata = JSON.parse(resource.metadata_json)
    if (!['ssh-forward','chisel'].includes(metadata.provider)) throw new ExecutionError('CAPABILITY_UNSUPPORTED','Only SSH SOCKS and Chisel SOCKS routes are validated')
    const url = new URL(input.url ?? `http://${input.host ?? '127.0.0.1'}:${Number(input.port)}/`)
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password) throw new ExecutionError('PROTOCOL_ERROR','Validation requires a credential-free HTTP(S) service URL')
    if (!resource.project_id) throw new ExecutionError('PROTOCOL_ERROR','Route validation requires a project Scope')
    const scope = this.operations.store.node<any>(resource.project_id,'origin','fact').description
    const hosts = [...scope.matchAll(/https?:\/\/[^\s),\]]+/gi)].map(match=>{ try { return new URL(match[0].replace(/[.,;]+$/,'')).host } catch { return '' } })
    hosts.push(...Object.values(this.operations.store.project(resource.project_id).benchmarkHosts ?? {}).flat())
    if (!hosts.includes(url.host)) throw new ExecutionError('PROTOCOL_ERROR','Validation service is outside the authorized project Scope')
    const proxy = new URL(`socks5h://${metadata.socks_endpoint ?? ''}`)
    if (!['127.0.0.1','localhost','[::1]'].includes(proxy.hostname) || !proxy.port || proxy.username || proxy.password) throw new ExecutionError('PROTOCOL_ERROR','A local managed socks_endpoint is required; listener readiness is not route validation')
    try {
      const seconds = Math.max(1, Math.min(30, Number(input.timeout ?? 5)))
      const { stdout } = await promisify(execFile)('curl',['--silent','--show-error','--noproxy','','--proxy',proxy.toString(),'--max-time',String(seconds),'--output',os.devNull,'--write-out','%{http_code}',url.toString()],{timeout:seconds*1000+1000,maxBuffer:8192})
      if (!/^[1-5]\d{2}$/.test(stdout.trim())) throw new Error('Proxy did not return an HTTP response from the target service')
      metadata.verified_at = new Date().toISOString(); metadata.verified_endpoint = url.toString(); metadata.verified_capabilities = ['pivot.socks']
      this.operations.verifiedResource(id,{status:'available',metadata_json:JSON.stringify(metadata),last_seen_at:metadata.verified_at},'route.verified')
      return {route_id:id,reachable:true,endpoint:url.toString(),via:proxy.toString(),http_status:Number(stdout.trim())}
    } catch (error) { this.operations.updateResource(id,{status:'degraded'}); throw error }
  }
  paths(project: string | null, target: string) {
    const resources = this.operations.store.db.prepare("SELECT * FROM shared_resources WHERE kind IN ('proxy','c2_session') AND status='available' AND (project_id IS NULL OR project_id IS ?)").all(project) as any[]
    const routes = resources.filter(row => row.kind === 'proxy').filter(row => { const metadata = JSON.parse(row.metadata_json); return ['ssh-forward','chisel'].includes(metadata.provider) && !!metadata.verified_at && metadata.runtime_verified === true && (!target || String(metadata.target_scope ?? row.target).includes(target) || target.startsWith(String(metadata.target_scope ?? row.target))) })
      .sort((a, b) => { const am = JSON.parse(a.metadata_json), bm = JSON.parse(b.metadata_json); return Number(Boolean(bm.verified_at)) - Number(Boolean(am.verified_at)) || String(b.last_seen_at ?? '').localeCompare(String(a.last_seen_at ?? '')) })
    return routes.map(row => ({ id: row.id, source_resource_id: JSON.parse(row.metadata_json).source_resource_id ?? null, target_scope: JSON.parse(row.metadata_json).target_scope ?? row.target, protocols: JSON.parse(row.metadata_json).protocols ?? ['tcp'], verified_at: JSON.parse(row.metadata_json).verified_at ?? null }))
  }
  async close(id: string) {
    const record=this.records.get(id);if(!record)return false
    this.records.delete(id);record.process.kill('SIGTERM')
    if(record.process.exitCode===null && record.process.signalCode===null) await new Promise<void>(resolve=>{
      const exited=()=>{clearTimeout(timer);resolve()}
      const timer=setTimeout(()=>{record.process.off('exit',exited);record.process.kill('SIGKILL');resolve()},1000)
      record.process.once('exit',exited)
    })
    try {this.operations.updateResource(id,{status:'offline'})} catch {}
    return true
  }
}
