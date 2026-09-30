import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { JevService, isJevRecoveryPath, traceCall } from '../src/jev.ts'
import type { JevScenes } from '../src/jev.ts'
import { activityPrompt, graphTools } from '../src/runner.ts'
import type { EngineConfig } from '../src/types.ts'
import type { TaskContext } from '../src/scheduler.ts'

const worker = { name: 'test', backend: 'pi' as const }
const legacyScenes: JevScenes = { context_filter: true, tool_filter: true, external_filter: true, skill_suggestion: true,
  step_dedup: true, fact_dedup: true, finding_dedup: true, evidence_support: true, trace_observer: true }
const fixture = (calls: Record<string, unknown>[], choose?: (scene: string, criteria: string[]) => string, noul = 0.1, confidence = 0.99) => async (_url: string | URL | Request, init?: RequestInit) => {
  const request = JSON.parse(String(init?.body)) as { model: string; state: unknown; questions: Record<string, { type: string; criteria?: Record<string, string> }> }
  calls.push(request)
  const scene = (request.state as { scene?: string })?.scene ?? ''
  const questionEntries = Object.entries(request.questions)
  const answers = Object.fromEntries(questionEntries.map(([name, question]) => {
    const criteria = Object.keys(question.criteria ?? {})
    if (question.type === 'noul') return [name, { type: 'noul', noul }]
    if (question.type === 'score') return [name, { type: 'score', score: 2.5, confidence: 0.8, probabilities: { '0': 0, '1': 0, '2': 0.5, '3': 0.5 } }]
    const choice = name === 'support' && criteria.includes('supported') ? 'supported'
      : choose?.(scene, criteria) ?? criteria.find(key => key !== 'none') ?? 'none'
    return [name, { type: 'choice', choice, confidence, probabilities: Object.fromEntries(criteria.map(key => [key, key === choice ? 1 : 0])) }]
  }))
  return Response.json({ model: request.model, answers, usage: { input_tokens: 120 } })
}

function seedGraph(store: Store, facts = 30) {
  const { project } = store.createProject({ title: 'Jev fixture', origin: 'Authorized test scope', goal: 'Verify endpoint exposure' })
  const subgoal = store.addGoal(project.id, 'Inspect endpoint behavior')
  const source = store.addFact(project.id, `Direct source ${'evidence '.repeat(45)}`)
  const step = store.addStep(project.id, { description: `Inspect the authorized endpoint ${'context '.repeat(12)}`, sourceIds: ['origin', source.id], goalId: subgoal.id })
  const run = store.claim(project.id, 'execute', worker, step.id)
  for (let index = 1; index < facts; index++) store.addFact(project.id, `Candidate ${index} ${'unrelated detail '.repeat(30)}`)
  return { project, step, run, source }
}

test('Jev defaults off and context filtering keeps scope, goal, current Step, and direct sources', async () => {
  const store = new Store(':memory:'), calls: Record<string, unknown>[] = [], root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project, step, run, source } = seedGraph(store)
    const service = new JevService(store, root, fixture(calls, (_scene, criteria) => criteria.includes('f008') ? 'f008' : criteria.find(key => key !== 'none') ?? 'none'))
    assert.equal(await service.filterGraph(run, step, store.graph(project.id)), undefined)
    assert.equal(calls.length, 0)
    service.setScenes(legacyScenes); service.setEnabled(true)
    const filtered = await service.filterGraph(run, step, store.graph(project.id))
    assert.ok(filtered)
    assert.equal(filtered.facts.some(fact => fact.id === 'origin'), true)
    assert.equal(filtered.facts.some(fact => fact.id === source.id), true)
    assert.equal(filtered.facts.some(fact => fact.id === 'f008'), true)
    assert.equal(filtered.facts.some(fact => fact.id === 'f002'), false)
    assert.ok(Buffer.byteLength(JSON.stringify(filtered)) < Buffer.byteLength(JSON.stringify(store.graph(project.id))) * 0.85)
    assert.equal(filtered.steps.some(item => item.id === step.id), true)
    assert.deepEqual(filtered.goals.map(goal => goal.id), ['goal', step.goalId])
    assert.equal(filtered.jev && (filtered.jev as { fullRead: string }).fullRead, 'read_graph({full:true,offset})')
    assert.ok(await service.filterGraph(run, step, store.graph(project.id)))
    assert.equal(calls.length, 1, 'same revision and input use the cached judgment')
    assert.equal((await service.evaluations(project.id))[0]?.cache_hit, true)
    assert.equal((await service.evaluations(project.id))[0]?.status, 'ok')
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('Explore candidate choice and evidence readiness are advisory, bounded, and cached by input', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY, previousPoc = process.env.REDTRACE_POC_DIR, previousLists = process.env.REDTRACE_WORDLISTS_DIR
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project, run, source } = seedGraph(store, 1), calls: Record<string, unknown>[] = []
    const service = new JevService(store, root, fixture(calls))
    service.setEnabled(true)
    const candidates = [
      { id: 'a', title: 'Source A', reference: 'https://example.test/a', detail: 'Direct endpoint documentation' },
      { id: 'b', title: 'Source B', reference: 'https://example.test/b', detail: 'General discussion' },
    ]
    const chosen = await service.chooseCandidate(run, 'web', 'Find endpoint documentation', candidates, [source.id])
    assert.equal(chosen.status, 'advisory')
    if (!('recommendedId' in chosen)) throw new Error('Expected candidate advice')
    assert.equal(chosen.recommendedId, 'a')
    assert.equal(chosen.scores.a?.type, 'score')
    assert.deepEqual(chosen.candidates, candidates)
    store.addFact(project.id, 'Unrelated revision')
    const repeated = await service.chooseCandidate(run, 'web', 'Find endpoint documentation', candidates, [source.id])
    assert.ok('recommendedId' in repeated && repeated.recommendedId === 'a')
    assert.equal(calls.length, 1)
    const readiness = await service.assessAttack(run, 'Test documented endpoint', ['Endpoint is reachable'], [source.id])
    assert.equal(readiness.status, 'advisory')
    if (!('score' in readiness)) throw new Error('Expected readiness advice')
    assert.equal(readiness.score, 2.5)
    assert.match(readiness.note, /no calibrated success probability/)
    assert.equal(calls.length, 2)
    assert.equal((await service.assessAttack(run, 'Test endpoint', ['Reachable'], ['missing'])).status, 'unknown_fact')
    const scanner = [{ id: 'scan_a', title: 'Scanner A', reference: process.execPath }, { id: 'scan_b', title: 'Scanner B', reference: process.execPath }]
    assert.equal((await service.chooseCandidate(run, 'scanner', 'Inspect endpoint', scanner)).status, 'advisory')
    const poc = path.join(root, 'poc'), lists = path.join(root, 'lists')
    mkdirSync(poc); mkdirSync(lists)
    for (const dir of [poc, lists]) { writeFileSync(path.join(dir, 'a.txt'), 'a'); writeFileSync(path.join(dir, 'b.txt'), 'b') }
    process.env.REDTRACE_POC_DIR = poc; process.env.REDTRACE_WORDLISTS_DIR = lists
    const files = [{ id: 'file_a', title: 'File A', reference: 'a.txt' }, { id: 'file_b', title: 'File B', reference: 'b.txt' }]
    assert.equal((await service.chooseCandidate(run, 'poc', 'Pick a PoC', files)).status, 'advisory')
    assert.equal((await service.chooseCandidate(run, 'wordlist', 'Pick a dictionary', files)).status, 'advisory')
    assert.equal((await service.chooseCandidate(run, 'poc', 'Pick a PoC', [{ ...files[0], reference: '../outside.txt' }, files[1]])).status, 'insufficient_eligible_candidates')
    assert.equal((await service.chooseCandidate(run, 'web', 'Find endpoint documentation', [{ ...candidates[0], reference: 'file:///tmp/a' }, candidates[1]])).status, 'insufficient_eligible_candidates')
    assert.equal(calls.length, 5)
    service.finishRun(run.id)
    const changed = path.join(poc, 'a.txt')
    writeFileSync(changed, 'c'); utimesSync(changed, new Date(Date.now() + 5000), new Date(Date.now() + 5000))
    assert.equal((await service.chooseCandidate(run, 'poc', 'Pick a PoC', files)).status, 'advisory')
    assert.equal(calls.length, 6, 'changed local candidate invalidates the cached ranking')
    const context = { store, run, worker, config: { maxSteps: null } as EngineConfig, signal: new AbortController().signal, jev: service } as TaskContext
    assert.ok(graphTools(context, () => {}).some(item => item.name === 'jev_choose'))
    assert.ok(graphTools(context, () => {}).some(item => item.name === 'jev_assess_attack'))
    service.setScenes({ candidate_choice: false, attack_readiness: true })
    assert.equal(graphTools(context, () => {}).some(item => item.name === 'jev_choose'), true, 'registered for later hot enable; hidden from the model while disabled')
    assert.match(activityPrompt('execute', undefined, false, true), /jev_assess_attack/)
    assert.doesNotMatch(activityPrompt('execute', undefined, false, true), /jev_choose/)
    service.setEnabled(false)
    assert.equal((await service.chooseCandidate(run, 'web', 'Find endpoint documentation', candidates)).status, 'disabled')
    store.finishRun(run.id, 'succeeded')
    assert.equal((await service.evaluations(project.id))[0]?.runOutcome.status, 'succeeded')
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    if (previousPoc === undefined) delete process.env.REDTRACE_POC_DIR
    else process.env.REDTRACE_POC_DIR = previousPoc
    if (previousLists === undefined) delete process.env.REDTRACE_WORDLISTS_DIR
    else process.env.REDTRACE_WORDLISTS_DIR = previousLists
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('tool excerpts preserve exact recovery locations, accept code, and honor scene switches', async () => {
  const store = new Store(':memory:'), calls: Record<string, unknown>[] = [], root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project, run } = seedGraph(store, 1), service = new JevService(store, root, fixture(calls, undefined, 0.99))
    service.setScenes(legacyScenes); service.setEnabled(true)
    const text = Array.from({ length: 60 }, (_, index) => `${index + 5}: ${`line ${index} `.repeat(24)}`).join('\n')
    const sourceFile = path.join(root, project.id, 'workspace', 'results.txt')
    mkdirSync(path.dirname(sourceFile), { recursive: true }); writeFileSync(sourceFile, text)
    const filtered = await service.filterToolText(run, 'workspace/results.txt', text)
    assert.ok(filtered)
    assert.match(filtered, /^5: line 0/)
    assert.match(filtered, /workspace\/results\.txt/)
    assert.match(filtered, /Re-read \.redtrace-output\/jev\/[a-f0-9]+\.txt at offset 3/)
    const recoveryPath = filtered.match(/Exact original: ([^\s]+)\. Omitted lines:/)?.[1]
    assert.ok(recoveryPath)
    assert.equal(readFileSync(path.join(root, project.id, recoveryPath), 'utf8'), text)
    assert.equal(isJevRecoveryPath(recoveryPath), true)
    assert.equal(await service.filterToolText(run, recoveryPath, text), undefined)
    service.setScenes({ ...legacyScenes, fact_dedup: false })
    store.addFact(project.id, 'An unrelated later Fact')
    assert.ok(await service.filterToolText(run, 'workspace/results.txt', text))
    assert.equal(calls.length, 1, 'unchanged tool text reuses its judgment across graph revisions')
    assert.ok(Buffer.byteLength(filtered) < Buffer.byteLength(text) * 0.85)
    assert.equal(readFileSync(sourceFile, 'utf8'), text)
    assert.ok(await service.filterToolText(run, 'payload.txt', 'print("proof")\n'.repeat(1000), true))
    assert.equal(calls.length, 2, 'code-like text is eligible for relevance filtering')
    const external = await service.filterToolText(run, 'https://docs.example.test/article', text, true)
    assert.match(external ?? '', /External instruction risk was flagged/)
    assert.equal(calls.length, 3)
    service.setScenes({ tool_filter: false })
    assert.equal(await service.filterToolText(run, 'workspace/results.txt', text), undefined)
    assert.equal(calls.length, 3)
    service.close()
    assert.ok(store.project(project.id))
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('read_graph keeps older relevant Facts discoverable and pages over the original graph', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project } = store.createProject({ title: 'Long graph', origin: 'Scope', goal: 'Endpoint marker' })
    const old = store.addFact(project.id, 'Endpoint marker discovered on host')
    const step = store.addStep(project.id, { description: 'Inspect the endpoint marker', sourceIds: ['origin'] })
    const run = store.claim(project.id, 'execute', worker, step.id)
    for (let index = 0; index < 120; index++) store.addFact(project.id, `Other note ${index} ${'unrelated detail '.repeat(30)}`)
    const calls: Record<string, unknown>[] = []
    const service = new JevService(store, root, fixture(calls, (_scene, criteria) => criteria.includes(old.id) ? old.id : 'none'))
    service.setScenes(legacyScenes); service.setEnabled(true)
    const context = { store, run, worker, config: { maxSteps: null } as EngineConfig, signal: new AbortController().signal, jev: service } as TaskContext
    const read = graphTools(context, () => {}).find(item => item.name === 'read_graph')!
    const page = async (args: { offset?: number; full?: boolean; id?: string }) => {
      const block = (await read.execute('read', args)).content[0]!
      if (block.type !== 'text') throw new Error('Expected graph text')
      return JSON.parse(block.text)
    }
    const focused = await page({})
    assert.equal(focused.nextOffset, 100)
    assert.equal(focused.facts.some((fact: { id: string }) => fact.id === old.id), true)
    assert.ok(focused.jev.omittedIds.length > 0)
    assert.equal((await page({ full: true })).facts.length, 100)
    assert.ok((await page({ offset: 100 })).facts.length > 0)
    assert.equal((await page({ id: old.id })).id, old.id)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('low-confidence filtering returns the original context', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project, run, step } = seedGraph(store)
    mkdirSync(path.join(root, project.id), { recursive: true })
    const service = new JevService(store, root, fixture([], undefined, 0.1, 0.3))
    service.setScenes(legacyScenes); service.setEnabled(true)
    assert.equal(await service.filterGraph(run, step, store.graph(project.id)), undefined)
    assert.equal(await service.filterToolText(run, 'output.txt', 'useful line\n'.repeat(900)), undefined)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('graph filtering skips Jev when required context already consumes the page', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  try {
    const { project } = store.createProject({ title: 'Large scope', origin: 'scope '.repeat(3000), goal: 'Inspect endpoint' })
    const step = store.addStep(project.id, { description: 'Inspect endpoint', sourceIds: ['origin'] })
    const run = store.claim(project.id, 'execute', worker, step.id)
    store.addFact(project.id, 'Small unrelated note')
    const calls: Record<string, unknown>[] = [], service = new JevService(store, root, fixture(calls))
    service.setScenes(legacyScenes); service.setEnabled(true)
    assert.equal(await service.filterGraph(run, step, store.graph(project.id)), undefined)
    assert.equal(calls.length, 0)
    service.close()
  } finally { store.close(); rmSync(root, { recursive: true, force: true }) }
})

test('tool filtering returns the original result when its recovery snapshot cannot be saved', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { run } = seedGraph(store, 1)
    const service = new JevService(store, root, fixture([]))
    service.setScenes(legacyScenes); service.setEnabled(true)
    assert.equal(await service.filterToolText(run, 'shell output', 'output line\n'.repeat(900)), undefined)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('background review leaves a slot for critical context and Trace ignores new progress', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project, run, step } = seedGraph(store)
    const calls: Record<string, unknown>[] = [], answer = fixture(calls)
    let release: (() => void) | undefined, started = 0
    const service = new JevService(store, root, (url, init) => {
      started++
      if (started === 1) return new Promise<Response>(resolve => { release = () => { void answer(url, init).then(resolve) } })
      return answer(url, init)
    })
    service.setScenes(legacyScenes); service.setEnabled(true)
    const skill = service.suggestSkill(run, step, [{ name: 'endpoint-audit', description: 'Inspect endpoints' }])
    await new Promise<void>(resolve => setImmediate(resolve))
    assert.equal(started, 1)
    assert.ok(await service.filterGraph(run, step, store.graph(project.id)))
    assert.equal(started, 2, 'critical context uses the reserved request slot')
    release?.(); await skill
    const progress = Array.from({ length: 10 }, () => traceCall('read', { path: 'same.txt' }, 'same', false, false))
    progress[4] = traceCall('read', { path: 'same.txt' }, 'new evidence', false, true)
    assert.equal(await service.observeTrace(run, step, progress), false)
    assert.equal(started, 2)
    const queryPlan = store.db.prepare("EXPLAIN QUERY PLAN SELECT result_json FROM jev_evaluations WHERE cache_key=? AND status='ok'").all('x')
    assert.match(JSON.stringify(queryPlan), /jev_cache_key/)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('Skill, duplicate, and Trace results are advisory and trace reminders are rate limited', async () => {
  const store = new Store(':memory:'), calls: Record<string, unknown>[] = [], root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project, step, run, source } = seedGraph(store, 15), service = new JevService(store, root, fixture(calls, (_scene, criteria) => criteria.includes('f002') ? 'f002' : criteria.find(key => key !== 'none') ?? 'none', 0.99))
    service.setScenes(legacyScenes); service.setEnabled(true)
    assert.equal((await service.suggestSkill(run, step, [{ name: 'endpoint-audit', description: 'Inspect HTTP endpoints', invocation: { modelInvocable: true } }]))?.name, 'endpoint-audit')
    assert.equal((await service.suggestDuplicate(project.id, source, run))?.duplicateId, 'f002')
    const tools = Array.from({ length: 10 }, (_, index) => traceCall('read', { path: 'same.txt' }, `same result ${index % 2}`, false, false))
    assert.equal(await service.observeTrace(run, step, tools), true)
    assert.equal(await service.observeTrace(run, step, tools), false)
    assert.equal(calls.length, 3)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('evidence review sends bounded text but stores only the judgment and source path', async () => {
  const store = new Store(':memory:'), calls: Record<string, unknown>[] = [], root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project } = store.createProject({ title: 'Jev evidence', origin: 'Scope', goal: 'Confirm the claim' })
    const workspace = path.join(root, project.id)
    mkdirSync(workspace, { recursive: true })
    const evidenceText = 'fixture-secret-evidence: the endpoint disclosed the configured marker.'
    writeFileSync(path.join(workspace, 'evidence.txt'), evidenceText)
    const fact = store.addFact(project.id, 'The endpoint returned the configured marker', { evidence: [{ path: 'evidence.txt', description: 'HTTP response excerpt' }] })
    const finding = store.addFinding(project.id, { title: 'Endpoint discloses configured marker', description: 'Observed in response', factIds: [fact.id] })
    const service = new JevService(store, root, fixture(calls))
    service.setScenes({ evidence_support: false }); service.setScenes(legacyScenes); service.setEnabled(true); service.setScenes({ evidence_support: true })
    const result = await service.reviewFinding(project.id, finding.id, true)
    assert.equal(result.status, 'supported')
    const evaluations = await service.evaluations(project.id)
    assert.equal(evaluations[0]?.result.evidencePaths[0], 'evidence.txt')
    assert.doesNotMatch(JSON.stringify(evaluations), /fixture-secret-evidence/)
    assert.equal(calls.length, 1)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('missing key and timeout fail open', async () => {
  const store = new Store(':memory:'), calls: Record<string, unknown>[] = [], root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    const { project, run, step } = seedGraph(store)
    const service = new JevService(store, root, fixture(calls))
    service.setScenes(legacyScenes); service.setEnabled(true)
    delete process.env.TYPESAFE_API_KEY
    assert.equal(await service.filterGraph(run, step, store.graph(project.id)), undefined)
    assert.equal((await service.evaluations(project.id))[0]?.status, 'missing_api_key')
    process.env.TYPESAFE_API_KEY = 'test-key'
    service.close()
    const timeoutService = new JevService(store, root, async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    timeoutService.setScenes(legacyScenes); timeoutService.setEnabled(true)
    const result = await timeoutService.filterToolText(run, 'output.txt', `${'output line\n'.repeat(800)}`)
    assert.equal(result, undefined)
    assert.ok((await timeoutService.evaluations(project.id)).some(entry => entry.status === 'timeout_or_disabled'))
    timeoutService.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('turning the plugin off aborts in-flight calls and bypasses later calls', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { run } = seedGraph(store, 1)
    let calls = 0
    const service = new JevService(store, root, async (_url, init) => {
      calls++
      return new Promise((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    })
    service.setScenes(legacyScenes); service.setEnabled(true)
    const text = 'output line\n'.repeat(900)
    const pending = service.filterToolText(run, 'output.txt', text)
    service.setEnabled(false)
    assert.equal(await pending, undefined)
    assert.equal(await service.filterToolText(run, 'output.txt', text), undefined)
    assert.equal(calls, 1)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('deleting a project aborts its active Jev request before cascading its audit rows', async () => {
  const store = new Store(':memory:'), root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-jev-'))
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project, run } = seedGraph(store, 1)
    const service = new JevService(store, root, async (_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    }))
    service.setScenes(legacyScenes); service.setEnabled(true)
    const pending = service.filterToolText(run, 'output.txt', 'output line\n'.repeat(900))
    store.markDeleting(project.id)
    assert.equal(await pending, undefined)
    store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id)
    assert.equal(Number(store.db.prepare('SELECT count(*) AS count FROM jev_evaluations WHERE project_id=?').get(project.id)?.count ?? 0), 0)
    service.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})
