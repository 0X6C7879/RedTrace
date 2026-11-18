import {domainTools} from '../../redtrace-dsh/lib/tool-domains.js'
import { MODE_ROLES, coordinatorRole } from '../../redtrace-dsh/lib/roles.js'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { graphTools, efficiencyToolAvailable } from '../src/runner.ts'
import { legionTools } from '../src/legion-tools.ts'
import { CommanderTodos } from '../src/legion-todos.ts'
import { chatTools, ChatStore } from '../src/chat.ts'
import { resourceTools, verbTools, verbToolAvailable } from '../src/capability-verbs.ts'
import { load } from '../../redtrace-dsh/lib/loader.js'
import { mountExecutionTools } from '../../redtrace-dsh/lib/execution-tools.js'
import { toolAllowed } from '../src/console-api.ts'

/** Inspect the real factories in a disposable registry, not model sessions or audit history. */
export async function inspectToolCatalog(ctx, engine, manager, runtime) {
  const { config, raw } = engine.configuration.resolvedSnapshot()
  const available = id => manager.availableForTask(id)
  const executionRoles = ['worker','soldier']
  const rows = [], store = new Store(':memory:')
  const add = (tools, role, enabled = () => true) => {
    for (const tool of domainTools(tools)) rows.push({ name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)),
      source: tool.name.startsWith('mcp__') ? 'MCP' : tool.redtrace === false ? 'DSH' : 'RedTrace', role, scope: role?'catalog':'assistant', status: 'available',
      enabled: enabled(tool) && toolAllowed(raw.tool_settings, tool.name, role) })
  }
  const verbs = { operations: engine.operations, isAdapterAvailable: id => manager.running(id) }
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'redtrace-schema-'))
  const { createScope } = await load('vendor/deepseek-harness/packages/core/scope/lib/index.js')
  const carrier = ctx.plugin({ inject: ['tools', 'systemPrompt'], apply() {} })
  await carrier.await()
  const scope = createScope(carrier.ctx, {})
  try {
    // This mounts definitions only; no Agent, model call, CLI or REA backend is started.
    await mountExecutionTools(scope.ctx, { task: { type: 'soldier', executionProfile: 'direct' }, cwd,
      sessionRoot: cwd, skillsDir: runtime.skillsDir, available: () => true,
      onSchemas(plugin, tools) {
        for (const role of executionRoles) add(tools.map(tool => ({ ...tool, redtrace: !!tool.redtrace })), role,
          () => plugin === 'redtrace-core' || available(plugin))
      } })
    for(const role of ['planner']) {
      const nativeScope=createScope(carrier.ctx,{})
      try{await mountExecutionTools(nativeScope.ctx,{task:{type:role,executionProfile:'direct'},cwd,sessionRoot:cwd,skillsDir:runtime.skillsDir,
        available:()=>true,onSchemas(plugin,tools){add(tools.map(t=>({...t,redtrace:!!t.redtrace})),role,()=>plugin==='redtrace-core'||available(plugin))}})}finally{await nativeScope.dispose()}
    }
    for (const mode of ['general', 'benchmark']) {
      const project = store.createProject({ mode, title: 'Schema inspection', origin: 'tsecbench Schema inspection', goal: 'Inspect definitions', bootstrap: false }).project
      add(legionTools(store, 'commander', project.id, config.maxSteps, () => {}, config, new CommanderTodos()), coordinatorRole(mode))
      for (const role of [...MODE_ROLES[mode].slice(1), ...(mode==='benchmark'?['reporter']:[])]) {
        const graph = mode === 'benchmark' ? store.createGraph(project.id, { taskKey: role, title: role, origin: 'Schema inspection', goal: 'Inspect definitions' }) : store.projectGraphs(project.id)[0]
        const step = role==='general'?store.addPlanner(project.id,graph.id,{description:'Inspect definitions',sourceIds:[graph.originId]}):store.forGraph(project.id, graph.id).addStep(project.id, { role, taskKey: role, description: 'Inspect definitions', sourceIds: [graph.originId], goalId: graph.goalId })
        const worker = { name: 'schema', backend: 'mock' }
        const run = role==='general'?store.forGraph(project.id,graph.id).claim(project.id,'plan',worker):store.claim(project.id, 'execute', worker, step.id)
        const context = { store, run, worker, config, signal: new AbortController().signal, featureAvailable: available }
        const graphSchemas = graphTools(context, () => {})
        add(graphSchemas, role==='reporter'?'soldier':role, tool => efficiencyToolAvailable(context, tool.name))
        if (role !== 'reporter' && role !== 'general') {
          add(resourceTools(context, verbs), role==='reporter'?'soldier':role)
          add(verbTools(context, verbs, step), role==='reporter'?'soldier':role, tool => verbToolAvailable(verbs, tool.name))
        }
        store.finishRun(run.id, 'cancelled')
      }
      if (mode==='general') {
        const graph=store.projectGraphs(project.id)[0]
        const step=store.addStep(project.id,{role:'worker',reportFindingId:'finding-schema',taskKey:'report',description:'Report workflow',sourceIds:[graph.originId],goalId:graph.goalId})
        const worker={name:'schema',backend:'mock'},run=store.claim(project.id,'execute',worker,step.id)
        add(graphTools({store,run,worker,config,signal:new AbortController().signal},()=>{}),'worker')
        store.finishRun(run.id,'cancelled')
      }
      if (mode === 'general') add(chatTools(store.forProject(project.id), { id: 'schema', projectId: project.id }, new ChatStore(store)), undefined)
    }
    add(chatTools(store, { id: 'schema' }, new ChatStore(store)), undefined)
    return rows
  } finally {
    try { await scope.dispose(); await carrier.dispose() } finally { store.close(); await rm(cwd, { recursive: true, force: true }) }
  }
}
