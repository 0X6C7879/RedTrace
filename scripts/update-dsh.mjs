import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, readlink, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'

const repository = fileURLToPath(new URL('../', import.meta.url))
const ignored = new Set(['node_modules', 'lib', '.git', 'dist', 'bin'])
const json = async filename => JSON.parse(await readFile(filename, 'utf8'))
const save = (filename, value) => writeFile(filename, JSON.stringify(value, null, 2) + '\n')

export async function sourceDigest(root) {
  const hash = createHash('sha256')
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      if (ignored.has(entry.name) || entry.name.endsWith('.tsbuildinfo') || entry.name === 'upstream.json') continue
      const filename = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(filename)
      else if (entry.isSymbolicLink()) { hash.update(path.relative(root, filename).replaceAll('\\', '/')); hash.update('\0link\0'); hash.update(await readlink(filename)); hash.update('\0') }
      else if (entry.isFile()) { hash.update(path.relative(root, filename).replaceAll('\\', '/')); hash.update('\0'); hash.update(await readFile(filename)); hash.update('\0') }
    }
  }
  await walk(root)
  return hash.digest('hex')
}

export async function latestRelease() {
  // GitHub's /releases/latest excludes prereleases; DSH currently publishes RCs.
  const response = await fetch('https://api.github.com/repos/deepseek-ai/deepseek-harness/releases?per_page=30', { signal: AbortSignal.timeout(30000), headers: { Accept: 'application/vnd.github+json' } })
  if (!response.ok) throw new Error(`GitHub release check failed (${response.status})`)
  const release = (await response.json()).find(item => !item.draft && /^dsh-v\d+\.\d+\.\d+(?:-[a-z]+\.\d+)?$/.test(item.tag_name))
  if (!release) throw new Error('No DSH release found')
  return { version: release.tag_name.slice(5), tag: release.tag_name, url: release.html_url }
}

function run(command, args, cwd, env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: { ...process.env, ...env }, stdio: 'inherit', shell: process.platform === 'win32' && command.endsWith('.cmd'), timeout: 20 * 60 * 1000 })
    child.once('error', reject)
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`${command} failed (${signal ?? code})`)))
  })
}

// The vendored TypeScript parses the staged tsconfigs; a checkout that has not
// run `dsh:install` yet (the engine suite is checked before it in CI) falls back
// to the engine's own TypeScript, which parses the same config files.
function upstreamTypeScript() {
  const require = createRequire(import.meta.url)
  for (const candidate of [path.join(repository, 'vendor/deepseek-harness/node_modules/typescript'), path.join(repository, 'packages/redtrace-engine/node_modules/typescript')]) {
    if (existsSync(candidate)) return require(candidate)
  }
  try { return require('typescript') } catch { throw new Error('TypeScript runtime not found; run npm ci --prefix packages/redtrace-engine or npm run dsh:install') }
}

export async function prepareRuntime(source, destination) {
  await mkdir(destination, { recursive: true })
  for (const name of ['packages', 'vendor', 'native', 'patches']) await cp(path.join(source, name), path.join(destination, name), { recursive: true, verbatimSymlinks: true, filter: filename => !['tests', 'test', 'docs', '.agents', '.claude'].includes(path.basename(filename)) && !/^README(?:\.|$)/.test(path.basename(filename)) })
  await cp(path.join(source, 'scripts/types'), path.join(destination, 'scripts/types'), { recursive: true })
  await cp(path.join(source, 'scripts/client-build-environment.ts'), path.join(destination, 'scripts/client-build-environment.ts'))
  await cp(path.join(source, 'scripts/bundle-input-isolation.ts'), path.join(destination, 'scripts/bundle-input-isolation.ts'))
  await mkdir(path.join(destination, 'apps/cli'), { recursive: true })
  for (const name of ['package.json', 'config']) await cp(path.join(source, 'apps/cli', name), path.join(destination, 'apps/cli', name), { recursive: true })
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md', '.gitignore', '.gitattributes', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.base.client.json', 'tsconfig.json', 'tsconfig.host.json', 'tsconfig.client.json', 'tsdown.config.ts']) await cp(path.join(source, name), path.join(destination, name))
  const pkg = await json(path.join(source, 'package.json'))
  pkg.workspaces = pkg.workspaces.filter(value => value !== 'website')
  pkg.scripts = {
    'build:native-system': 'tsx native/system/scripts/build.ts --host-addon-only',
    'build:lib': 'pnpm run build:lib:host && pnpm run build:lib:client',
    'build:lib:host': 'node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.host.json && tsdown --env.DSH_BUILD_FACE host',
    'build:lib:client': 'tsc -b tsconfig.client.json && tsdown --env.DSH_BUILD_FACE client',
  }
  // Inspector's host build also compiles its DevTools assets with upstream's Vite.
  pkg.devDependencies = Object.fromEntries(['@types/js-yaml', '@types/node', 'lightningcss', 'smol-toml', 'tsdown', 'tsx', 'typescript', 'vite'].map(name => [name, pkg.devDependencies[name]]))
  await save(path.join(destination, 'package.json'), pkg)
  // RedTrace serves its own UI; the upstream Web frontend is not part of this runtime.
  const webApp = path.join(destination, 'packages/bundle/web-app/package.json')
  const webPackage = await json(webApp)
  delete webPackage.dependencies['@deepseek-ai/dsh-web-frontend']
  await save(webApp, webPackage)
  const workspace = path.join(destination, 'pnpm-workspace.yaml')
  await writeFile(workspace, (await readFile(workspace, 'utf8')).replace(/^  - (benchmarks|website|python\/sdk-runtime)\r?\n/gm, '').replace(/^  lefthook: true\r?\n/gm, '').replace(/^  ['"]?@(electron\/osx-sign|yao-pkg\/pkg)@[^\n]+\r?\n/gm, ''))
  for (const name of ['tsconfig.host.json', 'tsconfig.client.json']) {
    const ts = upstreamTypeScript()
    // TypeScript 5.x throws its own "Debug Failure" path assertion on Windows
    // instead of reporting a diagnostic, so any throw means the config did not parse.
    let parsed
    try { parsed = ts.readConfigFile(path.join(destination, name), filename => readFileSync(filename, 'utf8')) }
    catch (error) { throw new Error(`Invalid upstream ${name}: ${error.message}`) }
    if (parsed.error) throw new Error(`Invalid upstream ${name}`)
    const config = parsed.config
    config.references = config.references.filter(ref => !ref.path.startsWith('./apps/'))
    if (name === 'tsconfig.host.json') {
      for (const entry of await readdir(path.join(destination, 'packages/client'), { withFileTypes: true })) {
        const project = `./packages/client/${entry.name}/tsconfig.host.json`
        if (entry.isDirectory() && existsSync(path.join(destination, project)) && !config.references.some(ref => ref.path === project)) config.references.push({ path: project })
      }
    }
    config.include = []; config.files = []
    await save(path.join(destination, name), config)
  }
  const bundler = path.join(destination, 'tsdown.config.ts')
  await writeFile(bundler, (await readFile(bundler, 'utf8')).replace(/, 'apps\/[^']+'/g, ''))
  await run('git', ['apply', '--check', path.join(repository, 'scripts/dsh-local.patch')], destination)
  await run('git', ['apply', path.join(repository, 'scripts/dsh-local.patch')], destination)
}

export async function updateDsh({ root = repository, source, release = undefined } = {}) {
  const vendor = path.join(root, 'vendor/deepseek-harness'), cache = path.join(root, '.redtrace/dsh-updates')
  await mkdir(cache, { recursive: true })
  const lock = path.join(cache, 'lock')
  try { await mkdir(lock) } catch (error) { if (error.code === 'EEXIST') throw new Error('Another DSH update is running'); throw error }
  let work
  try {
    const current = await json(path.join(vendor, 'package.json'))
    release ??= await latestRelease()
    if (current.version === release.version) return { version: current.version, changed: false }
    const originalDigest = await sourceDigest(vendor)
    let recorded
    try { recorded = await json(path.join(vendor, 'upstream.json')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (recorded && recorded.digest !== originalDigest) throw new Error('DSH source has local changes; preserve them before updating')
    work = await mkdtemp(path.join(cache, 'update-'))
    if (!source) {
      console.log('Downloading ' + release.tag)
      const response = await fetch(`https://api.github.com/repos/deepseek-ai/deepseek-harness/tarball/${release.tag}`, { signal: AbortSignal.timeout(120000) })
      if (!response.ok) throw new Error(`DSH download failed (${response.status})`)
      const archive = path.join(work, 'upstream.tgz')
      await writeFile(archive, Buffer.from(await response.arrayBuffer()))
      source = path.join(work, 'source'); await mkdir(source)
      await run('tar', ['-xzf', archive, '-C', source, '--strip-components=1'], root)
    }
    if ((await json(path.join(source, 'package.json'))).version !== release.version) throw new Error('Downloaded version does not match the release')
    const stage = path.join(work, 'stage'), candidate = path.join(stage, 'vendor/deepseek-harness')
    console.log('Preparing runtime and applying RedTrace patches')
    await prepareRuntime(source, candidate)
    await cp(path.join(root, 'packages/redtrace-dsh'), path.join(stage, 'packages/redtrace-dsh'), { recursive: true, filter: filename => !['lib', 'node_modules'].includes(path.basename(filename)) })
    await cp(path.join(root, 'packages/redtrace-engine'), path.join(stage, 'packages/redtrace-engine'), { recursive: true, filter: filename => !['node_modules', 'test'].includes(path.basename(filename)) })
    await symlink(path.join(root, 'packages/redtrace-engine/node_modules'), path.join(stage, 'packages/redtrace-engine/node_modules'), 'junction')
    const pnpm = args => run(process.execPath, [path.join(root, 'scripts/dsh-pnpm.mjs'), ...args], candidate, { REDTRACE_DSH_ROOT: candidate })
    console.log('Installing dependencies')
    await pnpm(['install', '--no-frozen-lockfile'])
    console.log('Building DSH and RedTrace')
    await pnpm(['run', 'build:native-system'])
    await pnpm(['run', 'build:lib:host'])
    await run(process.execPath, [path.join(candidate, 'node_modules/typescript/bin/tsc'), '-p', path.join(stage, 'packages/redtrace-dsh/tsconfig.json')], stage)
    console.log('Checking runtime compatibility')
    await run(process.execPath, ['--test', ...((await readdir(path.join(stage, 'packages/redtrace-dsh/test'))).filter(name => name.endsWith('.test.mjs')).map(name => path.join(stage, 'packages/redtrace-dsh/test', name)))], root, { REDTRACE_SOURCE_ROOT: root, REDTRACE_CODE_ROOT: stage })
    await run(process.execPath, [path.join(root, 'scripts/check-dsh-runtime.mjs'), stage], root)
    await save(path.join(candidate, 'upstream.json'), { ...release, digest: await sourceDigest(candidate) })
    if (await sourceDigest(vendor) !== originalDigest) throw new Error('DSH source changed during the update; current version retained')
    console.log('Installing verified runtime; previous version retained in ' + work)
    const lib = path.join(root, 'packages/redtrace-dsh/lib'), previousLib = path.join(work, 'previous-lib')
    await rename(vendor, path.join(work, 'previous-dsh'))
    let installed = false, libSaved = false
    try {
      await rename(candidate, vendor); installed = true
      await rename(lib, previousLib); libSaved = true
      await rename(path.join(stage, 'packages/redtrace-dsh/lib'), lib)
    } catch (error) {
      if (libSaved) await rename(previousLib, lib)
      if (installed) await rename(vendor, candidate)
      await rename(path.join(work, 'previous-dsh'), vendor)
      throw error
    }
    return { version: release.version, changed: true, backup: path.relative(root, work) }
  } finally { await rm(lock, { recursive: true, force: true }) }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { root: { type: 'string' }, source: { type: 'string' }, version: { type: 'string' } } })
  try {
    const release = values.version ? { version: values.version, tag: 'dsh-v' + values.version, url: `https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v${values.version}` } : undefined
    console.log('DSH_UPDATE_RESULT ' + JSON.stringify(await updateDsh({ root: values.root, source: values.source, release })))
  } catch (error) { console.error(error.message); process.exitCode = 1 }
}
