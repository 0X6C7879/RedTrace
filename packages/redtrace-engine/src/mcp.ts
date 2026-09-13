import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { AgentTool } from '@earendil-works/pi-agent-core'
import { toolEnvironment } from './shell.ts'

/** MCP is loaded only for Execute activities with enabled server configurations. */
export async function connectMcp(configs: Record<string, any>[], cwd: string, signal: AbortSignal, env?: Record<string, string>) {
  const clients: Client[] = [], tools: AgentTool[] = []
  const close = async () => { await Promise.all(clients.splice(0).map(c => c.close())); signal.removeEventListener('abort', abort) }
  const abort = () => { void close().catch(() => {}) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    for (const config of configs) {
      signal.throwIfAborted()
      const client = new Client({ name: 'redtrace', version: '0.4.0' }); clients.push(client)
      const transport = config.transport === 'stdio'
        ? new StdioClientTransport({ command: config.command, args: config.args ?? [], cwd: config.cwd || cwd, env: toolEnvironment({ ...env, ...config.env }) as Record<string, string>, stderr: 'inherit' })
        : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers ?? {} } })
      await client.connect(transport, { signal, timeout: 30_000 })
      let cursor: string | undefined
      do {
        const page = await client.listTools({ cursor }, { signal })
        for (const t of page.tools) tools.push({ name: `mcp__${config.serverName}__${t.name}`, label: t.name, description: t.description ?? t.name, parameters: t.inputSchema as AgentTool['parameters'],
          async execute(_id, args, abort) {
            const result = await client.callTool({ name: t.name, arguments: args as Record<string, unknown> }, undefined, { signal: abort, timeout: config.toolCallTimeoutMs ?? 60_000 })
            const content = Array.isArray(result.content) ? result.content.filter((c: any) => c.type === 'text' || c.type === 'image') : []
            return { content: content.length ? content as any : [{ type: 'text', text: JSON.stringify(result) }], details: result }
          } })
        cursor = page.nextCursor
      } while (cursor)
    }
    return { tools, close }
  } catch (error) { await close(); throw error }
}
