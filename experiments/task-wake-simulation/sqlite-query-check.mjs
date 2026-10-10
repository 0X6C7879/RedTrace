import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { performance } from 'node:perf_hooks'

// Closed query experiment: square results in memory, no production imports or workers.
const samples = 9
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]
function measure(read) {
  for (let i = 0; i < 3; i++) read()
  const wall = [], cpu = []
  let result
  for (let i = 0; i < samples; i++) {
    const usage = process.cpuUsage(), start = performance.now()
    result = read()
    wall.push(performance.now() - start)
    const elapsed = process.cpuUsage(usage)
    cpu.push((elapsed.user + elapsed.system) / 1000)
  }
  return { medianMs: median(wall), medianCpuMs: median(cpu), parsedNodes: result.parsedNodes }
}

const results = []
for (const nodeCount of [123, 20_083]) {
  const db = new DatabaseSync(':memory:')
  try {
    db.exec(`CREATE TABLE nodes(task_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL,
      data TEXT NOT NULL, PRIMARY KEY(task_id,id));`)
    const insert = db.prepare('INSERT INTO nodes VALUES (?,?,?,?)')
    db.exec('BEGIN')
    insert.run('squares', 'goal', 'goal', JSON.stringify({ id: 'goal', kind: 'goal', status: 'open' }))
    for (let i = 0; i < 8; i++) insert.run('squares', `s${i}`, 'step', JSON.stringify({ id: `s${i}`, kind: 'step', goalId: 'goal', status: 'running', input: i }))
    for (let i = 0; i < nodeCount - 9; i++) insert.run('squares', `f${i}`, 'fact', JSON.stringify({ id: `f${i}`, kind: 'fact', input: i, square: i ** 2, description: 'Verified local arithmetic. '.repeat(8) }))
    // A second task proves selection is scoped to the requested task.
    insert.run('other', 's0', 'step', JSON.stringify({ id: 's0', kind: 'step', status: 'paused' }))
    db.exec('COMMIT')

    const all = db.prepare('SELECT data FROM nodes WHERE task_id=? ORDER BY rowid')
    const one = db.prepare('SELECT data FROM nodes WHERE task_id=? AND id=?')
    const sql = "SELECT data FROM nodes WHERE task_id=? AND kind IN ('step','goal') ORDER BY rowid"
    const selected = db.prepare(sql)
    const beforeIndex = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('squares').map(row => row.detail)
    db.exec('CREATE INDEX nodes_task_kind ON nodes(task_id,kind)')
    const selectionPlan = db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all('squares').map(row => row.detail)
    assert(selectionPlan.some(detail => /SEARCH nodes USING INDEX nodes_task_kind/.test(detail)))
    const pointPlan = db.prepare('EXPLAIN QUERY PLAN SELECT data FROM nodes WHERE task_id=? AND id=?').all('squares', 's0').map(row => row.detail)
    assert(pointPlan.some(detail => /SEARCH nodes USING INDEX sqlite_autoindex_nodes/.test(detail)))

    for (const readers of [1, 8]) {
      function readFull() {
        let parsedNodes = 0
        const graph = () => { const rows = all.all('squares'); parsedNodes += rows.length; return rows.map(row => JSON.parse(row.data)) }
        const healthy = Array.from({ length: readers }, (_, i) => {
          const nodes = graph(), step = nodes.find(node => node.id === `s${i}`)
          return step.status === 'running' && nodes.find(node => node.id === step.goalId).status === 'open'
        })
        const schedulingNodes = graph().filter(node => node.kind === 'step' || node.kind === 'goal')
        return { healthy, schedulingNodes, parsedNodes }
      }
      function readIndexed() {
        const healthy = Array.from({ length: readers }, (_, i) => {
          const step = JSON.parse(one.get('squares', `s${i}`).data)
          const goal = JSON.parse(one.get('squares', step.goalId).data)
          return step.status === 'running' && goal.status === 'open'
        })
        const schedulingNodes = selected.all('squares').map(row => JSON.parse(row.data))
        return { healthy, schedulingNodes, parsedNodes: readers * 2 + schedulingNodes.length }
      }
      const full = readFull(), indexed = readIndexed()
      assert.deepEqual(indexed.healthy, full.healthy)
      assert.deepEqual(indexed.schedulingNodes, full.schedulingNodes)
      assert.equal(indexed.schedulingNodes.length, 9)
      assert.equal(indexed.parsedNodes, readers * 2 + 9)
      assert.equal(full.parsedNodes, (readers + 1) * nodeCount)
      results.push({ nodeCount, readers, full: measure(readFull), indexed: measure(readIndexed), beforeIndex, selectionPlan, pointPlan })
    }
  } finally { db.close() }
}
console.log(JSON.stringify({ node: process.version, samples, measuredAt: new Date().toISOString(), results }, null, 2))
