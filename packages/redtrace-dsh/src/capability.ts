/** Capability-driven Skill catalog and per-Session filesystem projection. */

import { mkdir, rename, rm, stat, symlink } from 'node:fs/promises'
import path from 'node:path'
import type { CapabilityName, RuntimeOptions, SkillProfile } from './types.js'
import { api } from './domain.js'

export interface SkillCatalog {
  skills: string[]
  capabilities: CapabilityName[]
  skillProfile: SkillProfile
  diagnostics: Array<Record<string, unknown>>
  competitionRules: string
}

export interface SkillView {
  directory: string
  catalog: SkillCatalog
  cleanup(): Promise<void>
}

function safeSessionId(value: string): string {
  const clean = value.replace(/[^A-Za-z0-9_-]/g, '-').replace(/-+/g, '-').slice(0, 96)
  return clean || 'session'
}

function assertSkillName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(name) || name.includes('..')) {
    throw new Error(`invalid resolved Skill name: ${name}`)
  }
}

/** Call the server's read-only Resolver; there is deliberately no local
 * fallback to the complete root catalog. */
export async function resolveSkillCatalog(
  config: RuntimeOptions,
  capabilities: CapabilityName[],
  skillProfile: SkillProfile,
): Promise<SkillCatalog> {
  const catalog = await api<SkillCatalog>(config, '/capabilities/resolve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ capabilities, skill_profile: skillProfile }),
  })
  if (!Array.isArray(catalog.skills) || catalog.skills.length === 0) {
    throw new Error('Capability Resolver returned an empty Skill catalog')
  }
  for (const name of catalog.skills) assertSkillName(name)
  return catalog
}

/** Atomically create a Session-isolated directory of links to canonical
 * skills/<name> roots. Skill content is never copied, so Memory and Skill
 * Evolution continue operating on the single project-root source. */
export async function createSkillView(
  config: RuntimeOptions,
  sessionId: string,
  catalog: SkillCatalog,
): Promise<SkillView> {
  const parent = path.resolve(config.root, '.redtrace', 'runtime', 'skill-views')
  const directory = path.join(parent, safeSessionId(sessionId))
  const temporary = path.join(parent, `.tmp-${safeSessionId(sessionId)}-${crypto.randomUUID()}`)
  const sourceRoot = path.resolve(config.root, config.skillsDir)
  await mkdir(parent, { recursive: true })
  await mkdir(temporary)
  try {
    for (const name of catalog.skills) {
      assertSkillName(name)
      const source = path.resolve(sourceRoot, name)
      const root = sourceRoot
      if (!source.startsWith(`${root}${path.sep}`)) throw new Error(`Skill source escapes root: ${name}`)
      if (!(await stat(source)).isDirectory()) throw new Error(`Skill source is missing: ${name}`)
      await symlink(source, path.join(temporary, name), process.platform === 'win32' ? 'junction' : 'dir')
    }
    await rm(directory, { recursive: true, force: true })
    await rename(temporary, directory)
  } catch (error) {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined)
    throw error
  }
  return {
    directory,
    catalog,
    cleanup: async () => {
      const resolvedParent = path.resolve(parent)
      const resolvedDirectory = path.resolve(directory)
      if (resolvedDirectory.startsWith(`${resolvedParent}${path.sep}`)) {
        await rm(resolvedDirectory, { recursive: true, force: true })
      }
    },
  }
}
