import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../../redtrace-engine/src/store.ts'
import { JevService } from '../../redtrace-engine/src/jev.ts'
import { verbToolAvailable } from '../../redtrace-engine/src/capability-verbs.ts'
import { filterDshJevResult, mountJevPrompt, rankDshWebResult, refreshToolRegistrations } from '../../redtrace-engine/compat/cordis.mjs'

test('live Jev toggle removes guidance and tools from the same DSH session', () => {
  const sections = [], registered = new Set(), scenes = new Set(['candidate_choice', 'attack_readiness'])
  const jev = { isEnabled: scene => scenes.has(scene) }
  mountJevPrompt({ systemPrompt: { section: value => sections.push(value) } }, { activity: 'execute' }, undefined, jev)
  const refresh = refreshToolRegistrations([{ name: 'jev_choose' }, { name: 'jev_assess_attack' }],
    tool => jev.isEnabled(tool.name === 'jev_choose' ? 'candidate_choice' : 'attack_readiness'), tool => {
    registered.add(tool.name); return () => registered.delete(tool.name)
  })
  const prompt = () => sections.map(section => section.text()).join('\n')
  refresh()
  assert.match(prompt(), /jev_choose/)
  assert.deepEqual([...registered], ['jev_choose', 'jev_assess_attack'])
  scenes.clear(); refresh()
  assert.doesNotMatch(prompt(), /Jev|jev_/)
  assert.deepEqual([...registered], [])
  scenes.add('candidate_choice'); refresh()
  assert.match(prompt(), /jev_choose/)
  assert.deepEqual([...registered], ['jev_choose'])
})

test('channel plugin toggle updates live remote tool registrations', () => {
  const enabled = new Set(['redtrace-webshell']), visible = new Set()
  const runtime = { isAdapterAvailable: id => enabled.has(id) }
  const refresh = refreshToolRegistrations([{ name: 'remote_command' }, { name: 'remote_task' }],
    tool => verbToolAvailable(runtime, tool.name), tool => { visible.add(tool.name); return () => visible.delete(tool.name) })
  refresh()
  assert.deepEqual([...visible], ['remote_command', 'remote_task'])
  enabled.clear(); refresh()
  assert.deepEqual([...visible], ['remote_task'])
  enabled.add('redtrace-c2'); refresh()
  assert.deepEqual([...visible].sort(), ['remote_command', 'remote_task'])
})

test('DSH web result appends a candidate suggestion without removing sources', async () => {
  const calls = []
  const jev = { isEnabled: scene => scene === 'candidate_choice', chooseCandidate: async (...args) => {
    calls.push(args); return { status: 'advisory', recommendedId: 'source_2', confidence: 0.8 }
  } }
  const result = { value: { sources: [{ url: 'https://example.test/a', title: 'A' }, { url: 'https://example.test/b', title: 'B' }] },
    content: [{ type: 'text', text: 'Original result with both sources' }] }
  const decision = { kind: 'accept' }
  const ranked = await rankDshWebResult(jev, { id: 'run' }, { name: 'web_search', arguments: { queries: ['endpoint'] } }, result, decision)
  assert.equal(ranked.content[0].text, result.content[0].text)
  assert.match(ranked.content[1].text, /source_2/)
  assert.equal(calls[0][2], 'endpoint')
  assert.deepEqual(await rankDshWebResult({ ...jev, isEnabled: () => false }, {}, { name: 'web_search' }, result, decision), decision)
})

test('DSH Web results have exact recovery files and recovery reads bypass Jev', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-dsh-jev-')), store = new Store(':memory:')
  const previousKey = process.env.TYPESAFE_API_KEY
  try {
    process.env.TYPESAFE_API_KEY = 'test-key'
    const { project } = store.createProject({ title: 'Web result', origin: 'Scope', goal: 'Inspect source' })
    const step = store.addStep(project.id, { description: 'Inspect the relevant Web result', sourceIds: ['origin'] })
    const run = store.claim(project.id, 'execute', { name: 'test', backend: 'dsh' }, step.id)
    const cwd = path.join(root, project.id)
    mkdirSync(cwd, { recursive: true })
    let calls = 0
    const jev = new JevService(store, root, async (_url, init) => {
      calls++
      const request = JSON.parse(String(init.body)), criteria = Object.keys(request.questions.relevant.criteria)
      const choice = criteria.find(item => item.startsWith('c')) ?? 'none'
      return Response.json({ model: 'jev-1.13.0', answers: {
        relevant: { type: 'choice', choice, confidence: 0.99, probabilities: Object.fromEntries(criteria.map(item => [item, Number(item === choice)])) },
        instruction_injection: { type: 'noul', noul: 0.1 },
      }, usage: { input_tokens: 120 } })
    })
    jev.setScenes({ tool_filter: true, external_filter: true }); jev.setEnabled(true)
    const text = Array.from({ length: 120 }, (_, index) => `Result ${index}: ${'relevant source text '.repeat(12)}`).join('\n')
    const decision = { kind: 'accept' }, result = { content: [{ type: 'text', text }] }
    const search = await filterDshJevResult(jev, run, cwd, { name: 'web_search', arguments: JSON.stringify({ queries: ['marker search'] }) }, result, decision)
    assert.match(search.content[0].text, /Jev excerpt from marker search/)
    const recovery = search.content[0].text.match(/Exact original: ([^\s]+)\. Omitted lines:/)?.[1]
    assert.ok(recovery)
    assert.equal(readFileSync(path.join(cwd, recovery), 'utf8'), text)
    const read = await filterDshJevResult(jev, run, cwd, { name: 'read', arguments: JSON.stringify({ file_path: recovery }) }, result, decision)
    assert.equal(read, decision)
    assert.equal(calls, 1)
    const fetch = await filterDshJevResult(jev, run, cwd, { name: 'web_fetch', arguments: JSON.stringify({ url: 'https://example.test/source' }) }, result, decision)
    assert.match(fetch.content[0].text, /Jev excerpt from https:\/\/example\.test\/source/)
    assert.equal(calls, 2)
    jev.close()
  } finally {
    if (previousKey === undefined) delete process.env.TYPESAFE_API_KEY
    else process.env.TYPESAFE_API_KEY = previousKey
    store.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('DSH long local text tools share the filter entry', async () => {
  const seen = []
  const jev = { isEnabled: () => true, filterToolText: async (_run, source, text, external) => {
    seen.push({ source, text, external }); return 'short excerpt'
  } }
  const decision = { kind: 'accept' }, result = { content: [{ type: 'text', text: 'line\n'.repeat(2000) }] }
  for (const [name, args] of [
    ['bash', { command: 'cat long.txt' }], ['grep', { pattern: 'marker' }], ['terminal_read', { id: 'session-1' }],
  ]) {
    const filtered = await filterDshJevResult(jev, { id: 'run' }, '/tmp', { name, arguments: args }, result, decision)
    assert.equal(filtered.content[0].text, 'short excerpt')
  }
  assert.deepEqual(seen.map(item => item.source), ['cat long.txt', 'marker', 'session-1'])
  assert.ok(seen.every(item => item.external === false && item.text === result.content[0].text))
  assert.equal(await filterDshJevResult(jev, { id: 'run' }, '/tmp', { name: 'bash', arguments: {} }, { ...result, isError: true }, decision), decision)
})
