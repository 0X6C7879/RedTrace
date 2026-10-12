#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFileSync, existsSync, realpathSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [command, ...values] = process.argv.slice(2), options = {}
for (let index = 0; index < values.length; index++) {
  const key = values[index]
  if (!key.startsWith('--')) throw new Error(`Unexpected argument: ${key}`)
  options[key.slice(2)] = values[index + 1]?.startsWith('--') || index + 1 === values.length ? true : values[++index]
}
const data = path.resolve(String(options.root ?? process.env.REDTRACE_DATA_DIR ?? path.join(root, '.redtrace/data/knowledge')))
function current() {
  const manifest = JSON.parse(readFileSync(path.join(data, 'current.json'), 'utf8'))
  if (!/^[A-Za-z0-9_-]+$/.test(manifest.generation)) throw new Error('Invalid generation')
  return { manifest, generation: path.join(data, 'generations', manifest.generation) }
}
try {
  if (command === 'status') {
    const { manifest, generation } = current(), file = path.join(generation, 'vuln.sqlite')
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      const check = db.prepare('PRAGMA quick_check').get()
      if (Object.values(check)[0] !== 'ok') throw new Error('SQLite quick_check failed')
      const missing = ['nuclei-templates', 'exploitdb', 'nvd'].filter(name => !existsSync(path.join(generation, name)))
      console.log(JSON.stringify({ ...manifest, database: file, missing, networkPolicy: 'local-only; no acquisition path', note: 'status performs local checks only' }))
      if (missing.length || manifest.partial) process.exitCode = 1
    } finally { db.close() }
  } else if (command === 'rollback') {
    const selected = String(options.generation ?? '')
    if (!/^[A-Za-z0-9_-]+$/.test(selected)) throw new Error('rollback requires --generation')
    const manifest = readFileSync(path.join(data, 'generations', selected, 'manifest.json'), 'utf8')
    JSON.parse(manifest); const temporary = path.join(data, '.current-rollback')
    writeFileSync(temporary, manifest)
    const { renameSync } = await import('node:fs'); renameSync(temporary, path.join(data, 'current.json'))
    console.log(JSON.stringify({ restored: selected }))
  } else if (command === 'export') {
    const { generation } = current()
    if (!options.output) throw new Error('export requires --output')
    const result = spawnSync('tar', ['-czf', path.resolve(String(options.output)), '-C', data, 'current.json', 'generations/' + path.basename(generation)], { stdio: 'inherit' })
    if (result.error || result.status) throw result.error ?? new Error('Offline package export failed')
    console.log(JSON.stringify({ output: path.resolve(String(options.output)) }))
  } else throw new Error('Commands: status, export, rollback. Explicit local build/import: tools/knowledge/knowledge.py build. Online acquisition: install-knowledge.sh --online.')
} catch (error) { console.error(JSON.stringify({ error: String(error), noOnlineFallback: true })); process.exitCode = 1 }
