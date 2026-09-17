import assert from 'node:assert/strict'
import test from 'node:test'

import { apply as webshellApply } from '../lib/webshell.js'
import { apply as c2Apply } from '../lib/c2.js'

function collector() {
  const tools = []
  return { tools, ctx: { tools: { register(tool) { tools.push(tool) } } } }
}

function withEnv(probe) {
  const previous = {}
  const env = { REDTRACE_TASK_TYPE: 'explore', REDTRACE_PROJECT_ID: 'proj/1', REDTRACE_WORKER: 'explorer', REDTRACE_SERVER: 'http://redtrace.test', REDTRACE_INTENT_ID: 'i001' }
  for (const [name, value] of Object.entries(env)) { previous[name] = process.env[name]; process.env[name] = value }
  const observed = []
  const previousFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    observed.push({ url: String(url), body: init?.body === undefined ? null : JSON.parse(init.body) })
    return { ok: true, status: 201, async json() { return probe(observed.length) } }
  }
  return {
    observed,
    done() {
      for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value }
      globalThis.fetch = previousFetch
    },
  }
}

test('webshell plugin registers structured registration and the connectivity probe', async () => {
  const { tools, ctx } = collector()
  await webshellApply(ctx, { types: ['explore'] })
  assert.deepEqual(tools.map(tool => tool.name), ['webshell_register', 'webshell_test'])
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.description.length > 0)
  }
  assert.deepEqual(tools.find(tool => tool.name === 'webshell_register').parameters.required, ['target'])
  assert.deepEqual(tools.find(tool => tool.name === 'webshell_test').parameters.required, ['target'])
})

test('webshell_register posts the full connection form with its secret', async () => {
  const { tools, ctx } = collector()
  await webshellApply(ctx, { types: ['explore'] })
  const register = tools.find(tool => tool.name === 'webshell_register')
  const harness = withEnv(() => ({ resource: { id: 'ws_1' } }))
  try {
    const value = await register.execute(
      { target: 'http://target.test/shell.php', password: 's3cret', shell_type: 'php', protocol: 'raw', command_param: 'cmd' },
      { concludeTurn() {} },
    )
    assert.deepEqual(value, { resource: { id: 'ws_1' } })
    assert.equal(harness.observed.length, 1)
    assert.equal(harness.observed[0].url, 'http://redtrace.test/projects/proj%2F1/resources')
    assert.deepEqual(harness.observed[0].body, {
      kind: 'webshell',
      name: 'http://target.test/shell.php',
      target: 'http://target.test/shell.php',
      summary: '',
      metadata: {
        command_param: 'cmd',
        password_param: '',
        shell_type: 'php',
        protocol: 'raw',
        os: 'auto',
        encoding: 'auto',
        method: 'POST',
        verify_tls: false,
      },
      secret: { password: 's3cret' },
      actor_type: 'worker',
      actor: 'explorer',
      worker: 'explorer',
      intent_id: 'i001',
      publish_fact: false,
    })
  } finally {
    harness.done()
  }
})

test('c2 plugin registers listener, session, credential, profile, payload and session tools', async () => {
  const { tools, ctx } = collector()
  await c2Apply(ctx, { types: ['explore'] })
  assert.deepEqual(tools.map(tool => tool.name), [
    'c2_listener_create',
    'c2_session_create',
    'c2_credential_create',
    'c2_profile_create',
    'c2_listener_kinds',
    'c2_payload_oneliner',
    'c2_payload_build',
    'c2_payload_external',
    'c2_sessions',
  ])
  for (const tool of tools) {
    assert.equal(tool.parameters.type, 'object')
    assert.ok(tool.description.length > 0)
  }
  assert.deepEqual(tools.find(tool => tool.name === 'c2_listener_create').parameters.required, ['listener_type', 'name'])
  assert.deepEqual(tools.find(tool => tool.name === 'c2_session_create').parameters.required, ['shell_type', 'target'])
  assert.deepEqual(tools.find(tool => tool.name === 'c2_credential_create').parameters.required, ['name', 'secret'])
  assert.deepEqual(tools.find(tool => tool.name === 'c2_payload_external').parameters.required, ['listener_id'])
})

test('c2 listener creation posts the resource contract with worker provenance', async () => {
  const { tools, ctx } = collector()
  await c2Apply(ctx, { types: ['explore'] })
  const create = tools.find(tool => tool.name === 'c2_listener_create')
  const harness = withEnv(() => ({ resource: { id: 'lis_1' } }))
  try {
    const value = await create.execute(
      { listener_type: 'tcp_reverse', name: 'pivot', bind_port: 4444, callback_host: '10.0.0.5', profile_id: 'prf_1' },
      { concludeTurn() {} },
    )
    assert.deepEqual(value, { resource: { id: 'lis_1' } })
    assert.equal(harness.observed.length, 1)
    assert.equal(harness.observed[0].url, 'http://redtrace.test/projects/proj%2F1/resources')
    assert.deepEqual(harness.observed[0].body, {
      kind: 'c2_listener',
      name: 'pivot',
      target: '127.0.0.1:4444',
      summary: '',
      metadata: { listener_type: 'tcp_reverse', bind_host: '127.0.0.1', bind_port: 4444, callback_host: '10.0.0.5', profile_id: 'prf_1' },
      actor_type: 'worker',
      actor: 'explorer',
      worker: 'explorer',
      intent_id: 'i001',
      publish_fact: false,
    })
  } finally {
    harness.done()
  }
})

test('c2 session creation carries the connection material into the secret', async () => {
  const { tools, ctx } = collector()
  await c2Apply(ctx, { types: ['explore'] })
  const create = tools.find(tool => tool.name === 'c2_session_create')
  const harness = withEnv(() => ({ resource: { id: 'ses_1' } }))
  try {
    await create.execute(
      { shell_type: 'ssh', target: '10.0.0.8', username: 'root', secret_type: 'password', secret: 'toor', port: 2222 },
      { concludeTurn() {} },
    )
    assert.equal(harness.observed.length, 1)
    assert.deepEqual(harness.observed[0].body, {
      kind: 'c2_session',
      name: 'ssh:10.0.0.8',
      target: '10.0.0.8',
      summary: '',
      metadata: { shell_type: 'ssh', connection_type: 'direct', username: 'root', port: 2222 },
      secret: { password: 'toor' },
      actor_type: 'worker',
      actor: 'explorer',
      worker: 'explorer',
      intent_id: 'i001',
      publish_fact: false,
    })
  } finally {
    harness.done()
  }
})
