import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { boot } from '../vendor/deepseek-harness/packages/boot/app-boot/lib/index.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const sessionRoot = resolve(root, '.redtrace/dsh/probe-sessions')
mkdirSync(sessionRoot, { recursive: true })

async function probe(profile) {
  const config = resolve(root, `profiles/redtrace/${profile}.cordis.yml`)
  Object.assign(process.env, {
    DEEPSEEK_API_KEY: 'probe-not-used',
    DSH_CORDIS_CONFIG: config,
    DSH_CWD: root,
    DSH_SESSION_ROOT: sessionRoot,
    REDTRACE_SERVER: 'http://127.0.0.1:1',
    REDTRACE_PROJECT_ID: 'probe',
    REDTRACE_INTENT_ID: 'probe',
    REDTRACE_WORKER: 'probe',
    REDTRACE_TASK_TYPE: profile === 'reason' ? 'reason' : 'explore',
    REDTRACE_SKILLS_DIR: resolve(root, 'skills'),
  })
  const ctx = await boot(`redtrace-probe-${profile}`, config)
  await ctx.fiber.dispose()
}

for (const profile of ['reason', 'direct', 'isolated']) {
  await probe(profile)
  console.log(`ok ${profile}`)
}

// A fake RedTrace API serving one initial project, so the runtime scheduler
// really selects the probe Worker, claims the bootstrap Intent, and drives a
// full Agent + Session lifecycle (the unknown provider makes the run fail
// fast, which still exercises composition, audit, and the outcome path).
const taskLimits = {
  bootstrap: { timeout: 2, conclude_timeout: 2 },
  reason: { timeout: 2, max_intents: 2 },
  explore: { timeout: 2, conclude_timeout: 2 },
}
const project = {
  project: { id: 'probe', status: 'active', title: 'probe', bootstrap_enabled: true, reason: null, planning_revision: 1, reason_evaluated_revision: 1 },
  facts: [
    { id: 'goal', description: 'goal' },
    { id: 'origin', description: 'origin' },
  ],
  intents: [],
  hints: [],
  blackboard_revision: 1,
}
const snapshot = {
  revision: 'probe-revision',
  workers: [{
    name: 'probe-worker', enabled: true, provider: 'probe-provider', model: 'probe-model',
    bootstrap: true, reason: true, explore: true, maxRunning: 2, priority: 0,
  }],
  tasks: taskLimits,
  limits: { maxWorkers: 2, maxRunningProjects: 1, maxProjectWorkers: 2, interval: 1 },
  providers: {},
  env: {},
}
let intent = { id: 'intent-probe', from: ['origin'], description: 'bootstrap', creator: 'dispatcher.bootstrap', worker: null, execution_profile: 'direct', created_at: new Date().toISOString(), state: 'open' }
const outcomes = []
const claims = []
const json = response => (value, status = 200) => {
  response.statusCode = status
  response.setHeader('content-type', 'application/json')
  response.end(JSON.stringify(value))
}

const api = createServer((request, response) => {
  const done = json(response)
  const url = new URL(request.url, 'http://probe')
  if (request.method === 'GET' && url.pathname === '/projects') return done([project.project])
  if (request.method === 'GET' && url.pathname === '/projects/probe') return done(project)
  if (request.method === 'GET' && url.pathname === '/runtime/config') return done(snapshot)
  if (request.method === 'GET' && url.pathname === '/projects/probe/resources') return done({ project_id: 'probe', resources: [] })
  if (request.method === 'POST' && url.pathname === '/projects/probe/intents') return done(intent)
  if (request.method === 'POST' && url.pathname === '/projects/probe/intents/intent-probe/claim') {
    claims.push(request.headers['content-type'] ? 'claim' : 'claim')
    return done({})
  }
  if (request.method === 'POST' && (url.pathname.endsWith('/heartbeat') || url.pathname === '/audit/events')) return done({})
  if (request.method === 'POST' && url.pathname.endsWith('/outcome')) {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      try { outcomes.push(JSON.parse(body)) } catch { outcomes.push({}) }
      done({})
    })
    return
  }
  done({})
})
await new Promise((accept, reject) => {
  api.once('error', reject)
  api.listen(0, '127.0.0.1', accept)
})
const apiPort = api.address().port
const runtimeProfile = resolve(root, 'profiles/redtrace/runtime.cordis.yml')
Object.assign(process.env, {
  DEEPSEEK_API_KEY: 'probe-not-used',
  DSH_CORDIS_CONFIG: runtimeProfile,
  DSH_SESSION_ROOT: sessionRoot,
  REDTRACE_DSH_SETTINGS: resolve(root, '.redtrace/dsh/probe-settings.yaml'),
  REDTRACE_DSH_WEB_HOST: '127.0.0.1',
  REDTRACE_DSH_WEB_PORT: '0',
  REDTRACE_DSH_PI_AI_CONFIG: '{"providers":{}}',
  REDTRACE_DSH_RUNTIME_CONFIG: JSON.stringify({
    runtime: true,
    server: `http://127.0.0.1:${apiPort}`,
    root,
    sessionRoot,
    skillsDir: resolve(root, 'skills'),
    workspacesDir: resolve(root, '.redtrace/dsh/probe-workspaces'),
    staticDir: resolve(root, 'redtrace/src/redtrace/server/static'),
    interval: 1,
    maxWorkers: 1,
    maxRunningProjects: 1,
    maxProjectWorkers: 1,
    tasks: taskLimits,
    mcpConfigs: [],
  }),
})
const runtime = await boot('redtrace-runtime-probe', runtimeProfile)
const deadline = Date.now() + 30_000
while (outcomes.length === 0 && Date.now() < deadline) {
  await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
}
await runtime.fiber.dispose()
await new Promise(resolve => api.close(resolve))
if (outcomes.length === 0) throw new Error('runtime probe dispatched no task')
const outcome = outcomes[0]
if (outcome.worker !== 'probe-worker') throw new Error(`runtime probe claimed by ${outcome.worker}, expected probe-worker`)
console.log(`ok runtime (worker=${outcome.worker}, outcome=${outcome.outcome})`)
