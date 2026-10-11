import { execFile, spawnSync } from 'node:child_process'
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { Type } from 'typebox'
import { toolEnvironment } from './shell.ts'
import type { AgentTool } from './tool-types.ts'
import type { TaskContext } from './scheduler.ts'
import type { Operations } from './operations.ts'

type Owner = { directory: string; socket: string; sessions: Map<string, string[]> }
export const shellInstructions = '同一 Run 内复用 shell_id，保留交互进程的 cwd/env；不跨 Worker/Run 共享、不保证重启恢复。shell_open 用 argv 数组启动 ssh、evil-winrm-py、penelope 或其他交互 CLI；宿主需安装对应工具与 tmux，远端不需 tmux。密码使用 shell_send 的 credential_id（项目授权 shell.send），不要放入 argv/text。shell_send 仅确认输入提交，不表示命令成功；shell_read 返回有界屏幕快照，process_exit_code 只表示 CLI 退出，不是每条命令退出码。根据明确输出验证结果，完成后 shell_close；Run 结束或插件停止自动清理。HTTP WebShell 仍无状态；关闭客户端不能保证结束远端后台进程。'

export class WorkerShells {
  private owners = new Map<string, Owner>()
  private pending = new Map<string, Promise<unknown>>()
  private retired = new Set<string>()
  enabled = true
  private exiting = () => { for (const owner of this.owners.values()) spawnSync('tmux', ['-S', owner.socket, 'kill-server'], { timeout: 2000, stdio: 'ignore' }) }
  constructor() { process.on('exit', this.exiting) }
  private serial<T>(run: string, action: () => Promise<T>): Promise<T> {
    const next = (this.pending.get(run) ?? Promise.resolve()).catch(() => {}).then(action)
    this.pending.set(run, next)
    void next.finally(() => { if (this.pending.get(run) === next) this.pending.delete(run) }).catch(() => {})
    return next
  }
  private tmux(owner: Owner, args: string[], input?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile('tmux', ['-S', owner.socket, '-f', path.join(owner.directory, 'tmux.conf'), ...args],
        { timeout: 5000, maxBuffer: 512 * 1024, env: toolEnvironment() }, (error, stdout, stderr) => {
          // Do not forward CLI errors containing supplied input or credentials.
          if (error) reject(Object.assign(new Error(`tmux ${args[0]} failed (${String(error.code)})`), { serverMissing: /no server running|error connecting|No such file or directory/.test(stderr) })); else resolve(stdout)
        })
      child.stdin?.on('error', () => {})
      child.stdin?.end(input)
    })
  }
  private owned(run: string, id: string) {
    const owner = this.owners.get(run)
    if (!owner?.sessions.has(id)) throw new Error('Shell is not owned by this Run')
    return owner
  }
  open(run: string, argv: string[], cwd: string, signal?: AbortSignal) {
    return this.serial(run, async () => {
      signal?.throwIfAborted()
      if (!this.enabled || this.retired.has(run)) throw new Error('Shell owner has stopped')
      if (process.platform === 'win32') throw new Error('Worker Shell requires a macOS/Linux tmux host')
      if (!Array.isArray(argv) || !argv.length || argv.length > 128 || argv.some(a => typeof a !== 'string' || a.includes('\0')) || !/^[a-zA-Z0-9_./+-]+$/.test(argv[0]) || argv.join('').length > 16384) throw new Error('Invalid CLI argv')
      if (!(await stat(cwd)).isDirectory()) throw new Error('cwd must be a directory')
      let owner = this.owners.get(run)
      if (!owner) {
        const directory = await mkdtemp('/tmp/rtsh-')
        owner = { directory, socket: path.join(directory, 's'), sessions: new Map() }
        await writeFile(path.join(directory, 'tmux.conf'), 'set -g remain-on-exit on\nset -g history-limit 2000\n', { mode: 0o600 })
        this.owners.set(run, owner)
      }
      if (owner.sessions.size >= 16) throw new Error('Run shell limit reached')
      const shell_id = 's' + randomUUID().replaceAll('-', '')
      try {
        await this.tmux(owner, ['new-session', '-d', '-s', shell_id, '-x', '160', '-y', '40', '-c', cwd, '--', ...argv])
        owner.sessions.set(shell_id, [])
        signal?.throwIfAborted()
        return { shell_id }
      } catch (error) {
        await this.tmux(owner, ['kill-session', '-t', shell_id]).catch(() => {})
        owner.sessions.delete(shell_id)
        if (!owner.sessions.size) { this.owners.delete(run); await rm(owner.directory, { recursive: true, force: true }) }
        throw error
      }
    })
  }
  send(run: string, id: string, text: string, submit = true, sensitive = false) {
    return this.serial(run, async () => {
      const owner = this.owned(run, id)
      if (typeof text !== 'string' || !text.length || Buffer.byteLength(text) > 16384 || text.includes('\0')) throw new Error('Input must be 1..16384 bytes without NUL')
      if (sensitive) {
        if (/[\x00-\x1f\x7f]/.test(text) || owner.sessions.get(id)!.length >= 64) throw new Error('Invalid credential input or redaction limit reached')
        owner.sessions.get(id)!.push(text)
      }
      const buffer = 'b' + randomUUID().replaceAll('-', '')
      try {
        await this.tmux(owner, ['load-buffer', '-b', buffer, '-'], text)
        await this.tmux(owner, ['paste-buffer', '-d', '-b', buffer, '-t', id + ':0.0'])
        if (submit) await this.tmux(owner, ['send-keys', '-t', id + ':0.0', 'Enter'])
        return { shell_id: id, submitted: true, command_status: 'unknown' }
      } finally { await this.tmux(owner, ['delete-buffer', '-b', buffer]).catch(() => {}) }
    })
  }
  read(run: string, id: string) {
    return this.serial(run, async () => {
      const owner = this.owned(run, id)
      const status = (await this.tmux(owner, ['display-message', '-p', '-t', id + ':0.0', '#{pane_dead} #{pane_dead_status}'])).trim().split(' ')
      let output = await this.tmux(owner, ['capture-pane', '-p', '-t', id + ':0.0', '-S', '-200'])
      for (const secret of owner.sessions.get(id)!) {
        const escaped = [...secret].map(char => char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\n?')
        output = output.replace(new RegExp(escaped, 'g'), '[REDACTED]')
      }
      const truncated = Buffer.byteLength(output) > 32768
      if (truncated) output = Buffer.from(output).subarray(-32768).toString('utf8')
      return { shell_id: id, output, snapshot: true, truncated, running: status[0] === '0', process_exit_code: status[0] === '1' && status[1] ? Number(status[1]) : null, command_status: 'unknown' }
    })
  }
  list(run: string) { return this.serial(run, async () => ({ shells: [...(this.owners.get(run)?.sessions.keys() ?? [])] })) }
  close(run: string, id: string) {
    return this.serial(run, async () => {
      const owner = this.owners.get(run)
      if (!owner?.sessions.has(id)) return { shell_id: id, closed: true }
      await this.tmux(owner, ['kill-session', '-t', id]).catch(error => { if (!error.serverMissing) throw error })
      owner.sessions.delete(id)
      if (!owner.sessions.size) { this.owners.delete(run); await rm(owner.directory, { recursive: true, force: true }) }
      return { shell_id: id, closed: true }
    })
  }
  closeRun(run: string, retire = true) {
    if (retire && (this.owners.has(run) || this.pending.has(run))) this.retired.add(run)
    return this.serial(run, async () => {
      const owner = this.owners.get(run)
      if (!owner) return
      await this.tmux(owner, ['kill-server']).catch(error => { if (!error.serverMissing) throw error })
      this.owners.delete(run)
      await rm(owner.directory, { recursive: true, force: true })
    })
  }
  async closeAll() { await Promise.all([...new Set([...this.owners.keys(), ...this.pending.keys()])].map(run => this.closeRun(run, false))) }
  async dispose() { await this.closeAll(); process.off('exit', this.exiting) }
}

export function workerShellTools(context: TaskContext, shells: WorkerShells, operations: Operations, cwd: string): AgentTool[] {
  const run = context.run.id
  const id = { shell_id: Type.String({ minLength: 1 }) }
  function tool(name: string, description: string, parameters: any, execute: (args: any, signal?: AbortSignal) => Promise<unknown>): AgentTool {
    return { name, label: name, description, parameters, executionMode: 'sequential', async execute(_call, args, signal) {
      context.signal.throwIfAborted(); signal?.throwIfAborted()
      if (!shells.enabled) throw new Error('Shell plugin is disabled')
      const result = await execute(args, signal)
      return { content: [{ type: 'text', text: JSON.stringify(result) }] }
    } }
  }
  return [
    tool('shell_open', shellInstructions, Type.Object({ argv: Type.Array(Type.String(), { minItems: 1, maxItems: 128 }), cwd: Type.Optional(Type.String()) }), (a, signal) => shells.open(run, a.argv, a.cwd === undefined ? cwd : path.resolve(cwd, a.cwd), signal)),
    tool('shell_send', '提交交互输入；text 与 credential_id 二选一。credential_id 读取已授权 credential Resource 的 password/value，不返回密文。submit 默认 true。不推断命令完成或成功。', Type.Object({ ...id, text: Type.Optional(Type.String()), credential_id: Type.Optional(Type.String()), submit: Type.Optional(Type.Boolean()) }), async a => {
      if ((a.text !== undefined) === (a.credential_id !== undefined)) throw new Error('Provide exactly one of text or credential_id')
      let text = a.text
      if (a.credential_id !== undefined) {
        const resource = operations.resource(a.credential_id)
        if (resource.kind !== 'credential_ref' || resource.project_id && resource.project_id !== context.run.projectId) throw new Error('Credential outside project scope')
        operations.available(resource, { actor_type: 'worker', actor: context.worker.name })
        if (!operations.authorized(context.run.projectId, 'shell.send', resource)) throw new Error('Credential requires project shell.send authorization')
        const secret = JSON.parse(resource.secret_json); text = secret.password ?? secret.value
        if (typeof text !== 'string') throw new Error('Credential has no password/value')
      }
      return shells.send(run, a.shell_id, text, a.submit ?? true, a.credential_id !== undefined)
    }),
    tool('shell_read', '读取最近屏幕快照（可重复，非增量）；CLI 退出码不是远端命令退出码。', Type.Object(id), a => shells.read(run, a.shell_id)),
    tool('shell_list', '仅列出当前 Run 的 Shell。', Type.Object({}), () => shells.list(run)),
    tool('shell_close', '结束当前 Run 的客户端；重复关闭无害，不保证远端后台进程终止。', Type.Object(id), a => shells.close(run, a.shell_id)),
  ]
}
