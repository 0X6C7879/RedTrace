---
name: claude-red-cloud
description: Authorized AWS, Azure, and GCP security assessment covering identity, exposed services, privilege paths, storage, secrets, and control-plane validation. Use when the task concerns cloud accounts, subscriptions, projects, IAM, metadata services, or cloud-native attack paths.
---

# Claude Red: Cloud

Use this Skill for scoped cloud discovery and evidence-driven validation across AWS, Azure, or GCP.

## Workflow

1. Confirm provider, tenant/account/project scope, regions, identities, rate limits, and prohibited actions.
2. Read [offensive-cloud.md](references/offensive-cloud.md), selecting only the provider and technique sections needed.
3. Establish the current identity and permissions before enumerating resources.
4. Map public exposure, IAM relationships, secrets, storage, workloads, metadata access, and privilege transitions with read-only APIs first.
5. Validate the least invasive transition that proves impact; separate effective permissions from policy text and simulated results.
6. Capture sanitized evidence, affected resource class, prerequisites, cleanup, and unverified boundaries.

## Tool readiness

Check required commands before use. If a tool is missing, follow RedTrace's common missing-tool bootstrap: search official documentation or releases online, choose an OS/architecture-compatible user-local installation, verify its checksum or provenance and run a version/smoke check, then reuse it. Do not guess command syntax, loop on installation, or block the assessment when a bounded fallback exists.

## Validation standard

Require provider-returned identity and resource evidence plus a reproducible, authorized check. Do not equate a broad-looking policy, scanner heuristic, or publicly named endpoint with exploitable access.

## Safety boundary

Do not alter organization policies, billing, logging, production data, or long-lived credentials unless explicitly authorized. Prefer temporary credentials and reversible, narrowly scoped tests.
