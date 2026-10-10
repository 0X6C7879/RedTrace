import type { Operations } from '../src/operations.ts'

// Protocol fixture only; this never runs an arbitrary received command.
export function fixtureFrame(wire: string, output: string, code = 0) {
  const begin = /RTBEGIN[a-f0-9]+/.exec(wire)?.[0], end = /RTEND[a-f0-9]+/.exec(wire)?.[0]
  if (!begin || !end) throw new Error('Fixture received an unframed request')
  return `\n${begin}\n${output}\n${end}:${code}\n`
}
export function fixtureAuthorize(ops: Operations, project: string, resource: string, actions: string[]) {
  ops.store.db.prepare('INSERT INTO operation_authorizations VALUES (?,?,?,?,?,?,?,?,?,?)').run(
    crypto.randomUUID(), project, JSON.stringify(actions), JSON.stringify([resource]), '[]', '[]', 'fixture-human',
    new Date(Date.now()+60000).toISOString(), null, new Date().toISOString())
}
