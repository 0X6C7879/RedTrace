import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export function toolEnvironment(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (/(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTHORIZATION)/i.test(key)) delete env[key]
  return { ...env, ...extra, PYTHONUTF8: '1' }
}

export async function runShell(command: string, cwd: string, options: { signal?: AbortSignal; timeout?: number; env?: Record<string, string> } = {}) {
  const windows = process.platform === 'win32'
  const executable = windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : '/bin/bash'
  const args = windows ? ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command] : ['--noprofile', '--norc', '-c', command]
  return runProcess(executable, args, cwd, options)
}

export async function runProcess(executable: string, args: string[], cwd: string, options: { signal?: AbortSignal; timeout?: number; env?: Record<string, string>; input?: string } = {}) {
  if (options.signal?.aborted) throw new Error('Command cancelled before launch')
  const seconds = options.timeout ?? 120
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds * 1000 > 2147483647) throw new Error('Invalid command timeout')
  const dir = path.join(cwd, '.redtrace-output'); await mkdir(dir, { recursive: true })
  const outputPath = path.join(dir, `${randomUUID()}.log`)
  return await new Promise<{ text: string; outputPath: string; exitCode: number }>((resolve, reject) => {
    const windows = process.platform === 'win32'
    const child = spawn(executable, args, { cwd, env: toolEnvironment(options.env), windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.on('error', () => {}); child.stdin.end(options.input)
    const output = createWriteStream(outputPath, { flags: 'wx', mode: 0o600 })
    let tail = '', failure: Error | undefined, stopped = false
    const kill = () => {
      if (stopped || !child.pid) return
      stopped = true
      if (windows) {
        const killer = spawn(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
        killer.on('error', () => child.kill())
        killer.on('exit', code => { if (code !== 0) child.kill() })
      } else { try { process.kill(-child.pid, 'SIGKILL') } catch { child.kill('SIGKILL') } }
    }
    const abort = () => { failure = new Error('Command cancelled; external side effects may have occurred'); kill() }
    const timer = setTimeout(() => { failure = new Error('Command timed out; external side effects may have occurred'); kill() }, seconds * 1000)
    options.signal?.addEventListener('abort', abort, { once: true })
    output.on('error', error => { failure = error; child.stdout.resume(); child.stderr.resume(); kill() })
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk: string) => {
        tail = (tail + chunk).slice(-64 * 1024)
        if (!output.destroyed && !output.write(chunk)) { stream.pause(); output.once('drain', () => stream.resume()) }
      })
    }
    child.on('error', error => { failure = error })
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      const done = () => failure ? reject(Object.assign(failure, { outputPath })) : resolve({ text: tail, outputPath, exitCode: code ?? -1 })
      if (output.destroyed) done(); else output.end(done)
    })
    if (options.signal?.aborted) abort()
  })
}
