import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

const shimDir = mkdtempSync(join(tmpdir(), 'redtrace-corepack-'))
writeFileSync(join(shimDir, 'pnpm'), '#!/bin/sh\nexec corepack pnpm@11.7.0 "$@"\n')
chmodSync(join(shimDir, 'pnpm'), 0o755)
writeFileSync(join(shimDir, 'pnpm.cmd'), '@echo off\r\ncorepack pnpm@11.7.0 %*\r\n')

let result
try {
  result = spawnSync(
    'corepack',
    ['pnpm@11.7.0', '--dir', 'vendor/deepseek-harness', ...process.argv.slice(2)],
    {
      cwd: new URL('..', import.meta.url),
      env: {
        ...process.env,
        CI: 'true',
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
