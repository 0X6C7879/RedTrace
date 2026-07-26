# Unified Skill evolution

`RedTrace/skills` is the only writable Skill source for Claude Code, Codex, and
Pi. Agent-native directories inside a project workspace are immutable runtime
snapshots created from that source; they are never read back as evolution
input.

## Runtime flow

1. The first Worker task for a project materializes one Skill snapshot and
   records every Skill version and revision in
   `.redtrace/capabilities.json`.
2. Later tasks in the same project reuse that digest without scanning or
   refreshing Skills. A new project receives the latest accepted versions.
3. A successful Worker may submit at most one complete replacement through
   `redtrace-skill propose`. Submission uses the current task's existing model
   call and a short local HTTP request; it never starts a separate model call.
4. The server writes the proposal to a durable inbox and returns `202`. A
   single daemon processes proposals outside the penetration task.

Example (the candidate must be a separate full replacement, not a runtime
snapshot file):

```bash
redtrace-skill propose \
  --name ctf-web \
  --target ctf-web \
  --candidate /tmp/ctf-web.SKILL.md \
  --summary "Verified branch ordering avoids two blind probes" \
  --validated "Solved the same path with the reduced sequence" \
  --tool-calls-saved 2
```

## Acceptance gates

An update is accepted only when it includes concrete validation and a measured
positive impact in successful completion, avoided invalid steps, saved tool
calls, or saved duration. The deterministic evolver:

- prefers an explicit or automatically matched existing Skill;
- rejects simple append-only changes and excessive growth;
- rejects missing frontmatter, oversize content, and repeated paragraphs;
- creates a Skill only when no reusable match exists and the count limit allows
  it;
- removes a redundant Skill when its meaningful content is already covered by
  the accepted replacement;
- retires the oldest disabled Skill before admitting a new one at the count
  limit.

No full repository scan or full evaluation suite is performed. Matching reads
only Skill entrypoints and runs only when a proposal exists.

## Concurrency, history, and rollback

All mutations use a cross-process store lock and optimistic SHA-256 revisions.
Every accepted state is recorded under
`skills/.redtrace/history/<name>/`, with bounded retention. Audit events use a
bounded, rotating `skills/.redtrace/audit.jsonl`. A stale proposal is rejected
instead of overwriting a newer version.

Useful endpoints:

- `POST /capabilities/evolution/proposals`
- `GET /capabilities/evolution`
- `GET /capabilities/evolution/audit`
- `GET /capabilities/skills/{name}/versions`
- `POST /capabilities/skills/{name}/rollback/{version}`

Limits can be tuned with:

- `REDTRACE_MAX_SKILLS` (default `24`)
- `REDTRACE_MAX_SKILL_CHARS` (default `65536`)
- `REDTRACE_SKILL_HISTORY_LIMIT` (default `12`)
- `REDTRACE_SKILL_QUEUE_LIMIT` (default `128`)
- `REDTRACE_SKILL_MATCH_THRESHOLD` (default `0.34`)
- `REDTRACE_SKILL_MAX_DUPLICATE_RATIO` (default `0.08`)
