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
