import type { TSchema, Static } from 'typebox'

/** Domain tool values; the DSH host owns native registration and image admission. */
export interface AgentToolResult<D = unknown> {
  content: ({ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string })[]
  details?: D
  terminate?: boolean
}
export interface AgentTool<T extends TSchema = TSchema, D = unknown> {
  name: string
  label: string
  description: string
  parameters: T
  executionMode?: 'sequential'
  execute(callId: string, args: Static<T>, signal?: AbortSignal): Promise<AgentToolResult<D>>
}
