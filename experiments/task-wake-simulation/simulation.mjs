import assert from 'node:assert/strict'

// Closed square-calculation experiment: no exports, agents, external tools or runtime imports.
const rawLimit = process.argv[2] ?? '3'
if (rawLimit !== 'null' && !/^[1-9]\d*$/.test(rawLimit)) throw new Error('Usage: node simulation.mjs [positive-step-limit|null]')
const defaultLimit = rawLimit === 'null' ? null : Number(rawLimit)
if (defaultLimit !== null && !Number.isSafeInteger(defaultLimit)) throw new Error('Step limit must be a safe integer')
const live = new Set(['pending', 'running', 'paused', 'stopping'])
const text = value => typeof value === 'string' && value.trim().length > 0
const squareInput = input => Number.isSafeInteger(input) && Number.isSafeInteger(input ** 2)
const occupied = t => t.steps.filter(s => live.has(s.status)).length
const capacity = t => t.limit ?? Infinity
const writable = t => assert(['active', 'stopped'].includes(t.status), 'Task is not writable')

function task(limit = defaultLimit, candidates = []) {
  assert(limit === null || Number.isSafeInteger(limit) && limit > 0, 'Invalid Step limit')
  assert(Array.isArray(candidates) && candidates.every(squareInput), 'Invalid square candidates')
  // ponytail: retain array history for finite square cases; bound fixture size if this experiment grows.
  return { status: 'active', limit, candidates: [...new Set(candidates)], steps: [], facts: [], findings: [],
    goals: [{ id: 'goal', input: null, parentId: null, description: 'Verify the requested squares', status: 'open', evidenceIds: [] }],
    graphRevision: 0, events: [], acknowledged: 0, initial: true, planning: null, retry: false, retryAt: 0 }
}
function goal(t, id) {
  const g = t.goals.find(g => g.id === id)
  assert(g, 'Goal belongs to another task')
  return g
}
function addGoal(t, input, description = 'Verify square ' + input) {
  writable(t)
  assert(goal(t, 'goal').status === 'open', 'Root Goal is closed')
  assert(t.candidates.includes(input) && text(description), 'Subgoal must advance a requested square')
  assert(!t.goals.some(g => g.input === input), 'Duplicate Subgoal')
  const g = { id: 'g' + t.goals.length, input, parentId: 'goal', description, status: 'open', evidenceIds: [] }
  t.goals.push(g); t.graphRevision++
  return g
}
function sources(t, ids) {
  assert(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length, 'Invalid sources')
  assert(ids.every(id => id === 'origin' || t.facts.some(f => f.id === id) || t.findings.some(f => f.id === id)), 'Unknown source')
}
function action(t, input, g, sourceIds, except = null) {
  assert(squareInput(input) && t.candidates.includes(input) && g.input === input && g.status === 'open', 'Step must advance its open Subgoal')
  sources(t, sourceIds)
  assert(!t.facts.some(f => f.input === input), 'Square is already verified')
  assert(!t.steps.some(s => s !== except && live.has(s.status) && s.input === input), 'Duplicate live calculation')
  assert(!t.steps.some(s => s !== except && s.replacement?.input === input), 'Calculation already awaits replacement')
}
function addStep(t, input, options = {}) {
  writable(t)
  const g = options.goalId ? goal(t, options.goalId) : t.goals.find(g => g.input === input)
  const sourceIds = options.sourceIds ?? ['origin'], priority = options.priority ?? 0
  action(t, input, g ?? { input, status: 'open' }, sourceIds)
  assert(Number.isSafeInteger(priority) && occupied(t) < capacity(t), 'Invalid priority or full Step capacity')
  const savedGoal = g ?? addGoal(t, input)
  const s = { id: 's' + (t.steps.length + 1), input, goalId: savedGoal.id, sourceIds: [...sourceIds], priority,
    status: 'pending', attempts: 0, replacement: null, replaces: options.replaces ?? null, removed: false }
  t.steps.push(s); t.graphRevision++
  return s
}
function notify(t, type, node) {
  const event = { seq: t.events.length + 1, type, node: structuredClone(node) }
  t.events.push(event)
  if (t.planning) t.planning.reminder = { message: 'New calculation events; read incrementally', latestSeq: event.seq }
}
function stepStatus(t, s, status) {
  assert(t.steps.includes(s) && t.status === 'active', 'Step cannot execute in this task')
  assert(['running', 'paused', 'done', 'failed'].includes(status), 'Invalid execution status')
  if (s.status === status) return
  assert(status === 'running' ? ['pending', 'paused'].includes(s.status) : s.status === 'running', 'Invalid execution transition')
  assert(goal(t, s.goalId).status === 'open', 'Step Subgoal is closed')
  if (status === 'running' && s.status === 'pending') s.attempts++
  s.status = status; t.graphRevision++
  if (status === 'done' || status === 'failed') notify(t, 'step.' + status, s)
}
function cancelStep(t, s) {
  writable(t)
  assert(t.steps.includes(s) && !['done', 'failed'].includes(s.status), 'Cannot cancel a concluded Step')
  if (s.status === 'cancelled' || s.status === 'stopping') {
    if (s.replacement) { s.replacement = null; t.graphRevision++ }
    return s
  }
  s.replacement = null
  s.status = s.status === 'pending' && !s.attempts ? 'cancelled' : 'stopping'
  t.graphRevision++
  return s
}
function updateStep(t, s, patch) {
  writable(t)
  assert(t.steps.includes(s) && live.has(s.status), 'Step cannot be edited')
  const input = patch.input ?? s.input, goalId = patch.goalId ?? s.goalId, sourceIds = patch.sourceIds ?? s.sourceIds
  const priority = patch.priority ?? s.priority
  assert(Number.isSafeInteger(priority), 'Invalid priority')
  const changed = input !== s.input || goalId !== s.goalId || JSON.stringify(sourceIds) !== JSON.stringify(s.sourceIds)
  if (changed) {
    assert(s.status !== 'stopping', 'Wait for the previous replacement')
    action(t, input, goal(t, goalId), sourceIds, s)
  }
  s.priority = priority
  if (changed && s.status === 'pending' && !s.attempts) Object.assign(s, { input, goalId, sourceIds: [...sourceIds] })
  else if (changed) { s.status = 'stopping'; s.replacement = { input, goalId, sourceIds: [...sourceIds] } }
  t.graphRevision++
  return s
}
function removeStep(t, s) {
  cancelStep(t, s); s.removed = true; t.graphRevision++
}
function acknowledgeStop(t, s) {
  assert(t.steps.includes(s) && s.status === 'stopping', 'No stopping execution')
  const replacement = s.replacement
  s.status = 'cancelled'; s.replacement = null; t.graphRevision++
  if (!replacement || !['active', 'stopped'].includes(t.status) || goal(t, replacement.goalId).status !== 'open'
      || t.facts.some(f => f.input === replacement.input) || t.steps.some(other => live.has(other.status) && other.input === replacement.input)) return null
  return addStep(t, replacement.input, { ...replacement, priority: s.priority, replaces: s.id })
}
function fact(t, s, submission) {
  assert(t.status === 'active' && t.steps.includes(s) && s.status === 'running', 'Only the current running calculation can submit')
  assert(goal(t, s.goalId).status === 'open', 'Subgoal is closed')
  assert(text(submission.evidence) && text(submission.value), 'Evidence and goal value are required')
  assert(submission.square === s.input ** 2 && Number.isSafeInteger(submission.square), 'Unsupported square result')
  const existing = t.facts.find(f => f.input === s.input && f.square === submission.square)
  if (existing) return existing
  const f = { id: 'f' + (t.facts.length + 1), stepId: s.id, goalId: s.goalId, input: s.input,
    square: submission.square, evidence: submission.evidence, value: submission.value }
  t.facts.push(f); t.graphRevision++; notify(t, 'fact.added', f)
  return f
}
function finding(t, factIds, total, value) {
  assert(t.status === 'active' && text(value), 'Finding needs goal value in an active task')
  assert(Array.isArray(factIds) && factIds.length >= 2 && new Set(factIds).size === factIds.length, 'Finding needs distinct supporting Facts')
  const facts = factIds.map(id => t.facts.find(f => f.id === id))
  assert(facts.every(Boolean), 'Unknown supporting Fact')
  assert(Number.isSafeInteger(total) && total === facts.reduce((sum, f) => sum + f.square, 0), 'Unsupported total')
  const ids = [...factIds].sort()
  const existing = t.findings.find(f => JSON.stringify(f.factIds) === JSON.stringify(ids) && f.total === total)
  if (existing) return existing
  const f = { id: 'finding' + (t.findings.length + 1), factIds: ids, total, value }
  t.findings.push(f); t.graphRevision++; notify(t, 'finding.added', f)
  return f
}
function updateGoal(t, g, patch) {
  writable(t)
  assert(t.goals.includes(g) && g.status === 'open', 'Only an open Goal can change')
  if (patch.description !== undefined) assert(text(patch.description), 'Invalid Goal description')
  const status = patch.status ?? g.status
  assert(['open', 'achieved', 'cancelled'].includes(status) && !(g.id === 'goal' && status === 'cancelled'), 'Invalid Goal transition')
  if (status === 'achieved') {
    const ids = patch.evidenceIds
    assert(Array.isArray(ids) && ids.length && new Set(ids).size === ids.length, 'Goal completion requires evidence')
    const support = ids.flatMap(id => {
      const f = t.facts.find(f => f.id === id)
      if (f) return [f]
      const result = t.findings.find(f => f.id === id)
      assert(result, 'Unknown Goal evidence')
      return result.factIds.map(fid => t.facts.find(f => f.id === fid))
    })
    const inputs = g.id === 'goal' ? t.candidates : [g.input]
    assert(inputs.length && inputs.every(input => support.some(f => f.input === input)), 'Evidence does not achieve this Goal')
  }
  if (patch.description !== undefined) g.description = patch.description
  g.status = status
  if (status === 'achieved') g.evidenceIds = [...patch.evidenceIds]
  if (status !== 'open') {
    const closed = g.id === 'goal' ? t.goals : [g]
    for (const child of closed) {
      if (child !== g && child.status === 'open') child.status = 'cancelled'
      for (const s of t.steps.filter(s => s.goalId === child.id && live.has(s.status))) cancelStep(t, s)
    }
    if (g.id === 'goal') t.status = 'completed'
  }
  t.graphRevision++
}
function taskStatus(t, status) {
  assert(['active', 'stopped', 'completed'].includes(status))
  if (t.status !== status) { t.status = status; t.graphRevision++ }
}
function begin(t, now = 0, deadline = null) {
  assert(deadline === null || Number.isFinite(deadline) && deadline > now, 'Invalid planning deadline')
  if (t.status !== 'active' || t.planning || now < t.retryAt || !(t.initial || t.retry || t.events.length > t.acknowledged)) return false
  t.planning = { readSeq: t.acknowledged, processedSeq: t.acknowledged, deadline, reminder: null }
  return true
}
function planning(t, now) {
  assert(t.status === 'active' && t.planning && (t.planning.deadline === null || now < t.planning.deadline), 'No active planning budget')
  return t.planning
}
function takeReminder(t) {
  assert(t.planning, 'No planning activity')
  const reminder = t.planning.reminder
  t.planning.reminder = null
  return reminder
}
function readDelta(t, limit = 2, now = 0) {
  const p = planning(t, now)
  assert(Number.isSafeInteger(limit) && limit > 0, 'Invalid event page size')
  const page = t.events.slice(p.readSeq, p.readSeq + limit)
  if (page.length) p.readSeq = page.at(-1).seq
  if (p.reminder && p.readSeq >= p.reminder.latestSeq) p.reminder = null
  return structuredClone(page)
}
function planSquares(t) {
  for (const input of t.candidates) {
    if (occupied(t) >= capacity(t)) break
    const g = t.goals.find(g => g.input === input)
    if (g && g.status !== 'open' || t.facts.some(f => f.input === input)
        || t.steps.some(s => s.input === input || s.replacement?.input === input)) continue
    addStep(t, input)
  }
}
function evaluate(t, now = 0) {
  const p = planning(t, now)
  // The stand-in planner only handles this finite list of local square calculations.
  planSquares(t)
  p.processedSeq = p.readSeq
}
function finish(t, { success = true, now = 0, retryAt = now } = {}) {
  assert(t.planning, 'No planning activity')
  const p = t.planning
  const completedPlan = t.status === 'completed' && goal(t, 'goal').status === 'achieved' && p.processedSeq === t.events.length
  if (!success || t.status !== 'active' && !completedPlan || p.deadline !== null && now >= p.deadline) {
    assert(Number.isFinite(retryAt) && retryAt >= now, 'Invalid retry deadline')
    t.planning = null; t.retry = true; t.retryAt = retryAt
    return 'retry'
  }
  if (p.processedSeq < t.events.length) {
    p.reminder = { message: 'Unprocessed calculation events; read and evaluate before finishing', latestSeq: t.events.length }
    return 'continue'
  }
  // Synchronous check + commit models one atomic end boundary; no await or external executor.
  t.acknowledged = p.processedSeq; t.initial = false; t.retry = false; t.retryAt = 0; t.planning = null
  return 'finished'
}
function restore(snapshot) {
  const t = JSON.parse(snapshot)
  if (t.planning) { t.planning = null; t.retry = true }
  return t
}
function ready(limit = null, candidates = [2, 3, 4, 5]) {
  const t = task(limit, candidates); assert(begin(t)); assert.equal(finish(t), 'finished'); return t
}
function running(t, input) {
  const s = t.steps.find(s => s.input === input && s.status === 'pending') ?? addStep(t, input)
  stepStatus(t, s, 'running'); return s
}
const result = (t, s) => fact(t, s, { square: s.input ** 2, evidence: 'Local integer arithmetic', value: 'Verifies requested square ' + s.input })
function settle(t) {
  while (readDelta(t).length) {}
  evaluate(t); assert.equal(finish(t), 'finished')
}
let passed = 0
function check(name, run) { run(); passed++; console.log('ok ' + passed + ' - ' + name) }

check('first planning uses origin and requested Goal; empty plans do not spin', () => {
  const t = task(defaultLimit, [2, 2, 3, 4, 5])
  assert(begin(t)); assert(!begin(t)); settle(t)
  assert.equal(occupied(t), Math.min(capacity(t), 4))
  assert(t.steps.every(s => goal(t, s.goalId).input === s.input && s.sourceIds[0] === 'origin'))
  assert(!begin(t))
  const empty = task(3); assert(begin(empty)); settle(empty); assert.equal(empty.steps.length, 0); assert(!begin(empty))
})
check('Fact alone wakes before a Step ends, including full capacity', () => {
  const t = ready(1), s = running(t, 2)
  result(t, s); assert.equal(s.status, 'running'); assert(begin(t)); settle(t)
  assert.equal(occupied(t), 1); assert(!begin(t))
})
check('Finding alone wakes after supporting Facts were already acknowledged', () => {
  const t = ready(), a = result(t, running(t, 2)), b = result(t, running(t, 3))
  assert(begin(t)); settle(t)
  const previous = t.acknowledged
  finding(t, [a.id, b.id], 13, 'Summarizes requested squares')
  assert.equal(t.events.length, previous + 1); assert(begin(t)); settle(t); assert(!begin(t))
})
check('active planning receives one compact latest reminder and no second planner', () => {
  const t = ready(), a = running(t, 2), b = running(t, 3)
  result(t, a); assert(begin(t, 0, 10))
  const p = t.planning
  result(t, b); stepStatus(t, a, 'done'); stepStatus(t, b, 'failed')
  assert(!begin(t)); assert.equal(t.planning, p); assert.equal(p.deadline, 10)
  assert.deepEqual(takeReminder(t), { message: 'New calculation events; read incrementally', latestSeq: 4 })
  assert.equal(takeReminder(t), null); settle(t)
})
check('incremental pages are detached, ordered, complete and never repeated', () => {
  const t = ready(), a = running(t, 2), b = running(t, 3)
  result(t, a); result(t, b); stepStatus(t, a, 'done'); assert(begin(t))
  const first = readDelta(t, 1); first[0].node.square = 999
  assert.equal(t.facts[0].square, 4)
  assert.deepEqual(first.map(e => e.seq), [1])
  assert.deepEqual(readDelta(t, 1).map(e => e.seq), [2])
  assert.deepEqual(readDelta(t, 1).map(e => e.seq), [3]); assert.deepEqual(readDelta(t), [])
  assert.equal(t.acknowledged, 0); evaluate(t); assert.equal(finish(t), 'finished'); assert.equal(t.acknowledged, 3)
})
check('reading or delivering a reminder cannot acknowledge evaluation', () => {
  const t = ready(), s = running(t, 2)
  result(t, s); assert(begin(t)); readDelta(t)
  assert.equal(finish(t), 'continue'); assert.equal(t.acknowledged, 0)
  takeReminder(t); assert.equal(finish(t), 'continue')
  evaluate(t); assert.equal(finish(t), 'finished')
})
check('new evidence before finish stays in the same planning activity', () => {
  const t = ready(), a = running(t, 2), b = running(t, 3)
  result(t, a); assert(begin(t)); readDelta(t); evaluate(t)
  const p = t.planning; result(t, b)
  assert.equal(finish(t), 'continue'); assert.equal(t.planning, p); assert.equal(t.acknowledged, 0)
  assert.deepEqual(readDelta(t).map(e => e.seq), [2]); evaluate(t)
  assert.equal(finish(t), 'finished'); assert.equal(t.acknowledged, 2); assert(!begin(t))
})
check('an event after atomic finish starts exactly one next activity', () => {
  const t = ready(), a = running(t, 2), b = running(t, 3)
  result(t, a); assert(begin(t)); settle(t)
  result(t, b); assert(begin(t)); assert(!begin(t)); settle(t); assert(!begin(t))
})
for (const status of ['done', 'failed']) check('a ' + status + ' Step wakes without a Fact and only once', () => {
  const t = ready(), s = running(t, 2)
  stepStatus(t, s, status); assert(begin(t)); settle(t)
  const count = t.events.length; stepStatus(t, s, status)
  assert.equal(t.events.length, count); assert(!begin(t))
})
check('burst notifications cannot extend the injected budget or lose events', () => {
  const t = ready(), a = running(t, 2), b = running(t, 3)
  result(t, a); assert(begin(t, 0, 10)); readDelta(t)
  result(t, b); stepStatus(t, a, 'done')
  assert.equal(t.planning.deadline, 10); assert.throws(() => evaluate(t, 10))
  assert.equal(finish(t, { now: 10, retryAt: 20 }), 'retry'); assert.equal(t.acknowledged, 0)
  assert(!begin(t, 19)); assert(begin(t, 20, 30)); readDelta(t, 10, 20); evaluate(t, 20)
  assert.equal(finish(t, { now: 20 }), 'finished'); assert(!begin(t, 21))
})
check('failed planning preserves all events and respects the supplied retry time', () => {
  const t = ready(), s = running(t, 2); result(t, s); assert(begin(t)); readDelta(t); evaluate(t)
  assert.equal(finish(t, { success: false, retryAt: 100 }), 'retry'); assert.equal(t.acknowledged, 0)
  assert(!begin(t, 99)); assert(begin(t, 100)); settle(t); assert(!begin(t, 101))
  const initial = task(); assert(begin(initial)); finish(initial, { success: false, retryAt: 100 })
  assert(!begin(initial, 99)); assert(begin(initial, 100)); settle(initial)
})
check('duplicate and unsupported submissions do not change graph or events', () => {
  const t = ready(), s = running(t, 2), f = result(t, s), revision = t.graphRevision
  assert.equal(result(t, s), f)
  for (const submission of [
    { square: 5, evidence: 'Arithmetic', value: 'Goal' },
    { square: 4, evidence: '', value: 'Goal' },
    { square: 4, evidence: 'Arithmetic', value: '' },
  ]) assert.throws(() => fact(t, s, submission))
  assert.equal(t.graphRevision, revision); assert.equal(t.events.length, 1)
  assert.throws(() => addStep(t, 99)); assert.throws(() => task(3, [Number.MAX_SAFE_INTEGER]))
})
check('Finding dedup ignores reference order and requires a new supported conclusion', () => {
  const t = ready(), a = result(t, running(t, 2)), b = result(t, running(t, 3))
  const f = finding(t, [a.id, b.id], 13, 'Goal total'), revision = t.graphRevision, count = t.events.length
  assert.equal(finding(t, [b.id, a.id], 13, 'Same total rephrased'), f)
  assert.throws(() => finding(t, [a.id, a.id], 8, 'Duplicate support'))
  assert.throws(() => finding(t, [a.id, 'missing'], 13, 'Unknown support'))
  assert.throws(() => finding(t, [a.id, b.id], 14, 'Wrong total'))
  assert.throws(() => finding(t, [a.id, b.id], 13, ''))
  assert.equal(t.graphRevision, revision); assert.equal(t.events.length, count)
})
check('an unstarted Step edits in place and priority changes do not stop execution', () => {
  const t = ready(), s = addStep(t, 2), nextGoal = addGoal(t, 3), count = t.events.length
  updateStep(t, s, { input: 3, goalId: nextGoal.id }); assert.equal(t.steps.length, 1); assert.equal(s.input, 3)
  stepStatus(t, s, 'running'); updateStep(t, s, { priority: 9 })
  assert.equal(s.status, 'running'); assert.equal(s.priority, 9); assert.equal(t.events.length, count); assert(!begin(t))
})
check('running replacement waits for stop, preserves Facts and rejects late writes', () => {
  const t = ready(1), s = running(t, 2), f = result(t, s), nextGoal = addGoal(t, 3)
  updateStep(t, s, { input: 3, goalId: nextGoal.id, sourceIds: [f.id] })
  assert.equal(s.status, 'stopping'); assert.equal(occupied(t), 1); assert.equal(t.steps.length, 1)
  assert.throws(() => addStep(t, 3)); assert.throws(() => result(t, s)); assert.throws(() => stepStatus(t, s, 'done'))
  const replacement = acknowledgeStop(t, s)
  assert.equal(s.status, 'cancelled'); assert.equal(replacement.status, 'pending'); assert.equal(replacement.replaces, s.id)
  assert.deepEqual(replacement.sourceIds, [f.id]); assert.equal(t.facts[0], f); assert.equal(occupied(t), 1)
  stepStatus(t, replacement, 'running'); assert.throws(() => result(t, s))
  assert.equal(result(t, replacement).square, 9); assert.equal(t.events.length, 2)
})
check('paused execution also requires stop acknowledgement before replacement', () => {
  const t = ready(1), s = running(t, 2), nextGoal = addGoal(t, 3)
  stepStatus(t, s, 'paused'); updateStep(t, s, { input: 3, goalId: nextGoal.id })
  assert.equal(s.status, 'stopping'); assert.equal(occupied(t), 1)
  assert.equal(acknowledgeStop(t, s).status, 'pending')
})
check('removing a Step retains history, consumes stopping capacity and emits no event', () => {
  const t = ready(1), s = running(t, 2), f = result(t, s)
  assert(begin(t)); settle(t); const count = t.events.length
  removeStep(t, s); assert(s.removed); assert.equal(s.status, 'stopping'); assert.equal(occupied(t), 1)
  assert.equal(acknowledgeStop(t, s), null); assert.equal(occupied(t), 0)
  assert.equal(t.steps[0], s); assert.equal(t.facts[0], f); assert.equal(t.events.length, count); assert(!begin(t))
  const pending = addStep(t, 3); removeStep(t, pending); assert.equal(pending.status, 'cancelled')
})
check('closing a Subgoal suppresses queued replacement without a planning loop', () => {
  const t = ready(1), s = running(t, 2), nextGoal = addGoal(t, 3)
  updateStep(t, s, { input: 3, goalId: nextGoal.id })
  updateGoal(t, nextGoal, { description: 'Abandoned calculation', status: 'cancelled' })
  assert.equal(acknowledgeStop(t, s), null); assert.equal(t.steps.length, 1); assert.equal(t.events.length, 0); assert(!begin(t))
})
check('Subgoal achievement requires matching evidence; Step completion alone is insufficient', () => {
  const t = ready(), a = running(t, 2), b = running(t, 3), g = goal(t, a.goalId)
  const other = result(t, b); stepStatus(t, a, 'done')
  assert.equal(g.status, 'open')
  assert.throws(() => updateGoal(t, g, { status: 'achieved', evidenceIds: [] }))
  assert.throws(() => updateGoal(t, g, { status: 'achieved', evidenceIds: [other.id] }))
  assert.throws(() => updateGoal(t, g, { status: 'achieved', evidenceIds: ['origin'] }))
  updateGoal(t, g, { description: 'Still needs confirmed square evidence' }); assert.equal(g.status, 'open')
})
check('Root Goal accepts supported Finding only when all requested squares are covered', () => {
  const t = ready(null, [2, 3]), a = running(t, 2), b = running(t, 3), fa = result(t, a), fb = result(t, b)
  const summary = finding(t, [fa.id, fb.id], 13, 'All requested results')
  assert(begin(t)); readDelta(t, 10); evaluate(t)
  assert.throws(() => updateGoal(t, goal(t, 'goal'), { status: 'achieved', evidenceIds: [fa.id] }))
  updateGoal(t, goal(t, a.goalId), { status: 'achieved', evidenceIds: [fa.id] })
  assert.equal(a.status, 'stopping')
  updateGoal(t, goal(t, 'goal'), { status: 'achieved', evidenceIds: [summary.id] })
  assert.equal(t.status, 'completed'); assert.equal(b.status, 'stopping'); assert.equal(finish(t), 'finished'); assert(!begin(t))
  assert.equal(acknowledgeStop(t, a), null); assert.equal(acknowledgeStop(t, b), null)
})
check('retry and unfinished events survive JSON recovery without false acknowledgement', () => {
  let t = ready(), s = running(t, 2); result(t, s)
  t = restore(JSON.stringify(t)); assert(begin(t)); readDelta(t); evaluate(t)
  t = restore(JSON.stringify(t)); assert.equal(t.acknowledged, 0); assert(begin(t)); settle(t)
  t = restore(JSON.stringify(t)); assert(!begin(t)); assert.equal(t.limit, null)
})
check('stopping replacements survive recovery and remain pending while task is stopped', () => {
  let t = ready(1), s = running(t, 2), nextGoal = addGoal(t, 3)
  updateStep(t, s, { input: 3, goalId: nextGoal.id }); taskStatus(t, 'stopped')
  t = restore(JSON.stringify(t)); s = t.steps[0]
  assert.equal(occupied(t), 1); const replacement = acknowledgeStop(t, s)
  assert.equal(replacement.status, 'pending'); assert.throws(() => stepStatus(t, replacement, 'running'))
  taskStatus(t, 'active'); stepStatus(t, replacement, 'running'); assert.equal(replacement.input, 3)
})
check('stopped and completed tasks keep notifications without automatic evaluation', () => {
  for (const status of ['stopped', 'completed']) {
    const t = ready(), s = running(t, 2); result(t, s); taskStatus(t, status)
    assert(!begin(t)); const restored = restore(JSON.stringify(t)); assert(!begin(restored))
    taskStatus(restored, 'active'); assert(begin(restored)); settle(restored)
  }
  const t = ready(); taskStatus(t, 'stopped'); taskStatus(t, 'active'); assert(!begin(t))
})
check('stopping an active planner cannot acknowledge its read events', () => {
  const t = ready(), s = running(t, 2); result(t, s); assert(begin(t)); readDelta(t); evaluate(t)
  taskStatus(t, 'stopped'); assert.throws(() => readDelta(t)); assert.equal(finish(t), 'retry'); assert.equal(t.acknowledged, 0)
  taskStatus(t, 'active'); assert(begin(t)); settle(t)
})
check('tasks isolate event cursors, reminders and supporting evidence', () => {
  const a = ready(), b = ready(), c = ready(), sa = running(a, 2), sb = running(b, 3)
  const fa = result(a, sa); assert(begin(a)); stepStatus(b, sb, 'failed')
  assert.equal(a.planning.reminder, null); assert.equal(b.events.length, 1); assert(!begin(c))
  assert.throws(() => fact(b, sa, { square: 4, evidence: 'Arithmetic', value: 'Goal' }))
  assert.throws(() => finding(b, [fa.id, 'missing'], 13, 'Foreign support'))
  settle(a); assert.equal(b.acknowledged, 0); assert(begin(b)); settle(b)
})
check('plan edits do not notify themselves or recreate abandoned calculations', () => {
  const t = task(3, [2, 3]), s = addStep(t, 2)
  assert(begin(t)); removeStep(t, s); updateGoal(t, goal(t, s.goalId), { status: 'cancelled' }); settle(t)
  assert.equal(t.events.length, 0); assert(!begin(t)); assert.equal(t.steps.filter(s => s.input === 2).length, 1)
})
check('invalid edits fail before altering a running calculation', () => {
  const t = ready(), s = running(t, 2), before = structuredClone(s), revision = t.graphRevision
  assert.throws(() => updateStep(t, s, { priority: 7, input: 99 }))
  assert.throws(() => updateStep(t, s, { sourceIds: ['unknown'] }))
  assert.deepEqual(s, before); assert.equal(t.graphRevision, revision)
})
check('invalid creation cannot leave an orphan Subgoal and submission cannot forge identity', () => {
  const t = ready(1), before = JSON.stringify(t)
  assert.throws(() => addStep(t, 2, { sourceIds: ['unknown'] }))
  assert.throws(() => addStep(t, 2, { priority: 0.5 }))
  assert.equal(JSON.stringify(t), before)
  const s = running(t, 2), full = JSON.stringify(t)
  assert.throws(() => addStep(t, 3)); assert.equal(JSON.stringify(t), full)
  const f = fact(t, s, { square: 4, evidence: 'Arithmetic', value: 'Requested square', id: 'forged', input: 99, stepId: 'foreign', goalId: 'foreign' })
  assert.equal(f.id, 'f1'); assert.equal(f.input, 2); assert.equal(f.stepId, s.id); assert.equal(f.goalId, s.goalId)
})

console.log(passed + ' acceptance checks passed; demo Step limit: ' + (defaultLimit ?? 'unlimited'))
