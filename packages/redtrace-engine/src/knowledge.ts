import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Type } from 'typebox'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import type { TaskContext } from './scheduler.ts'

const digest = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const searchable = /\.(?:md|txt|rst|ya?ml|json)$/i
const excluded = /(?:^|[\\/])(?:\.git|node_modules|\.redtrace|write.?up|solution|answer|flag|secret|credential)(?:[\\/._-]|$)/i
const tokenize = (query: string) => [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])].slice(0, 16)

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
    const sourcePath = path.relative(repository, path.join(root, category))
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
        const relative=path.relative(root,file),body=readFileSync(file,'utf8'),hash=digest(body)
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
  const sources = ['skills', '.agents/skills', '.redtrace/skills', 'tools/poc/vulhub', 'tools/poc/vulhub/.claude/skills', 'tools/payloads/PayloadsAllTheThings'].map(item => path.join(repository, item)).filter(item => { try { return statSync(item).isDirectory() } catch { return false } })
  const wordlists = ['tools/wordlists/SecLists'].map(item => path.join(repository, item)).filter(item => { try { return statSync(item).isDirectory() } catch { return false } })
  const index = path.join(repository, '.redtrace', 'knowledge.sqlite')
  return [
    { name: 'knowledge_search', label: 'knowledge_search', description: 'Search only indexed local Skills, Vulhub notes and PayloadsAllTheThings. Returns at most 5 short source snippets. A match is not proof that a vulnerability applies.', parameters: Type.Object({ query: Type.String({ minLength: 2, maxLength: 300 }) }), executionMode: 'sequential', execute: async (_id: string, args: { query: string }) => {
      const terms = tokenize(args.query)
      if (!terms.length) return { content: [{ type: 'text', text: JSON.stringify({ results: [], reason: 'No searchable terms' }) }], details: { results: [] } }
      const db = openIndex(repository, index, sources, wordlists)
      try {
        const rows = db.prepare('SELECT id,path,body,substr(body,max(1,instr(lower(body),lower(?))-160),360) AS snippet FROM docs WHERE docs MATCH ? ORDER BY bm25(docs) LIMIT 5').all(terms[0], terms.map(term => `"${term.replaceAll('"', '""')}"`).join(' OR ')) as { id: string; path: string; body: string; snippet: string }[]
        const results = rows.map(row => ({ id: row.id, path: row.path, sha256: row.id, snippet: row.snippet, component: 'unknown', version: 'unknown', prerequisites: 'unknown' }))
        const value = { results, indexedSources: (db.prepare('SELECT COUNT(*) AS count FROM docs').get() as { count: number }).count }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      } finally { db.close() }
    } },
    { name: 'knowledge_read', label: 'knowledge_read', description: 'Read at most 8 KiB from a local knowledge result returned by knowledge_search.', parameters: Type.Object({ id: Type.String({ minLength: 64, maxLength: 64, pattern: '^[a-f0-9]{64}$' }), offset: Type.Optional(Type.Integer({ minimum: 0 })), length: Type.Optional(Type.Integer({ minimum: 1, maximum: 8192 })) }), executionMode: 'sequential', execute: async (_id: string, args: { id: string; offset?: number; length?: number }) => {
      const db = openIndex(repository, index, sources, wordlists)
      try {
        const row = db.prepare('SELECT path,body FROM docs WHERE id=?').get(args.id) as { path: string; body: string } | undefined
        if (!row) throw new Error('Knowledge entry not found; search again after rebuilding the local index')
        if (!row.path.endsWith(' (catalog)') && digest(readFileSync(path.join(repository,row.path))) !== args.id) { db.prepare("DELETE FROM index_state WHERE key='updated'").run(); throw new Error('Knowledge source changed; search again to rebuild the index') }
        const body = Buffer.from(row.body), offset = args.offset ?? 0, length = args.length ?? 8192
        const value = { id: args.id, path: row.path, offset, totalBytes: body.length, text: body.subarray(offset, offset + length).toString('utf8'), nextOffset: offset + length < body.length ? offset + length : null }
        return { content: [{ type: 'text', text: JSON.stringify(value) }], details: value }
      } finally { db.close() }
    } },
  ] as unknown as AgentTool[]
}
