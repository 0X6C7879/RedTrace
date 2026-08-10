# RedTrace plugins

This directory is the canonical source and registry for external RedTrace
integrations. `manifest.json` is the single inventory; build output stays inside
each plugin's own `dist/` directory and is not used as source.

Plugin enablement and Worker compatibility are global rather than project
scoped. The management UI reads and writes this manifest directly. Every new
Claude, Codex, or Pi task receives a frozen, compact catalog at
`.redtrace/plugins.json`; plugin source is not duplicated into each project
workspace.

The migrated browser and Burp Suite plugins retain the CyberStrikeAI v1 wire
protocol. RedTrace implements that protocol under the legacy `/api/...` paths
and also exposes the same operations under `/api/plugins/v1/...`.

## Connection

- Server: `http://127.0.0.1:8000` by default.
- Token: optional for a loopback-only server.
- To require authentication, set `REDTRACE_PLUGIN_TOKEN` before starting
  `redtrace serve`, then enter that value in the plugin's Password/Token field.
- Every Send creates an isolated RedTrace project. A selected existing project
  is recorded as context provenance and is never stopped or modified by the
  plugin run.

## Managed plugins

- `browser-extension/cyberstrikeai-browser-extension`
- `burp-suite/cyberstrikeai-burp-extension`

The compatibility contract is covered by
`redtrace/tests/test_plugin_compatibility.py`.
