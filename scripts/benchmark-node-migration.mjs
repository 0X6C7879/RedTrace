import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const root = path.resolve(import.meta.dirname, '..'), require = createRequire(path.join(root, 'packages/redtrace-engine/package.json'))
const { parse, stringify } = require('yaml'), node = process.execPath
const python = process.env.REDTRACE_PYTHON || path.join(root, 'redtrace', process.platform === 'win32' ? '.venv-windows/Scripts/python.exe' : '.venv/bin/python')
const rounds = Math.max(1, Number(process.argv.find(value => value.startsWith('--rounds='))?.split('=')[1] || process.env.REDTRACE_BENCH_RUNS || 3))
const selectedModes = process.argv.filter(value => ['legacy', 'node-lean', 'node-compat'].includes(value))
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function port() {
  const server = createServer(); await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject))
  const value = server.address().port; await new Promise(resolve => server.close(resolve)); return value
}

function start(command, args, cwd, env = {}) {
  const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk).slice(-8000) })
  return { child, output: () => output }
}

function stop(item) {
  if (!item || item.child.exitCode != null) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(item.child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  else try { process.kill(-item.child.pid, 'SIGTERM') } catch {}
}

async function ready(base, processes) {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    for (const item of processes) if (item.child.exitCode != null) throw new Error(`process exited ${item.child.exitCode}: ${item.output()}`)
    try { if ((await fetch(`${base}/projects`)).ok) return } catch {}
    await sleep(50)
  }
  throw new Error(`startup timeout: ${processes.map(item => item.output()).join('\n')}`)
}

function rss(pid) {
  let bytes
  if (process.platform === 'win32') {
    const command = `$all=Get-CimInstance Win32_Process;$ids=@(${pid});do{$fresh=@($all|Where-Object{$ids -contains [int]$_.ParentProcessId -and $ids -notcontains [int]$_.ProcessId}|ForEach-Object{[int]$_.ProcessId});$ids+=$fresh}while($fresh.Count);($all|Where-Object{$ids -contains [int]$_.ProcessId}|Measure-Object WorkingSetSize -Sum).Sum`
    bytes = Number(spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true }).stdout.trim())
  } else {
    const rows = spawnSync('ps', ['-eo', 'pid=,ppid=,rss='], { encoding: 'utf8' }).stdout.trim().split(/\r?\n/).map(line => line.trim().split(/\s+/).map(Number))
    const ids = new Set([pid])
    for (let changed = true; changed;) {
      changed = false
      for (const [child, parent] of rows) if (ids.has(parent) && !ids.has(child)) { ids.add(child); changed = true }
    }
    bytes = rows.filter(([child]) => ids.has(child)).reduce((sum, row) => sum + row[2] * 1024, 0)
  }
  return Number((bytes / 1024 / 1024).toFixed(1))
}

async function task(base) {
  const started = performance.now(), response = await fetch(`${base}/projects`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Migration benchmark', origin: 'Deterministic local fixture', goal: 'Produce a verified completion', bootstrap_enabled: true }) })
  if (!response.ok) throw new Error(`create failed ${response.status}: ${await response.text()}`)
  const id = (await response.json()).project.id, deadline = Date.now() + 30_000
  let project
  while (Date.now() < deadline) {
    project = await (await fetch(`${base}/projects/${id}`)).json()
    if (project.project.status === 'completed') {
      const usage = await (await fetch(`${base}/audit/tasks/${id}/usage`)).json()
      return { task_ms: Math.round(performance.now() - started), success: true, tokens: Number(usage.total_tokens ?? usage.tokens ?? 0) }
    }
    await sleep(25)
  }
  throw new Error(`benchmark task did not complete: ${JSON.stringify(project).slice(0, 2000)}`)
}

async function measure(mode) {
  const directory = mkdtempSync(path.join(os.tmpdir(), `redtrace-${mode}-`)), listen = await port(), base = `http://127.0.0.1:${listen}`, processes = [], started = performance.now()
  try {
    if (mode === 'legacy') {
      const config = parse(readFileSync(path.join(root, 'redtrace.yaml'), 'utf8'))
      config.server = base; config.common_env = {}; config.providers = {}; config.runtime = { ...config.runtime, interval: 1, execution: 'local', worker_healthcheck: 'disabled', prompt_group: 'mock', max_workers: 4, max_project_workers: 4, max_running_projects: 1 }
      config.paths = { root: directory, skills: path.join(root, 'skills'), mcp: path.join(root, 'mcp'), managed: path.join(directory, '.redtrace'), workspaces: path.join(directory, 'workspaces'), audit: path.join(directory, '.redtrace/audit') }
      config.local = { workspace_root: path.join(directory, 'workspaces') }; config.workers = [{ name: 'mock', provider: 'mock', model: 'mock', max_running: 4, priority: 0 }]
      const filename = path.join(directory, 'redtrace.yaml'); writeFileSync(filename, stringify(config))
      const env = { REDTRACE_ROOT: directory, REDTRACE_DISPATCH_CONFIG: filename }
      processes.push(start(python, ['-m', 'redtrace', 'serve', '--db-path', path.join(directory, 'legacy.db'), '--host', '127.0.0.1', '--port', String(listen)], root, env)); await ready(base, processes)
      processes.push(start(python, ['-m', 'redtrace', 'dispatch', '--config', filename], root, env)); await sleep(300)
    } else {
      processes.push(start(node, [path.join(root, 'scripts/run-redtrace-node.mjs'), '--root', directory, '--mock', '--port', String(listen), ...(mode === 'node-compat' ? ['--compat'] : [])], root))
      await ready(base, processes)
    }
    const startup_ms = Math.round(performance.now() - started), result = await task(base).catch(error => { throw new Error(`${mode}: ${error.message}\n${processes.map(item => item.output()).join('\n')}`) })
    return { startup_ms, rss_mb: Number(processes.reduce((sum, item) => sum + rss(item.child.pid), 0).toFixed(1)), processes: processes.length, ...result }
  } finally { for (const item of processes.reverse()) stop(item); rmSync(directory, { recursive: true, force: true }) }
}

const samples = {}
for (const mode of selectedModes.length ? selectedModes : ['legacy', 'node-lean', 'node-compat']) {
  samples[mode] = []
  for (let i = 0; i < rounds; i++) samples[mode].push(await measure(mode))
}
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
const summary = Object.fromEntries(Object.entries(samples).map(([mode, rows]) => [mode, { startup_ms: median(rows.map(r => r.startup_ms)), rss_mb: median(rows.map(r => r.rss_mb)), processes: median(rows.map(r => r.processes)), task_ms: median(rows.map(r => r.task_ms)), success_rate: rows.filter(r => r.success).length / rows.length, tokens: median(rows.map(r => r.tokens)) }]))
const report = `${JSON.stringify({ measured_at: new Date().toISOString(), platform: `${process.platform}/${process.arch}`, node: process.versions.node, rounds, task: 'deterministic local mock bootstrap completion', summary, samples }, null, 2)}\n`
const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length)
if (output) writeFileSync(path.resolve(root, output), report)
process.stdout.write(report)
