import type { Graph, GraphNode } from './types.ts'

/** Sapper title/description/doc semantics; raw bytes stay in ProjectEvidence. */
export const factTitle = (description: string) => Array.from(description.split(/[\n。！？.!?]/u)[0].trim()).slice(0, 40).join('') || Array.from(description.trim()).slice(0, 40).join('')
export const activeStep = (status: string) => !['done', 'cancelled'].includes(status)
export function foldedFactIds(graph: Graph) {
  const covered = new Set(graph.findings.flatMap(f => f.factIds))
  for (const step of graph.steps) if (!step.deleted && activeStep(step.status)) for (const id of step.sourceIds) covered.delete(id)
  return covered
}
export function nodeContent(node: GraphNode, detail: 'title' | 'summary' | 'doc' = 'title'): Record<string, unknown> & { id: string; kind: GraphNode['kind'] } {
  if (node.kind !== 'fact' && node.kind !== 'finding') return { ...node }
  const { description, ...rest } = node
  const index: Record<string, unknown> = { ...rest }
  for (const field of ['evidence', 'doc', 'details', 'report']) delete index[field]
  const title = { ...index, id: node.id, kind: node.kind, hasDoc: node.kind === 'fact' && !!node.doc, ...(node.kind === 'finding' ? { factCount: node.factIds.length, hasReport: !!node.report } : {}) }
  return detail === 'doc' ? { ...node } : detail === 'summary' ? { ...title, description } : title
}
export function graphContent(graph: Graph, fold = true) {
  const folded = fold ? foldedFactIds(graph) : new Set<string>()
  return { ...graph, facts: graph.facts.filter(f => !folded.has(f.id)).map(f => nodeContent(f)), findings: graph.findings.map(f => nodeContent(f)) }
}

// Project-local IN sets are materialized once, not scanned once per Fact. IDs are Project-unique.
export const CONTEXT_FACT_SQL = `(kind!='fact' OR id NOT IN (
  SELECT ref.value FROM nodes finding, json_each(finding.data,'$.factIds') ref
  WHERE finding.project_id=? AND finding.kind='finding'
) OR id IN (
  SELECT ref.value FROM nodes step, json_each(step.data,'$.sourceIds') ref
  WHERE step.project_id=? AND step.kind='step'
  AND COALESCE(json_extract(step.data,'$.deleted'),0)=0 AND json_extract(step.data,'$.status') NOT IN ('done','cancelled')
))`
