# External plugin compatibility

RedTrace manages external integrations from one canonical directory:
`RedTrace/plugins`. The versioned `plugins/manifest.json` inventory describes
the source location, entrypoint, build command, version, and compatibility
protocol of every managed plugin. Generated `dist`, `target`, Gradle, and local
JAR dependency directories are not source inputs.

## Migrated plugins

- Chromium DevTools traffic capture extension
- Burp Suite traffic analysis extension

Both were migrated from `CyberStrikeAI/plugins`, keep their upstream capture
and presentation behavior, and use RedTrace's native `/api/plugins/v1`
contract. RedTrace also exposes the CyberStrikeAI v1 route names so existing
unmodified plugin builds can connect after changing their host, port, and
scheme.

## Authentication

`REDTRACE_PLUGIN_TOKEN` is optional. When it is unset, session creation returns
the loopback development token `redtrace-local`. This mode is intended only for
a server bound to `127.0.0.1`.

When the variable is set, `POST /api/plugins/v1/session` accepts it in the
`password` field and subsequent requests require
`Authorization: Bearer <token>`. The legacy `/api/auth/login` and
`/api/auth/validate` routes use the same policy.

## Native routes

| Route | Purpose |
|---|---|
| `POST /api/plugins/v1/session` | Create a plugin session |
| `GET /api/plugins/v1/session` | Validate a bearer token |
| `GET /api/plugins/v1/catalog` | Read the managed plugin inventory |
| `GET /api/plugins/v1/projects` | List RedTrace projects for context selection |
| `GET /api/plugins/v1/roles` | List compatibility role choices |
| `POST /api/plugins/v1/runs/stream` | Create an isolated project and stream its run |
| `POST /api/plugins/v1/runs/cancel` | Stop that isolated project |

Compatibility aliases include `/api/auth/*`, `/api/projects`, `/api/roles`,
`/api/eino-agent/stream`, `/api/multi-agent/stream`, and
`/api/agent-loop/cancel`.

## Run isolation and streaming

Each Send creates a new RedTrace project. If the plugin supplies an existing
`projectId`, RedTrace records that project as contextual provenance; it does
not add work to, stop, or otherwise mutate the selected project.

The response is an SSE stream using the legacy `{type, message}` event shape:

- `conversation` carries the new RedTrace project ID as `conversationId`;
- Worker audit deltas are translated to progress/reasoning events;
- the RedTrace completion intent becomes the final `response`;
- completion, cancellation, deletion, and errors terminate with `done`.

The stream subscribes to RedTrace's in-process event hub. It uses a 15-second
heartbeat only to detect terminal project state when no audit event is emitted;
there is no independent high-frequency polling loop.
