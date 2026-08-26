import assert from 'node:assert/strict'
import test from 'node:test'

import { selectWorker } from '../lib/scheduler.js'

const workers = [
  { name: 'glm-explore', enabled: true, provider: 'glm', model: 'glm-5.3', bootstrap: false, reason: false, explore: true, maxRunning: 3, priority: 80 },
  { name: 'gpt-worker', enabled: true, provider: 'openai', model: 'gpt-5.6', bootstrap: true, reason: true, explore: true, maxRunning: 2, priority: 100 },
  { name: 'deepseek-reason', enabled: true, provider: 'deepseek', model: 'deepseek-reasoner', bootstrap: false, reason: true, explore: false, maxRunning: 1, priority: 120 },
  { name: 'disabled', enabled: false, provider: 'x', model: 'x', bootstrap: true, reason: true, explore: true, maxRunning: 5, priority: 0 },
]

test('routes each task type only to workers eligible for it', () => {
  assert.equal(selectWorker(workers, () => 0, 'reason').name, 'gpt-worker')
  assert.equal(selectWorker(workers, () => 0, 'explore').name, 'glm-explore')
  assert.equal(selectWorker(workers, () => 0, 'bootstrap').name, 'gpt-worker')
})

test('respects per-worker max_running capacity', () => {
  const running = new Map([['glm-explore', 3], ['gpt-worker', 2]])
  const picked = selectWorker(workers, name => running.get(name) ?? 0, 'explore')
  assert.equal(picked, undefined)
  running.set('gpt-worker', 1)
  assert.equal(selectWorker(workers, name => running.get(name) ?? 0, 'explore').name, 'gpt-worker')
})

test('prefers priority, then the least-loaded worker for fairness', () => {
  const running = new Map([['glm-explore', 1]])
  assert.equal(selectWorker(workers, name => running.get(name) ?? 0, 'explore').name, 'glm-explore')
  running.set('glm-explore', 3)
  assert.equal(selectWorker(workers, name => running.get(name) ?? 0, 'explore').name, 'gpt-worker')
})

test('falls back to the next eligible worker when the preferred one lacks the task type', () => {
  // gpt-worker (priority 100) is ineligible for reason only through its flags
  // here: deepseek-reason must win even though its priority is worse.
  const local = [
    { ...workers[1], reason: false },
    workers[2],
  ]
  assert.equal(selectWorker(local, () => 0, 'reason').name, 'deepseek-reason')
  // With deepseek-reason also disabled, no worker is left for reason.
  assert.equal(selectWorker([
    { ...workers[1], reason: false },
    { ...workers[2], enabled: false },
  ], () => 0, 'reason'), undefined)
})

test('normalizes a missing or zero max_running to a cap of one', () => {
  const one = [
    { name: 'a', enabled: true, provider: 'x', model: 'x', bootstrap: false, reason: true, explore: false, maxRunning: 0, priority: 1 },
    { name: 'b', enabled: true, provider: 'x', model: 'x', bootstrap: false, reason: true, explore: false, priority: 2 },
  ]
  assert.equal(selectWorker(one, () => 0, 'reason').name, 'a')
  // Both workers effectively cap at 1: 'a' is busy, so 'b' takes over.
  assert.equal(selectWorker(one, name => name === 'a' ? 1 : 0, 'reason').name, 'b')
  // And when both are busy there is nothing to pick.
  assert.equal(selectWorker(one, () => 1, 'reason'), undefined)
})

test('breaks priority and load ties by name for determinism', () => {
  const twins = [
    { name: 'zeta', enabled: true, provider: 'x', model: 'x', bootstrap: false, reason: true, explore: false, maxRunning: 2, priority: 50 },
    { name: 'alpha', enabled: true, provider: 'x', model: 'x', bootstrap: false, reason: true, explore: false, maxRunning: 2, priority: 50 },
  ]
  assert.equal(selectWorker(twins, () => 0, 'reason').name, 'alpha')
  // Equal priority, unequal load: least-loaded wins regardless of name.
  assert.equal(selectWorker(twins, name => name === 'alpha' ? 1 : 0, 'reason').name, 'zeta')
})
