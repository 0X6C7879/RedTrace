import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Type } from 'typebox'
import { parse as parseYaml } from 'yaml'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TaskContext } from './scheduler.ts'

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
      version: strings(metadata.version ?? metadata.versions)[0]?.slice(0, 100),
      protocols: Object.keys(template).filter(key => nucleiProtocols.has(key.toLowerCase())), tags: strings(info.tags).map(value => value.toLowerCase()),
      cves: [...cves].slice(0, 20), cwes: [...cwes].slice(0, 20), references: strings(info.reference ?? info.references).slice(0, 10).map(value => value.slice(0, 500)),
      prerequisites: strings(metadata.prerequisites ?? info.prerequisites).slice(0, 10).map(value => value.slice(0, 300)), fingerprintIndicators: fingerprintIndicators(template),
    }
  } catch { return { kind: 'nuclei-template', protocols: [], tags: [], cves: [], cwes: [], references: [], prerequisites: [], fingerprintIndicators: [], parseError: true } }
}
function sourcePath(file: string, repository: string, nucleiRoot: string) {
  const relative = path.relative(nucleiRoot, file)
  return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`) ? `${nucleiPathPrefix}${relative}` : path.relative(repository, file)
}
function sourceFile(repository: string, relative: string, nucleiRoot: string) {
  return relative.startsWith(nucleiPathPrefix) ? path.join(nucleiRoot, relative.slice(nucleiPathPrefix.length)) : path.join(repository, relative)
}
const normalized = (value: string) => value.trim().toLocaleLowerCase()
// Index keys and model-visible paths stay slash-separated on every platform.
const portable = (value: string) => value.split(path.sep).join('/')

function collect(root: string, output: string[], maximum = 10_000) {
  const pending = [root]
  let scanned = 0
  while (pending.length && output.length < maximum && scanned < maximum * 8) {
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
        if (output.length >= maximum) break
      }
    }
  }
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
  return [...counts].map(([category, value]) => {
    const sourcePath = portable(path.relative(repository, path.join(root, category)))
    const relative = `${sourcePath} (catalog)`
    return { relative, body: `SecLists category: ${sourcePath}; ${value.files} files; ${value.bytes} bytes; filenames and sizes only, wordlist content not indexed.` }
  })
}

function openIndex(root: string, filename: string, sources: string[], wordlists: string[]) {
  mkdirSync(path.dirname(filename), { recursive: true })
  const db = new DatabaseSync(filename)
  db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS index_state(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(id UNINDEXED,path UNINDEXED,body,tokenize='unicode61')")
  const state = db.prepare("SELECT value FROM index_state WHERE key='updated' ").get() as { value: string } | undefined
  if (!state || Date.now() - Number(state.value) > 60_000) {
    const files: string[] = []
    for (const source of sources) collect(source, files)
    const known = new Map((db.prepare('SELECT id,path FROM docs').all() as { id: string; path: string }[]).map(row => [row.path, row.id]))
    const remove = db.prepare('DELETE FROM docs WHERE path=?'), insert = db.prepare('INSERT INTO docs(id,path,body) VALUES (?,?,?)')
    db.exec('BEGIN')
    try {
      const current = new Map<string, { hash: string; body: string }>()
      for (const file of files) {
        const relative=portable(path.relative(root,file)),body=readFileSync(file,'utf8'),hash=digest(body)
        if (/\b(?:flag|tsecbench|htb)\{[^}\r\n]+\}/i.test(body)) continue
        current.set(relative, { hash, body })
      }
      for (const wordlist of wordlists) for (const item of collectWordlistCatalog(wordlist, root)) current.set(item.relative, { hash: digest(item.body), body: item.body })
      for (const [relative, item] of current) if (known.get(relative) !== item.hash) { if (known.has(relative)) remove.run(relative); insert.run(item.hash, relative, item.body) }
      for (const previous of known.keys()) if (!current.has(previous)) remove.run(previous)
      db.prepare("INSERT INTO index_state VALUES ('updated',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(Date.now()))
      db.exec('COMMIT')
    } catch (error) { db.exec('ROLLBACK'); db.close(); throw error }
  }
  return db
}

export function knowledgeTools(_evidenceRoot: string, context: TaskContext): AgentTool[] {
  const repository = context.config.workspaceRoot ? path.resolve(context.config.workspaceRoot, '..') : path.join(os.tmpdir(), 'redtrace-knowledge-test', context.run.projectId)
  const nucleiRoot = path.resolve(process.env.REDTRACE_NUCLEI_TEMPLATES_DIR ?? path.join(repository, 'tools', 'poc', 'nuclei-templates'))
  const sources = [...['skills', '.agents/skills', '.redtrace/skills', 'tools/poc/vulhub', 'tools/poc/vulhub/.claude/skills', 'tools/payloads/PayloadsAllTheThings'].map(item => path.join(repository, item)), nucleiRoot].filter((item, index, all) => all.indexOf(item) === index && (() => { try { return statSync(item).isDirectory() } catch { return false } })())
  const wordlists = ['tools/wordlists/SecLists'].map(item => path.join(repository, item)).filter(item => { try { return statSync(item).isDirectory() } catch { return false } })
  const index = path.join(repository, '.redtrace', 'knowledge.sqlite')
  return [
    { name: 'knowledge_search', label: 'knowledge_search', description: 'Search indexed local Skills, Vulhub, PayloadsAllTheThings and available local Nuclei CVE/fingerprint templates. Returns at most 5 candidates; a match is not proof a vulnerability applies.', parameters: Type.Object({ query: Type.String({ minLength: 2, maxLength: 300 }) }), executionMode: 'sequential', execute: async (_id: string, args: { query: string }) => {
      const terms = tokenize(args.query)
      if (!terms.length) return { content: [{ type: 'text', text: JSON.stringify({ results: [], reason: 'No searchable terms' }) }], details: { results: [] } }
      const db = openIndex(repository, index, sources, wordlists)
      try {
      const rows = db.prepare('SELECT id,path,body,substr(body,max(1,instr(lower(body),lower(?))-160),360) AS snippet FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT 5').all(terms[0], terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')) as { id: string; path: string; body: string; snippet: string }[]
      const results = rows.map(row => { const metadata = metadataFor(sourceFile(repository,row.path,nucleiRoot),row.body,nucleiRoot); return { id: row.id, path: row.path, sha256: row.id, snippet: row.snippet, kind: metadata.kind, templateId: metadata.templateId ?? null, name: metadata.name ?? null, severity: metadata.severity ?? 'unknown', vendor: metadata.vendor ?? 'unknown', component: metadata.component ?? 'unknown', version: metadata.version ?? 'unknown', protocols: metadata.protocols, tags: metadata.tags, cves: metadata.cves, cwes: metadata.cwes, references: metadata.references, prerequisites: metadata.prerequisites.length ? metadata.prerequisites : 'unknown', fingerprintIndicators: metadata.fingerprintIndicators, metadataParseError: metadata.parseError ?? false } })
        const value = { results, indexedSources: (db.prepare('SELECT COUNT(*) AS count FROM docs').get() as { count: number }).count }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      } finally { db.close() }
    } },
    { name: 'knowledge_match', label: 'knowledge_match', description: 'Compare a local template candidate with supplied confirmed component, exact version and protocol facts. Returns candidate/not_applicable/unknown only; never confirms a vulnerability or runs a template.', parameters: Type.Object({ id: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }), component: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })), version: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })), protocol: Type.Optional(Type.String({ minLength: 1, maxLength: 32 })), confirmed_prerequisites: Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10 })) }), executionMode: 'sequential', execute: async (_id: string, args: { id: string; component?: string; version?: string; protocol?: string; confirmed_prerequisites?: string[] }) => {
      const db = openIndex(repository, index, sources, wordlists)
      try {
        const row = db.prepare('SELECT path,body FROM docs WHERE id=?').get(args.id) as { path: string; body: string } | undefined
        if (!row) throw new Error('Knowledge entry not found; search again after rebuilding the local index')
        const metadata = metadataFor(sourceFile(repository,row.path,nucleiRoot),row.body,nucleiRoot)
        const checks = (['component', 'version', 'protocol'] as const).flatMap(field => args[field] ? [{ field, expected: args[field]!, actual: field === 'protocol' ? metadata.protocols.find(value => normalized(value) === normalized(args[field]!)) ?? (metadata.protocols.length ? metadata.protocols.join(', ') : undefined) : metadata[field], matches: field === 'protocol' ? metadata.protocols.some(value => normalized(value) === normalized(args[field]!)) : metadata[field] ? normalized(metadata[field]!) === normalized(args[field]!) : undefined }] : [])
        const knownMismatch = checks.some(check => check.matches === false), unknown = checks.filter(check => check.matches === undefined).map(check => check.field)
        const confirmed = new Set((args.confirmed_prerequisites ?? []).map(normalized)), unconfirmedPrerequisites = metadata.prerequisites.filter(value => !confirmed.has(normalized(value)))
        const hasMatch = checks.some(check => check.matches === true)
        const status = knownMismatch ? 'not_applicable' : hasMatch && !unknown.length && !unconfirmedPrerequisites.length ? 'candidate' : 'unknown'
        const value = { id: args.id, path: row.path, status, checks, unconfirmedPrerequisites, unresolved: [...unknown, ...(metadata.version ? [] : ['version']), ...(metadata.component ? [] : ['component'])], note: 'Candidate matching is not vulnerability evidence; manually validate template prerequisites and target response.' }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      } finally { db.close() }
    } },
    { name: 'knowledge_read', label: 'knowledge_read', description: 'Read at most 8 KiB from a local knowledge result returned by knowledge_search.', parameters: Type.Object({ id: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })) }), executionMode: 'sequential', execute: async (_id: string, args: { id: string; offset?: number; length?: number }) => {
      const db = openIndex(repository, index, sources, wordlists)
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
