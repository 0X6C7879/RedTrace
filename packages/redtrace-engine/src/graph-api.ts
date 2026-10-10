import { Type } from 'typebox'
import { Router, body, queryNumber, send } from './http.ts'
import type { RequestContext } from './http.ts'
import { Store } from './store.ts'
import { legacyIntent, legacyProject, legacySummary } from './legacy.ts'
import { projectFgs, liveSteps } from './fgs.ts'
import { HttpError } from './types.ts'
import type { Step } from './types.ts'

const text = Type.String({ minLength: 1, pattern: '\\S' }), refs = Type.Array(text, { minItems: 1 })
const profile = Type.Union([Type.Literal('direct'), Type.Literal('isolated')])
const requires = Type.Array(Type.String(), { uniqueItems: true, maxItems: 16 })
const stepSchema = Type.Object({ description: text, sourceIds: refs, goalId: Type.Optional(text), creator: Type.Optional(text), priority: Type.Optional(Type.Integer()), executionProfile: Type.Optional(profile), requires: Type.Optional(requires) })
const goalUpdate = Type.Object({ description: Type.Optional(text), status: Type.Optional(Type.Union(['open', 'achieved', 'cancelled'].map(v => Type.Literal(v)))), evidenceIds: Type.Optional(Type.Array(text)) })

export function graphRoutes(router: Router, store: Store, maxSteps: () => number | null = () => null) {
  const p = (c: RequestContext) => c.params.project
  const requireActive = (id: string) => { const project = store.project(id); if (project.status !== 'active') throw new HttpError(403, `Project is ${project.status}`) }
  const intent = (id: string, sid: string) => { const step = store.node<Step>(id, sid, 'step'); if (step.deleted) throw new HttpError(404, 'Intent not found'); return legacyIntent(step, store.latestRun(id, sid)) }
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
    const view = projectFgs(graph), live = liveSteps(graph)
    // The live layer is a canvas-only virtual overlay; exports and tools keep the pure projection.
    return { ...graph, ...view, nodes: [...view.nodes, ...live.nodes], edges: [...view.edges, ...live.edges] }
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
  router.add('PATCH', '/v2/projects/:project/steps/:node', async c => store.updateStep(p(c), c.params.node, await body(c.req, Type.Object({ priority: Type.Optional(Type.Integer()), status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('cancelled')])), executionProfile: Type.Optional(profile) }))))
  router.add('DELETE', '/v2/projects/:project/steps/:node', c => store.updateStep(p(c), c.params.node, { status: 'cancelled' }))
  router.add('POST', '/v2/projects/:project/facts', async c => { const b = await body(c.req, Type.Object({ description: text, creator: Type.Optional(text), evidence: Type.Array(Type.Object({ description: text, path: Type.Optional(text), runId: Type.Optional(text), toolCallId: Type.Optional(text) })) })); send(c.res, store.addFact(p(c), b.description, { creator: b.creator ?? 'human', evidence: b.evidence }), 201) })
  router.add('POST', '/v2/projects/:project/findings', async c => send(c.res, store.addFinding(p(c), await body(c.req, Type.Object({ title: text, description: text, type: Type.Optional(text), factIds: refs, creator: Type.Optional(text) }))), 201))
  router.add('POST', '/v2/projects/:project/observations', async c => { const b = await body(c.req, Type.Object({ content: text, creator: Type.Optional(text), stepId: Type.Optional(text) })); send(c.res, store.addInput(p(c), 'observation', b.content, b.creator, b.stepId), 201) })
  router.add('GET', '/v2/projects/:project/events', c => store.events(p(c), queryNumber(c.url, 'after', 0), queryNumber(c.url, 'limit', 100, 1, 500)))
  router.add('POST', '/projects/:project/intents', async c => {
    const b = await body(c.req, Type.Object({ from: refs, description: text, creator: text, worker: Type.Optional(Type.Union([text, Type.Null()])), execution_profile: Type.Optional(profile), requires: Type.Optional(requires), max_active_intents: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])) }))
    requireActive(p(c))
    if (b.from.includes('goal')) throw new HttpError(400, 'goal cannot be used in from')
    if (b.worker && b.worker !== b.creator) throw new HttpError(400, 'worker must be null or equal to creator')
    const bootstrap = b.creator === 'dispatcher.bootstrap' && b.description === 'bootstrap' && b.from.length === 1 && b.from[0] === 'origin'
    const result = store.transaction(() => { const s = store.addStep(p(c), { description: b.description, sourceIds: b.from, creator: b.creator, executionProfile: b.execution_profile, requires: b.requires, bootstrap }, b.max_active_intents); if (b.worker) store.claim(p(c), 'execute', { name: b.worker, backend: 'dsh' }, s.id); return intent(p(c), s.id) })
    send(c.res, result, 201)
  })
  router.add('PATCH', '/projects/:project/intents/:node/execution-profile', async c => {
    requireActive(p(c))
    store.updateStep(p(c), c.params.node, { executionProfile: (await body(c.req, Type.Object({ execution_profile: profile }))).execution_profile })
    return intent(p(c), c.params.node)
  })
  router.add('DELETE', '/projects/:project/intents/:node', c => { requireActive(p(c)); store.deleteStep(p(c), c.params.node); send(c.res, null, 204) })
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
  router.add('POST', '/projects/:project/reopen', async c => { const b = await body(c.req, Type.Object({ description: text, creator: text })), value = store.reopen(p(c), b.description, b.creator); return { project: legacyProject(store, p(c)).project, fact: { id: value.fact.id, description: value.fact.description }, intent: legacyIntent(value.step) } })
}
