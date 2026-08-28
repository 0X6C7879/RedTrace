---
name: agent-cloud
description: Security workflow for AI-agent, prompt-injection, MCP or toolchain, cloud, container, CI/CD, and supply-chain tasks. Use when the user asks to analyze prompt-to-tool flows, retrieval poisoning, mounted secrets, deployment drift, runtime-vs-manifest mismatches, registry provenance, or CI-produced artifacts within the authorized scope. Use directly when this Capability matches.
metadata:
  redtrace:
    capabilities: [ai-security]
---

# Agent Cloud

Use this skill directly for the matching security surface and keep conclusions tied to observable evidence.

Use this skill when the task path is driven by prompt-to-tool execution, retrieval and memory boundaries, deployment drift, or build and release provenance.

Reply in Simplified Chinese unless the user explicitly requests English.

## Quick Start

1. Decide whether the dominant path is agentic or infrastructure-driven.
2. Map one minimal control chain: untrusted input -> visible context -> tool or deployment side effect.
3. Distinguish checked-in intent from live runtime truth.
4. Keep prompts, tool args, manifests, mounts, and provenance steps in compact evidence blocks.
5. Reproduce the exploit or misconfiguration with minimal context and minimal instrumentation.

## Workflow

### 1. Agent And Prompt Injection

- Treat prompts, tool schemas, retrieved chunks, planner notes, memory files, and handoffs as task artifacts.
- Prove one minimal chain from untrusted content to model-visible instruction to tool side effect.
- Distinguish claimed capability from runtime-exposed capability.

### 2. Cloud, Containers, And CI/CD

- Split build-time, deploy-time, and runtime.
- Reconcile compose or kube manifests with live mounts, env, logs, and traffic.
- Trace provenance from source to dependency resolution to build to publish to runtime consumer.

## Read This Reference

- Load `references/agent-cloud.md` for the control-stack checklist, deployment-truth checklist, and evidence packaging.
- If the task is specifically about prompt-boundary abuse or retrieved-content-to-tool drift, prefer `$prompt-injection`.
- If the task is specifically about CI, dependency provenance, registry drift, or shipped artifacts, prefer `$supply-chain`.
- If the task is specifically about queue payloads, async worker drift, retries, or worker-only runtime state, prefer `$queue-worker-drift`.
- If the task is specifically about SSRF to internal control surfaces, metadata endpoints, or metadata-derived token pivots, prefer `$ssrf-metadata-pivot`.
- If the task is specifically about proxy-upstream parse differentials, ambiguous headers, path normalization drift, or request smuggling behavior, prefer `$request-normalization-smuggling`.
- If the task is specifically about metadata-service access, instance or workload identity, link-local token paths, or metadata-derived privilege, prefer `$cloud-metadata-path`.
- If the task is specifically about kube API permissions, service-account trust, admission behavior, controller drift, or cluster secret exposure, prefer `$k8s-control-plane`.
- If the task is specifically about live mounts, sidecars, init containers, or runtime-only secret exposure, prefer `$container-runtime`.
- If the task is specifically about container-to-host boundary crossing, kernel-surface prerequisites, or escape primitive verification, prefer `$kernel-container-escape`.

## What To Preserve

- Prompt snippets, retrieved chunks, planner transitions, and final tool args
- Compose or Kubernetes fragments tied to live mounts or routes
- Artifact hashes, dependency drift, CI steps, and the resulting runtime consumer
