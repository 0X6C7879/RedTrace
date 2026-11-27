import type { Graph } from './types.ts'
import { foldedFactIds } from './graph-content.ts'

export type FgsNodeType = 'scope' | 'fact' | 'finding' | 'subgoal' | 'goal' | 'step'
export interface FgsNode { id: string; nodeType: FgsNodeType; label: string; description: string; status?: string; worker?: string | null; activeSteps?: number; folded?: boolean; factCount?: number }
export interface FgsEdge { id: string; source: string; target: string; relation: 'scope' | 'derived' | 'supports' | 'pursues' | 'evidence' | 'subgoal' | 'executes'; stepIds: string[] }
const ACTIVE_STEP_STATUSES = ['pending', 'running', 'paused', 'blocked']

/** A lossless projection of recorded relationships, not a second graph database. */
export function projectFgs(graph: Graph) {
  const origin=graph.graph?.originId??'origin'
  const folded = foldedFactIds(graph)
  const activeSteps = new Map<string, number>()
  for (const step of graph.steps) if (!step.deleted && ACTIVE_STEP_STATUSES.includes(step.status)) activeSteps.set(step.goalId, (activeSteps.get(step.goalId) ?? 0) + 1)
  const nodes: FgsNode[] = [
    ...graph.facts.map(f => ({ id: f.id, nodeType: f.id === origin ? 'scope' as const : 'fact' as const, label: f.title, description: f.title, folded: folded.has(f.id) })),
    ...graph.goals.map(g => ({ id: g.id, nodeType: g.parentId ? 'subgoal' as const : 'goal' as const, label: g.description, description: g.description, status: g.status,
      activeSteps: activeSteps.get(g.id) ?? 0 })),
    ...graph.findings.map(f => ({ id: f.id, nodeType: 'finding' as const, label: f.title, description: f.title, factCount: f.factIds.length })),
  ]
  const ids = new Set(nodes.map(n => n.id)), edges = new Map<string, FgsEdge>(), missing = new Set<string>()
  const add = (source: string, target: string, relation: FgsEdge['relation'], stepId?: string) => {
    if (!ids.has(source) || !ids.has(target)) { missing.add(`${source} → ${target}`); return }
    if (source === target) return
    const id = JSON.stringify([relation, source, target])
    const edge = edges.get(id) ?? { id, source, target, relation, stepIds: [] }
    if (stepId && !edge.stepIds.includes(stepId)) edge.stepIds.push(stepId)
    edges.set(id, edge)
  }
  const root = graph.goals.find(g => !g.parentId)
  if (root) add(origin, root.id, 'scope')
  const producers = new Map([...(graph.graph?.planner?.legacyAssignments ?? []), ...graph.steps].map(step => [step.id, step]))
  const linkedFacts = new Set([...producers.values()].flatMap(step => step.factIds))
  const outputs = new Map<string, Set<string>>()
  for (const fact of graph.facts) {
    const producerIds = [...(fact.producerStepIds ?? []), ...(fact.stepId ? [fact.stepId] : [])]
    for (const id of producerIds) {
      const facts = outputs.get(id) ?? new Set<string>()
      facts.add(fact.id)
      outputs.set(id, facts)
    }
    if (fact.id !== origin && !producerIds.length && !linkedFacts.has(fact.id)) add(origin, fact.id, 'scope')
  }
  for (const goal of graph.goals) {
    if (goal.parentId) {
      add(goal.id, goal.parentId, 'subgoal')
      // Every subgoal belongs to the project's scope; this is not evidence of success.
      add(origin, goal.id, 'scope')
    }
    for (const fact of goal.evidenceIds) add(fact, goal.id, 'evidence')
  }
  for (const step of producers.values()) {
    const facts = new Set([...step.factIds, ...(outputs.get(step.id) ?? [])])
    for (const output of facts) {
      if (!ids.has(output)) continue
      for (const source of step.sourceIds) add(source, output, 'derived', step.id)
      add(output, step.goalId, 'pursues', step.id)
    }
  }
  for (const finding of graph.findings) {
    for (const fact of finding.factIds) add(fact, finding.id, 'supports')
    for (const stepId of new Set([...(finding.producerStepIds ?? []), ...(finding.stepId ? [finding.stepId] : [])])) {
      const step = producers.get(stepId)
      if (step) add(finding.id, step.goalId, 'pursues', step.id)
    }
  }
  return { nodes, edges: [...edges.values()], missingReferences: [...missing] }
}

/**
 * Canvas-only virtual layer for human review, mirroring the old open-Intent placeholder nodes:
 * active Steps render as temporary nodes with dashed executes edges and vanish once their facts exist.
 * It is never persisted into exports/snapshots and never read by graph tools such as read_graph.
 */
export function liveSteps(graph: Graph): { nodes: FgsNode[]; edges: FgsEdge[] } {
  const active = graph.steps.filter(s => !s.deleted && ACTIVE_STEP_STATUSES.includes(s.status))
  if (!active.length) return { nodes: [], edges: [] }
  const ids = new Set<string>([...graph.facts.map(f => f.id), ...graph.goals.map(g => g.id), ...graph.findings.map(f => f.id), ...active.map(s => s.id)])
  const edges: FgsEdge[] = [], pairs = new Set<string>()
  const add = (source: string, target: string, relation: FgsEdge['relation'], stepId: string) => {
    if (!ids.has(source) || !ids.has(target) || source === target) return
    const pair = JSON.stringify([source, target])
    if (pairs.has(pair)) return
    pairs.add(pair)
    edges.push({ id: JSON.stringify([relation, source, target]), source, target, relation, stepIds: [stepId] })
  }
  for (const step of active) {
    for (const source of step.sourceIds) add(source, step.id, 'executes', step.id)
    if (step.goalId) add(step.id, step.goalId, 'pursues', step.id)
  }
  return { nodes: active.map(s => ({ id: s.id, nodeType: 'step' as const, label: s.description, description: s.description, status: s.status, worker: s.worker })), edges }
}
