import { Type } from 'typebox'
import { createHash, randomUUID } from 'node:crypto'
import { Router, body, queryNumber, send } from './http.ts'
import type { RequestContext } from './http.ts'
import { Store } from './store.ts'
import { legacyIntent, legacyProject, legacySummary, graphEdges } from './legacy.ts'
import { projectFgs } from './fgs.ts'
import { HttpError, requiredText } from './types.ts'
import type { Fact, Step, Run } from './types.ts'

const text = Type.String({ minLength: 1, pattern: '\\S' }), refs = Type.Array(text, { minItems: 1 })
const workerBody = Type.Object({ worker: text })
const capabilities = Type.Array(Type.Union(['common', 'web', 'pentest', 'binary', 'crypto', 'cloud', 'blockchain', 'hardware', 'ai-security', 'defense'].map(v => Type.Literal(v))), { uniqueItems: true })
const profile = Type.Union([Type.Literal('direct'), Type.Literal('isolated')])
const stepSchema = Type.Object({ description: text, sourceIds: refs, goalId: Type.Optional(text), creator: Type.Optional(text), priority: Type.Optional(Type.Integer()), executionProfile: Type.Optional(profile), capabilities: Type.Optional(capabilities) })
const goalUpdate = Type.Object({ description: Type.Optional(text), status: Type.Optional(Type.Union(['open', 'achieved', 'cancelled'].map(v => Type.Literal(v)))), evidenceIds: Type.Optional(Type.Array(text)) })

function waitChange(store: Store, id: string | undefined, changed: () => boolean, seconds: number, signal: AbortSignal) {
  if (changed() || signal.aborted || seconds === 0) return Promise.resolve()
  return new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); store.changes.off('change', listener); signal.removeEventListener('abort', finish); resolve() }
    const listener = (projectId: string) => { if ((!id || id === projectId) && changed()) finish() }
    const timer = setTimeout(finish, seconds * 1000)
    store.changes.on('change', listener); signal.addEventListener('abort', finish, { once: true })
    if (changed() || signal.aborted) finish()
  })
}

export function graphRoutes(router: Router, store: Store, maxSteps: () => number | null = () => null) {
  const p = (c: RequestContext) => c.params.project
  const requireActive = (id: string) => { const project = store.project(id); if (project.status !== 'active') throw new HttpError(403, `Project is ${project.status}`) }
  const intent = (id: string, sid: string) => { const step = store.node<Step>(id, sid, 'step'); if (step.deleted) throw new HttpError(404, 'Intent not found'); return legacyIntent(step, store.runs(id).findLast(r => r.stepId === sid)) }
  const runFor = (id: string, sid: string, worker: string, claim = false) => {
    const step = store.node<Step>(id, sid, 'step')
    if (claim && step.status === 'pending') return store.claim(id, 'execute', { name: worker, backend: 'dsh' }, sid)
    return store.ownedRun(id, 'execute', worker, sid)
  }
  const createSchema = Type.Object({ title: text, origin: text, goal: text, bootstrap_enabled: Type.Optional(Type.Boolean()), bootstrap: Type.Optional(Type.Boolean()), hints: Type.Optional(Type.Union([Type.Null(), Type.Array(Type.Object({ content: text, creator: text }))])) })
  for (const prefix of ['', '/v2']) {
    router.add('GET', `${prefix}/projects`, () => store.projects().map(project => prefix ? project : legacySummary(store, project.id)))
    router.add('POST', `${prefix}/projects`, async c => {
      const input = await body(c.req, createSchema), graph = store.createProject({ ...input, hints: input.hints ?? [], bootstrap: input.bootstrap ?? input.bootstrap_enabled })
      send(c.res, prefix ? graph : legacyProject(store, graph.project.id), 201)
    })
    router.add('GET', `${prefix}/projects/:project`, c => prefix ? store.graph(p(c)) : legacyProject(store, p(c)))
    router.add('PUT', `${prefix}/projects/:project/title`, async c => { store.rename(p(c), (await body(c.req, Type.Object({ title: text }))).title); return prefix ? store.project(p(c)) : legacyProject(store, p(c)).project })
    router.add('PUT', `${prefix}/projects/:project/status`, async c => { store.setStatus(p(c), (await body(c.req, Type.Object({ status: Type.Union([Type.Literal('active'), Type.Literal('stopped')]) }))).status); return prefix ? store.project(p(c)) : legacyProject(store, p(c)).project })
    router.add('POST', `${prefix}/projects/:project/hints`, async c => { const b = await body(c.req, Type.Object({ content: text, creator: text })); const h = store.addInput(p(c), 'hint', b.content, b.creator); send(c.res, prefix ? h : { id: h.id, content: h.content, creator: h.creator, created_at: h.createdAt }, 201) })
    router.add('DELETE', `${prefix}/projects/:project/hints/:node`, c => { store.deleteInput(p(c), c.params.node); send(c.res, null, 204) })
  }
  router.add('GET', '/v2/projects/:project/graph', c => {
    const graph = c.url.searchParams.has('revision') ? store.graphAt(p(c), queryNumber(c.url, 'revision', 1)) : store.graph(p(c))
    return { ...graph, ...projectFgs(graph) }
  })
  router.add('GET', '/v2/projects/:project/nodes/:node', c => store.node(p(c), c.params.node))
  router.add('GET', '/v2/projects/:project/runs', c => { store.project(p(c)); return store.runs(p(c)) })
  router.add('GET', '/v2/projects/:project/steps/:node/runs', c => { store.node(p(c), c.params.node, 'step'); return store.runs(p(c)).filter(r => r.stepId === c.params.node) })
  router.add('GET', '/v2/projects/:project/runs/:run/events', c => {
    if (store.run(c.params.run).projectId !== p(c)) throw new HttpError(404, 'Run not found')
    return store.db.prepare('SELECT id,data FROM audit_events WHERE project_id=? AND run_id=? AND id<? ORDER BY id DESC LIMIT ?')
      .all(p(c), c.params.run, queryNumber(c.url, 'before', Number.MAX_SAFE_INTEGER), queryNumber(c.url, 'limit', 100, 1, 500))
      .map(row => ({ ...JSON.parse(String(row.data)), id: Number(row.id) })).reverse()
  })
  for (const kind of ['goals', 'steps', 'findings', 'facts', 'observations'] as const) router.add('GET', `/v2/projects/:project/${kind}`, c => store.graph(p(c))[kind])
  router.add('POST', '/v2/projects/:project/goals', async c => { const b = await body(c.req, Type.Object({ description: text, parentId: Type.Optional(text), creator: Type.Optional(text) })); send(c.res, store.addGoal(p(c), b.description, b.parentId, b.creator), 201) })
  router.add('PATCH', '/v2/projects/:project/goals/:node', async c => store.updateGoal(p(c), c.params.node, await body(c.req, goalUpdate)))
  router.add('DELETE', '/v2/projects/:project/goals/:node', c => store.updateGoal(p(c), c.params.node, { status: 'cancelled' }))
  router.add('POST', '/v2/projects/:project/steps', async c => send(c.res, store.addStep(p(c), await body(c.req, stepSchema), maxSteps()), 201))
  router.add('PATCH', '/v2/projects/:project/steps/:node', async c => store.updateStep(p(c), c.params.node, await body(c.req, Type.Object({ priority: Type.Optional(Type.Integer()), status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('cancelled')])), executionProfile: Type.Optional(profile), capabilities: Type.Optional(capabilities) }))))
  router.add('DELETE', '/v2/projects/:project/steps/:node', c => store.updateStep(p(c), c.params.node, { status: 'cancelled' }))
  router.add('POST', '/v2/projects/:project/facts', async c => { const b = await body(c.req, Type.Object({ description: text, creator: Type.Optional(text), evidence: Type.Array(Type.Object({ description: text, path: Type.Optional(text), runId: Type.Optional(text), toolCallId: Type.Optional(text) })) })); send(c.res, store.addFact(p(c), b.description, { creator: b.creator ?? 'human', evidence: b.evidence }), 201) })
  router.add('POST', '/v2/projects/:project/findings', async c => send(c.res, store.addFinding(p(c), await body(c.req, Type.Object({ title: text, description: text, type: Type.Optional(text), factIds: refs, creator: Type.Optional(text) }))), 201))
  router.add('POST', '/v2/projects/:project/observations', async c => { const b = await body(c.req, Type.Object({ content: text, creator: Type.Optional(text), stepId: Type.Optional(text) })); send(c.res, store.addInput(p(c), 'observation', b.content, b.creator, b.stepId), 201) })
  router.add('GET', '/v2/projects/:project/events', c => store.events(p(c), queryNumber(c.url, 'after', 0), queryNumber(c.url, 'limit', 100, 1, 500)))
  router.add('GET', '/v2/projects/:project/stream', async c => {
    store.project(p(c)); let after = queryNumber(c.url, 'after', 0)
    c.res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' }); c.res.flushHeaders()
    while (!c.signal.aborted) {
      const events = store.events(p(c), after)
      for (const event of events) { after = event.id; if (!c.res.write(`id: ${after}\nevent: graph\ndata: ${JSON.stringify(event)}\n\n`)) await new Promise<void>(resolve => { c.res.once('drain', resolve); c.res.once('close', resolve) }) }
      if (events.length === 500) continue
      await waitChange(store, p(c), () => store.events(p(c), after, 1).length > 0, 20, c.signal)
      if (!c.signal.aborted) c.res.write(': keepalive\n\n')
    }
  })
  router.add('POST', '/projects/:project/intents', async c => {
    const b = await body(c.req, Type.Object({ from: refs, description: text, creator: text, worker: Type.Optional(Type.Union([text, Type.Null()])), execution_profile: Type.Optional(profile), capabilities, max_active_intents: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])) }))
    requireActive(p(c))
    if (b.from.includes('goal')) throw new HttpError(400, 'goal cannot be used in from')
    if (b.worker && b.worker !== b.creator) throw new HttpError(400, 'worker must be null or equal to creator')
    const bootstrap = b.creator === 'dispatcher.bootstrap' && b.description === 'bootstrap' && b.from.length === 1 && b.from[0] === 'origin'
    if (!bootstrap && !b.capabilities.length) throw new HttpError(422, 'capabilities must contain at least one direction')
    const result = store.transaction(() => { const s = store.addStep(p(c), { description: b.description, sourceIds: b.from, creator: b.creator, executionProfile: b.execution_profile, capabilities: b.capabilities, bootstrap }, b.max_active_intents); if (b.worker) store.claim(p(c), 'execute', { name: b.worker, backend: 'dsh' }, s.id); return intent(p(c), s.id) })
    send(c.res, result, 201)
  })
  for (const suffix of ['execution-profile', 'capabilities'] as const) router.add('PATCH', `/projects/:project/intents/:node/${suffix}`, async c => {
    requireActive(p(c))
    if (suffix === 'capabilities') { const b = await body(c.req, Type.Object({ capabilities })); if (!b.capabilities.length) throw new HttpError(422, 'capabilities must contain at least one direction'); store.updateStep(p(c), c.params.node, { capabilities: b.capabilities }) }
    else store.updateStep(p(c), c.params.node, { executionProfile: (await body(c.req, Type.Object({ execution_profile: profile }))).execution_profile })
    return intent(p(c), c.params.node)
  })
  router.add('DELETE', '/projects/:project/intents/:node', c => { requireActive(p(c)); store.deleteStep(p(c), c.params.node); send(c.res, null, 204) })
  for (const action of ['claim', 'heartbeat', 'release']) router.add('POST', `/projects/:project/intents/:node/${action}`, async c => {
    const b = await body(c.req, workerBody); requireActive(p(c))
    if (action === 'claim') store.claim(p(c), 'execute', { name: b.worker, backend: 'dsh' }, c.params.node)
    else if (action === 'heartbeat') store.heartbeat(runFor(p(c), c.params.node, b.worker).id)
    else { const s = store.node<Step>(p(c), c.params.node, 'step'); if (s.status !== 'pending') store.releaseRun(runFor(p(c), c.params.node, b.worker).id) }
    return { ...intent(p(c), c.params.node), ...(action === 'heartbeat' ? { blackboard_revision: store.project(p(c)).revision } : {}) }
  })
  router.add('POST', '/projects/:project/intents/:node/conclude', async c => {
    const b = await body(c.req, Type.Object({ worker: text, description: text, complete_description: Type.Optional(Type.Union([text, Type.Null()])) })); requireActive(p(c))
    return store.transaction(() => {
      const s = store.node<Step>(p(c), c.params.node, 'step')
      if (b.complete_description && s.creator !== 'dispatcher.bootstrap') throw new HttpError(422, 'Only bootstrap intents can conclude with completion')
      const run = runFor(p(c), s.id, b.worker, true), fact = store.addFact(p(c), b.description, { runId: run.id, creator: b.worker })
      store.finishRun(run.id, 'succeeded')
      if (b.complete_description) store.complete(p(c), b.complete_description, [fact.id], b.worker)
      return { fact: { id: fact.id, description: fact.description }, intent: intent(p(c), s.id), completed: !!b.complete_description }
    })
  })
  router.add('POST', '/projects/:project/complete', async c => {
    const b = await body(c.req, Type.Object({ from: refs, description: text, worker: text })); requireActive(p(c))
    if (b.from.includes('goal')) throw new HttpError(400, 'goal cannot be used in from')
    return legacyIntent(store.complete(p(c), b.description, b.from, b.worker))
  })
  router.add('POST', '/projects/:project/intents/:node/outcome', async c => {
    const b = await body(c.req, Type.Object({ worker: text, outcome: Type.Union(['success', 'cancelled', 'heartbeat_loss', 'timeout', 'session_missing', 'provider_exit', 'contract_error', 'api_error', 'workspace_integrity', 'internal_error', 'unhealthy', 'rejected'].map(v => Type.Literal(v))), detail: Type.Optional(Type.String()), runtime_ms: Type.Optional(Type.Integer({ minimum: 0 })) }))
    return store.outcome(p(c), b.worker, b.outcome, b.detail ?? '', c.params.node, { runtimeMs: b.runtime_ms })
  })
  router.add('POST', '/projects/:project/reason/outcome', async c => {
    const b = await body(c.req, Type.Object({ worker: text, outcome: text, detail: Type.Optional(Type.String()), base_planning_revision: Type.Optional(Type.Integer({ minimum: 0 })), context_revision: Type.Optional(Type.Integer({ minimum: 0 })) }))
    return store.outcome(p(c), b.worker, b.outcome, b.detail ?? '', null, { baseRevision: b.base_planning_revision, contextRevision: b.context_revision })
  })
  router.add('POST', '/projects/:project/reopen', async c => { const b = await body(c.req, Type.Object({ description: text, creator: text })), value = store.reopen(p(c), b.description, b.creator); return { project: legacyProject(store, p(c)).project, fact: { id: value.fact.id, description: value.fact.description }, intent: legacyIntent(value.step) } })
  router.add('POST', '/projects/:project/reason/claim', async c => {
    const b = await body(c.req, Type.Object({ worker: text, trigger: text })); requireActive(p(c))
    store.transaction(() => { const run = store.claim(p(c), 'decide', { name: b.worker, backend: 'dsh' }); run.trigger = b.trigger; store.saveRun(run) })
    return legacyProject(store, p(c)).project
  })
  for (const action of ['heartbeat', 'release']) router.add('POST', `/projects/:project/reason/${action}`, async c => {
    const b = await body(c.req, workerBody); requireActive(p(c)); const run = store.ownedRun(p(c), 'decide', b.worker)
    if (action === 'heartbeat') store.heartbeat(run.id); else store.releaseRun(run.id)
    return legacyProject(store, p(c)).project
  })
  const generation = () => Number(store.db.prepare('SELECT COALESCE(MAX(id),0) AS value FROM events').get()!.value)
  router.add('GET', '/dispatcher/changes', async c => { const after = queryNumber(c.url, 'after', generation()); await waitChange(store, undefined, () => generation() !== after, queryNumber(c.url, 'timeout', 10, 0, 30, false), c.signal); return { generation: generation() } })
  blackboardRoutes(router, store)
}

function blackboardRoutes(router: Router, store: Store) {
  const base = '/projects/:project/blackboard'
  const nodes = (id: string) => { const g = legacyProject(store, id); return [...g.facts.map(f => ({ ...f, kind: 'fact' as const })), ...g.intents.map(i => ({ ...i, kind: 'intent' as const })), ...g.hints.map(h => ({ ...h, kind: 'hint' as const }))] }
  const source = (id: string, fid: string, limit = 6, beforeId = Number.MAX_SAFE_INTEGER) => {
    if (fid === 'goal') return null
    const fact = store.node<Fact>(id, fid, 'fact'); if (!fact.stepId) return null
    const step = store.node<Step>(id, fact.stepId, 'step'), runs = store.runs(id).filter(r => r.stepId === step.id)
    const events = runs.flatMap(r => store.db.prepare('SELECT * FROM run_events WHERE run_id=? AND id<? ORDER BY id DESC LIMIT ?').all(r.id, beforeId, limit)).sort((a, b) => Number(b.id) - Number(a.id)).slice(0, limit).reverse()
    return { intent_id: step.id, intent_description: step.description, creator: step.creator, worker: step.worker, from: step.sourceIds, runs, events }
  }
  const audit = (c: RequestContext, command: string, value: Record<string, unknown>) => {
    const result = { project: c.params.project, command, revision: store.project(c.params.project).revision, ...value, query_id: randomUUID().replaceAll('-', '') }
    const bytes = JSON.stringify(result)
    store.transaction(() => store.db.prepare('INSERT INTO query_audit(project_id,data) VALUES (?,?)').run(c.params.project, JSON.stringify({ command, query_id: result.query_id, worker: c.req.headers['x-redtrace-worker'] ?? 'unknown', task_type: c.req.headers['x-redtrace-task'] ?? 'unknown', intent_id: c.req.headers['x-redtrace-intent'] ?? null, arguments: Object.fromEntries(c.url.searchParams), output_sha256: createHash('sha256').update(bytes).digest('hex'), output_bytes: Buffer.byteLength(bytes), created_at: new Date().toISOString() })))
    return result
  }
  store.db.exec('CREATE TABLE IF NOT EXISTS query_audit(id INTEGER PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, data TEXT NOT NULL)')
  router.add('GET', `${base}/status`, c => { const g = legacyProject(store, c.params.project), since = queryNumber(c.url, 'since', 0); return audit(c, 'status', { status: g.project.status, since, changed: g.blackboard_revision > since, counts: { facts: g.facts.length, intents: g.intents.length, hints: g.hints.length } }) })
  router.add('GET', `${base}/wait`, async c => { const since = queryNumber(c.url, 'since', 0), revision = () => store.project(c.params.project).revision; await waitChange(store, c.params.project, () => revision() > since, queryNumber(c.url, 'timeout', 20, 0, 30, false), c.signal); return { revision: revision() } })
  router.add('GET', `${base}/snapshot`, c => { const all = nodes(c.params.project); return audit(c, 'snapshot', { facts: all.filter(n => n.kind === 'fact'), intents: all.filter(n => n.kind === 'intent'), hints: all.filter(n => n.kind === 'hint'), edges: graphEdges(store.graph(c.params.project)) }) })
  router.add('GET', `${base}/nodes/:node`, c => { const node = nodes(c.params.project).find(n => n.id === c.params.node) ?? null; return audit(c, 'node', { found: !!node, node }) })
  router.add('GET', `${base}/facts/:node/source`, c => { const found = nodes(c.params.project).some(n => n.kind === 'fact' && n.id === c.params.node); return audit(c, 'source', { fact_id: c.params.node, found, source: found ? source(c.params.project, c.params.node, queryNumber(c.url, 'limit', 50, 1, 200), queryNumber(c.url, 'before_id', Number.MAX_SAFE_INTEGER, 1)) : null }) })
  router.add('DELETE', `${base}/facts/:node`, c => { store.releaseFact(c.params.project, c.params.node); send(c.res, null, 204) })
  router.add('GET', `${base}/changes`, c => {
    const id = c.params.project, since = queryNumber(c.url, 'since', 0), limit = queryNumber(c.url, 'limit', 20, 1, 100), all = nodes(id)
    const rows = store.db.prepare('SELECT revision,type,node_id,created_at FROM events WHERE project_id=? AND revision>? ORDER BY revision LIMIT ?').all(id, since, limit + 1)
    const changes = rows.slice(0, limit).map(row => {
      let [kind, action] = String(row.type).split('.'); if (kind === 'step' || kind === 'execute') { kind = 'intent'; if (!['added', 'deleted'].includes(action)) action = 'updated' }
      const node = all.find(n => n.id === row.node_id) ?? null
      return { revision: row.revision, kind, node_id: row.node_id, action, created_at: row.created_at, node: node && node.kind === 'fact' && c.url.searchParams.get('include_source') === 'true' ? { ...node, source: source(id, node.id) } : node }
    })
    return audit(c, 'changes', { since, next_revision: changes.at(-1)?.revision ?? Math.min(since, store.project(id).revision), has_more: rows.length > limit, changes })
  })
  router.add('GET', `${base}/path`, c => {
    const from = requiredText(c.url.searchParams.get('source'), 'source'), to = requiredText(c.url.searchParams.get('target'), 'target'), all = nodes(c.params.project), edges = graphEdges(store.graph(c.params.project))
    const parents = new Map<string, string | null>([[from, null]]), pending = [from]
    for (let i = 0; i < pending.length && !parents.has(to); i++) for (const edge of edges.filter(e => e.from === pending[i])) if (!parents.has(edge.to)) { parents.set(edge.to, pending[i]); pending.push(edge.to) }
    const ids: string[] = []; if (parents.has(to)) for (let id: string | null = to; id !== null; id = parents.get(id) ?? null) ids.unshift(id)
    const selected = ids.map(id => all.find(n => n.id === id)).filter(Boolean)
    return audit(c, 'path', { source: from, target: to, found: !!ids.length && selected.length === ids.length, path: selected })
  })
  router.add('GET', `${base}/context/:node`, c => {
    const depth = queryNumber(c.url, 'depth', 1, 0, 3), limit = queryNumber(c.url, 'limit', 30, 1, 50), all = nodes(c.params.project), edges = graphEdges(store.graph(c.params.project)), found = all.some(n => n.id === c.params.node)
    const seen = new Map<string, number>(found ? [[c.params.node, 0]] : []), selected: string[] = []
    for (const [id, level] of seen) { if (selected.length >= limit) break; selected.push(id); if (level < depth) for (const e of edges) { const neighbor = e.from === id ? e.to : e.to === id ? e.from : null; if (neighbor && !seen.has(neighbor)) seen.set(neighbor, level + 1) } }
    return audit(c, 'context', { root: c.params.node, found, depth, truncated: found && selected.length >= limit, nodes: selected.map(id => all.find(n => n.id === id)).filter(Boolean), edges: edges.filter(e => selected.includes(e.from) && selected.includes(e.to)) })
  })
}
