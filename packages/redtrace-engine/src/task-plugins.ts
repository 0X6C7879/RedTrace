import { Type } from 'typebox'
import { TASK_PLUGINS } from '../../redtrace-dsh/src/task-plugins.ts'
import { HttpError } from './types.ts'

export { TASK_PLUGINS }
export const taskPluginsSchema = Type.Array(Type.Union(TASK_PLUGINS.map(p => Type.Literal(p.id))), { uniqueItems: true, maxItems: 16 })

export function validateTaskPlugins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 16 || new Set(value).size !== value.length
    || value.some(id => !TASK_PLUGINS.some(p => p.id === id))) throw new HttpError(422, 'Invalid task plugins')
  return [...value].sort()
}
