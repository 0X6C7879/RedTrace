/** Fixed identities are disjoint; Project.mode selects the vocabulary, not a role suffix. */
export const MODE_ROLES = {
  benchmark: ['commander', 'general', 'soldier'],
  general: ['planner', 'worker'],
} as const
export const LEGACY_GENERAL_ROLES: Record<string, 'planner'|'worker'> = {commander:'planner',general:'worker',soldier:'worker',reporter:'worker',leader:'worker',operator:'worker'}
export type ProjectMode = keyof typeof MODE_ROLES
export type FixedRole = (typeof MODE_ROLES)[ProjectMode][number]
export const FIXED_ROLES: FixedRole[] = [...MODE_ROLES.benchmark, ...MODE_ROLES.general]
export const coordinatorRole = (mode: ProjectMode) => mode === 'benchmark' ? 'commander' : 'planner'
export const executorRole = (mode: ProjectMode) => mode === 'benchmark' ? 'soldier' : 'worker'
export const isReportStep = (step?: { role?: string; reportFindingId?: string }) => step?.role === 'reporter' || !!step?.reportFindingId
export function executionRole(mode: ProjectMode, role?: string): FixedRole {
  if (!role || role === 'reporter') return executorRole(mode)
  if (!(MODE_ROLES[mode] as readonly string[]).includes(role)) throw new Error(`Invalid ${mode} role: ${role}`)
  return role as FixedRole
}
