import { spawn } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

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
  const base = path.join(dir, randomUUID()), stdoutPath=base+'.stdout', stderrPath=base+'.stderr'
  return await new Promise<{ text: string; exitCode: number; bytes: number; stdoutSha256:string; stderrSha256:string; stdoutBytes:number; stderrBytes:number; stdoutPath:string; stderrPath:string; truncated:boolean }>((resolve, reject) => {
    const windows = process.platform === 'win32'
    const child = spawn(executable, args, { cwd, env: toolEnvironment(options.env), windowsHide: true, detached: !windows, stdio: ['pipe', 'pipe', 'pipe'] })
    child.stdin.on('error', () => {}); child.stdin.end(options.input)
    const stdout=createWriteStream(stdoutPath,{flags:'wx',mode:0o600}), stderr=createWriteStream(stderrPath,{flags:'wx',mode:0o600})
    let tail: Buffer = Buffer.alloc(0), failure: Error | undefined, stopped = false, truncated = false
    const stdoutHash = createHash('sha256'), stderrHash = createHash('sha256'), sizes={stdoutBytes:0,stderrBytes:0}, tailLimit = 64 * 1024
    const retain = (file: ReturnType<typeof createWriteStream>) => {
      let remaining = 16 * 1024 * 1024
      return (stream: NodeJS.ReadableStream, chunk: Buffer) => {
        if (chunk.length > remaining) truncated = true
        if (!remaining || file.destroyed) return
        const kept = chunk.subarray(0, remaining)
        remaining -= kept.length
        if (!file.write(kept)) { stream.pause(); file.once('drain', () => stream.resume()) }
      }
    }
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
    for (const file of [stdout,stderr]) file.on('error', error => { failure = error; child.stdout.resume(); child.stderr.resume(); kill() })
    for (const [stream,file,hash,key] of [[child.stdout,stdout,stdoutHash,'stdoutBytes'],[child.stderr,stderr,stderrHash,'stderrBytes']] as const) {
      const separate = retain(file)
      stream.on('data', (chunk: Buffer) => {
        separate(stream, chunk)
        sizes[key] += chunk.length; hash.update(chunk)
        tail = chunk.length >= tailLimit ? chunk.subarray(-tailLimit) : Buffer.concat([tail.subarray(Math.max(0, tail.length + chunk.length - tailLimit)), chunk])
      })
    }
    child.on('error', error => { failure = error })
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort)
      const done = () => {
        let start=0;while(start<tail.length&&tail[start]>=0x80&&tail[start]<=0xbf)start++
        const result={text:tail.subarray(start).toString('utf8'),stdoutPath,stderrPath,bytes:sizes.stdoutBytes+sizes.stderrBytes,...sizes,stdoutSha256:stdoutHash.digest('hex'),stderrSha256:stderrHash.digest('hex'),exitCode:code??-1,truncated}
        if (failure) reject(Object.assign(failure, {...result,completion:'unknown'}))
        else resolve(result)
      }
      Promise.all([stdout,stderr].map(file=>new Promise<void>(resolve=>{if(file.destroyed)resolve();else file.end(resolve)}))).then(done)
    })
    if (options.signal?.aborted) abort()
  })
}
