# Shared MCP servers

Each `*.json` file defines one MCP server. The filename is the server name:

```json
{
  "enabled": true,
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "."],
  "env": {
    "TOKEN": "${TOKEN}"
  },
  "agents": {
    "codex": {
      "startup_timeout_sec": 30
    },
    "pi": {
      "lifecycle": "eager"
    }
  }
}
```

Common fields are adapted to each agent's native MCP configuration. Optional
`agents.claude`, `agents.codex`, and `agents.pi` objects are merged last, so
agent-specific fields remain available without narrowing any runtime's MCP
feature set.

Prefer environment-variable references over literal credentials. MCP files can
be created, edited, enabled, disabled, and deleted from RedTrace's MCP page.
