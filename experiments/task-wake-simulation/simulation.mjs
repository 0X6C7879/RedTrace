import assert from 'node:assert/strict'

// Closed, deterministic simulation: local square calculations, no workers or tools.
const rawLimit = process.argv[2] ?? '3'
if (rawLimit !== 'null' && !/^[1-9]\d*$/.test(rawLimit)) throw new Error('Usage: node simulation.mjs [positive-step-limit|null]')
const defaultLimit = rawLimit === 'null' ? null : Number(rawLimit)
if (defaultLimit !== null && !Number.isSafeInteger(defaultLimit)) throw new Error('Step limit must be a safe integer')
const live = new Set(['pending', 'running', 'paused'])

function task(limit = defaultLimit, candidates = []) {
  return { status: 'active', limit, candidates: [...new Set(candidates)], steps: [], facts: [], graphRevision: 0,
    factSeq: 0, endedSeq: 0, acknowledged: { factSeq: 0, endedSeq: 0 }, initial: true, planning: null, retry: false, retryAt: 0 }
}
const occupied = t => t.steps.filter(s => live.has(s.status)).length
const capacity = t => t.limit ?? Infinity
function addStep(t, input) {
  assert(!t.steps.some(s => s.input === input), 'Duplicate calculation')
  assert(occupied(t) < capacity(t), 'No free Step capacity')
  const s = { input, status: 'pending' }
  t.steps.push(s); t.graphRevision++
  return s
}
function stepStatus(t, s, status) {
  assert(t.steps.includes(s), 'Step belongs to another task')
  assert([...live, 'done', 'failed', 'cancelled'].includes(status), 'Invalid Step status')
  if (s.status === status) return
  assert(live.has(s.status), 'Cannot reopen a terminal Step')
  if (status === 'done' || status === 'failed') t.endedSeq++
  s.status = status; t.graphRevision++
}
function fact(t, s) {
  assert(t.steps.includes(s) && s.status === 'running', 'Fact requires a running calculation')
  t.facts.push({ input: s.input, square: s.input ** 2 })
  t.factSeq++; t.graphRevision++
}
function taskStatus(t, status) {
  assert(['active', 'stopped', 'completed'].includes(status))
  if (t.status !== status) { t.status = status; t.graphRevision++ }
}
function begin(t, now = 0) {
  if (t.status !== 'active' || t.planning || occupied(t) >= capacity(t) || now < t.retryAt) return false
  if (!t.initial && !t.retry && !(t.factSeq > t.acknowledged.factSeq && t.endedSeq > t.acknowledged.endedSeq)) return false
  t.planning = { factSeq: t.factSeq, endedSeq: t.endedSeq }
  return true
}
function finish(t, success = true, retryAt = 0) {
  assert(t.planning, 'No planning activity')
  if (success) {
    // Finite candidates represent useful, independently executable calculations.
    if (t.status === 'active') for (const input of t.candidates) {
      if (occupied(t) >= capacity(t)) break
      if (!t.steps.some(s => s.input === input)) addStep(t, input)
    }
    t.acknowledged = t.planning; t.initial = false; t.retry = false; t.retryAt = 0
  } else {
    t.retry = true; t.retryAt = retryAt
  }
  t.planning = null
}
function restore(snapshot) {
  const t = JSON.parse(snapshot)
  // An interrupted simulation can retry; its event boundary was not acknowledged.
  if (t.planning) { t.planning = null; t.retry = true }
  return t
}
function ready(limit = null) { const t = task(limit); assert(begin(t)); finish(t); return t }
function running(t, input) { const s = addStep(t, input); stepStatus(t, s, 'running'); return s }

let passed = 0
function check(name, run) { run(); passed++; console.log(`ok ${passed} - ${name}`) }

check('first launch only; reactivation does not create a planning event', () => {
  const t = task(); assert(begin(t)); assert(!begin(t)); finish(t); assert(!begin(t))
  taskStatus(t, 'stopped'); assert(!begin(t)); taskStatus(t, 'active'); assert(!begin(t))
})
check('many Facts from one running Step coalesce and cannot wake alone', () => {
  const t = ready(), s = running(t, 2), revision = t.graphRevision
  for (let i = 0; i < 5; i++) fact(t, s)
  assert.equal(t.graphRevision, revision + 5); assert(!begin(t))
  stepStatus(t, s, 'done'); assert(begin(t)); assert(!begin(t)); finish(t); assert(!begin(t))
})
check('ending a Step without a new Fact cannot wake', () => {
  const t = ready(), s = running(t, 2)
  stepStatus(t, s, 'done'); assert(!begin(t))
})
for (const order of ['fact-first', 'end-first']) check(`different Steps pair in either order: ${order}`, () => {
  const t = ready(), a = running(t, 2), b = running(t, 3)
  if (order === 'fact-first') { fact(t, a); assert(!begin(t)); stepStatus(t, b, 'done') }
  else { stepStatus(t, b, 'done'); assert(!begin(t)); fact(t, a) }
  assert(begin(t)); finish(t)
  fact(t, a); assert(!begin(t), 'Previously acknowledged ending must not be reused')
})
check('events from different tasks never pair', () => {
  const a = ready(), b = ready(), sa = running(a, 2), sb = running(b, 3)
  fact(a, sa); stepStatus(b, sb, 'done'); assert(!begin(a)); assert(!begin(b))
})
check('pending, running and paused Steps occupy capacity; full capacity preserves events', () => {
  const t = ready(3), a = running(t, 2), b = addStep(t, 3), c = running(t, 4)
  stepStatus(t, c, 'paused'); assert.equal(occupied(t), 3)
  fact(t, a); stepStatus(t, b, 'done'); const replacement = addStep(t, 5)
  assert(!begin(t)); assert.deepEqual(t.acknowledged, { factSeq: 0, endedSeq: 0 })
  stepStatus(t, replacement, 'cancelled'); assert(begin(t)); finish(t)
})
for (const status of ['done', 'failed', 'paused', 'cancelled']) check(`Step outcome: ${status}`, () => {
  const t = ready(), s = running(t, 2); fact(t, s); stepStatus(t, s, status)
  assert.equal(begin(t), status === 'done' || status === 'failed')
  const before = t.endedSeq; stepStatus(t, s, status); assert.equal(t.endedSeq, before)
})
check('tail stage: spare capacity and elapsed time cannot wake on a Fact alone', () => {
  const t = ready(3), s = running(t, 2); fact(t, s)
  assert(!begin(t)); assert(!begin(t, 1_000_000)); stepStatus(t, s, 'done'); assert(begin(t))
})
check('planning acknowledges its start boundary and preserves events arriving during it', () => {
  const t = ready(), a = running(t, 2), b = running(t, 3)
  fact(t, a); stepStatus(t, a, 'done'); assert(begin(t))
  fact(t, b); stepStatus(t, b, 'failed'); finish(t)
  assert.deepEqual(t.acknowledged, { factSeq: 1, endedSeq: 1 })
  assert(begin(t)); finish(t); assert(!begin(t))
})
check('failed planning keeps events and respects a supplied retry deadline', () => {
  const t = ready(), s = running(t, 2); fact(t, s); stepStatus(t, s, 'done'); assert(begin(t))
  finish(t, false, 100); assert.deepEqual(t.acknowledged, { factSeq: 0, endedSeq: 0 })
  assert(!begin(t, 99)); assert(begin(t, 100)); finish(t); assert(!begin(t, 101))
})
check('failed first planning also respects retry timing', () => {
  const t = task(); assert(begin(t)); finish(t, false, 100)
  assert(!begin(t, 99)); assert(begin(t, 100)); finish(t); assert(!begin(t))
})
check('JSON recovery retains pending events, acknowledged events and interrupted planning', () => {
  let t = ready(), s = running(t, 2); fact(t, s); stepStatus(t, s, 'done')
  t = restore(JSON.stringify(t)); assert(begin(t))
  t = restore(JSON.stringify(t)); assert(begin(t)); finish(t)
  t = restore(JSON.stringify(t)); assert(!begin(t)); assert.equal(t.limit, null)
})
check('stopped and completed tasks preserve pending events without automatic planning', () => {
  for (const status of ['stopped', 'completed']) {
    const t = ready(), s = running(t, 2); fact(t, s); stepStatus(t, s, 'done'); taskStatus(t, status)
    assert(!begin(t)); const restored = restore(JSON.stringify(t)); assert(!begin(restored))
    taskStatus(restored, 'active'); assert(begin(restored), 'Reactivation retains an existing event pair')
  }
})
check('planner fills available capacity using finite, nonduplicate calculations', () => {
  const t = task(defaultLimit, [2, 2, 3, 4, 5]); assert(begin(t)); finish(t)
  assert.equal(occupied(t), Math.min(capacity(t), 4)); assert(!begin(t))
  const s = t.steps[0]; stepStatus(t, s, 'running'); fact(t, s); stepStatus(t, s, 'done')
  assert(begin(t)); finish(t)
  assert.equal(occupied(t), Math.min(capacity(t), 3)); assert.equal(new Set(t.steps.map(s => s.input)).size, t.steps.length)
})
check('no useful candidates permits an unsaturated plan', () => {
  const t = task(3, [2]); assert(begin(t)); finish(t); assert.equal(occupied(t), 1); assert(!begin(t))
})

console.log(`${passed} acceptance checks passed; demo Step limit: ${defaultLimit ?? 'unlimited'}`)
