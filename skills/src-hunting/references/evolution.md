# Controlled Evolution for `src-hunting`

Read this reference only at the final RedTrace Skill feedback checkpoint or when
reviewing a verified evolution candidate.

## Source of truth

Treat `RedTrace/skills/src-hunting` as the only writable formal source. Never
evolve copies under `.claude`, `.codex`, `.agents`, `.pi`, workspace snapshots,
or Worker-private directories. Those copies are read-only runtime snapshots.

Do not write the formal Skill during an active hunting task. At the final output
boundary, emit at most one compact `skillFeedback` object when the task produced
a verified, reusable improvement. RedTrace's background author may then prepare
at most one complete `SKILL.md` replacement proposal.

Do not scan all Skills, invoke another model, or add work to the main execution
path merely to satisfy the feedback checkpoint.

## Admission gate

Admit an evolution candidate only when all are true:

- an actual authorized task or independently verified subflow validated it;
- it generalizes across targets or business domains;
- it improves a decision rule, priority model, branch, validation method, failure
  boundary, or stop condition;
- it reduces invalid attempts, unnecessary tool calls, execution time, or
  ambiguity, or reproducibly improves success;
- concrete evidence references support the result;
- no existing matching Skill already contains the same guidance.

Reject:

- unverified guesses, ordinary failures, one-off luck, or target-specific tricks;
- domains, routes, accounts, identifiers, parameter values, credentials, secrets,
  task IDs, or temporary paths;
- raw cases, growing payload collections, tool catalogs, or chronological notes;
- exploit details already covered by `exploit-*` Skills;
- fabricated success, applicability, measurements, or time/call savings.

## Replacement rule

Prefer, in order:

1. correct an unsafe, stale, or ineffective rule;
2. improve an existing decision branch or stop condition;
3. merge duplicate guidance and remove lower-value text;
4. create another Skill only when no existing Skill can absorb the capability.

Produce a complete replacement, not an appended note. Integrate the new rule at
the decision point it changes, compress or remove overlapping content, and keep
the total size stable. As evolution accumulates, replace obsolete rules and
delete duplication so content does not grow linearly.

Keep exploit mechanics in the exact specialist Skill. `src-hunting` should retain
only orchestration, business/trust reasoning, hypothesis quality, bounded
validation, graph coordination, evidence, and stopping rules.

## Candidate requirements

Each proposal must state:

```text
Type: FIX | IMPROVE | CAPTURE | MERGE | RETIRE
Target Skill: src-hunting
Verified result:
Evidence references:
Cross-target applicability:
Existing rule/section replaced:
Replacement decision or procedure:
Validation and stopping condition:
Invalid steps/tool calls/time avoided:
Measurement basis, or "not measured":
Content removed or compressed to keep size stable:
```

Do not invent numeric impact. If the task did not measure a saving, state that it
was not measured and describe only the observed qualitative reduction.

## Final validation

Before accepting a replacement, verify:

- the trigger, scope, workflow, validation, failure, and safety sections remain
  complete;
- the new rule is executable by Claude Code, Codex, and Pi without agent-specific
  paths or tools;
- the replacement contains no target-specific or secret material;
- it does not duplicate an `exploit-*` Skill;
- it replaces or compresses old content rather than appending a case;
- its references remain one level from `SKILL.md`;
- it adds no model call, full Skill scan, polling loop, or expensive evaluation to
  normal task execution;
- evidence supports every claimed validation and efficiency improvement.
