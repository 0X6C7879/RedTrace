import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { cleanupSessionArtifacts } from '../lib/audit.js'

test('removes only located session artifacts for deleted projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'redtrace-session-cleanup-'))
  const session = path.join(root, 'project', 'rt-project-explore-test')
  const artifact = path.join(session, 'session.jsonl')
  const keep = path.join(root, 'other', 'keep.txt')
  await mkdir(session, { recursive: true })
  await mkdir(path.dirname(keep), { recursive: true })
  await writeFile(artifact, '{}\n')
  await writeFile(keep, 'keep')
  try {
    await cleanupSessionArtifacts(root, [{ session_id: 'rt-project-explore-test' }], {
      supportsRawArtifacts: true,
      async readRaw(id) { return { meta: { id } } },
      locate() { return { path: artifact } },
    })
    await assert.rejects(readFile(artifact))
    assert.equal(await readFile(keep, 'utf8'), 'keep')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
