import assert from 'node:assert/strict'
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { createSkillView } from '../lib/capability.js'

function catalog(skills) {
  return {
    skills,
    capabilities: ['web'],
    diagnostics: [],
  }
}

async function prepareRoot() {
  const root = await mkdtemp(path.join(tmpdir(), 'redtrace-skill-view-'))
  const skillsRoot = path.join(root, 'skills')
  for (const name of ['alpha', 'beta', 'gamma']) {
    const dir = path.join(skillsRoot, name)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\n---\n\n# ${name}\n`)
  }
  const config = { root, skillsDir: 'skills' }
  return { root, skillsRoot, config }
}

async function tmpLeftovers(parent) {
  const entries = await readdir(parent)
  return entries.filter(name => name.startsWith('.tmp-'))
}

test('createSkillView links every catalog Skill to the project-root source', async () => {
  const { root, skillsRoot, config } = await prepareRoot()
  try {
    const view = await createSkillView(config, 'rt-proj_001-explore-abc', catalog(['alpha', 'beta']))
    assert.equal(view.directory, path.join(root, '.redtrace', 'runtime', 'skill-views', 'rt-proj_001-explore-abc'))
    assert.deepEqual((await readdir(view.directory)).sort(), ['alpha', 'beta'])
    for (const name of ['alpha', 'beta']) {
      const entry = lstat(path.join(view.directory, name))
      assert.equal((await entry).isSymbolicLink(), true, name)
      assert.equal(
        await realpath(path.join(view.directory, name)),
        await realpath(path.join(skillsRoot, name)),
      )
    }
    // Content is reachable through the link and sourced from the root copy.
    const through = await readFile(path.join(view.directory, 'alpha', 'SKILL.md'), 'utf8')
    assert.equal(through, await readFile(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'))
    assert.equal(await readFile(path.join(skillsRoot, 'alpha', 'SKILL.md'), 'utf8'), '---\nname: alpha\n---\n\n# alpha\n')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('concurrent sessions with different catalogs stay isolated', async () => {
  const { root, config } = await prepareRoot()
  try {
    const web = await createSkillView(config, 'rt-proj_001-explore-web', catalog(['alpha']))
    const ad = await createSkillView(config, 'rt-proj_001-explore-ad', catalog(['beta', 'gamma']))
    assert.deepEqual((await readdir(web.directory)).sort(), ['alpha'])
    assert.deepEqual((await readdir(ad.directory)).sort(), ['beta', 'gamma'])

    // A Web session finishing must not disturb the still-running AD session.
    await web.cleanup()
    await assert.rejects(readdir(web.directory))
    assert.deepEqual((await readdir(ad.directory)).sort(), ['beta', 'gamma'])
    // The canonical skills root is never touched by view lifecycle.
    assert.deepEqual((await readdir(path.join(root, 'skills'))).sort(), ['alpha', 'beta', 'gamma'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('cleanup removes only its own derived view', async () => {
  const { root, config } = await prepareRoot()
  try {
    const view = await createSkillView(config, 'rt-proj_001-explore-one', catalog(['alpha']))
    await view.cleanup()
    const parent = path.join(root, '.redtrace', 'runtime', 'skill-views')
    await assert.rejects(readdir(view.directory))
    assert.deepEqual(await tmpLeftovers(parent), [])
    assert.deepEqual((await readdir(path.join(root, 'skills'))).sort(), ['alpha', 'beta', 'gamma'])
    // A second cleanup of the same session stays a no-op.
    await view.cleanup()
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('recreating a session view replaces it without leftovers', async () => {
  const { root, config } = await prepareRoot()
  try {
    const first = await createSkillView(config, 'rt-proj_001-explore-swap', catalog(['alpha']))
    assert.deepEqual((await readdir(first.directory)).sort(), ['alpha'])
    const second = await createSkillView(config, 'rt-proj_001-explore-swap', catalog(['beta', 'gamma']))
    assert.equal(second.directory, first.directory)
    assert.deepEqual((await readdir(second.directory)).sort(), ['beta', 'gamma'])
    const parent = path.join(root, '.redtrace', 'runtime', 'skill-views')
    assert.deepEqual(await tmpLeftovers(parent), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a failing creation rolls back and keeps the previous view', async () => {
  const { root, config } = await prepareRoot()
  try {
    const existing = await createSkillView(config, 'rt-proj_001-explore-keep', catalog(['alpha']))
    await assert.rejects(
      createSkillView(config, 'rt-proj_001-explore-keep', catalog(['alpha', 'missing-skill'])),
      /Skill source is missing|ENOENT/,
    )
    const parent = path.join(root, '.redtrace', 'runtime', 'skill-views')
    assert.deepEqual(await tmpLeftovers(parent), [])
    // The previously created view was not clobbered by the failed attempt.
    assert.deepEqual((await readdir(existing.directory)).sort(), ['alpha'])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('skill names that would escape the root are rejected', async () => {
  const { root, config } = await prepareRoot()
  try {
    await assert.rejects(
      createSkillView(config, 'rt-proj_001-explore-escape', catalog(['../skills/alpha'])),
      /invalid resolved Skill name/,
    )
    const parent = path.join(root, '.redtrace', 'runtime', 'skill-views')
    assert.deepEqual(await tmpLeftovers(parent), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
