import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, appendFileSync, unlinkSync, realpathSync, cpSync, symlinkSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { parse } from 'yaml'
import { Type } from 'typebox'
import { atomicWrite } from './config.ts'
import { HttpError } from './types.ts'
import { body, send } from './http.ts'
import type { Router } from './http.ts'

const ignored = new Set(['.git', '.venv', '__pycache__', 'node_modules', '.redtrace'])
const validName = (name: string) => { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new HttpError(400, 'Invalid capability name'); return name }
const readJSON = (file: string, fallback: any = undefined) => existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
export function frontmatter(content: string): Record<string, any> {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content)
  if (!match) return {}
  try { const value = parse(match[1]); return value && typeof value === 'object' && !Array.isArray(value) ? value : {} } catch { throw new HttpError(400, 'Invalid Skill YAML frontmatter') }
}
function files(root: string, relative = ''): string[] {
  return readdirSync(path.join(root, relative), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    if (entry.isSymbolicLink() || ignored.has(entry.name) || entry.name === '.redtrace.json') return []
    const name = path.posix.join(relative, entry.name)
    return entry.isDirectory() ? files(root, name) : [name]
  })
}
const revisionOf = (content: string, state: any) => createHash('sha256').update(`trust=${state.trust}\nsuccessful_reuses=${state.successfulReuses}\nfailure_count=${state.failureCount}\n${content}`).digest('hex')

export class Capabilities {
  readonly root: string
  readonly skillsDir: string
  readonly disabledDir: string
  readonly mcpDir: string
  constructor(root: string) {
    this.root = path.resolve(root); this.skillsDir = path.join(this.root, 'skills'); this.disabledDir = path.join(this.root, 'disabled-skills'); this.mcpDir = path.join(this.root, 'mcp')
    for (const dir of [this.skillsDir, this.disabledDir, this.mcpDir]) mkdirSync(dir, { recursive: true })
  }
  initialize(source: string) {
    const marker = path.join(this.root, 'capabilities-imported.json')
    if (existsSync(marker)) return
    const wsl = process.platform === 'linux' && Boolean(process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP)
    for (const name of ['skills', 'disabled-skills', 'mcp']) {
      const from = path.join(source, name), to = path.join(this.root, name)
      if (existsSync(from) && !readdirSync(to).length) {
        cpSync(from, to, { recursive: true, dereference: true, filter: entry => !wsl || path.basename(entry) !== 'node_modules' })
        if (wsl && name !== 'mcp') for (const skill of readdirSync(from)) {
          const modules = path.join(from, skill, 'node_modules'), target = path.join(to, skill, 'node_modules')
          if (existsSync(modules) && existsSync(path.dirname(target))) symlinkSync(modules, target, 'dir')
        }
      }
    }
    atomicWrite(marker, JSON.stringify({ source, importedAt: new Date().toISOString() }))
  }
  directory(name: string) {
    validName(name)
    const root = existsSync(path.join(this.skillsDir, name, 'SKILL.md')) ? this.skillsDir : this.disabledDir, directory = path.join(root, name)
    if (!existsSync(path.join(directory, 'SKILL.md'))) throw new HttpError(404, `skill not found: ${name}`)
    const relative = path.relative(realpathSync(root), realpathSync(directory)); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new HttpError(400, 'Skill path escapes catalog')
    return directory
  }
  skill(name: string, includeFiles = true) {
    const directory = this.directory(name), content = readFileSync(path.join(directory, 'SKILL.md'), 'utf8'), metadata = frontmatter(content)
    const state = { version: 1, updatedAt: null, trust: 'trusted', successfulReuses: 0, failureCount: 0, ...readJSON(path.join(directory, '.redtrace.json'), {}) }
    if (state.revision && state.revision !== revisionOf(content, state)) { state.trust = 'provisional'; state.successfulReuses = 0; state.provisionalTask = 'out-of-band' }
    return { name, description: metadata.description ?? '', enabled: path.dirname(directory) === this.skillsDir, content,
      files: includeFiles ? files(directory) : [], version: state.version, revision: revisionOf(content, state), updatedAt: state.updatedAt, trust: state.trust,
      successfulReuses: state.successfulReuses, failureCount: state.failureCount }
  }
  skills() { return [...new Set([this.skillsDir, this.disabledDir].flatMap(root => readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory() && !d.name.startsWith('.') && existsSync(path.join(root, d.name, 'SKILL.md'))).map(d => d.name)))].sort().map(name => this.skill(name, false)) }
  write(name: string, content: string, enabled: boolean, expected?: string | null, restore?: any) {
    validName(name); content = content.trimEnd() + '\n'
    if (!content.trim() || content.length > Number(process.env.REDTRACE_MAX_SKILL_CHARS ?? 65536)) throw new HttpError(400, 'Invalid Skill content length')
    frontmatter(content)
    let previous: ReturnType<Capabilities['skill']> | undefined
    try { previous = this.skill(name) } catch (e) { if (!(e instanceof HttpError) || e.status !== 404) throw e }
    if (expected && previous?.revision !== expected) throw new HttpError(409, 'Skill revision conflict')
    if (!previous && this.skills().length >= Number(process.env.REDTRACE_MAX_SKILLS ?? 256)) throw new HttpError(400, 'Skill count limit reached')
    const changed = previous?.content !== content
    const state = { version: (previous?.version ?? 0) + 1, updatedAt: new Date().toISOString(), trust: restore?.trust ?? (changed ? 'provisional' : previous!.trust), successfulReuses: restore?.successfulReuses ?? (changed ? 0 : previous!.successfulReuses), failureCount: restore?.failureCount ?? previous?.failureCount ?? 0 }
    const directory = path.join(enabled ? this.skillsDir : this.disabledDir, name)
    if (previous) {
      this.history(previous)
      const old = this.directory(name)
      if (old !== directory) { if (existsSync(directory)) throw new HttpError(409, 'Skill exists in both roots'); renameSync(old, directory) }
    }
    atomicWrite(path.join(directory, 'SKILL.md'), content)
    atomicWrite(path.join(directory, '.redtrace.json'), JSON.stringify({ ...state, revision: revisionOf(content, state) }))
    const current = this.skill(name); this.history(current)
    const audit = path.join(this.skillsDir, '.redtrace/audit.jsonl'); mkdirSync(path.dirname(audit), { recursive: true })
    appendFileSync(audit, JSON.stringify({ skill: name, action: previous ? 'update' : 'create', version: current.version, revision: current.revision, at: state.updatedAt }) + '\n')
    return current
  }
  private history(record: ReturnType<Capabilities['skill']>) {
    const file = path.join(this.skillsDir, '.redtrace/history', record.name, `v${String(record.version).padStart(6, '0')}.json`)
    if (!existsSync(file)) atomicWrite(file, JSON.stringify({ ...record, actor: 'api', reason: 'manual update', at: record.updatedAt ?? new Date().toISOString() }))
  }
  versions(name: string) { this.skill(name, false); const dir = path.join(this.skillsDir, '.redtrace/history', name); return existsSync(dir) ? readdirSync(dir).filter(n => /^v\d+\.json$/.test(n)).sort().reverse().map(n => readJSON(path.join(dir, n))) : [] }
  delete(name: string) { const directory = this.directory(name); this.history(this.skill(name)); rmSync(directory, { recursive: true }) }
  entries(name?: string) {
    return (name ? [this.skill(name)] : this.skills()).flatMap(s => {
      const directory = this.directory(s.name)
      return files(directory).filter(f => path.posix.basename(f) === 'SKILL.md').map(f => {
        const metadata = frontmatter(readFileSync(path.join(directory, f), 'utf8')), nested = f !== 'SKILL.md'
        return { ...s, content: undefined, files: undefined, key: nested ? `${s.name}:${f}` : s.name, parent: s.name, path: f, name: metadata.name ?? s.name, description: metadata.description ?? '', depth: f.split('/').length - 1, nested }
      })
    })
  }
  mcp(name: string) {
    const file = path.join(this.mcpDir, `${validName(name)}.json`); if (!existsSync(file)) throw new HttpError(404, `MCP server not found: ${name}`)
    const config = readJSON(file), common = { ...config }; delete common.agents
    return { name, enabled: config.enabled ?? true, transport: common.transport ?? common.type ?? (common.url ? 'http' : 'stdio'), command: common.command ?? null, url: common.url ?? null, agents: ['dsh'], config }
  }
  servers() { return readdirSync(this.mcpDir).filter(n => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}\.json$/.test(n)).sort().map(n => this.mcp(n.slice(0, -5))) }
  mcpConfigs() {
    return this.servers().filter(s => s.enabled).map(s => {
      const config = { ...s.config, ...s.config.agents?.dsh, serverName: s.name }
      for (const key of ['enabled', 'agents', 'name']) delete config[key]
      config.transport = config.transport ?? config.type ?? (config.url ? 'streamable-http' : 'stdio')
      if (config.transport === 'http') config.transport = 'streamable-http'
      delete config.type
      return config
    })
  }
  writeMcp(name: string, config: Record<string, any>) {
    if (!config.command && !config.url && !Object.values(config.agents ?? {}).some((a: any) => a?.command || a?.url)) throw new HttpError(400, 'MCP config requires command or url')
    atomicWrite(path.join(this.mcpDir, `${validName(name)}.json`), JSON.stringify(config, null, 2)); return this.mcp(name)
  }
}

export function capabilityRoutes(router: Router, store: Capabilities) {
  router.add('GET', '/capabilities', () => { const skills = store.entries(), mcp = store.servers(); return { root: store.root, skillsDir: store.skillsDir, mcpDir: store.mcpDir, skills: { total: skills.length, enabled: skills.filter(s => s.enabled).length }, mcp: { total: mcp.length, enabled: mcp.filter(s => s.enabled).length }, agents: [{ id: 'dsh', skills: store.skillsDir, runtimeSnapshot: null, mcp: 'mcpConfigs (runtime config)' }] } })
  router.add('GET', '/capabilities/skill-entries', () => store.entries())
  router.add('GET', '/capabilities/skills/:name', c => store.skill(c.params.name))
  router.add('GET', '/capabilities/skills/:name/entries', c => store.entries(c.params.name).filter(s => s.nested))
  router.add('GET', '/capabilities/skills/:name/entries/:entry*', c => {
    const entry = store.entries(c.params.name).find(s => s.path === c.params.entry); if (!entry) throw new HttpError(404, 'Skill entry not found')
    return { ...entry, content: readFileSync(path.join(store.directory(c.params.name), entry.path), 'utf8') }
  })
  router.add('POST', '/capabilities/skills', async c => {
    const b = await body(c.req, Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }), content: Type.String({ minLength: 1 }), enabled: Type.Optional(Type.Boolean()) }))
    try { store.skill(b.name); throw new HttpError(409, 'Skill already exists') } catch (e) { if (!(e instanceof HttpError) || e.status !== 404) throw e }
    send(c.res, store.write(b.name, b.content, b.enabled ?? true), 201)
  })
  router.add('PUT', '/capabilities/skills/:name', async c => { const b = await body(c.req, Type.Object({ content: Type.String({ minLength: 1 }), enabled: Type.Optional(Type.Boolean()), expected_revision: Type.Optional(Type.Union([Type.String(), Type.Null()])) })); store.skill(c.params.name); return store.write(c.params.name, b.content, b.enabled ?? true, b.expected_revision) })
  router.add('PATCH', '/capabilities/skills/:name/enabled', async c => { const b = await body(c.req, Type.Object({ enabled: Type.Boolean(), expected_revision: Type.Optional(Type.Union([Type.String(), Type.Null()])) })), current = store.skill(c.params.name); return store.write(c.params.name, current.content, b.enabled, b.expected_revision ?? current.revision) })
  router.add('DELETE', '/capabilities/skills/:name', c => { store.delete(c.params.name); send(c.res, null, 204) })
  router.add('GET', '/capabilities/skills/:name/versions', c => store.versions(c.params.name).map(({ content: _, ...v }) => v))
  router.add('POST', '/capabilities/skills/:name/rollback/:version', async c => { const b = await body(c.req, Type.Object({ expected_revision: Type.Optional(Type.Union([Type.String(), Type.Null()])) })), value = store.versions(c.params.name).find(v => v.version === Number(c.params.version)); if (!value) throw new HttpError(404, 'Skill version not found'); return store.write(c.params.name, value.content, value.enabled, b.expected_revision, value) })
  router.add('GET', '/capabilities/mcp', () => store.servers())
  router.add('GET', '/capabilities/mcp/:name', c => store.mcp(c.params.name))
  router.add('POST', '/capabilities/mcp', async c => {
    const b = await body(c.req, Type.Object({ name: Type.String(), config: Type.Record(Type.String(), Type.Unknown()) }))
    if (existsSync(path.join(store.mcpDir, `${validName(b.name)}.json`))) throw new HttpError(409, 'MCP server already exists')
    send(c.res, store.writeMcp(b.name, b.config), 201)
  })
  router.add('PUT', '/capabilities/mcp/:name', async c => { const b = await body(c.req, Type.Object({ config: Type.Record(Type.String(), Type.Unknown()) })); store.mcp(c.params.name); return store.writeMcp(c.params.name, b.config) })
  router.add('PATCH', '/capabilities/mcp/:name/enabled', async c => { const b = await body(c.req, Type.Object({ enabled: Type.Boolean() })), current = store.mcp(c.params.name); return store.writeMcp(c.params.name, { ...current.config, enabled: b.enabled }) })
  router.add('DELETE', '/capabilities/mcp/:name', c => { store.mcp(c.params.name); unlinkSync(path.join(store.mcpDir, `${c.params.name}.json`)); send(c.res, null, 204) })
}
