---
name: prompt-injection
description: Security workflow for prompt-injection, retrieval poisoning, memory contamination, planner drift, MCP or tool-boundary abuse, and agent exfiltration tasks. Use when the user asks to analyze prompt injection, retrieval poisoning, memory contamination, planner drift, tool-argument corruption, or secret exposure caused by an agent chain. Use directly when this Capability matches.
metadata:
  redtrace:
    capabilities: [ai-security]
---

# Prompt Injection

Use this skill directly for the matching security surface and keep conclusions tied to observable evidence.

Use this skill when the task is primarily about trust boundaries inside an agentic system.

Reply in Simplified Chinese unless the user explicitly requests English.

## Quick Start

1. Identify the first untrusted content that becomes model-visible.
2. Map the chain from retrieval, memory, or transcript into planner or executor behavior.
3. Record the exact point where text becomes a tool argument, file path, network target, or secret request.
4. Prove one minimal exploit chain before exploring variants.
5. Keep prompt snippets and tool transitions in compact evidence blocks.

## Workflow

### 1. Map The Control Stack

- Track system, developer, user, retrieved, memory, planner, and tool-response layers separately.
- Distinguish claimed capability from runtime-exposed capability.
- Note what the model can actually call, read, or mutate.

### 2. Prove The Boundary Crossing

- Reproduce one chain from untrusted text to changed planner behavior, changed tool args, or secret exposure.
- Keep the decisive transcript compact: source chunk, rewritten planner state, final tool invocation.
- Prefer the smallest transcript that still demonstrates the bug.

### 3. Report By Boundary

- State which layer failed: retrieval, summarizer, planner, executor, tool normalization, or output post-processing.
- Separate instruction drift from actual side effect.

## Read This Reference

- Load `references/prompt-injection.md` for the checklist, evidence layout, and common prompt-boundary pitfalls.

## What To Preserve

- Original malicious chunk or prompt
- Intermediate summary or planner drift if it matters
- Final tool args, file paths, or exposed secret surface
