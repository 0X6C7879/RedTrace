import { randomBytes } from 'node:crypto'

export type ExecutionErrorCode = 'COMMAND_FAILED' | 'TRANSPORT_ERROR' | 'AUTH_FAILED' | 'PROTOCOL_ERROR' | 'CAPABILITY_UNSUPPORTED' | 'TIMEOUT' | 'CANCELLED' | 'UNKNOWN_RESULT' | 'ADAPTER_DISABLED'
export interface ExecutionResult {
  version: 1
  completion: 'known' | 'unknown'
  exit_code: number | null
  error_code: ExecutionErrorCode | null
  stdout: string | null
  stderr: string | null
  combined_output: string
  output_ref: string | null
  truncated: boolean
  execution_context: Record<string, unknown>
  started_at: string
  completed_at: string
}
export function validateExecutionResult(value: unknown): ExecutionResult {
  const r = value as ExecutionResult
  const codes = ['COMMAND_FAILED', 'TRANSPORT_ERROR', 'AUTH_FAILED', 'PROTOCOL_ERROR', 'CAPABILITY_UNSUPPORTED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN_RESULT', 'ADAPTER_DISABLED']
  if (!r || r.version !== 1 || !['known', 'unknown'].includes(r.completion)
    || !(r.exit_code === null || Number.isInteger(r.exit_code) && r.exit_code >= 0 && r.exit_code <= 255)
    || !(r.error_code === null || codes.includes(r.error_code)) || typeof r.combined_output !== 'string'
    || !(r.stdout === null || typeof r.stdout === 'string') || !(r.stderr === null || typeof r.stderr === 'string')
    || typeof r.truncated !== 'boolean' || !r.execution_context || typeof r.execution_context !== 'object' || Array.isArray(r.execution_context)
    || !Number.isFinite(Date.parse(r.started_at)) || !Number.isFinite(Date.parse(r.completed_at))) {
    throw new ExecutionError('PROTOCOL_ERROR', 'Adapter returned an invalid versioned execution result')
  }
  return { ...r, error_code: r.completion === 'unknown' ? r.error_code ?? 'UNKNOWN_RESULT' : r.exit_code !== null && r.exit_code !== 0 ? r.error_code ?? 'COMMAND_FAILED' : r.error_code }
}
export function executionResult(output = '', exitCode: number | null = null, fields: Partial<ExecutionResult> = {}): ExecutionResult {
  const at = new Date().toISOString()
  return { version: 1, completion: exitCode === null ? 'unknown' : 'known', exit_code: exitCode,
    error_code: exitCode === null ? 'UNKNOWN_RESULT' : exitCode === 0 ? null : 'COMMAND_FAILED', stdout: null, stderr: null,
    combined_output: output, output_ref: null, truncated: false, execution_context: {}, started_at: at, completed_at: at, ...fields }
}
export class ExecutionError extends Error {
  readonly result: ExecutionResult
  constructor(code: ExecutionErrorCode, message: string, output = '', fields: Partial<ExecutionResult> = {}) {
    super(message); this.result = executionResult(output, null, { error_code: code, ...fields, execution_context: { ...fields.execution_context, error_message: message } })
  }
}
export function errorResult(error: unknown): ExecutionResult {
  if (error instanceof ExecutionError) return error.result
  const value = error as Error & { stdout?: string; stderr?: string; outputPath?: string }
  const message = value?.message ?? String(error)
  const code = /cancel|abort/i.test(message) ? 'CANCELLED' : /timed? out|timeout/i.test(message) ? 'TIMEOUT' : /authentication|permission denied \(publickey/i.test(message) ? 'AUTH_FAILED' : 'TRANSPORT_ERROR'
  return executionResult([value?.stdout, value?.stderr].filter(Boolean).join('') || message, null,
    { error_code: code, stdout: value?.stdout ?? null, stderr: value?.stderr ?? null, output_ref: value?.outputPath ?? null })
}
export const quoteShell = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'"
export function commandFrame(command: string, os = 'linux', cwd?: string) {
  const nonce = randomBytes(16).toString('hex'), begin = `RTBEGIN${nonce}`, end = `RTEND${nonce}`
  if (os === 'windows') {
    const text = `${cwd ? `Set-Location -LiteralPath '${cwd.replaceAll("'", "''")}';` : ''}$ErrorActionPreference='Stop';$global:LASTEXITCODE=0;Write-Output '${begin}';try{& ([ScriptBlock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(command).toString('base64')}')))));$r=if($?){$global:LASTEXITCODE}else{1}}catch{Write-Output $_;$r=1};Write-Output ('${end}:'+$r)`
    return { nonce, begin, end, command: `powershell -NoProfile -EncodedCommand ${Buffer.from(text, 'utf16le').toString('base64')}` }
  }
  return { nonce, begin, end, command: `printf '\\n%s\\n' '${begin}'; ${cwd ? `cd -- ${quoteShell(cwd)} && ` : ''}eval ${quoteShell(command)}; __rt_rc=$?; printf '\\n%s:%s\\n' '${end}' "$__rt_rc"` }
}
export function parseCommandFrame(output: string, frame: { begin: string; end: string }): ExecutionResult | undefined {
  const begin = new RegExp('(?:^|\\r?\\n)' + frame.begin + '\\r?\\n').exec(output)
  const match = new RegExp('(?:\\r?\\n)' + frame.end + ':(-?\\d+)(?:\\r?\\n)').exec(output)
  const position = begin ? begin.index + begin[0].length : -1
  if (position < 0 || !match || match.index < position) return undefined
  const code = Number(match[1]); if (!Number.isSafeInteger(code) || code < 0 || code > 255) return undefined
  return executionResult(output.slice(position, match.index), code)
}
