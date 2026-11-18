import { Type } from 'typebox'
import type { Todo } from './legion-todos.ts'
import { Router, body, queryNumber, send } from './http.ts'
import type { RequestContext } from './http.ts'
import { Store } from './store.ts'
import { legacyIntent, legacyProject, legacyProjectInfo, legacySummary } from './legacy.ts'
import { projectFgs, liveSteps } from './fgs.ts'
import { HttpError } from './types.ts'
import type { Json, Step } from './types.ts'
import { goalUpdateSchema, stepUpdateSchema, specialistSchema } from './graph-contracts.ts'
import { taskPluginsSchema } from './task-plugins.ts'
import { graphContent, nodeContent } from './graph-content.ts'
import { ProjectEvidence } from './project-evidence.ts'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const text = Type.String({ minLength: 1, pattern: '\\S' }), refs = Type.Array(text, { minItems: 1 })
const profile = Type.Union([Type.Literal('direct'), Type.Literal('isolated')])
const requires = Type.Array(Type.String(), { uniqueItems: true, maxItems: 16 })
const stepSchema = Type.Object({ dependsOn:Type.Optional(Type.Array(text,{uniqueItems:true})), specialist:Type.Optional(specialistSchema), role: Type.Optional(Type.Union([Type.Literal('soldier'), Type.Literal('reporter'), Type.Literal('worker')])), taskKey: Type.Optional(text), parentStepId: Type.Optional(text), description: text, sourceIds: refs, goalId: Type.Optional(text), creator: Type.Optional(text), priority: Type.Optional(Type.Integer()), executionProfile: Type.Optional(profile), requires: Type.Optional(requires), plugins: Type.Optional(taskPluginsSchema) })

export function graphRoutes(router: Router, store: Store, planningTodos?: (projectId: string, graphId: string) => Todo[], workspaceRoot?: string) {
  const view = (c:RequestContext) => {
    if(!c.params.project)return store
    const id=c.params.project, graphId=c.url.searchParams.get('graphId')
    if(graphId)return store.forGraph(id,graphId)
    if(store.project(id).mode==='general')return store.forGraph(id,store.projectGraphs(id)[0].id)
    if(/\/(?:graph|nodes|facts|goals|steps|findings|observations|intents|evidence)(?:\/|$)/.test(c.url.pathname))throw new HttpError(422,'Select graphId in a Benchmark Project')
    return store.forProject(id)
  }
  const p = (c: RequestContext) => c.params.project
  const currentOnly = (c: RequestContext) => {
    if (c.url.searchParams.has('revision') || c.url.searchParams.has('includeInactive')) throw new HttpError(422, 'FGS history has been removed; read current state without revision/includeInactive')
  }
  const requireActive = (id: string) => { const project = store.project(id); if (project.status !== 'active') throw new HttpError(403, `Project is ${project.status}`) }
  const intent = (id: string, sid: string) => { const step = store.node<Step>(id, sid, 'step'); if (step.deleted) throw new HttpError(404, 'Intent not found'); return legacyIntent(step, store.latestRun(id, sid)) }
  const runFor = (id: string, sid: string, worker: string, claim = false) => {
    const step = store.node<Step>(id, sid, 'step')
    if (claim && step.status === 'pending') return store.claim(id, 'execute', { name: worker, backend: 'dsh' }, sid)
    return store.ownedRun(id, 'execute', worker, sid)
  }
  const createSchema = Type.Object({ mode:Type.Union([Type.Literal('benchmark'),Type.Literal('general')]), title: text, origin: text, goal: text, bootstrap_enabled: Type.Optional(Type.Boolean()), bootstrap: Type.Optional(Type.Boolean()), hints: Type.Optional(Type.Union([Type.Null(), Type.Array(Type.Object({ content: text, creator: text }))])) })
  for (const prefix of ['', '/v2']) {
    router.add('GET', `${prefix}/projects`, c => view(c).projects().map(project => prefix ? project : legacySummary(view(c), project.id)))
    router.add('POST', `${prefix}/projects`, async c => {
      const input = await body(c.req, createSchema), graph = view(c).createProject({ ...input, hints: input.hints ?? [], bootstrap: input.bootstrap ?? input.bootstrap_enabled })
      send(c.res, prefix ? graph : legacyProject(view(c), graph.project.id), 201)
    })
    router.add('GET', `${prefix}/projects/:project`, c => store.project(p(c)).mode==='benchmark'&&!c.url.searchParams.has('graphId') ? {project:prefix?store.project(p(c)):legacyProjectInfo(store.project(p(c))),graphs:store.projectGraphs(p(c))} : prefix ? view(c).graph(p(c)) : legacyProject(view(c), p(c)))
    router.add('PUT', `${prefix}/projects/:project/title`, async c => { view(c).rename(p(c), (await body(c.req, Type.Object({ title: text }))).title); return prefix ? view(c).project(p(c)) : legacyProject(view(c), p(c)).project })
    router.add('PUT', `${prefix}/projects/:project/status`, async c => { view(c).setStatus(p(c), (await body(c.req, Type.Object({ status: Type.Union([Type.Literal('active'), Type.Literal('stopped')]) }))).status); return prefix ? view(c).project(p(c)) : legacyProject(view(c), p(c)).project })
    router.add('POST', `${prefix}/projects/:project/hints`, async c => {
      const b=await body(c.req,Type.Object({content:text,creator:text}))
      send(c.res,store.commanderInput(p(c),b.content,b.creator,c.url.searchParams.get('graphId')??undefined),201)
    })
  }
  router.add('GET','/v2/projects/:project/graphs',c=>store.projectGraphs(p(c)))
  router.add('POST','/v2/projects/:project/graphs',async c=>send(c.res,store.createGraph(p(c),await body(c.req,Type.Object({taskKey:text,title:text,origin:text,goal:text}))),201))
  router.add('GET', '/v2/projects/:project/graph', c => {
    currentOnly(c)
    const graph = view(c).graph(p(c))
    const projection = projectFgs(graph), live = liveSteps(graph)
    // The live layer is a canvas-only virtual overlay; exports and tools keep the pure projection.
    return { ...graphContent(graph, false), ...projection, ...(planningTodos ? { planningTodos: planningTodos(p(c), graph.graph!.id) } : {}), nodes: [...projection.nodes, ...live.nodes], edges: [...projection.edges, ...live.edges] }
  })
  router.add('GET', '/v2/projects/:project/nodes/:node', c => {
    const detail = c.url.searchParams.get('detail') ?? 'summary'
    if (detail !== 'summary' && detail !== 'doc') throw new HttpError(422, 'detail must be summary or doc')
    return view(c).readNode(p(c), c.params.node, detail)
  })
  router.add('GET', '/v2/projects/:project/runs', c => { view(c).project(p(c)); return view(c).runs(p(c)) })
  router.add('GET', '/v2/projects/:project/steps/:node/runs', c => { view(c).node(p(c), c.params.node, 'step'); return view(c).runs(p(c)).filter(r => r.stepId === c.params.node) })
  router.add('GET', '/v2/projects/:project/runs/:run/events', c => {
    if (store.run(c.params.run).projectId !== p(c) || c.url.searchParams.has('graphId')&&store.run(c.params.run).graphId!==c.url.searchParams.get('graphId')) throw new HttpError(404, 'Run not found')
    return view(c).db.prepare('SELECT id,data FROM audit_events WHERE project_id=? AND run_id=? AND id<? ORDER BY id DESC LIMIT ?')
      .all(p(c), c.params.run, queryNumber(c.url, 'before', Number.MAX_SAFE_INTEGER), queryNumber(c.url, 'limit', 100, 1, 500))
      .map(row => ({ ...JSON.parse(String(row.data)), id: Number(row.id) })).reverse()
  })
  for (const kind of ['goals', 'steps', 'findings', 'facts', 'observations'] as const) router.add('GET', `/v2/projects/:project/${kind}`, c => { currentOnly(c); return view(c).nodes(p(c), [kind.slice(0, -1) as 'goal' | 'step' | 'finding' | 'fact' | 'observation'], { context: true, ...(c.url.searchParams.has('limit') ? { limit: queryNumber(c.url, 'limit', 100, 1, 100), offset: queryNumber(c.url, 'offset', 0) } : {}) }).map(node => nodeContent(node)) })
  router.add('GET', '/v2/projects/:project/graph/delta', c => view(c).graphDelta(p(c), queryNumber(c.url, 'after', 0), queryNumber(c.url, 'limit', 100, 1, 100)))
  router.add('POST', '/v2/projects/:project/runs/:run/resolve', async c => {
    if (view(c).run(c.params.run).projectId !== p(c)) throw new HttpError(404, 'Run not found')
    return view(c).resolveUnknown(c.params.run, (await body(c.req, Type.Object({ resolution: text }))).resolution)
  })
  router.add('POST', '/v2/projects/:project/goals', async c => { const b = await body(c.req, Type.Object({ description: text, parentId: Type.Optional(text), creator: Type.Optional(text) })); send(c.res, view(c).addGoal(p(c), b.description, b.parentId, b.creator), 201) })
  router.add('PATCH', '/v2/projects/:project/goals/:node', async c => view(c).updateGoal(p(c), c.params.node, await body(c.req, goalUpdateSchema)))
  router.add('POST', '/v2/projects/:project/steps', async c => send(c.res, view(c).addStep(p(c), await body(c.req, stepSchema)), 201))
  router.add('PATCH', '/v2/projects/:project/steps/:node', async c => view(c).updateStep(p(c), c.params.node, await body(c.req, stepUpdateSchema)))
  router.add('POST', '/v2/projects/:project/facts', async c => {
    const b = await body(c.req, Type.Object({ title: Type.Optional(text), description: text, doc: Type.Optional(text), creator: Type.Optional(text), evidence: Type.Array(Type.Object({ description: text, path: Type.Optional(text), artifactId: Type.Optional(text), runId: Type.Optional(text), toolCallId: Type.Optional(text) })) }))
    let doc, evidence = b.evidence
    if (b.doc || b.evidence.some(e => e.path || e.artifactId)) {
      if (!workspaceRoot) throw new HttpError(503, 'Project workspace unavailable')
      mkdirSync(path.join(workspaceRoot, p(c)), { recursive: true })
      const storage = new ProjectEvidence(view(c), workspaceRoot)
      evidence = b.evidence.map(source => {
        if (source.artifactId) storage.read(p(c), source.artifactId)
        return source.path ? { ...source, artifactId: storage.promoteFile(p(c), source).id } : source
      })
      if (b.doc) doc = { artifactId: storage.publish(p(c), Buffer.from(b.doc), { description: (b.title ?? 'Fact')+' — doc' }).id, description: (b.title ?? 'Fact')+' — doc' }
    }
    send(c.res, view(c).addFact(p(c), b.description, { title: b.title, doc, creator: b.creator ?? 'human', evidence }), 201)
  })
  router.add('POST', '/v2/projects/:project/findings', async c => send(c.res, view(c).addFinding(p(c), await body(c.req, Type.Object({ title: text, description: text, type: Type.Optional(text), severity: Type.Optional(Type.Union((['critical','high','medium','low'] as const).map(v=>Type.Literal(v)))), assetIds: Type.Optional(Type.Array(text)), details: Type.Optional(Type.Unsafe<Json>({})), factIds: refs, creator: Type.Optional(text) }))), 201))
  router.add('POST', '/v2/projects/:project/findings/:node/report', c => view(c).requestFindingReport(p(c), c.params.node))
  router.add('POST', '/v2/projects/:project/observations', async c => { const b = await body(c.req, Type.Object({ content: text, creator: Type.Optional(text), stepId: Type.Optional(text) })); send(c.res, view(c).addInput(p(c), 'observation', b.content, b.creator, b.stepId), 201) })
  router.add('GET', '/v2/projects/:project/events', c => view(c).events(p(c), queryNumber(c.url, 'after', 0), queryNumber(c.url, 'limit', 100, 1, 500)))
  router.add('POST', '/projects/:project/intents', async c => {
    const b = await body(c.req, Type.Object({ from: refs, description: text, creator: text, worker: Type.Optional(Type.Union([text, Type.Null()])), execution_profile: Type.Optional(profile), requires: Type.Optional(requires), plugins: Type.Optional(taskPluginsSchema), max_active_intents: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])) }))
    requireActive(p(c))
    if (b.from.includes('goal')) throw new HttpError(400, 'goal cannot be used in from')
    if (b.worker && b.worker !== b.creator) throw new HttpError(400, 'worker must be null or equal to creator')
    const bootstrap = b.creator === 'dispatcher.bootstrap' && b.description === 'bootstrap' && b.from.length === 1 && b.from[0] === 'origin'
    const result = view(c).transaction(() => { const s = view(c).addStep(p(c), { description: b.description, sourceIds: b.from, creator: b.creator, executionProfile: b.execution_profile, requires: b.requires, plugins: b.plugins, bootstrap }); if (b.worker) view(c).claim(p(c), 'execute', { name: b.worker, backend: 'dsh' }, s.id); return intent(p(c), s.id) })
    send(c.res, result, 201)
  })
  router.add('PATCH', '/projects/:project/intents/:node/execution-profile', async c => {
    requireActive(p(c))
    view(c).updateStep(p(c), c.params.node, { executionProfile: (await body(c.req, Type.Object({ execution_profile: profile }))).execution_profile })
    return intent(p(c), c.params.node)
  })
  router.add('POST', '/projects/:project/intents/:node/conclude', async c => {
    const b = await body(c.req, Type.Object({ worker: text, description: text, complete_description: Type.Optional(Type.Union([text, Type.Null()])) })); requireActive(p(c))
    return view(c).transaction(() => {
      const s = view(c).node<Step>(p(c), c.params.node, 'step')
      if (b.complete_description && s.creator !== 'dispatcher.bootstrap') throw new HttpError(422, 'Only bootstrap intents can conclude with completion')
      const run = runFor(p(c), s.id, b.worker, true), fact = view(c).addFact(p(c), b.description, { runId: run.id, creator: b.worker })
      view(c).finishRun(run.id, 'succeeded')
      if (b.complete_description) view(c).complete(p(c), b.complete_description, [fact.id], b.worker)
      return { fact: { id: fact.id, description: fact.description }, intent: intent(p(c), s.id), completed: !!b.complete_description }
    })
  })
  router.add('POST', '/projects/:project/complete', async c => {
    const b = await body(c.req, Type.Object({ from: refs, description: text, worker: text })); requireActive(p(c))
    if (b.from.includes('goal')) throw new HttpError(400, 'goal cannot be used in from')
    return legacyIntent(view(c).complete(p(c), b.description, b.from, b.worker))
  })
  router.add('POST', '/projects/:project/reopen', async c => { const b = await body(c.req, Type.Object({ description: text, creator: text })), hint = view(c).reopen(p(c), b.description, b.creator); return { project: legacyProject(view(c), p(c)).project, hint } })
}
