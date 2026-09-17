/**
 * DSH Agent activation helpers for the FGS engine's Cordis compatibility
 * host: create or resume an Agent session under the selected Worker's model
 * route, and resolve the reasoning effort against the owning adapter's model
 * metadata.
 * @module redtrace-agent
 */

import type { LlmService, RuntimeContext, WorkerRoute } from './types.js'

export function activateAgent(
  agents: RuntimeContext['agents'],
  sessionId: unknown,
  cwd: string,
  activation: Record<string, unknown>,
  resume: boolean,
): Promise<import('./types.js').AgentHandle> {
  return resume
    ? agents.resume({ resumeSessionId: sessionId, ...activation })
    : agents.create({ sessionId, meta: { cwd }, ...activation })
}

const REASONING_ORDER: readonly Exclude<import('./types.js').ReasoningPolicy, 'auto_max'>[] = [
  'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
]

/** Resolve RedTrace's policy against the exact model metadata exposed by the
 * owning DSH adapter. Unknown capability preserves the provider default. */
export async function resolveReasoningEffort(
  llm: LlmService,
  route: WorkerRoute,
): Promise<string | undefined> {
  const info = await llm.resolveModelInfo(route.provider, route.model)
  const supported = info.reasoning?.efforts.map(effort => effort.id)
  if (route.reasoning === 'auto_max') {
    if (supported === undefined || supported.length === 0) return undefined
    const offered = new Set(supported)
    for (const effort of [...REASONING_ORDER].reverse()) {
      if (offered.has(effort)) return effort
    }
    return [...supported].reverse().find(effort => effort !== 'off')
  }
  if (supported?.includes(route.reasoning)) return route.reasoning
  throw new Error(
    `provider "${route.provider}" model "${route.model}" does not support configured reasoning effort "${route.reasoning}"`,
  )
}
