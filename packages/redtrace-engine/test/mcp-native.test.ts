import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
const { load, mount } = await import(new URL('../../redtrace-dsh/lib/loader.js', import.meta.url).href)

test('native MCP discovers and invokes a real stdio server; disposal unregisters tools and closes its process', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-native-mcp-')), file = path.join(root, 'echo.mjs'), pidFile = path.join(root, 'pid')
  writeFileSync(file, `import {createInterface} from 'node:readline'; import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
createInterface({input:process.stdin}).on('line', line => {const q=JSON.parse(line); if(q.id===undefined)return;
let result=q.method==='initialize'?{protocolVersion:q.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'echo',version:'1'}}:
q.method==='tools/list'?{tools:[{name:'echo',description:'Echo',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}}]}:
q.method==='tools/call'?{content:[{type:'text',text:q.params.arguments.text}]}:{};
console.log(JSON.stringify({jsonrpc:'2.0',id:q.id,result}));});`)
  const { Context } = await load('vendor/deepseek-harness/vendor/cordis/lib/index.js'), ctx = new Context()
  try {
    for (const module of ['vendor/deepseek-harness/packages/session/session-projection/lib/index.js', 'vendor/deepseek-harness/packages/subprocess/subprocess-local/lib/index.js', 'packages/redtrace-dsh/lib/core.js']) await mount(ctx, module)
    await ctx.fiber.await()
    const fiber = await mount(ctx, 'vendor/deepseek-harness/packages/mcp/mcp-client/lib/index.js', { serverName: 'echo', transport: 'stdio', command: process.execPath, args: [file], cwd: root, failOnStartupError: true })
    const tool = ctx.get('tools').get('mcp__echo__echo'); assert.ok(tool)
    const result = await tool.execute({ text: 'verified-native-mcp' }, { signal: AbortSignal.timeout(5000), callId: 'call1' })
    assert.deepEqual(result.content, [{ type: 'text', text: 'verified-native-mcp' }])
    const pid = Number(readFileSync(pidFile, 'utf8')); process.kill(pid, 0)
    await fiber.dispose()
    assert.equal(ctx.get('tools').get('mcp__echo__echo'), undefined)
    assert.throws(() => process.kill(pid, 0), (error: any) => error.code === 'ESRCH')
  } finally { await ctx.fiber.dispose(); rmSync(root, { recursive: true, force: true }) }
})
