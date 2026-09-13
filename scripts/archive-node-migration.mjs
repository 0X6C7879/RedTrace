import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, backup } from 'node:sqlite'

const root = process.cwd()
const destination = path.join(root, '.redtrace', 'migration', new Date().toISOString().replaceAll(/[:.]/g, '-'))
await mkdir(destination, { recursive: true })
const git = (...args) => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
await writeFile(path.join(destination, 'head.txt'), git('rev-parse', 'HEAD'))
await writeFile(path.join(destination, 'status.txt'), git('status', '--short', '--branch'))
await writeFile(path.join(destination, 'working.patch'), git('diff', '--binary'))
await writeFile(path.join(destination, 'staged.patch'), git('diff', '--cached', '--binary'))
git('archive', '--format=zip', `--output=${path.join(destination, 'source.zip')}`, 'HEAD')
for (const relative of git('ls-files', '--others', '--exclude-standard', '-z').toString().split('\0').filter(Boolean)) {
  const target = path.resolve(destination, 'untracked', relative)
  if (!target.startsWith(path.join(destination, 'untracked') + path.sep)) throw new Error('Invalid archive path')
  await mkdir(path.dirname(target), { recursive: true })
  await copyFile(path.join(root, relative), target)
}
const source = path.join(root, '.redtrace', 'redtrace.db')
if (existsSync(source)) {
  const db = new DatabaseSync(source, { readOnly: true })
  try { await backup(db, path.join(destination, 'redtrace.db')) } finally { db.close() }
}
// Configuration copies remain inside the ignored, private migration directory.
for (const relative of ['redtrace.yaml', '.redtrace/dsh/settings.yaml', '.redtrace/dsh/plugins.json']) {
  if (!existsSync(path.join(root, relative))) continue
  await writeFile(path.join(destination, relative.replaceAll(/[\\/]/g, '_')), await readFile(path.join(root, relative)), { mode: 0o600 })
}
await writeFile(path.join(destination, 'README.txt'), 'Consistent legacy database and source snapshot. Workspaces and secret-store keys remain in their original locations. Never run both versions against the same database.\n')
console.log(destination)
