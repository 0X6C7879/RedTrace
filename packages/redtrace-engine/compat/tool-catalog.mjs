import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { graphTools, efficiencyToolAvailable, tsecbenchSubmitTool } from '../src/runner.ts'
import { legionTools } from '../src/legion-tools.ts'
import { CommanderTodos } from '../src/legion-todos.ts'
import { chatTools, ChatStore } from '../src/chat.ts'
import { resourceTools, verbTools, verbToolAvailable } from '../src/capability-verbs.ts'
import { load } from '../../redtrace-dsh/lib/loader.js'
import { mountExecutionTools } from '../../redtrace-dsh/lib/execution-tools.js'
import { reverseToolSchemas } from '../../redtrace-dsh/lib/reverse.js'
import { toolAllowed } from '../src/console-api.ts'

/** Inspect the real factories in a disposable registry, not model sessions or audit history. */
export async function inspectToolCatalog(ctx, engine, manager, runtime) {
  const { config, raw } = engine.configuration.resolvedSnapshot()
  const available = id => manager.availableForTask(id)
  const executionRoles = ['general:general', 'soldier:general', 'general:benchmark', 'soldier:benchmark', 'scout:benchmark']
  const rows = [], store = new Store(':memory:')
  const add = (tools, role, enabled = () => true) => {
    for (const tool of tools) rows.push({ name: tool.name, description: tool.description, parameters: JSON.parse(JSON.stringify(tool.parameters)),
      source: tool.redtrace === false ? tool.name.startsWith('mcp__') ? 'MCP' : 'DSH' : 'RedTrace', role, scope: 'catalog', status: 'available',
      enabled: enabled(tool) && (tool.redtrace === false || (raw.tool_settings?.[tool.name]?.workers === undefined
        ? toolAllowed(raw.tool_settings, tool.name)
        : config.workers.some(worker => toolAllowed(raw.tool_settings, tool.name, worker.name) && (worker.roles ?? []).includes(role.split(':')[0])))) })
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
        const roles = ['redtrace-c2', 'redtrace-webshell'].includes(plugin) ? executionRoles.filter(role => !role.startsWith('scout:')) : executionRoles
        for (const role of roles) add(tools.map(tool => ({ ...tool, redtrace: !!tool.redtrace })), role,
          () => plugin === 'redtrace-core' || available(plugin))
      } })
    const reverse = await reverseToolSchemas()
    for (const role of executionRoles) add(reverse, role, () => available('redtrace-reverse'))
    for (const mode of ['general', 'benchmark']) {
      const project = store.createProject({ mode, title: 'Schema inspection', origin: 'tsecbench Schema inspection', goal: 'Inspect definitions', bootstrap: false }).project
      add(legionTools(store, 'commander', project.id, config.maxSteps, () => {}, config, new CommanderTodos()), 'commander:' + mode)
      for (const role of ['general', 'soldier', 'scout', 'reporter']) {
        if (mode === 'general' && role === 'scout') continue
        const graph = mode === 'benchmark' ? store.createGraph(project.id, { taskKey: role, title: role, origin: 'Schema inspection', goal: 'Inspect definitions' }) : store.projectGraphs(project.id)[0]
        const step = store.forGraph(project.id, graph.id).addStep(project.id, { role, taskKey: role, description: 'Inspect definitions', sourceIds: [graph.originId], goalId: graph.goalId })
        const worker = { name: 'schema', backend: 'mock' }
        const run = store.claim(project.id, 'execute', worker, step.id)
        const context = { store, run, worker, config, signal: new AbortController().signal, featureAvailable: available }
        const graphSchemas = graphTools(context, () => {})
        add(graphSchemas, role + ':' + mode, tool => efficiencyToolAvailable(context, tool.name))
        if (role !== 'reporter') {
          if (!graphSchemas.some(tool => tool.name === 'tsecbench_submit')) add([tsecbenchSubmitTool(context)], role + ':' + mode, () => false)
          add(resourceTools(context, verbs), role + ':' + mode)
          add(verbTools(context, verbs, step), role + ':' + mode, tool => verbToolAvailable(verbs, tool.name))
        }
        store.finishRun(run.id, 'cancelled')
      }
      if (mode === 'general') add(chatTools(store.forProject(project.id), { id: 'schema', projectId: project.id }, new ChatStore(store)), 'chief')
    }
    add(chatTools(store, { id: 'schema' }, new ChatStore(store)), 'assistant')
    return rows
  } finally {
    try { await scope.dispose(); await carrier.dispose() } finally { store.close(); await rm(cwd, { recursive: true, force: true }) }
  }
}
