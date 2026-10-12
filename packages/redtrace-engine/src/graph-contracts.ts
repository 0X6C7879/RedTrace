import { Type } from 'typebox'
import { taskPluginsSchema } from './task-plugins.ts'

const text = Type.String({ minLength: 1, pattern: '\\S' })
const mode = Type.Optional(Type.Union([Type.Literal('amend'), Type.Literal('replace')]))
const version = Type.Optional(Type.Integer({ minimum: 1 }))
export const stepUpdateSchema = Type.Object({
  description: Type.Optional(text), sourceIds: Type.Optional(Type.Array(text, { minItems: 1, uniqueItems: true })),
  goalId: Type.Optional(text), priority: Type.Optional(Type.Integer()),
  status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('cancelled')])),
  executionProfile: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('isolated')])),
  plugins: Type.Optional(taskPluginsSchema),
  requires: Type.Optional(Type.Array(text, { maxItems: 16, uniqueItems: true })), expectedVersion: version, mode,
})
export const goalUpdateSchema = Type.Object({ description: Type.Optional(text),
  status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('achieved'), Type.Literal('cancelled')])),
  evidenceIds: Type.Optional(Type.Array(text, { uniqueItems: true })), expectedVersion: version, mode,
})
export const evidenceChangeSchema = Type.Object({
  operation: Type.Union([Type.Literal('merge'), Type.Literal('delete')]),
  id: text, expectedVersion: Type.Integer({ minimum: 1 }), reason: text,
  sourceIds: Type.Optional(Type.Array(text, { minItems: 1, uniqueItems: true })),
  sourceVersions: Type.Optional(Type.Record(Type.String(), Type.Integer({ minimum: 1 }))),
  description: Type.Optional(text), title: Type.Optional(text), details: Type.Optional(Type.Any()),
})
