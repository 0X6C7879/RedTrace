/** Fixed identities are disjoint; Project.mode selects the vocabulary, not a role suffix. */
export const MODE_ROLES = {
  benchmark: ['commander', 'general', 'soldier'],
  general: ['general', 'soldier'],
} as const
export const LEGACY_GENERAL_ROLES: Record<string, 'general'|'soldier'> = {commander:'general',planner:'general',worker:'soldier',general:'general',soldier:'soldier',reporter:'soldier',leader:'soldier',operator:'soldier'}
export type ProjectMode = keyof typeof MODE_ROLES
export type FixedRole = (typeof MODE_ROLES)[ProjectMode][number]
export const FIXED_ROLES: FixedRole[] = [...new Set([...MODE_ROLES.benchmark, ...MODE_ROLES.general])]
export const coordinatorRole = (mode: ProjectMode) => mode === 'benchmark' ? 'commander' : 'general'
export const executorRole = (mode: ProjectMode) => 'soldier' as const
export const isReportStep = (step?: { role?: string; reportFindingId?: string }) => step?.role === 'reporter' || !!step?.reportFindingId
export function executionRole(mode: ProjectMode, role?: string): FixedRole {
  if (!role || role === 'reporter') return executorRole(mode)
  if (!(MODE_ROLES[mode] as readonly string[]).includes(role)) throw new Error(`Invalid ${mode} role: ${role}`)
  return role as FixedRole
}
