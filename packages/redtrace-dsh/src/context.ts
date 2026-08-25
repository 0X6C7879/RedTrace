/**
 * RedTrace Context plugin: serializes the RedTrace domain state (graph,
 * resources) into the dynamic part of an agent's context. The stable part
 * (persona + Rules) lives in the prompt plugin; this module builds the
 * task directive and the injected context messages.
 * @module redtrace-context
 */

import type { Intent, ProjectDetail, ResourceSummary, RuntimeTask, TaskType } from './types.js'

export const name = 'redtrace-context'

const BOOTSTRAP_CREATOR = 'dispatcher.bootstrap'
const BOOTSTRAP_DESCRIPTION = 'bootstrap'

export function isBootstrap(intent: Intent): boolean {
  return intent.description === BOOTSTRAP_DESCRIPTION
    && intent.creator === BOOTSTRAP_CREATOR
    && intent.from.length === 1
    && intent.from[0] === 'origin'
    && intent.to == null
}

export function isInitial(project: ProjectDetail): boolean {
  const ids = project.facts.map(fact => fact.id).sort()
  return ids.length === 2 && ids[0] === 'goal' && ids[1] === 'origin' && project.intents.every(isBootstrap)
}

export function schedulable(intent: Intent): boolean {
  return intent.state === 'open' && intent.to == null && intent.worker == null
    && !intent.circuit_open && (intent.retry_after == null || intent.retry_after <= Date.now() / 1000)
}

/** The graph slice an agent sees: every fact/hint for planning, the claimed intent's lineage for execution. */
export function graph(project: ProjectDetail, intent?: Intent): string {
  const wanted = intent === undefined ? undefined : new Set(['origin', 'goal', ...intent.from])
  return JSON.stringify({
    project: { title: project.project.title, bootstrap_enabled: project.project.bootstrap_enabled },
    facts: project.facts.filter(fact => wanted === undefined || wanted.has(fact.id)),
    hints: project.hints,
    intents: intent === undefined
      ? project.intents.filter(item => !['blocked', 'dropped', 'superseded'].includes(item.state))
      : [intent],
  })
}

/** Compact, non-secret summary of the resources shared across the project. */
export function resourceSummary(resources: ResourceSummary[]): string {
  if (resources.length === 0) return '(当前没有已注册的共享资源)'
  return resources
    .map(resource => `- [${resource.kind}] ${resource.name}${resource.target ? ` (${resource.target})` : ''}${resource.summary ? ` — ${resource.summary}` : ''} <id: ${resource.id}>`)
    .join('\n')
}

/** The dynamic task directive sent as the first user message. */
export function taskPrompt(task: RuntimeTask, project: ProjectDetail, intent?: Intent): string {
  const context = graph(project, intent)
  if (task.type === 'reason') return [
    '分析当前 RedTrace 任务图,判断 Goal 是否已经完成,或提出下一个高价值的前沿 Intent。',
    `最多创建 ${task.maxIntents ?? 4} 个活跃 Intent,只能引用现有 Fact id 作为来源;只能通过 redtrace_intent_create、redtrace_project_complete 或 redtrace_reason_noop 提交决策,不要输出 JSON 或散文替代。`,
    context,
  ].join('\n\n')
  if (task.type === 'bootstrap') return [
    '从 Origin、Goal 与 Hints 出发自举本项目:理解起点与已掌握的信息,成为该领域专家并稳步推进。只执行安全、合规的操作,工作目录为分配的 Workspace。',
    '确认初始证据后,调用 redtrace_bootstrap_conclude(恰好一次)提交结论;大量原始数据写入 Workspace 文件并在结论中引用。',
    context,
  ].join('\n\n')
  return [
    '只执行 Current Intent 所指定的探索方向,推动任务朝 Goal 前进。按需使用 Shell、文件系统、Skill、MCP 与 RedTrace 资源工具。',
    '大量证据保存在 Workspace 中并在结论中引用;可复用的非敏感资源用 redtrace_resource_register 注册。完成后调用 redtrace_explore_conclude(恰好一次),只提交本次新确认的客观事实。',
    context,
  ].join('\n\n')
}

/** The full context injected at launch and on graph revision updates. */
export function contextMessage(
  task: RuntimeTask,
  project: ProjectDetail,
  intent: Intent | undefined,
  resources: ResourceSummary[],
): string {
  const parts = [`RedTrace 上下文(修订版本 ${project.blackboard_revision}):\n${graph(project, intent)}`]
  if (task.type !== 'reason') {
    parts.push(`共享资源摘要(完整信息用 redtrace_resource_get 获取):\n${resourceSummary(resources)}`)
  }
  return parts.join('\n\n')
}

/** The graph-revision update injected into a running agent's session. */
export function revisionMessage(
  type: TaskType,
  revision: number,
  project: ProjectDetail,
  intent: Intent | undefined,
  resources: ResourceSummary[],
): string {
  const parts = [`RedTrace 上下文已更新(修订版本 ${revision}):\n${graph(project, intent)}`]
  if (type !== 'reason') {
    parts.push(`共享资源摘要(完整信息用 redtrace_resource_get 获取):\n${resourceSummary(resources)}`)
  }
  return parts.join('\n\n')
}

export function apply(): void {
  // Pure functions by design; mounted as a plugin so deployments can extend
  // or replace the serialization through future config without touching the
  // scheduler.
}
