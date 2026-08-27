import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const shimDir = mkdtempSync(join(tmpdir(), 'redtrace-corepack-'))
writeFileSync(join(shimDir, 'pnpm'), '#!/bin/sh\nexec corepack pnpm@11.7.0 "$@"\n')
chmodSync(join(shimDir, 'pnpm'), 0o755)
writeFileSync(join(shimDir, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm@11.7.0 %*\r\n')

let result
try {
  const repositoryRoot = new URL('..', import.meta.url)
  const dshRoot = process.env.REDTRACE_DSH_ROOT
    ? resolve(process.env.REDTRACE_DSH_ROOT)
    : resolve(fileURLToPath(new URL('vendor/deepseek-harness', repositoryRoot)))
  const command = process.argv[2]
  const pnpmOptions = command === 'install' ? [] : ['--config.frozen-lockfile=false']
  result = spawnSync(
    'corepack',
    ['pnpm@11.7.0', ...pnpmOptions, '--dir', dshRoot, ...process.argv.slice(2)],
    {
      cwd: dshRoot,
      env: {
        ...process.env,
        CI: 'true',
        ...(command === 'install'
          ? {}
          : { PNPM_CONFIG_FROZEN_LOCKFILE: 'false', npm_config_frozen_lockfile: 'false' }),
        PATH: `${shimDir}${delimiter}${process.env.PATH ?? ''}`,
      },
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  )
} finally {
  rmSync(shimDir, { recursive: true, force: true })
}

if (result.error) throw result.error
process.exit(result.status ?? 1)
