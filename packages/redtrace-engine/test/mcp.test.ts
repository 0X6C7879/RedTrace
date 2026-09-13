import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { connectMcp } from '../src/mcp.ts'

test('real stdio MCP discovers and invokes tools and closes its process on cancellation', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'redtrace-mcp-')), filename = path.join(root, 'server.mjs')
  writeFileSync(filename, `import { Server } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/index.js'))};
import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
import { ListToolsRequestSchema, CallToolRequestSchema } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/types.js'))};
const server = new Server({ name: 'echo', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: [{ name: 'echo', description: 'Echo test', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }));
server.setRequestHandler(CallToolRequestSchema, request => ({ content: [{ type: 'text', text: request.params.arguments.text }] }));
await server.connect(new StdioServerTransport());`)
  const abort = new AbortController()
  try {
    const connected = await connectMcp([{ serverName: 'echo', transport: 'stdio', command: process.execPath, args: [filename] }], root, abort.signal)
    assert.equal(connected.tools[0].name, 'mcp__echo__echo')
    const result = await connected.tools[0].execute('call-1', { text: 'verified' }, abort.signal)
    assert.deepEqual(result.content, [{ type: 'text', text: 'verified' }])
    await connected.close(); abort.abort()
  } finally { abort.abort(); rmSync(root, { recursive: true, force: true }) }
})
