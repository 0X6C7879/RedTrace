import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { serveEngine } from '../src/index.ts'
import { dispatchVerb, verbTask, verbTools, verbToolAvailable, channelsFor, resourceTools, VerbDispatchError } from '../src/capability-verbs.ts'
import { fixtureFrame, fixtureAuthorize } from './execution-fixture.ts'
import type { VerbRuntime } from '../src/capability-verbs.ts'

test('verb registry: channel reuse, selection rules, approval gating and Step requires round-trip', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-verbs-'))
  const wire: string[] = []
  const remote = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const form = new URLSearchParams(body); wire.push(form.get('cmd') ?? '')
      res.end(fixtureFrame(form.get('cmd') ?? '', /RT_[a-f0-9]+/.exec(form.get('cmd') ?? '')?.[0] ?? 'verb fixture output'))
    })
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const remotePort = (remote.address() as { port: number }).port
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  const url = `http://127.0.0.1:${(engine.server.address() as { port: number }).port}`
  const runtime: VerbRuntime = { operations: engine.operations }
  const context = { projectId: '', worker: 'worker-1', stepId: null, signal: new AbortController().signal }
  const request = async (route: string, method = 'GET', b?: unknown) => {
    const res = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json' }, ...(b === undefined ? {} : { body: JSON.stringify(b) }) })
    return { status: res.status, data: await res.json() as any }
  }
  try {
    const { project } = engine.store.createProject({ title: 'Verbs', origin: 'Fixture', goal: 'Verify verb dispatch' })
    context.projectId = project.id

    // Registry route: every verb lists its adapters; stubs are unavailable.
    const verbs = await request('/capabilities/verbs')
    assert.equal(verbs.status, 200)
    const remoteCommand = verbs.data.verbs.find((v: any) => v.id === 'remote.command')
    assert.deepEqual(remoteCommand.adapters, ['webshell', 'c2'])
    assert.deepEqual(verbs.data.verbs.find((v: any) => v.id === 'remote.file.upload').adapters, ['ssh-sftp'])
    assert.deepEqual(verbs.data.verbs.find((v: any) => v.id === 'remote.file.download').adapters, ['ssh-sftp'])
    assert.equal(remoteCommand.available, true)
    assert.equal(verbs.data.verbs.find((v: any) => v.id === 'web.request'), undefined)
    assert.equal(verbs.data.adapters.find((a: any) => a.id === 'browser'), undefined)
    assert.equal(verbs.data.adapters.find((a: any) => a.id === 'webshell').plugin_id, 'redtrace-webshell')
    assert.equal(verbs.data.verbs.find((v: any) => v.id === 'pivot.socks').available, true)
    assert.equal(verbs.data.verbs.find((v: any) => v.id === 'remote.terminal.open').available, true)

    // No channel: the dispatch error carries establishment guidance, no guess.
    await assert.rejects(dispatchVerb(runtime, 'remote.command', { command: 'id' }, context), (error: unknown) => {
      assert.ok(error instanceof VerbDispatchError)
      assert.equal(error.hint.available.length, 0)
      assert.ok(error.hint.establish.some(hint => hint.includes('webshell')))
      return true
    })

    // One channel: auto-selected without target or via.
    const shellA = engine.operations.create(project.id, { kind: 'webshell', name: 'Shell A', target: `http://127.0.0.1:${remotePort}`, metadata: { command_param: 'cmd', protocol: 'raw', verified_capabilities: ['remote.command', 'remote.file.delete'] }, actor_type: 'human', actor: 'test' }).resource
    fixtureAuthorize(engine.operations, project.id, shellA.id, ['command'])
    const falseSftp = engine.operations.create(project.id, { kind: 'c2_session', name: 'non-SSH C2', target: 'fixture', status: 'available', metadata: { connection_type: 'beacon', verified_capabilities: ['remote.file.upload'] }, actor_type: 'human', actor: 'test' }).resource
    fixtureAuthorize(engine.operations, project.id, falseSftp.id, ['upload_file'])
    await assert.rejects(dispatchVerb(runtime, 'remote.file.upload', { artifact_id: 'missing', path: '/tmp/file', via: falseSftp.id }, context), /不在可用通道列表/)
    const first = await dispatchVerb(runtime, 'remote.command', { command: 'echo one' }, context)
    assert.equal(first.status, 'succeeded')
    assert.equal(first.channel.resource_id, shellA.id)
    assert.equal(first.output, 'verb fixture output')
    assert.match(wire.at(-1)!, /echo one/)

    // Target matching picks the channel whose host matches.
    const shellB = engine.operations.create(project.id, { kind: 'webshell', name: 'Shell B', target: `http://localhost:${remotePort}/shell-b.php`, metadata: { command_param: 'cmd', protocol: 'raw', verified_capabilities: ['remote.command', 'remote.file.delete'] }, actor_type: 'human', actor: 'test' }).resource
    fixtureAuthorize(engine.operations, project.id, shellB.id, ['command'])
    wire.length = 0
    const matched = await dispatchVerb(runtime, 'remote.command', { command: 'echo two', target: 'http://localhost' }, context)
    assert.equal(matched.channel.resource_id, shellB.id)
    await assert.rejects(dispatchVerb(runtime, 'remote.command', { command: 'id', target: 'http://10.9.8.7' }, context), (error: unknown) => {
      assert.ok(error instanceof VerbDispatchError)
      assert.equal(error.hint.available.length, 2)
      return true
    })

    // Ambiguity without target/via is refused with the candidate list.
    await assert.rejects(dispatchVerb(runtime, 'remote.command', { command: 'id' }, context), (error: unknown) => {
      assert.ok(error instanceof VerbDispatchError)
      assert.deepEqual(error.hint.available.map((c: any) => c.id).sort(), [shellA.id, shellB.id].sort())
      return true
    })

    // via forces an explicit channel; a stale id is rejected.
    const forced = await dispatchVerb(runtime, 'remote.command', { command: 'echo three', via: shellA.id }, context)
    assert.equal(forced.channel.resource_id, shellA.id)
    await assert.rejects(dispatchVerb(runtime, 'remote.command', { command: 'id', via: 'ws_missing' }, context), VerbDispatchError)

    // High-risk worker verbs land in the approval queue, then poll to done.
    const risky = await dispatchVerb(runtime, 'remote.file.delete', { path: '/tmp/x', via: shellA.id }, context)
    assert.equal(risky.status, 'awaiting_approval')
    assert.ok(String(risky.note).includes('remote.task'))
    engine.store.db.prepare("UPDATE operation_tasks SET status='queued',approved_by='fixture-human' WHERE id=?").run(risky.task_id)
    engine.operations.wake()
    for (let i = 0; i < 100 && engine.operations.task(risky.task_id).status !== 'succeeded'; i++) await new Promise(resolve => setTimeout(resolve, 10))
    const polled = await verbTask(runtime, risky.task_id)
    assert.equal(polled.status, 'succeeded')
    assert.equal(polled.output, 'verb fixture output')

    // Stopping the adapter plugin removes its channels from dispatch.
    const gated: VerbRuntime = { operations: engine.operations, isAdapterAvailable: () => false }
    assert.equal(verbToolAvailable(runtime, 'remote_command'), true)
    assert.equal(verbToolAvailable(gated, 'remote_command'), false)
    assert.equal(verbToolAvailable(gated, 'remote_task'), true)
    await assert.rejects(dispatchVerb(gated, 'remote.command', { command: 'id' }, context), (error: unknown) => {
      assert.ok(error instanceof VerbDispatchError)
      assert.match(error.message, /没有可用适配器/)
      return true
    })

    // Step.requires round-trip: creation, validation, and tool exposure.
    const step = engine.store.addStep(project.id, { description: 'run remote commands', sourceIds: ['origin'], requires: ['remote.command'] })
    assert.deepEqual(step.requires, ['remote.command'])
    assert.deepEqual(channelsFor(runtime, step.requires).map((c: any) => c.id).sort(), [shellA.id, shellB.id].sort())
    const tools = verbTools({ store: engine.store, run: { projectId: project.id, stepId: step.id } as any, worker: { name: 'worker-1' } as any, config: {} as any, signal: new AbortController().signal }, runtime, step)
    assert.deepEqual(tools.map(t => t.name), ['remote_command', 'remote_task'])
    assert.throws(() => engine.store.addStep(project.id, { description: 'bad verb', sourceIds: ['origin'], requires: ['remote.nope'] }), /Unknown capability verb/)
    const api = await request(`/v2/projects/${project.id}/steps`, 'POST', { description: 'api step', sourceIds: ['origin'], requires: ['remote.file.read'] })
    assert.equal(api.status, 201)
    assert.deepEqual(api.data.requires, ['remote.file.read'])
    const invalid = await request(`/v2/projects/${project.id}/steps`, 'POST', { description: 'api bad', sourceIds: ['origin'], requires: ['bogus.verb'] })
    assert.equal(invalid.status, 422)

    // Steps without requires expose no verb tools.
    assert.deepEqual(verbTools({} as any, runtime, undefined), [])
  } finally {
    await engine.close(); remote.close(); rmSync(root, { recursive: true, force: true })
  }
})

test('resource tools: agent registration with secrets becomes a visible, dispatchable channel', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-resource-tools-'))
  const wire: string[] = []
  const remote = createServer((req, res) => {
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const form = new URLSearchParams(body); wire.push(form.get('cmd') ?? '')
      res.end(fixtureFrame(form.get('cmd') ?? '', /RT_[a-f0-9]+/.exec(form.get('cmd') ?? '')?.[0] ?? 'registered channel output'))
    })
  })
  await new Promise<void>(resolve => remote.listen(0, '127.0.0.1', resolve))
  const remotePort = (remote.address() as { port: number }).port
  const engine = await serveEngine({ root, port: 0, autoStart: false })
  const runtime = { operations: engine.operations }
  try {
    const { project } = engine.store.createProject({ title: 'ResourceTools', origin: 'Fixture', goal: 'Verify agent registration' })
    const step = engine.store.addStep(project.id, { description: 'run remote commands', sourceIds: ['origin'], requires: ['remote.command', 'remote.file.touch'] })
    const context = { store: engine.store, run: { projectId: project.id, stepId: step.id, activity: 'execute' } as any, worker: { name: 'worker-1' } as any, config: {} as any, signal: new AbortController().signal }
    const tools = resourceTools(context, runtime)
    const byName = (name: string) => {
      const tool = tools.find(entry => entry.name === name)
      if (!tool) throw new Error(`missing tool: ${name}`)
      return (args: Record<string, unknown>) => (tool.execute as unknown as (id: string, args: Record<string, unknown>) => Promise<{ details: unknown }>)('', args).then(result => result.details)
    }

    // Register a WebShell the way an Explore agent would: with the secret.
    const target = `http://127.0.0.1:${remotePort}/agent.php`
    const registered = await byName('resource_register')({ kind: 'webshell', name: 'agent shell', target, summary: 'found during task', metadata: { command_param: 'cmd', protocol: 'raw' }, secret: { password: 'agent-secret' } })
    const id = (registered as { resource: { id: string } }).resource.id
    // The stored row carries the secret; the public view never returns it.
    assert.equal(JSON.parse(engine.operations.resource(id).secret_json).password, 'agent-secret')
    assert.equal((registered as { resource: { has_secret?: boolean } }).resource.has_secret, true)
    assert.equal('secret' in (registered as { resource: Record<string, unknown> }).resource, false)

    // The channel is visible through list and get, and reusable by verbs.
    const listed = await byName('resource_list')({ kind: 'webshell' })
    assert.deepEqual((listed as { resources: Array<{ id: string }> }).resources.map(row => row.id), [id])
    const detail = await byName('resource_get')({ resource_id: id })
    assert.equal((detail as { resource: { target: string } }).resource.target, target)
    engine.operations.verifiedResource(id, { metadata_json: JSON.stringify({ command_param: 'cmd', protocol: 'raw', verified_capabilities: ['remote.command','remote.file.touch'] }) })
    fixtureAuthorize(engine.operations, project.id, id, ['command', 'create_file'])
    const context2 = { projectId: project.id, worker: 'worker-1', stepId: step.id, signal: new AbortController().signal }
    const run = await dispatchVerb(runtime, 'remote.command', { command: 'echo registered', via: id }, context2)
    assert.equal(run.status, 'succeeded')
    assert.equal(run.output, 'registered channel output')
    assert.equal(wire.length, 1); assert.match(wire[0], /echo registered/)

    // The touch verb creates empty files through the same channel.
    const touch = await dispatchVerb(runtime, 'remote.file.touch', { path: '/tmp/agent-marker', via: id }, context2)
    assert.equal(touch.status, 'succeeded')
    assert.match(wire.at(-1)!, /agent-marker/)

    // registerable kinds exclude 'result' (server-owned) but include materials.
    const kindSchema = (tools.find(entry => entry.name === 'resource_register')!.parameters as { properties: { kind: { anyOf: Array<{ const: string }> } } }).properties.kind
    const allowed = kindSchema.anyOf.map(item => item.const)
    assert.equal(allowed.includes('result'), false)
    assert.ok(allowed.includes('credential_ref'))
    assert.ok(allowed.includes('webshell'))
  } finally {
    await engine.close(); remote.close(); rmSync(root, { recursive: true, force: true })
  }
})
