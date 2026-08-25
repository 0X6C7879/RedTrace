import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { initState, disposeState } from '../lib/state.js'
import { apply } from '../lib/web.js'

function fakeResponse() {
  const res = {
    status: 0,
    headers: {},
    body: null,
    writeHead(status, headers) {
      res.status = status
      res.headers = headers
    },
    end(body) {
      res.body = body ?? ''
    },
  }
  return res
}

function staticRoute() {
  const routes = []
  const webServer = {
    register(route) { routes.push(route) },
    registerFallback() {},
  }
  apply({ webServer })
  const route = routes.find((item) => item.kind === 'prefix' && item.path === '/static')
  assert.ok(route, 'static prefix route must be registered')
  return route
}

async function serve(route, url) {
  const res = fakeResponse()
  route.handler({ url }, res)
  for (let i = 0; i < 100 && res.status === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  return res
}

test('serves static assets with cache-busting query strings', async (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'redtrace-web-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(path.join(dir, 'app.js'), 'console.log("ok")\n')
  initState({
    server: 'http://127.0.0.1:9',
    root: dir,
    sessionRoot: dir,
    skillsDir: dir,
    workspacesDir: dir,
    staticDir: dir,
  })
  t.after(() => disposeState())

  const route = staticRoute()

  const withQuery = await serve(route, '/static/app.js?v=20260825-cache-1')
  assert.equal(withQuery.status, 200)
  assert.equal(withQuery.headers['content-type'], 'text/javascript; charset=utf-8')
  assert.equal(withQuery.body.toString(), 'console.log("ok")\n')

  const withoutQuery = await serve(route, '/static/app.js')
  assert.equal(withoutQuery.status, 200)

  const missing = await serve(route, '/static/missing.js?v=1')
  assert.equal(missing.status, 404)

  const traversal = await serve(route, '/static/../app.js')
  assert.equal(traversal.status, 404)
})
