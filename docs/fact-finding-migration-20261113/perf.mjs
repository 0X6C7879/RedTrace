import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
const root = process.argv[2]
const { Store } = await import(pathToFileURL(root+'/packages/redtrace-engine/src/store.ts'))
const { graphTools } = await import(pathToFileURL(root+'/packages/redtrace-engine/src/runner.ts'))
const store = new Store(':memory:')
const { project } = store.createProject({ title: 'performance fixture', origin: 'authorized synthetic fixture only', goal: 'measure', bootstrap: false })
const graphId = store.projectGraphs(project.id)[0].id
const insert = store.db.prepare('INSERT INTO nodes(project_id,id,kind,data,graph_id) VALUES(?,?,?,?,?)')
store.db.exec('BEGIN')
for (let i = 0; i < 2000; i++) insert.run(project.id, 'bulk-'+i, 'fact', JSON.stringify({ id: 'bulk-'+i, graphId, projectId: project.id, kind: 'fact', title: 'Fact '+i, description: 'Synthetic confirmed summary '.repeat(30), evidence: [{ description: 'Synthetic raw evidence '.repeat(30) }], stepId: null, version: 1, creator: 'fixture', createdAt: '' }), graphId)
for (let i = 0; i < 200; i++) insert.run(project.id, 'finding-'+i, 'finding', JSON.stringify({ id: 'finding-'+i, graphId, projectId: project.id, kind: 'finding', title: 'Finding '+i, description: 'Synthetic aggregate summary '.repeat(10), details: null, factIds: Array.from({ length: 10 }, (_, j) => 'bulk-'+(i*10+j)), version: 1, creator: 'fixture', createdAt: '' }), graphId)
store.db.exec('COMMIT')
const step = store.addStep(project.id, { description: 'measure', sourceIds: ['origin','bulk-1999'] })
const run = store.claim(project.id, 'execute', { name: 'fixture', backend: 'mock' }, step.id)
const read = graphTools({ store, run, worker: { name: 'fixture' }, config: { workspaceRoot: '/tmp', maxSteps: null }, signal: new AbortController().signal }, () => {}).find(t => t.name === 'read_graph')
const times = []; let page
for (let i = 0; i < 5; i++) { const start = performance.now(); page = (await read.execute('measure', { limit: 100 })).details; times.push(performance.now()-start) }
console.log(JSON.stringify({ fixture: { facts: 2000, findings: 200, supportingFactsPerFinding: 10, activeIndependentDependencies: 1 }, medianMs: times.sort((a,b) => a-b)[2], contextBytes: Buffer.byteLength(JSON.stringify(page)), factPage: page.facts.length, findingPage: page.findings.length, retainsActiveDependency: page.facts.some(f => f.id === 'bulk-1999') }))
store.close()
