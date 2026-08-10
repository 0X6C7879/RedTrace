# Lightweight Context Harness

RedTrace adds one dependency-free `redtrace-context` CLI to every new local or
container task workspace. Claude Code, Codex, and Pi use the same executable and
Artifact contract. RTK remains the first compression layer and its installation,
hooks, configuration, command rewriting, and session handling are unchanged.

The intended command path is:

```text
Agent -> existing RTK command -> redtrace-context -> bounded Agent output
                                           \-> complete local Artifact
```

For a security tool that RTK does not specialize, put RTK inside the harness:

```bash
redtrace-context run -- rtk proxy nuclei -u https://target -jsonl
redtrace-context run -- rtk proxy nmap -oX - -sV target
redtrace-context run --kind http --source https://target/login -- rtk curl -i https://target/login
redtrace-context capture page.html --kind web --source https://target/login
```

Small plain-text output passes through unchanged. Large output and structured
security, HTTP, Web, XML, JSON, JSONL, and HAR content is saved under
`.redtrace/artifacts/context/<artifact-id>/`. The Agent receives deterministic
local-parser signals and an evidence ID. No model call is made.

Each Artifact contains:

- `stdout.raw` and `stderr.raw`: complete byte streams;
- `metadata.json`: hashes, sizes, source, tool exit code, parsing time, task
  duration, visible size, peak harness memory, and Web/network comparison state;
- an entry in `index.jsonl`.

Raw content is queried only through bounded selectors:

```bash
redtrace-context query ev-... --keyword "CVE-"
redtrace-context query ev-... --lines 120:180
redtrace-context query ev-... --offset 65536 --length 8192
redtrace-context query ev-... --stream stderr --keyword timeout
redtrace-context list --limit 20
redtrace-context metrics
```

The CLI rejects unbounded reads. Query calls are appended to `queries.jsonl`.
`metrics` reports original and Agent-visible sizes, estimated token reduction,
additional query count, parse time, task duration, and peak harness memory.

## Configuration

`context_harness` is a top-level `dispatch.yaml` section:

```yaml
context_harness:
  enabled: true
  artifact_root: ".redtrace/artifacts/context"
  inline_bytes: 262144
  visible_bytes: 65536
  query_bytes: 1048576
  parse_bytes: 67108864
  worker_output_chars: 33554432
```

Set `enabled: false` for an immediate raw-execution downgrade. Configuration is
translated to Worker environment variables by RedTrace, not by per-Agent config.
Changing this section requires a dispatcher restart; Worker-only hot reload
semantics remain unchanged.

These defaults are deliberately sized for RedTrace's 1M-token, long-running
worker sessions: ordinary evidence stays visible longer, bounded queries may
return up to 1 MiB, and large command output is still retained through the
artifact layer rather than being silently discarded.

`--passthrough` keeps real-time stdout/stderr for progress-sensitive
non-interactive commands while still retaining an Artifact. Truly interactive
TTY commands should bypass the harness. If Artifact setup fails before child
startup, the CLI executes the original command directly. Parser failure replays
the captured raw streams. Child stdin inheritance, stream separation, exit code,
and task result are preserved.

## Runtime and state boundaries

Worker stdout/stderr is drained continuously. RedTrace keeps only a bounded
prefix and tail for final session/result extraction; audit normalization still
receives normal records in real time. A pathological single record over 2 MiB
produces an explicit `output.truncated` audit event instead of being retained in
memory. Assistant audit messages are flushed in bounded chunks rather than
accumulated for the full run.

The harness does not add Idea, Memory, vector, queue, or service state. Facts,
Intents, Hints, and the task graph remain authoritative. Facts should contain
only confirmed conclusions plus evidence IDs/paths. Working-context compaction
keeps the objective, scope, confirmed facts, active direction, failed boundaries,
authentication state, evidence paths, and next action.

## Before/after benchmark

Run real `curl` and, when available, `nmap` tasks against an ephemeral localhost
target:

```bash
python redtrace/scripts/benchmark_context_harness.py --concurrency 4 --enforce
```

The report verifies identical child exit codes and SHA-256-identical raw stdout
Artifacts, then compares duration, visible bytes, token reduction, parser time,
peak harness memory, and concurrent success preservation. Run it inside the Kali
worker image for the representative tool set.
