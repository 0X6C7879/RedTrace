import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Configuration } from '../packages/redtrace-engine/src/config.ts'
import { Store } from '../packages/redtrace-engine/src/store.ts'
import { quoteShell } from '../packages/redtrace-engine/src/execution-result.ts'
import { domainFixtureRequest } from '../packages/redtrace-engine/test/domain-fixture.mjs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const baseline = process.argv.indexOf('--baseline')
const revision = baseline < 0 ? undefined : process.argv[baseline + 1] ?? 'HEAD'
const outputMode = process.argv.includes('--tool-output')
const toolName = outputMode ? (process.platform === 'win32' ? 'pwsh' : 'bash') : 'read'
const root = mkdtempSync(path.join(tmpdir(), 'redtrace-agent-bench-'))
const observedOutputs = new Set()
let child, store, logs = '', failure, requests = 0, firstRequest, exited = false
const model = createServer(async (req, res) => {
  try {
    let raw = ''
    for await (const chunk of req) raw += chunk
    const body = domainFixtureRequest(JSON.parse(raw), res)
    firstRequest ??= performance.now()
    requests++
    assert.ok(requests <= 120, 'Agent loop exceeded the fixed workload: ' + JSON.stringify(body.messages.slice(-2)))
    const errors = body.messages.filter(message => message.role === 'tool' && typeof message.content === 'string' && message.content.startsWith('Error:'))
    assert.equal(errors.length, 0, JSON.stringify(errors))
    const history = body.messages.flatMap(message => message.tool_calls ?? [])
    const calls = history.map(call => call.function.name)
    if (outputMode) {
      const outputCalls = new Set(history.filter(call => call.function.name === toolName).map(call => call.id))
      for (const message of body.messages.filter(message => message.role === 'tool' && outputCalls.has(message.tool_call_id))) {
        assert.ok(typeof message.content === 'string' && message.content.includes('Local retained fixture 中文 😀') && /\[上一行另重复 \d+ 次\]/.test(message.content), 'Output fixture was not folded: ' + JSON.stringify(message.content).slice(0, 1500))
        observedOutputs.add(message.tool_call_id)
      }
    }
    let name, args
    if (calls.filter(name => name === toolName).length < 20) {
      const file = path.join(root, 'workspaces/proj_001/fixture.txt')
      const command = process.platform === 'win32' ? "Get-Content -Raw -LiteralPath '" + file.replaceAll("'", "''") + "'" : 'cat ' + quoteShell(file)
      name = toolName; args = outputMode ? { command, description: 'Fixed local output fixture' } : { file_path: file }
    } else if (!calls.includes('submit_fact')) {
      name = 'submit_fact'; args = { title: 'Local fixture read', description: 'Retained local file was read successfully', evidence: [{ description: 'Fixed local file result retained in Run audit' }] }
    } else {
      name = 'finish_step'; args = { summary: 'Local file read benchmark completed' }
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.end('data: ' + JSON.stringify({ id: `fixture-${requests}`, object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `call-${requests}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) + '\n\ndata: [DONE]\n\n')
  } catch (error) { failure = error; res.writeHead(500); res.end(String(error)) }
})
try {
  symlinkSync(path.join(repository, 'static'), path.join(root, 'static'), 'dir')
  symlinkSync(path.join(repository, 'skills'), path.join(root, 'skills'), 'dir')
  await new Promise(resolve => model.listen(0, '127.0.0.1', resolve))
  const configuration = new Configuration(root)
  configuration.initialize()
  configuration.commit(configuration.read().revision, raw => {
    raw.providers = { fixture: { api: 'openai-completions', base_url: `http://127.0.0.1:${model.address().port}/v1`, api_key: 'fixture', models: [{ id: 'fixture', context_window: 1_000_000, max_tokens: 1024, reasoning: 'off', reasoning_efforts: false }] } }
    raw.workers = [{ name: 'fixture', roles: ['soldier'], provider: 'fixture', model: 'fixture', max_running: 4 }]
    raw.runtime = { max_project_workers: 4, max_running_projects: 1 }
    raw.tasks = { soldier: { timeout: 60, conclude_timeout: 5 } }
  })
  store = new Store(path.join(root, '.redtrace/engine.db'))
  const project = store.createProject({ title: 'Agent benchmark', origin: 'Local fixture files only', goal: 'Verify local runtime', bootstrap: false }).project
  mkdirSync(path.join(root, 'workspaces', project.id), { recursive: true })
  writeFileSync(path.join(root, 'workspaces', project.id, 'fixture.txt'), 'Local retained fixture 中文 😀\n'.repeat(outputMode ? 12000 : 400))
  for (let i = 0; i < 4; i++) store.addStep(project.id, { description: `Read local fixture ${i}`, sourceIds: ['origin'] })
  const hook = path.join(root, 'measure.mjs')
  const sources = revision ? ['packages/redtrace-engine/compat/cordis.mjs', 'packages/redtrace-engine/src/store.ts', 'packages/redtrace-engine/src/run-trace.ts', 'packages/redtrace-dsh/src/tool-domains.ts', 'packages/redtrace-dsh/lib/tool-domains.js'].map(file => [new URL(file, new URL('../', import.meta.url)).href, execFileSync('git', ['show', `${revision}:${file.replace('/lib/tool-domains.js', '/src/tool-domains.ts')}`], { cwd: repository, encoding: 'utf8' })]) : []
  if (process.argv.includes('--original-output')) {
    const file = 'packages/redtrace-dsh/lib/spill.js'
    const source = execFileSync('git', ['show', '42d6b795:packages/redtrace-dsh/src/spill.ts'], { cwd: repository, encoding: 'utf8' })
    sources.push([new URL(file, new URL('../', import.meta.url)).href, source])
    const codeRoot = process.env.REDTRACE_DSH_ROOT ?? process.env.REDTRACE_CODE_ROOT
    if (codeRoot) sources.push([new URL(file, pathToFileURL(realpathSync(codeRoot) + path.sep)).href, source])
  }
  writeFileSync(hook, `import {registerHooks} from 'node:module';
const sources=new Map(${JSON.stringify(sources)});registerHooks({load(id,context,next){const source=sources.get(id);return source===undefined?next(id,context):{source,format:id.endsWith('.mjs')?'module':'module-typescript',shortCircuit:true}}});
process.on('exit',()=>{const cpu=process.cpuUsage();console.log('AGENT_BENCH_METRICS '+JSON.stringify({cpuMs:(cpu.user+cpu.system)/1000,peakRssBytes:process.resourceUsage().maxRSS*1024}))})`)
  const start = performance.now()
  child = spawn(process.execPath, [...process.execArgv, '--import', hook, path.join(repository, 'scripts/run-redtrace-node.mjs'), '--root', root, '--port', '0'], { cwd: repository, env: { ...process.env, DSH_HOME: path.join(root, '.dsh'), REDTRACE_DATA_ROOT: path.join(root, '.redtrace') }, stdio: ['ignore', 'pipe', 'pipe'] })
  child.once('close', () => { exited = true })
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { logs += chunk })
  const deadline = start + 80_000
  for (;;) {
    if (failure) throw failure
    assert.ok(!exited, logs)
    const runs = store.runs(project.id)
    if (runs.length === 4 && runs.every(run => run.status === 'succeeded')) break
    if (runs.some(run => ['failed', 'cancelled'].includes(run.status)) || performance.now() >= deadline)
      assert.fail('Agent benchmark did not complete: ' + JSON.stringify({ requests, runs, graph: store.graph(project.id) }) + '\n' + logs)
    await delay(10)
  }
  const completed = performance.now()
  assert.equal(requests, 88)
  if (outputMode) assert.equal(observedOutputs.size, 80)
  assert.ok(store.runs(project.id).every(run => !run.pendingTools.length))
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM tool_calls WHERE name=? AND status='succeeded'").get(toolName).n, 80)
  const closed = new Promise(resolve => child.once('close', resolve))
  child.kill('SIGTERM'); await closed; child = undefined
  const metrics = JSON.parse(logs.match(/AGENT_BENCH_METRICS (\{[^\n]+\})/)[1])
  console.log(JSON.stringify({ runs: 4, reads: outputMode ? 0 : 80, commands: outputMode ? 80 : 0, requests, startupAndRunMs: completed - start, runMs: completed - firstRequest, ...metrics }))
} finally {
  if (child && !exited) { const closed = new Promise(resolve => child.once('close', resolve)); child.kill('SIGTERM'); await closed }
  store?.close()
  model.closeAllConnections(); await new Promise(resolve => model.close(resolve))
  rmSync(root, { recursive: true, force: true })
}
