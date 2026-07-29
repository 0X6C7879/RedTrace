---
name: skill-creator
description: Create, update, merge, retire, and validate RedTrace penetration-testing Skills from verified evolution evidence. Use for RedTrace background Skill evolution when a Worker reports a FIX, IMPROVE, CAPTURE, MERGE, or RETIRE candidate, and always prefer extending an existing Skill over creating a near-duplicate.
---

# RedTrace Skill Creator

Convert one bounded, verified candidate into a compact, executable Skill change.
Treat `RedTrace/skills` as the only writable source. Treat `.claude`, `.codex`,
`.agents`, and `.pi` Skill directories as read-only runtime snapshots.

## Admission

Use only evidence that identifies:

- a reproducible result or independently verified subflow;
- a reusable procedure, decision rule, failure boundary, or tool combination;
- the evidence reference that supports the result;
- the applicable environment or precondition.

Reject ordinary failures, guesses, one-off luck, and claims without a concrete
validation result. Never carry target addresses, domains, accounts, credentials,
task identifiers, temporary paths, or other project-specific values into Skill
content.

## Choose the evolution

Apply this order:

1. Use `FIX` when existing guidance is wrong, stale, unsafe, or reproducibly
   ineffective.
2. Use `IMPROVE` when an existing Skill can cover the capability with fewer
   steps, fewer calls, a higher success rate, or a missing branch.
3. Use `MERGE` when two Skills substantially overlap or one is fully covered by
   the replacement.
4. Use `RETIRE` when a Skill is repeatedly ineffective, redundant, or superseded.
5. Use `CAPTURE` only when no existing Skill can be extended or merged.

Before creating a Skill, compare the proposed name, description, triggers, scope,
and workflow with the supplied relevant Skill entrypoints. A different tool,
operating system, version, or permission level is normally an applicability
condition, not a reason for another Skill.

## Name and scope

Choose a lowercase hyphenated name under 64 characters. Organize by vulnerability
class, stable task capability, or reusable workflow. Avoid names tied to a single
target, task, product instance, command variant, or narrow payload.

Write a model-independent description that states both what the Skill does and
when it should trigger. Keep the procedure tool-neutral where possible; put
tool-, version-, operating-system-, permission-, and environment-specific
differences in applicability or branches.

## Author the replacement

Return a complete replacement rather than an appended patch. Preserve validated
guidance that still matters, integrate the new evidence into the best location,
remove repetition, and compress nearby prose. Keep `SKILL.md` below 500 lines and
move stable detail to a referenced resource only when progressive disclosure
materially saves context.

For a new or substantially rewritten Skill, use this structure:

```markdown
---
name: concise-skill-name
description: What it enables and the concrete contexts that should trigger it.
---

# Skill title

## Trigger conditions

## Applicability and scope

## Workflow

## Validation standard

## Failure handling

## Safety boundaries
```

The workflow must be directly executable by Claude Code, Codex, and Pi. State
branch conditions and stopping conditions. Prefer deterministic checks and
bounded probes. Do not embed a live target, credential, source task, evidence
identifier, confidence score, trust state, version history, or evolution reason
inside `SKILL.md`; RedTrace stores provenance in Skill metadata and audit history.

## Validation

Before returning a replacement, check:

- completeness: trigger, scope, workflow, validation, failure handling, and
  safety boundaries are present;
- consistency: steps and branches do not contradict each other;
- duplication: no repeated paragraphs or append-only tail;
- generality: examples use placeholders and apply to a class of tasks;
- executability: required tools, permissions, versions, inputs, outputs, and
  stopping conditions are clear;
- safety: authorization boundaries and non-destructive defaults are explicit.

Return only one complete `SKILL.md` beginning with YAML frontmatter. Do not modify
files, invoke tools, start another Agent, or perform a full repository or log scan.

## Trust lifecycle

New and substantially rewritten Skills enter `provisional`. Do not label them
trusted in their content. RedTrace promotes a provisional Skill only after a
different task reports independently validated reuse. A verified regression
should produce a `FIX`; repeated harmful or ineffective behavior should lead to
rollback or `RETIRE`.
