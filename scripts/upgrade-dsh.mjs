/**
 * DSH upstream upgrade helper.
 *
 * Compares the pinned harness revision (scripts/check-dsh-revision.mjs) with
 * the upstream default branch. `--check` only reports drift (used by CI);
 * without it the submodule pointer and the pin are updated on disk so a
 * caller (the scheduled upgrade workflow) can commit them into an upgrade
 * PR. The upgrade PR then flows through the regular three-platform
 * `dsh-mainline` CI before merge — production never tracks `latest`.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const UPSTREAM_URL = 'https://github.com/deepseek-ai/deepseek-harness.git'
const UPSTREAM_BRANCH = process.env.DSH_UPSTREAM_BRANCH ?? 'master'
const CHECK_ONLY = process.argv.includes('--check')

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const harnessDir = resolve(root, 'vendor/deepseek-harness')
const pinPath = resolve(root, 'scripts/check-dsh-revision.mjs')

function git(args, cwd) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

const pinSource = readFileSync(pinPath, 'utf8')
const pinned = pinSource.match(/const expected = '([0-9a-f]{40})'/)?.[1]
if (pinned === undefined) throw new Error('cannot read the pinned DSH revision')

const upstream = git(['ls-remote', UPSTREAM_URL, `refs/heads/${UPSTREAM_BRANCH}`]).split('\t')[0]
if (upstream === pinned) {
  console.log(`DSH revision ${pinned.slice(0, 10)} matches upstream ${UPSTREAM_BRANCH}`)
  process.exit(0)
}

if (CHECK_ONLY) {
  console.log(`DSH upgrade available: ${pinned.slice(0, 10)} -> ${upstream.slice(0, 10)}`)
  process.exit(1)
}

console.log(`upgrading DSH: ${pinned.slice(0, 10)} -> ${upstream.slice(0, 10)}`)
git(['fetch', 'origin', upstream], harnessDir)
git(['checkout', '--detach', upstream], harnessDir)
writeFileSync(pinPath, pinSource.replace(pinned, upstream))
console.log(`pin updated to ${upstream}`)
