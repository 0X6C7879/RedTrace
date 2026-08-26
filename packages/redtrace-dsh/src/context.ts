/**
 * RedTrace Context plugin: renders each task's single launch prompt — the
 * context slice the task type needs (Reason: the full graph; Bootstrap:
 * Origin/Goal/Hints; Explore: the claimed Intent's lineage plus shared
 * resources) — and the runtime hint injection. Stable rules live in the
 * prompt plugin's personas; this module carries dynamic content only.
 * @module redtrace-context
 */

import type { Intent, ProjectDetail, ResourceSummary, RuntimeTask } from './types.js'

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
  return `- [${intent.id}] ${intent.state}: ${intent.description}(from: [${intent.from.join(', ')}]${target})`
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
        ['Facts', factLines(graph)],
        [`Intents(最多创建 ${task.maxIntents ?? 4} 个活跃 Intent)`, project.intents.map(intentLine)],
        ['Hints', hintLines(project.hints)],
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
    ...sections([
      ['Source Facts', factLines(lineage)],
      ['Hints', hintLines(project.hints)],
      ['Current Intent', intent === undefined ? [] : [intentLine(intent)]],
      ['Resources', resourceLines(resources)],
    ]),
  ].join('\n\n')
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
