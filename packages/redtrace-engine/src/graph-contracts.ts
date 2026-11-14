import { Type } from 'typebox'

const text = Type.String({ minLength: 1, pattern: '\\S' })
const mode = Type.Optional(Type.Union([Type.Literal('amend'), Type.Literal('replace')]))
const version = Type.Optional(Type.Integer({ minimum: 1 }))
export const stepUpdateSchema = Type.Object({
  description: Type.Optional(text), sourceIds: Type.Optional(Type.Array(text, { minItems: 1, uniqueItems: true })),
  goalId: Type.Optional(text), priority: Type.Optional(Type.Integer()),
  status: Type.Optional(Type.Union([Type.Literal('pending'), Type.Literal('cancelled')])),
  executionProfile: Type.Optional(Type.Union([Type.Literal('direct'), Type.Literal('isolated')])),
  expectedVersion: version, mode,
})
export const goalUpdateSchema = Type.Object({ description: Type.Optional(text),
  status: Type.Optional(Type.Union([Type.Literal('open'), Type.Literal('achieved'), Type.Literal('cancelled')])),
  evidenceIds: Type.Optional(Type.Array(text, { uniqueItems: true })), expectedVersion: version, mode,
})
