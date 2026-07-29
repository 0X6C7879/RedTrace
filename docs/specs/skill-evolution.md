# Unified Skill evolution

`RedTrace/skills` is the only writable Skill source for Claude Code, Codex, and
Pi. Agent-native directories in a project are frozen, read-only snapshots. They
are never read back as evolution input and are never refreshed during a running
Worker or Intent.

## Fast-path contract

Every non-mock Worker receives one final-output checkpoint. When it has a
high-signal evolution opportunity, it adds one compact `skillFeedback` object
beside its normal `accepted` and `data` fields:

```json
{
  "accepted": true,
  "data": {"description": "normal task result"},
  "skillFeedback": {
    "type": "IMPROVE",
    "targetSkill": "web-recon",
    "summary": "A bounded comparison removes a redundant probe.",
    "applicability": "Authorized HTTP validation.",
    "procedure": [
      "Capture one bounded baseline.",
      "Change one input and compare the relevant response property."
    ],
    "validation": ["The difference reproduced twice."],
    "evidenceRefs": ["context:ev-1"],
    "impact": {"invalid_steps_avoided": 1}
  }
}
```

Omit `skillFeedback` when the signal is weak. The Worker does not scan Skills,
write `SKILL.md`, invoke `redtrace-skill`, or make another model call. The
dispatcher extracts valid feedback and performs one best-effort local HTTP
handoff with a sub-second timeout. Handoff failure never changes the task result.

A candidate may come from an independently verified subflow even when the
overall task fails. Ordinary failures, guesses, accidental success, missing
validation, and missing evidence references are rejected.

## Background pipeline

One daemon processes the durable inbox outside penetration-task execution:

1. Normalize and deterministically reject target-specific or secret-bearing
   feedback.
2. Coalesce identical candidates before any model call.
3. Read only Skill entrypoints relevant to the candidate and prefer a matching
   existing Skill.
4. For `FIX`, `IMPROVE`, `CAPTURE`, or `MERGE`, invoke one installed native
   Claude Code, Codex, or Pi CLI as a low-priority author. The author receives
   the compact evidence, `skills/skill-creator/SKILL.md`, and relevant Skill
   entrypoints only.
5. Validate frontmatter, required sections, generality, secret literals,
   duplication, append-only growth, size growth, and optimistic revision.
6. Commit atomically under the cross-process Skill store lock.

No extra Agent Runtime is embedded. If no author CLI is available or authoring
times out, the candidate moves to `skills/.redtrace/deferred/`; task execution
continues unchanged.

Author selection:

- `REDTRACE_SKILL_AUTHOR=auto|claude|codex|pi|disabled`
- `REDTRACE_SKILL_AUTHOR_ORDER=claude,codex,pi`
- `REDTRACE_SKILL_AUTHOR_TIMEOUT=120`

## Evolution types

- `FIX`: correct wrong, stale, unsafe, or reproducibly ineffective guidance.
- `IMPROVE`: reduce steps/calls/latency, raise success rate, or add a missing
  branch.
- `CAPTURE`: create a reusable capability only when no existing Skill can
  absorb it.
- `MERGE`: write one replacement and retire overlapping Skills.
- `RETIRE`: disable a superseded, redundant, or repeatedly ineffective Skill
  while preserving history and rollback.

## Trust and quality

Existing unmanaged Skills default to `trusted` for backward compatibility.
New and substantially rewritten Skills are `provisional`. A provisional Skill
becomes `trusted` only when a different project/Intent submits verified reuse
with `reuseValidated: true`. Trust, successful reuse count, failure count, and
the provisional source task live in `.redtrace.json`, not in `SKILL.md`.

The workspace manifest records each snapshot's version, revision, and trust.
Retired Skills are disabled and excluded from later runtime snapshots. Every
mutation and decision records the evolution type, reason, source project/Intent,
validation results, evidence references, impact, and revision in bounded audit
and history storage.

## Anti-growth rules

- Prefer update or merge over create.
- Reject simple append-only replacements.
- Bound replacement growth and total Skill count.
- Reject repeated paragraphs and incomplete new/major Skills.
- Retire redundant Skills after a merge.
- Prune only the oldest already-disabled Skill when the count limit is reached.
- Never persist target addresses, accounts, secrets, task IDs, or temporary
  paths inside Skill content.

Matching and authoring inspect only the candidate, relevant entrypoint metadata,
and at most a few related Skill entrypoints. They do not scan full logs, the
repository, or every bundled Skill resource.

## Concurrency, history, and rollback

All mutations use a cross-process store lock and optimistic SHA-256 revisions.
Accepted states are retained under `skills/.redtrace/history/<name>/`. Audit
events use bounded `skills/.redtrace/audit.jsonl`. Stale proposals never
overwrite newer versions.

Endpoints:

- `POST /capabilities/evolution/proposals`
- `GET /capabilities/evolution`
- `GET /capabilities/evolution/audit`
- `GET /capabilities/skills/{name}/versions`
- `POST /capabilities/skills/{name}/rollback/{version}`

The legacy `redtrace-skill propose` command remains available for a manually
prepared full replacement. Automatic Worker evolution uses `skillFeedback`.

Limits:

- `REDTRACE_MAX_SKILLS` (default `32`)
- `REDTRACE_MAX_SKILL_CHARS` (default `65536`)
- `REDTRACE_SKILL_HISTORY_LIMIT` (default `12`)
- `REDTRACE_SKILL_QUEUE_LIMIT` (default `128`)
- `REDTRACE_SKILL_MATCH_THRESHOLD` (default `0.34`)
- `REDTRACE_SKILL_MAX_DUPLICATE_RATIO` (default `0.08`)
- `REDTRACE_SKILL_FAILURE_LIMIT` (default `3`)
