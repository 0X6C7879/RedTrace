import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Store } from '../src/store.ts'
import { webTools, closeWebSessions } from '../src/web.ts'
import type { EngineConfig, Worker } from '../src/types.ts'
const worker: Worker = { name: 'local-web', backend: 'mock', provider: 'mock', model: '', enabled: true, reason: false, explore: true, bootstrap: false, maxRunning: 1, priority: 0 }
async function fixture(action: (tools: ReturnType<typeof webTools>, url: string, store: Store) => Promise<void>) {
  let nonce='nonce-one'
  const server = createServer((req,res)=>{
    if(req.url==='/login'){res.setHeader('Content-Type','text/html');res.end('<form method="post" action="/login-done"><label>User<input name="user"></label><button>Login</button></form>');return}
    if(req.url==='/login-done'){res.setHeader('Set-Cookie','identity=fixture; Path=/');res.end('logged in');return}
    if(req.url==='/csrf'){res.setHeader('Content-Type','text/html');res.end(`<form><input type="hidden" name="csrf" value="${nonce}"><button>Verify</button></form>`);return}
    if(req.url==='/verify'){let body='';req.on('data',chunk=>body+=chunk);req.on('end',()=>{res.statusCode=req.headers.cookie?.includes('identity=fixture') && req.headers.authorization==='Bearer explicit' && new URLSearchParams(body).get('csrf')===nonce ? 200:403;if(res.statusCode===200)nonce='nonce-two';res.end(JSON.stringify({status:res.statusCode}))});return}
    if (req.url === '/broken') { req.socket.destroy(); return }
    if (req.url === '/set') res.setHeader('Set-Cookie', 'identity=fixture; Path=/')
    if (req.url === '/page') { res.setHeader('Content-Type', 'text/html'); res.end('<form action="/submit"><input type="hidden" name="csrf" value="secret-csrf"><label>Name<input name="name"></label><button>Save</button></form>'); return }
    if (req.url?.startsWith('/lookup?')) { res.end(new URL(req.url, 'http://fixture').searchParams.get('q') ?? 'missing'); return }
    if (req.url?.startsWith('/json?')) { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ stable: 1, nested: { value: new URL(req.url, 'http://fixture').searchParams.get('value') } })); return }
    res.end(req.headers.cookie ?? 'anonymous')
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as {port:number}).port}`, root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-web-')), store = new Store(':memory:')
  const project = store.createProject({ title: 'Local fixture', origin: url, goal: 'Verify browser and HTTP isolation' }).project
  const step = store.addStep(project.id, { description: 'Inspect', sourceIds: ['origin'] }), run = store.claim(project.id, 'execute', worker, step.id)
  run.workspaceRoot = root
  try { await action(webTools({ store, run, worker, config: {} as EngineConfig, signal: new AbortController().signal }), url, store) }
  finally { await closeWebSessions(store); store.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }) }
}
test('HTTP uses no browser, preserves partial failures and raw request/response, isolates identities and challenges', async () => {
  const before = process.env.REDTRACE_BROWSER_CHANNEL
  process.env.REDTRACE_BROWSER_CHANNEL = 'deliberately-unavailable'
  try { await fixture(async (tools, url) => {
    const batch = tools.find(tool => tool.name === 'http_batch')!
    const result = await batch.execute('batch', { session: 'same', challenge: 'one', identity: 'alice', requests: [{ url: url + '/set' }, { url: url + '/broken', method: 'POST', body: 'retain-this-input' }, { url }] }) as any
    assert.equal(result.results[0].status, 200)
    assert.equal(result.results[1].status, null)
    assert.match(result.results[1].error, /socket hang up/)
    assert.equal(result.results[2].status, 200)
    assert.match(readFileSync(result.results[2].evidence.file, 'utf8'), /aWRlbnRpdHk9Zml4dHVyZQ==/)
    assert.match(readFileSync(result.results[1].evidence.file, 'utf8'), /retain-this-input/)
    assert.ok(!JSON.stringify(result).includes('bodyBase64'))
    const json = await batch.execute('json', { session: 'same', challenge: 'one', identity: 'alice', requests: [{ url: url + '/json?value=a' }, { url: url + '/json?value=b' }] }) as any
    assert.deepEqual(json.results[1].differenceFromFirst.jsonChangedFields, ['$.nested.value'])
    for (const scope of [{ challenge: 'one', identity: 'bob' }, { challenge: 'two', identity: 'alice' }]) {
      const isolated = await batch.execute('batch', { session: 'same', ...scope, requests: [{ url }] }) as any
      assert.match(readFileSync(isolated.results[0].evidence.file, 'utf8'), /YW5vbnltb3Vz/)
    }
  }) } finally { if (before === undefined) delete process.env.REDTRACE_BROWSER_CHANNEL; else process.env.REDTRACE_BROWSER_CHANNEL = before }
})
test('browser keeps form evidence and invalidates a snapshot even when a later action fails', { skip: !process.env.REDTRACE_TEST_BROWSER }, async () => {
  await fixture(async (tools, url) => {
    const open = tools.find(tool => tool.name === 'web_open')!, act = tools.find(tool => tool.name === 'web_act')!, batch = tools.find(tool => tool.name === 'http_batch')!, network = tools.find(tool => tool.name === 'web_network')!
    const args = { session: 'login', challenge: 'one', identity: 'alice' }
    await batch.execute('cookie', { ...args, requests: [{ url: url + '/set' }] })
    const page = await open.execute('page', { ...args, url: url + '/page' }) as any
    assert.match(readFileSync(page.evidence.file, 'utf8'), /secret-csrf/)
    assert.doesNotMatch(page.text, /secret-csrf/)
    await assert.rejects(act.execute('act', { ...args, snapshot_id: page.snapshotId, actions: [{ action: 'fill', role: 'textbox', name: 'Name', value: 'changed' }, { action: 'click', role: 'button', name: 'Missing' }] }), /found 0/)
    await assert.rejects(act.execute('act', { ...args, snapshot_id: page.snapshotId, actions: [{ action: 'click', role: 'button', name: 'Save' }] }), /stale/)
    const rows = await network.execute('net', args) as any
    assert.ok(rows.requests.length)
    const detail = await network.execute('detail', { ...args, request_id: rows.requests[0].id }) as any
    assert.ok(detail.evidence)
  })
})

test('captured safe browser GET requests can be replayed with bounded query variants', { skip: !process.env.REDTRACE_TEST_BROWSER }, async () => {
  await fixture(async (tools, url) => {
    const args = { session: 'replay', challenge: 'replay-fixture', identity: 'alice' }
    await tools.find(tool => tool.name === 'web_open')!.execute('open', { ...args, url: url + '/lookup?q=original' })
    const network = tools.find(tool => tool.name === 'web_network')!, rows = await network.execute('network', args) as any
    const captured = rows.requests.find((request: any) => request.url.includes('/lookup?'))
    assert.ok(captured)
    const result = await tools.find(tool => tool.name === 'http_replay')!.execute('replay', { ...args, request_id: captured.id, variants: [[{ name: 'q', value: 'candidate' }]] }) as any
    assert.deepEqual(result.results.map((item: any) => item.status), [200, 200])
    assert.deepEqual(result.results.map((item: any) => item.differenceFromBaseline?.sameBody), [undefined, false])
    const record = JSON.parse(readFileSync(result.results[1].evidence.file, 'utf8'))
    assert.equal(Buffer.from(record.response.bodyBase64, 'base64').toString(), 'candidate')
    await assert.rejects(tools.find(tool => tool.name === 'http_replay')!.execute('replay', { ...args, request_id: captured.id, variants: [[{ name: 'csrf_token', value: 'bad' }]] }), /state-bound/)
  })
})

test('browser login cookies plus explicit Authorization/CSRF work; one-time tokens are not replayed', { skip: !process.env.REDTRACE_TEST_BROWSER }, async()=>{
 await fixture(async(tools,url)=>{
  const byName=(name:string)=>tools.find(tool=>tool.name===name)!
  const args={session:'login',challenge:'csrf-fixture',identity:'alice'}
  const page=await byName('web_open').execute('open',{...args,url:url+'/login'}) as any
  await byName('web_act').execute('act',{...args,snapshot_id:page.snapshotId,actions:[{action:'fill',role:'textbox',name:'User',value:'alice'},{action:'click',role:'button',name:'Login'}]})
  const requests=await byName('web_network').execute('network',args) as any, loginRequest=requests.requests.find((item:any)=>item.method==='POST'&&item.url.endsWith('/login-done'))
  assert.ok(loginRequest)
  await assert.rejects(byName('http_replay').execute('replay',{...args,request_id:loginRequest.id,variants:[[]]}),/bodyless GET\/HEAD/)
  const csrf=await byName('web_open').execute('open',{...args,url:url+'/csrf'}) as any
  const forms=JSON.parse(readFileSync(csrf.evidence.file,'utf8')).forms
  assert.equal(forms[0].fields[0].value,'nonce-one')
  const body='csrf='+forms[0].fields[0].value
  const result=await byName('http_batch').execute('batch',{...args,requests:[{url:url+'/verify',method:'POST',headers:{Authorization:'Bearer explicit','Content-Type':'application/x-www-form-urlencoded'},body},{url:url+'/verify',method:'POST',headers:{Authorization:'Bearer explicit'},body}]}) as any
  assert.deepEqual(result.results.map((row:any)=>row.status),[200,403])
  const image=await byName('web_snapshot').execute('snapshot',{...args,screenshot:true,selector:'form'}) as any
  assert.equal(image.content[1].type,'image')
 })
})
