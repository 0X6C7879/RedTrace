import assert from 'node:assert/strict'
import test from 'node:test'

import {
  activateAgent, fetchAllResources, planDispatch, postWithRetry,
  reasonEligible, resolveLimits, sessionIdForTask, sessionPlan, taskTurn,
} from '../lib/scheduler.js'
import { schedulable } from '../lib/context.js'

function summary(id, overrides = {}) {
  return {
    id,
    status: 'active',
    reason: null,
    planning_revision: 1,
    reason_evaluated_revision: 1,
    ...overrides,
  }
}

function intent(overrides = {}) {
  return {
    id: 'intent-1',
    from: ['origin'],
    to: null,
    description: 'do the thing',
    creator: 'user',
    worker: null,
    created_at: '2026-01-01T00:00:00Z',
    state: 'open',
    ...overrides,
  }
}

const LIMS = { maxWorkers: 4, maxProjectWorkers: 2, maxRunningProjects: 2 }

test('every Reason wake receives a fresh session just like other tasks', () => {
  assert.notEqual(sessionIdForTask('reason', 'proj_001'), sessionIdForTask('reason', 'proj_001'))
  assert.notEqual(sessionIdForTask('explore', 'proj_001'), sessionIdForTask('explore', 'proj_001'))
})

test('Reason ignores paused and conclude recovery sessions while Explore keeps recovery', () => {
  const reason = sessionPlan('reason', 'proj_001', 'paused-reason', 'conclude-reason')
  assert.notEqual(reason.sessionId, 'paused-reason')
  assert.notEqual(reason.sessionId, 'conclude-reason')
  assert.equal(reason.resumeOnly, false)
  assert.equal(reason.concludeOnly, false)

  assert.deepEqual(sessionPlan('explore', 'proj_001', 'paused-explore', 'conclude-explore'), {
    sessionId: 'paused-explore', resumeOnly: true, concludeOnly: false,
  })
  assert.deepEqual(sessionPlan('explore', 'proj_001', undefined, 'conclude-explore'), {
    sessionId: 'conclude-explore', resumeOnly: false, concludeOnly: true,
  })
})

test('activateAgent resumes a recovered session and creates a missing one', async () => {
  const calls = []
  const handle = { agent: {}, async dispose() {} }
  const agents = {
    async create(options) { calls.push(['create', options]); return handle },
    async resume(options) { calls.push(['resume', options]); return handle },
  }
  await activateAgent(agents, 'rt-p-reason', '/workspace/p', { agentOptions: { model: 'm' } }, true)
  await activateAgent(agents, 'rt-p-reason', '/workspace/p', { agentOptions: { model: 'm' } }, false)
  assert.deepEqual(calls, [
    ['resume', { resumeSessionId: 'rt-p-reason', agentOptions: { model: 'm' } }],
    ['create', { sessionId: 'rt-p-reason', meta: { cwd: '/workspace/p' }, agentOptions: { model: 'm' } }],
  ])
})

test('conclude retries use each task short prompt and conclude timeout', () => {
  for (const type of ['bootstrap', 'reason', 'explore']) {
    const turn = taskTurn(type, 'conclude', 'LONG LAUNCH PROMPT', {
      timeout: 300,
      conclude_timeout: 17,
    })
    assert.equal(turn.timeout, 17)
    assert.ok(!turn.prompt.includes('LONG LAUNCH PROMPT'))
    assert.match(turn.prompt, /停止/)
  }
})

test('stopped tasks resume with only the short continue prompt', () => {
  const turn = taskTurn('explore', 'resume', 'LONG LAUNCH PROMPT', { timeout: 300 })
  assert.deepEqual(turn, { prompt: '继续', timeout: 300 })
})

// ─── Health / cooldown gates ────────────────────────────────────────────────

test('schedulable: an open unclaimed intent with no cooldown is schedulable', () => {
  assert.equal(schedulable(intent()), true)
})

test('schedulable: claimed, routed, or closed intents are not schedulable', () => {
  assert.equal(schedulable(intent({ worker: 'glm-worker' })), false)
  assert.equal(schedulable(intent({ to: 'goal' })), false)
  assert.equal(schedulable(intent({ state: 'claimed' })), false)
})

test('schedulable: the circuit breaker and retry deadline gate dispatch', () => {
  const now = Date.now()
  assert.equal(schedulable(intent({ circuit_open: true })), false)
  // Retry deadline still in the future: cooldown active.
  assert.equal(schedulable(intent({ retry_after: (now + 60_000) / 1000 })), false)
  // Deadline passed: back in the pool.
  assert.equal(schedulable(intent({ retry_after: (now - 1_000) / 1000 })), true)
})

test('reasonEligible: the project-level reason cooldown mirrors the intent gate', () => {
  const now = Date.now()
  assert.equal(reasonEligible(summary('p', { reason_circuit_open: true }), now), false)
  assert.equal(reasonEligible(summary('p', { reason_retry_after: (now + 60_000) / 1000 }), now), false)
  assert.equal(reasonEligible(summary('p', { reason_retry_after: (now - 1_000) / 1000 }), now), true)
  assert.equal(reasonEligible(summary('p'), now), true)
})

// ─── Limits resolution ──────────────────────────────────────────────────────

test('resolveLimits: snapshot wins over config over defaults', () => {
  const snapshot = { revision: 'r', workers: [], tasks: {}, limits: { maxWorkers: 8, maxRunningProjects: 7, maxProjectWorkers: 6, interval: 5 } }
  assert.deepEqual(resolveLimits(snapshot, { maxWorkers: 3, maxRunningProjects: 2, maxProjectWorkers: 1, interval: 9 }), {
    maxWorkers: 8, maxRunningProjects: 7, maxProjectWorkers: 6, interval: 5,
  })
  assert.deepEqual(resolveLimits(undefined, { maxWorkers: 3, maxRunningProjects: 2, maxProjectWorkers: 1, interval: 9 }), {
    maxWorkers: 3, maxRunningProjects: 2, maxProjectWorkers: 1, interval: 9,
  })
  assert.deepEqual(resolveLimits(undefined, {}), { maxWorkers: 1, maxRunningProjects: 1, maxProjectWorkers: 1, interval: 2 })
})

// ─── Dispatch planning: fairness + concurrency caps ─────────────────────────

test('planDispatch: rotates active projects round-robin and advances the cursor', () => {
  const projects = [summary('c'), summary('a'), summary('b')]
  const first = planDispatch(projects, [], LIMS, 0)
  assert.deepEqual(first.candidates.map(p => p.id), ['a', 'b', 'c'])
  assert.equal(first.nextCursor, 1)
  // Next round starts one project further along: fairness across ticks.
  const second = planDispatch(projects, [], LIMS, 1)
  assert.deepEqual(second.candidates.map(p => p.id), ['b', 'c', 'a'])
  const third = planDispatch(projects, [], LIMS, 2)
  assert.deepEqual(third.candidates.map(p => p.id), ['c', 'a', 'b'])
  // The cursor keeps counting up; only the offset wraps.
  assert.equal(planDispatch(projects, [], LIMS, 3).nextCursor, 4)
})

test('planDispatch: skips non-active projects and keeps the cursor still', () => {
  const projects = [summary('a'), summary('b', { status: 'stopped' }), summary('c', { status: 'deleting' })]
  const plan = planDispatch(projects, [], LIMS, 5)
  assert.deepEqual(plan.candidates.map(p => p.id), ['a'])
  assert.equal(plan.nextCursor, 6)
  const empty = planDispatch([summary('x', { status: 'completed' })], [], LIMS, 5)
  assert.deepEqual(empty.candidates, [])
  assert.equal(empty.nextCursor, 5)
})

test('planDispatch: the global max_workers cap blocks the whole round', () => {
  const projects = [summary('a'), summary('b')]
  const plan = planDispatch(projects, [{ projectId: 'a' }, { projectId: 'a' }, { projectId: 'a' }, { projectId: 'b' }], LIMS, 0)
  assert.deepEqual(plan.candidates, [])
  assert.equal(plan.nextCursor, 0)
})

test('planDispatch: the per-project cap excludes saturated projects', () => {
  const projects = [summary('a'), summary('b')]
  // 'a' already runs its full maxProjectWorkers (2) tasks.
  const plan = planDispatch(projects, [{ projectId: 'a' }, { projectId: 'a' }], LIMS, 0)
  assert.deepEqual(plan.candidates.map(p => p.id), ['b'])
  // Still eligible when one slot is free.
  const partial = planDispatch(projects, [{ projectId: 'a' }], LIMS, 0)
  assert.deepEqual(partial.candidates.map(p => p.id), ['a', 'b'])
})

test('planDispatch: the distinct-project cap admits running projects but blocks new ones', () => {
  const projects = [summary('a'), summary('b'), summary('c')]
  // maxRunningProjects=2 with 'a' and 'b' running: both stay eligible
  // (they already hold slots), 'c' is blocked as a new project.
  const plan = planDispatch(projects, [{ projectId: 'a' }, { projectId: 'b' }], LIMS, 0)
  assert.deepEqual(plan.candidates.map(p => p.id), ['a', 'b'])
  // Lowering the cap to 1 keeps only the already-running project.
  const tight = planDispatch(projects, [{ projectId: 'a' }], { ...LIMS, maxRunningProjects: 1 }, 0)
  assert.deepEqual(tight.candidates.map(p => p.id), ['a'])
})

// ─── Retry semantics ────────────────────────────────────────────────────────

// ─── Resource pagination ────────────────────────────────────────────────────

test('fetchAllResources: walks pages at the API cap until a short page', async () => {
  const offsets = []
  const page = size => Array.from({ length: size }, (_, index) => ({ id: `r${index}`, kind: 'k', name: `n${index}` }))
  const resources = await fetchAllResources(async offset => {
    offsets.push(offset)
    return offset === 0 ? page(500) : offset === 500 ? page(500) : page(3)
  })
  assert.equal(resources.length, 1003)
  assert.deepEqual(offsets, [0, 500, 1000])
})

test('fetchAllResources: an exact full page still probes one follow-up', async () => {
  const offsets = []
  const resources = await fetchAllResources(async offset => {
    offsets.push(offset)
    return offset === 0 ? Array.from({ length: 500 }, (_, index) => ({ id: `r${index}` })) : []
  })
  assert.equal(resources.length, 500)
  assert.deepEqual(offsets, [0, 500])
})

test('fetchAllResources: a short or empty first page ends immediately', async () => {
  const one = await fetchAllResources(async () => [{ id: 'r0' }])
  assert.deepEqual(one, [{ id: 'r0' }])
  const none = await fetchAllResources(async () => [])
  assert.deepEqual(none, [])
})

// ─── Retry semantics ────────────────────────────────────────────────────────

function recordingFetch(responses) {
  const calls = []
  const queue = [...responses]
  const fn = async (url, init) => {
    calls.push({ url, init })
    const next = queue.shift() ?? { status: 500 }
    if (next instanceof Error) throw next
    return { ok: next.status >= 200 && next.status < 300, status: next.status }
  }
  return { fn, calls }
}

const instantSleep = delays => () => { delays.push('slept'); return Promise.resolve() }

test('postWithRetry: posts the body and returns true on the first success', async () => {
  const { fn, calls } = recordingFetch([{ status: 200 }])
  const delays = []
  assert.equal(await postWithRetry('http://srv/x', { worker: 'w' }, { fetchFn: fn, sleep: instantSleep(delays) }), true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://srv/x')
  assert.equal(calls[0].init.method, 'POST')
  assert.deepEqual(JSON.parse(calls[0].init.body), { worker: 'w' })
  assert.deepEqual(delays, [])
})

test('postWithRetry: a 4xx answers false immediately without retrying', async () => {
  const { fn, calls } = recordingFetch([{ status: 409 }])
  const delays = []
  assert.equal(await postWithRetry('http://srv/x', {}, { fetchFn: fn, sleep: instantSleep(delays) }), false)
  assert.equal(calls.length, 1)
  assert.deepEqual(delays, [])
})

test('postWithRetry: retries 5xx and network errors with linear backoff, then succeeds', async () => {
  const { fn, calls } = recordingFetch([{ status: 503 }, new Error('boom'), { status: 200 }])
  const delays = []
  assert.equal(await postWithRetry('http://srv/x', {}, { fetchFn: fn, sleep: async ms => { delays.push(ms) } }), true)
  assert.equal(calls.length, 3)
  assert.deepEqual(delays, [100, 200])
})

test('postWithRetry: gives up after three attempts and reports the last error', async () => {
  const { fn, calls } = recordingFetch([new Error('e1'), new Error('e2'), new Error('e3')])
  const errors = []
  const delays = []
  assert.equal(await postWithRetry('http://srv/x', {}, {
    fetchFn: fn, sleep: instantSleep(delays), onError: error => { errors.push(String(error)) },
  }), false)
  assert.equal(calls.length, 3)
  assert.deepEqual(errors, ['Error: e3'])
  // Backoff runs after every failed attempt, including the last.
  assert.deepEqual(delays, ['slept', 'slept', 'slept'])
})
