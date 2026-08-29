/**
 * RedTrace Context plugin: renders each task's single launch prompt — the
 * context slice the task type needs (Reason: the full graph; Bootstrap:
 * Origin/Goal/Hints; Explore: the claimed Intent's lineage plus shared
 * resources) — and the runtime hint injection. Stable rules live in the
 * prompt plugin's personas; this module carries dynamic content only.
 * @module redtrace-context
 */

import type { BlackboardChange, Intent, Json, ProjectDetail, ResourceSummary, RuntimeTask } from './types.js'

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

type Fact = { id: string; description: string }
type Hint = { id: string; content: string }

function factLines(facts: Fact[]): string[] {
  return facts.map(fact => `- [${fact.id}] ${fact.description}`)
}

function hintLines(hints: Hint[]): string[] {
  return hints.map(hint => `- [${hint.id}] ${hint.content}`)
}

function intentLine(intent: Intent): string {
  const target = intent.to == null ? '' : ` → ${intent.to}`
  const capabilities = intent.capabilities?.length ? `; capabilities: [${intent.capabilities.join(', ')}]` : ''
  return `- [${intent.id}] ${intent.state}: ${intent.description}(from: [${intent.from.join(', ')}]${target}${capabilities})`
}

function resourceLines(resources: ResourceSummary[]): string[] {
  return resources.map(resource =>
    `- [${resource.kind}] ${resource.name}${resource.target ? ` (${resource.target})` : ''}${resource.summary ? ` — ${resource.summary}` : ''} <id: ${resource.id}>`)
}

function sections(parts: Array<[title: string, lines: string[]]>): string[] {
  return parts.filter(([, lines]) => lines.length > 0).map(([title, lines]) => [`## ${title}`, ...lines].join('\n'))
}

/**
 * The launch prompt: the task's whole context slice as one user message.
 * Reason reads the full graph; Bootstrap reads only Origin/Goal/Hints;
 * Explore reads its Intent's lineage, every Hint, and the shared resources.
 */
export function taskPrompt(
  task: RuntimeTask,
  project: ProjectDetail,
  intent?: Intent,
  resources: ResourceSummary[] = [],
): string {
  const facts = new Map(project.facts.map(fact => [fact.id, fact]))
  const origin = facts.get('origin')
  const goal = facts.get('goal')
  const head = [
    `RedTrace 任务上下文(项目「${project.project.title}」,修订版本 ${project.blackboard_revision}):`,
    ...(origin === undefined ? [] : [`## Origin\n${origin.description}`]),
    ...(goal === undefined ? [] : [`## Goal\n${goal.description}`]),
  ]
  if (task.type === 'reason') {
    const graph = project.facts.filter(fact => fact.id !== 'origin' && fact.id !== 'goal')
    return [
      ...head,
      ...sections([
        ['Facts', graph.length === 0 ? ['- 无'] : factLines(graph)],
        [`Intents(最多创建 ${task.maxIntents ?? 4} 个活跃 Intent)`, project.intents.length === 0 ? ['- 无'] : project.intents.map(intentLine)],
        ['Hints', project.hints.length === 0 ? ['- 无'] : hintLines(project.hints)],
      ]),
    ].join('\n\n')
  }
  if (task.type === 'bootstrap') {
    return [...head, ...sections([['Hints', hintLines(project.hints)]])].join('\n\n')
  }
  const lineage = (intent?.from ?? [])
    .map(id => facts.get(id))
    .filter((fact): fact is Fact => fact !== undefined && fact.id !== 'origin' && fact.id !== 'goal')
  return [
    ...head,
    '注:Origin 描述整个任务的背景,仅供理解上下文;本 session 只对下方 Current Intent 负责,朝 Goal 推进,不推进 Intent 之外的方向。',
    ...sections([
      ['Source Facts', factLines(lineage)],
      ['Hints', hintLines(project.hints)],
      ['Current Intent', intent === undefined ? [] : [intentLine(intent)]],
      ['Resources', resourceLines(resources)],
    ]),
  ].join('\n\n')
}

function stringValue(node: Record<string, Json>, key: string): string | undefined {
  const value = node[key]
  return typeof value === 'string' ? value : undefined
}

function changeLine(change: BlackboardChange): string {
  const prefix = `- [r${change.revision}] ${change.kind} ${change.node_id} ${change.action}:`
  if (change.node === null) return `${prefix} (removed)`
  if (change.kind === 'fact') return `${prefix} ${stringValue(change.node, 'description') ?? JSON.stringify(change.node)}`
  if (change.kind === 'hint') return `${prefix} ${stringValue(change.node, 'content') ?? JSON.stringify(change.node)}`
  if (change.kind === 'intent') {
    const state = stringValue(change.node, 'state') ?? 'unknown'
    const description = stringValue(change.node, 'description') ?? JSON.stringify(change.node)
    const sources = Array.isArray(change.node.from)
      ? change.node.from.filter((item): item is string => typeof item === 'string')
      : []
    const target = stringValue(change.node, 'to')
    const capabilities = Array.isArray(change.node.capabilities)
      ? change.node.capabilities.filter((item): item is string => typeof item === 'string')
      : []
    const capabilityText = capabilities.length ? `; capabilities: [${capabilities.join(', ')}]` : ''
    return `${prefix} ${state}: ${description}(from: [${sources.join(', ')}]${target === undefined ? '' : ` → ${target}`}${capabilityText})`
  }
  return `${prefix} ${JSON.stringify(change.node)}`
}

/** A continuation prompt for the persistent Reason session. It contains only
 * Blackboard events after the session's durable revision cursor. */
export function graphDeltaMessage(
  task: RuntimeTask,
  projectTitle: string,
  since: number,
  revision: number,
  changes: BlackboardChange[],
): string {
  return [
    `RedTrace Graph Delta(项目「${projectTitle}」,修订版本 ${since} → ${revision}):`,
    `当前最多创建 ${task.maxIntents ?? 4} 个活跃 Intent。`,
    '完整 Graph 由 Blackboard 保存；需要早期事实或关系时使用只读 Graph 工具按需回查。',
    '## Changes',
    ...(changes.length === 0 ? ['- 本轮没有新的 Blackboard 事件；继续评估当前 frontier。'] : changes.map(changeLine)),
  ].join('\n')
}

/** The runtime update pushed into running workers: newly added human Hints only. */
export function hintMessage(hints: ReadonlyArray<Hint>): string {
  return ['RedTrace 新增 Hint:', ...hints.map(hint => `- [${hint.id}] ${hint.content}`)].join('\n')
}

export function apply(): void {
  // Pure functions by design; mounted as a plugin so deployments can extend
  // or replace the serialization through future config without touching the
  // scheduler.
}
