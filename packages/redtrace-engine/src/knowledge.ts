import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Type } from 'typebox'
import { parse as parseYaml } from 'yaml'
import type { AgentTool } from './tool-types.ts'
import type { TaskContext } from './scheduler.ts'
import { knowledgeData, knowledgeEnvironment, readVulnerability, vulnerabilitySearch } from './knowledge-vuln.ts'
import type { VulnerabilityQuery } from './knowledge-vuln.ts'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const searchable = /\.(?:md|txt|rst|ya?ml|json)$/i
const excluded = /(?:^|[\\/])(?:\.git|node_modules|\.redtrace|write.?up|solution|answer|flag|secret|credential)(?:[\\/._-]|$)/i
const tokenize = (query: string) => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 16)
const nucleiProtocols = new Set(['http', 'dns', 'tcp', 'ssl', 'headless', 'code', 'file', 'websocket', 'network', 'whois', 'javascript'])
const nucleiPathPrefix = '@nuclei-templates/'
type KnowledgeMetadata = { kind: string; templateId?: string; name?: string; severity?: string; vendor?: string; component?: string; version?: string; protocols: string[]; tags: string[]; cves: string[]; cwes: string[]; references: string[]; prerequisites: string[]; fingerprintIndicators: string[]; parseError?: boolean }
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
function strings(value: unknown): string[] {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : value === undefined || value === null ? [] : [value]
  return [...new Set(values.map(item => String(item).trim()).filter(Boolean))].slice(0, 20)
}
function fingerprintIndicators(value: unknown): string[] {
  const output: string[] = []
  const visit = (node: unknown, depth: number) => {
    if (depth > 10 || output.length >= 20 || node === null || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const child of node) visit(child, depth + 1); return }
    const row = node as Record<string, unknown>
    if (Array.isArray(row.matchers)) for (const item of row.matchers) {
      const matcher = object(item)
      for (const key of ['words', 'regex', 'dsl', 'status']) for (const indicator of strings(matcher[key])) if (output.length < 20) output.push(`${key}: ${indicator.slice(0, 180)}`)
    }
    for (const [key, child] of Object.entries(row)) if (key !== 'matchers') visit(child, depth + 1)
  }
  visit(value, 0)
  return output
}
function metadataFor(file: string, body: string, nucleiRoot: string): KnowledgeMetadata {
  const relative = path.relative(nucleiRoot, file)
  if (path.isAbsolute(relative) || relative === '..' || relative.startsWith(`..${path.sep}`) || !/\.ya?ml$/i.test(file)) return { kind: 'document', protocols: [], tags: [], cves: [], cwes: [], references: [], prerequisites: [], fingerprintIndicators: [] }
  try {
    const template = object(parseYaml(body)), info = object(template.info), metadata = object(info.metadata), classification = object(info.classification)
    const cves = new Set<string>(), cwes = new Set<string>()
    for (const value of [String(template.id ?? ''), ...strings(classification['cve-id']), ...body.match(/\bCVE-\d{4}-\d{4,}\b/gi) ?? []]) for (const id of value.match(/\bCVE-\d{4}-\d{4,}\b/gi) ?? []) cves.add(id.toUpperCase())
    for (const value of [...strings(classification['cwe-id']), ...body.match(/\bCWE-\d+\b/gi) ?? []]) for (const id of value.match(/\bCWE-\d+\b/gi) ?? []) cwes.add(id.toUpperCase())
    return {
      kind: 'nuclei-template', templateId: String(template.id ?? path.basename(file, path.extname(file))).slice(0, 200),
      name: typeof info.name === 'string' ? info.name.slice(0, 300) : undefined,
      severity: typeof info.severity === 'string' ? info.severity.slice(0, 40).toLowerCase() : undefined,
      vendor: strings(metadata.vendor)[0]?.slice(0, 200), component: strings(metadata.product ?? metadata.component ?? metadata.technology)[0]?.slice(0, 200),
      version: strings(metadata.version ?? metadata.versions)[0]?.match(/^\d+(?:\.\d+){0,4}$/)?.[0],
      protocols: Object.keys(template).filter(key => nucleiProtocols.has(key.toLowerCase())), tags: strings(info.tags).map(value => value.toLowerCase()),
      cves: [...cves].slice(0, 20), cwes: [...cwes].slice(0, 20), references: strings(info.reference ?? info.references).slice(0, 10).map(value => value.slice(0, 500)),
      prerequisites: strings(metadata.prerequisites ?? info.prerequisites).slice(0, 10).map(value => value.slice(0, 300)), fingerprintIndicators: fingerprintIndicators(template),
    }
  } catch { return { kind: 'nuclei-template', protocols: [], tags: [], cves: [], cwes: [], references: [], prerequisites: [], fingerprintIndicators: [], parseError: true } }
}
function sourcePath(file: string, repository: string, nucleiRoot: string) {
  const relativeToNuclei = path.relative(nucleiRoot, file)
  if (!path.isAbsolute(relativeToNuclei) && relativeToNuclei !== '..' && !relativeToNuclei.startsWith(`..${path.sep}`)) return `${nucleiPathPrefix}${portable(relativeToNuclei)}`
  const relativeToRepository = path.relative(repository, file)
  if (!path.isAbsolute(relativeToRepository) && relativeToRepository !== '..' && !relativeToRepository.startsWith(`..${path.sep}`)) return portable(relativeToRepository)
  return portable(relativeToRepository)
}
function sourceFile(repository: string, relative: string, nucleiRoot: string) {
  return relative.startsWith(nucleiPathPrefix) ? path.join(nucleiRoot, relative.slice(nucleiPathPrefix.length)) : path.join(repository, relative)
}
const normalized = (value: string) => value.trim().toLowerCase()
// Index keys and model-visible paths stay slash-separated on every platform.
const portable = (value: string) => value.split(path.sep).join('/')
function localDirectory(repository: string, name: string, env: string, candidates: string[], envChild?: string, environment: NodeJS.ProcessEnv = process.env) {
  const explicit = environment[env]
  const explicitPath = explicit ? path.resolve(explicit) : undefined
  const paths = explicit ? [explicitChild(explicitPath!, envChild)] : candidates.map(value => path.resolve(repository, value))
  const found = paths.find(value => { try { return statSync(value).isDirectory() } catch { return false } })
  return { name, path: found ?? null, status: found ? 'available' : 'missing', ...(found ? {} : { reason: explicit ? `${env} points to a missing directory` : 'No supported local installation path exists', checked: paths }) }
}
function explicitChild(directory: string, child?: string) {
  return child && path.basename(directory).toLowerCase() !== child.toLowerCase() ? path.join(directory, child) : directory
}

function collect(root: string, output: string[], maximum = 10_000) {
  const pending = [root]
  let scanned = 0
  const start = output.length
  while (pending.length && output.length - start < maximum && scanned < maximum * 8) {
    const directory = pending.pop()!
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++scanned >= maximum * 8) break
      const full = path.join(directory, entry.name)
      if (excluded.test(path.relative(root, full))) continue
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile() && searchable.test(entry.name)) {
        try { if (statSync(full).size <= 256 * 1024) output.push(full) } catch {}
        if (output.length - start >= maximum) break
      }
    }
  }
  return pending.length > 0 || output.length - start >= maximum || scanned >= maximum * 8
}

function collectWordlistCatalog(root: string, repository: string) {
  const pending = [root], counts = new Map<string, { files: number; bytes: number }>()
  let visited = 0, scanned = 0
  while (pending.length && visited < 10_000 && scanned < 80_000) {
    const directory = pending.pop()!
    let entries
    try { entries = readdirSync(directory, { withFileTypes: true }) } catch { continue }
    for (const entry of entries) {
      if (++scanned >= 80_000) break
      const full = path.join(directory, entry.name)
      if (excluded.test(path.relative(root, full))) continue
      if (entry.isDirectory()) pending.push(full)
      else if (entry.isFile()) {
        const category = path.relative(root, path.dirname(full)) || '.'
        try {
          const value = counts.get(category) ?? { files: 0, bytes: 0 }
          value.files++; value.bytes += statSync(full).size; counts.set(category, value); visited++
        } catch {}
        if (visited >= 10_000) break
      }
    }
  }
  return { items: [...counts].map(([category, value]) => {
    const sourcePath = portable(path.relative(repository, path.join(root, category)))
    const relative = `${sourcePath} (catalog)`
    return { relative, body: `SecLists category: ${sourcePath}; ${value.files} files; ${value.bytes} bytes; filenames and sizes only, wordlist content not indexed.` }
  }), truncated: pending.length > 0 || visited >= 10_000 || scanned >= 80_000 }
}

function openIndex(root: string, filename: string, sources: string[], wordlists: string[], nucleiRoot: string) {
  mkdirSync(path.dirname(filename), { recursive: true })
  const db = new DatabaseSync(filename)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS index_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(id UNINDEXED,path UNINDEXED,body,tokenize='unicode61')")
  const state = db.prepare("SELECT value FROM index_state WHERE key='updated' ").get() as { value: string } | undefined
  if (!state || Date.now() - Number(state.value) > 60_000) {
    const files: string[] = []
    const warnings: string[] = []
    for (const source of sources) if (collect(source, files)) warnings.push(`Source indexing limit reached; some files were not indexed: ${source}`)
    const known = new Map((db.prepare('SELECT id,path FROM docs').all() as { id: string; path: string }[]).map(row => [row.path, row.id]))
    const remove = db.prepare('DELETE FROM docs WHERE path=?'), insert = db.prepare('INSERT INTO docs(id,path,body) VALUES (?,?,?)')
    db.exec('BEGIN')
    try {
      const current = new Map<string, { hash: string; body: string }>()
      for (const file of files) {
        const relative=sourcePath(file,root,nucleiRoot),body=readFileSync(file,'utf8'),hash=digest(body)
        if (/\b(?:flag|tsecbench|htb)\{[^}\r\n]+\}/i.test(body)) continue
        current.set(relative, { hash, body })
      }
      for (const wordlist of wordlists) {
        const catalog = collectWordlistCatalog(wordlist, root)
        if (catalog.truncated) warnings.push(`SecLists catalog limit reached; some categories were not indexed: ${wordlist}`)
        for (const item of catalog.items) current.set(item.relative, { hash: digest(item.body), body: item.body })
      }
      for (const [relative, item] of current) if (known.get(relative) !== item.hash) { if (known.has(relative)) remove.run(relative); insert.run(item.hash, relative, item.body) }
      for (const previous of known.keys()) if (!current.has(previous)) remove.run(previous)
      db.prepare("INSERT INTO index_state VALUES ('updated',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()))
      db.prepare("INSERT INTO index_state VALUES ('warnings',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(warnings))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error }
  }
  return db
}

export function knowledgeTools(_evidenceRoot: string, context: TaskContext): AgentTool[] {
  const repository = context.config.workspaceRoot ? path.resolve(context.config.workspaceRoot, '..') : path.join(os.tmpdir(), 'redtrace-knowledge-test', context.run.projectId)
  const environment = knowledgeEnvironment(context.config)
  let generation: string | undefined
  try { const data = knowledgeData(context.config); if (data.database) generation = path.dirname(data.database) } catch {}
  const dataRoot = environment.REDTRACE_DATA_DIR ?? '/opt/redtrace/data'
  const nucleiPaths = [generation && path.join(generation, 'nuclei-templates'), path.join(dataRoot, 'nuclei-templates'), 'tools/wordlists/nuclei-templates', 'tools/poc/nuclei-templates', '/opt/redtrace/data/nuclei-templates', path.join(os.homedir(), 'nuclei-templates'), path.join(os.homedir(), '.nuclei-templates')].filter((value): value is string => !!value)
  for (const config of [path.join(repository, '.redtrace/config/nuclei/.templates-config.json'), path.join(os.homedir(), 'Library/Application Support/nuclei/.templates-config.json'), path.join(environment.XDG_STATE_HOME ?? path.join(os.homedir(), '.local/state'), 'nuclei/templates.json'), path.join(os.homedir(), '.config/nuclei/.templates-config.json')]) {
    try { const state = JSON.parse(readFileSync(config, 'utf8')); const root = state['nuclei-templates-directory'] ?? state.templatesDirectory; if (typeof root === 'string') nucleiPaths.push(root) } catch {}
  }
  const directory = (name: string, variable: string, paths: string[], child?: string) => localDirectory(repository, name, variable, paths, child, environment)
  const resources = [
    directory('project-skills', 'REDTRACE_SKILLS_DIR', ['skills']),
    directory('agent-skills', 'REDTRACE_AGENT_SKILLS_DIR', ['.agents/skills']),
    directory('private-skills', 'REDTRACE_PRIVATE_SKILLS_DIR', ['.redtrace/skills']),
    directory('vulhub', 'REDTRACE_VULHUB_DIR', ['tools/poc/vulhub', 'tools/vulhub', 'tools/poc/Vulhub']),
    directory('vulhub-skills', 'REDTRACE_VULHUB_SKILLS_DIR', ['tools/poc/vulhub/.claude/skills']),
    directory('payloads-all-the-things', 'REDTRACE_PAYLOADS_DIR', ['tools/payloads/PayloadsAllTheThings', 'tools/payloads/payloads-all-the-things'], 'PayloadsAllTheThings'),
    directory('exploitdb', 'REDTRACE_EXPLOITDB_DIR', [generation && path.join(generation, 'exploitdb'), path.join(dataRoot, 'exploitdb'), 'tools/poc/exploitdb', 'tools/exploitdb', '/usr/share/exploitdb', '/opt/homebrew/opt/exploitdb/share/exploitdb', '/usr/local/opt/exploitdb/share/exploitdb'].filter((value): value is string => !!value)),
    directory('nuclei-templates', 'REDTRACE_NUCLEI_TEMPLATES_DIR', nucleiPaths),
    directory('seclists', 'REDTRACE_WORDLISTS_DIR', ['tools/wordlists/SecLists', '/usr/share/seclists'], 'SecLists'),
  ]
  const nucleiRoot = resources.find(item => item.name === 'nuclei-templates')!.path ?? path.resolve(repository, 'tools/poc/nuclei-templates')
  const sources = [...new Set(resources.filter(item => item.path && item.name !== 'seclists' && item.name !== 'exploitdb' && !(generation && item.name === 'nuclei-templates')).map(item => item.path!))]
  const wordlists = resources.filter(item => item.name === 'seclists' && item.path).map(item => item.path!)
  const index = path.join(repository, '.redtrace', 'knowledge.sqlite')
  return [
    { name: 'knowledge_search', label: 'knowledge_search', description: `Actively search offline vulnerability intelligence by CVE, component name, or component plus version. Data directory: ${dataRoot}; SQLite: ${generation ? path.join(generation, 'vuln.sqlite') : 'missing (import data first)'}. Examples: {query:"CVE-2021-41773"}, {query:"apache"}, {component:"apache",version:"2.4.49"}. Optional vendor/cpe disambiguate products. No target/evidence required; no downloads, target scans or automatic PoC execution. Paginate with offset/limit; read CVE details or source IDs with knowledge_read. Matches are not proof of a vulnerability.`, parameters: Type.Object({ query: Type.Optional(Type.String({ minLength: 2, maxLength: 300 })), component: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), version: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), vendor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), cpe: Type.Optional(Type.String({ minLength: 1, maxLength: 4096 })), version_scheme: Type.Optional(Type.Union(['intdot', 'openssl', 'semver', 'pypi', 'maven', 'debian', 'rpm'].map(value => Type.Literal(value)))), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), include_excluded: Type.Optional(Type.Boolean()) }), executionMode: 'sequential', execute: async (_id: string, args: VulnerabilityQuery) => {
      const vulnerabilities = await vulnerabilitySearch(_evidenceRoot, context, args)
      const terms = tokenize(args.query ?? '')
      if (vulnerabilities.total || !terms.length || args.component || args.cpe || (vulnerabilities.database && /CVE-\d{4}-\d{4,}/i.test(args.query ?? ''))) {
        const value = { ...vulnerabilities, resources, note: 'Candidates are unverified; no template or PoC was executed' }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      }
      const db = openIndex(repository, index, sources, wordlists, nucleiRoot)
      try {
      const expression = terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')
      const rows = db.prepare('SELECT id,path,body,substr(body,max(1,instr(lower(body),lower(?))-160),360) AS snippet FROM docs WHERE docs MATCH ? ORDER BY bm25(docs),path LIMIT ? OFFSET ?').all(terms[0], expression, args.limit ?? 5, args.offset ?? 0) as { id: string; path: string; body: string; snippet: string }[]
      const results = rows.map(row => { const metadata = metadataFor(sourceFile(repository,row.path,nucleiRoot),row.body,nucleiRoot); return { id: row.id, path: row.path, sha256: row.id, snippet: row.snippet, kind: metadata.kind, templateId: metadata.templateId ?? null, name: metadata.name ?? null, severity: metadata.severity ?? 'unknown', vendor: metadata.vendor ?? 'unknown', component: metadata.component ?? 'unknown', version: metadata.version ?? 'unknown', protocols: metadata.protocols, tags: metadata.tags, cves: metadata.cves, cwes: metadata.cwes, references: metadata.references, prerequisites: metadata.prerequisites.length ? metadata.prerequisites : 'unknown', fingerprintIndicators: metadata.fingerprintIndicators, metadataParseError: metadata.parseError ?? false } })
        const indexWarnings = (db.prepare("SELECT value FROM index_state WHERE key='warnings'").get() as { value: string } | undefined)?.value
        const documentTotal = (db.prepare('SELECT COUNT(*) AS count FROM docs WHERE docs MATCH ?').get(expression) as { count: number }).count
        const value = { ...vulnerabilities, results: vulnerabilities.total ? vulnerabilities.results : results, documents: vulnerabilities.total ? results : [], documentTotal, nextDocumentOffset: (args.offset ?? 0) + rows.length < documentTotal ? (args.offset ?? 0) + rows.length : null, total: vulnerabilities.total || documentTotal, nextOffset: vulnerabilities.total ? vulnerabilities.nextOffset : (args.offset ?? 0) + rows.length < documentTotal ? (args.offset ?? 0) + rows.length : null, indexedSources: (db.prepare('SELECT COUNT(*) AS count FROM docs').get() as { count: number }).count, resources, indexWarnings: indexWarnings ? JSON.parse(indexWarnings) : [] }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      } finally { db.close() }
    } },
    { name: 'knowledge_match', label: 'knowledge_match', description: 'Actively check a CVE candidate with supplied component/version/vendor/cpe against the offline NVD version ranges. Legacy source-hash IDs compare template metadata. No scanning or vulnerability confirmation.', parameters: Type.Object({ id: Type.Optional(Type.String({ minLength: 1, maxLength: 64, pattern: '^(?:CVE-[0-9]{4}-[0-9]{4,}|[a-f0-9]{64})$' })), candidate_id: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), component: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), vendor: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), version: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), cpe: Type.Optional(Type.String({ maxLength: 4096 })), version_scheme: Type.Optional(Type.String({ maxLength: 32 })), protocol: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })), confirmed_prerequisites: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 })) }), executionMode: 'sequential', execute: async (_id: string, args: VulnerabilityQuery & { id?: string; candidate_id?: string; component?: string; version?: string; protocol?: string; confirmed_prerequisites?: string[] }) => {
      if (args.candidate_id || args.id?.startsWith('CVE-')) {
        const candidateId = args.candidate_id ?? args.id!
        const value = await vulnerabilitySearch(_evidenceRoot, context, { ...args, query: candidateId, candidate_id: candidateId, include_excluded: true, limit: 50 })
        const candidate = value.results.find(item => item.candidateId === candidateId)
        const details = candidate ?? { status: 'unknown', diagnostics: value.diagnostics, reason: 'Candidate not found in this offline generation' }
        return { content: [{ type: 'text', text: JSON.stringify(details) }], details }
      }
      if (!args.id) throw new Error('Provide id or candidate_id')
      const db = openIndex(repository, index, sources, wordlists, nucleiRoot)
      try {
        const source = await readVulnerability(context.config, args.id)
        const row = source ? { path: source.path, body: readFileSync(source.path, 'utf8') } : db.prepare('SELECT path,body FROM docs WHERE id=?').get(args.id) as { path: string; body: string } | undefined
        if (!row) throw new Error('Knowledge entry not found; search again after rebuilding the local index')
        const metadata = metadataFor(source ? source.path : sourceFile(repository,row.path,nucleiRoot),row.body,nucleiRoot)
        // shortcut: exact dotted versions only; add range parsing if local templates encode ranges.
        const checks = (['component', 'version', 'protocol'] as const).flatMap(field => {
          const expected = args[field]
          if (!expected) return []
          const actual = field === 'protocol' ? metadata.protocols.length ? metadata.protocols.join(', ') : undefined : metadata[field]
          const matches = field === 'protocol' ? metadata.protocols.length ? metadata.protocols.some(value => normalized(value) === normalized(expected)) : undefined : actual ? normalized(actual) === normalized(expected) : undefined
          return [{ field, expected, actual, matches }]
        })
        const required = ['component', 'version', 'protocol'] as const
        const knownMismatch = checks.some(check => check.matches === false), unknown = [...new Set([...checks.filter(check => check.matches === undefined).map(check => check.field), ...required.filter(field => !args[field])])]
        const confirmed = new Set((args.confirmed_prerequisites ?? []).map(normalized)), unconfirmedPrerequisites = metadata.prerequisites.filter(value => !confirmed.has(normalized(value)))
        const completeMatch = required.every(field => checks.some(check => check.field === field && check.matches === true))
        const status = knownMismatch ? 'not_applicable' : completeMatch && !unknown.length && !unconfirmedPrerequisites.length ? 'candidate' : 'unknown'
        const value = { id: args.id, path: row.path, status, checks, unconfirmedPrerequisites, unresolved: unknown, note: 'Candidate matching is not vulnerability evidence; manually validate template prerequisites and target response.' }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      } finally { db.close() }
    } },
    { name: 'knowledge_read', label: 'knowledge_read', description: 'Read at most 8 KiB of full NVD CVE details/configurations or a local source file. id accepts a CVE or the source hash from knowledge_search; offset/length paginate.', parameters: Type.Object({ id: Type.String({ minLength: 1, maxLength: 64, pattern: '^(?:CVE-[0-9]{4}-[0-9]{4,}|[a-f0-9]{64})$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })) }), executionMode: 'sequential', execute: async (_id: string, args: { id: string; offset?: number; length?: number }) => {
      const local = await readVulnerability(context.config, args.id, args.offset, args.length)
      if (local) return { content: [{ type: 'text', text: JSON.stringify(local) }], details: local }
      const db = openIndex(repository, index, sources, wordlists, nucleiRoot)
      try {
        const row = db.prepare('SELECT path,body FROM docs WHERE id=?').get(args.id) as { path: string; body: string } | undefined
        if (!row) throw new Error('Knowledge entry not found; search again after rebuilding the local index')
        if (!row.path.endsWith(' (catalog)') && digest(readFileSync(sourceFile(repository,row.path,nucleiRoot))) !== args.id) { db.prepare("DELETE FROM index_state WHERE key='updated'").run(); throw new Error('Knowledge source changed; search again to rebuild the index') }
        const body = Buffer.from(row.body), offset = args.offset ?? 0, length = args.length ?? 8192
        const value = { id: args.id, path: row.path, offset, totalBytes: body.length, text: body.subarray(offset, offset + length).toString('utf8'), nextOffset: offset + length < body.length ? offset + length : null }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      } finally { db.close() }
    } },
  ] as unknown as AgentTool[]
}
