import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { Capabilities } from '../src/capabilities.ts'
import { serveEngine } from '../src/index.ts'

const content = (text: string) => `---\nname: sample\ndescription: Test helper\n---\n${text}\n`
test('capabilities keep independent copies, nested entries, revisions and MCP configurations', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-capabilities-'))
  mkdirSync(path.join(root, 'skills/sample'), { recursive: true }); writeFileSync(path.join(root, 'skills/sample/SKILL.md'), content('original'))
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const request = async (route: string, method = 'GET', data?: unknown) => {
    const response = await fetch(url + route, { method, ...(data === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) })
    return { status: response.status, data: response.status === 204 ? null : await response.json() as any }
  }
  try {
    const c = engine.capabilities, first = c.skill('sample')
    const second = c.write('sample', content('edited'), true, first.revision)
    assert.equal(readFileSync(path.join(root, 'skills/sample/SKILL.md'), 'utf8'), content('original'))
    assert.throws(() => c.write('sample', content('stale'), true, first.revision), /revision conflict/)
    assert.equal(second.version, 2)
    mkdirSync(path.join(c.directory('sample'), 'modules/deep'), { recursive: true }); writeFileSync(path.join(c.directory('sample'), 'modules/deep/SKILL.md'), '---\nname: nested\ndescription: Nested helper\n---\nNested text')
    assert.equal((await request('/capabilities/skills/sample/entries/modules/deep/SKILL.md')).data.name, 'nested')
    assert.equal((await request('/capabilities/skills/sample/enabled', 'PATCH', { enabled: false, expected_revision: second.revision })).status, 200)
    assert.equal((await request('/capabilities/skills/sample/rollback/1', 'POST', { expected_revision: c.skill('sample').revision })).data.content, content('original'))
    const created = await request('/capabilities/mcp', 'POST', { name: 'echo', config: { agents: { dsh: { command: process.execPath, args: ['echo.mjs'] } } } })
    assert.equal(created.status, 201); assert.equal(c.mcpConfigs()[0].command, process.execPath)
    assert.equal((await request('/capabilities/mcp/echo/enabled', 'PATCH', { enabled: false })).status, 200); assert.equal(c.mcpConfigs().length, 0)
    assert.equal((await request('/capabilities/mcp/echo', 'DELETE')).status, 204)
    assert.equal((await request('/capabilities/mcp', 'POST', { name: 'broken', config: {} })).status, 400)
    const restored = new Capabilities(c.root); restored.initialize(root)
    assert.equal(restored.skill('sample').version, 4)
  } finally { await engine.close(); rmSync(root, { recursive: true, force: true }) }
})
