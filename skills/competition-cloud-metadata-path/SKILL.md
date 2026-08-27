---
name: competition-cloud-metadata-path
description: Competition skill. CTF-sandbox workflow for cloud metadata services, instance identity, workload identity, link-local credential paths, role assumption, and metadata-to-privilege trust edges. Use when the user asks to inspect metadata-service access, instance credentials, pod or workload identity, link-local token paths, SSRF-to-metadata escalation, or explain how metadata-derived credentials turn into accepted cloud or control-plane privilege. Use directly when this Capability matches; the active Competition Profile supplies sandbox assumptions and evidence priorities.
metadata:
  redtrace:
    capabilities: [cloud]
    competition: true
---

# Competition Cloud Metadata Path

Use this skill directly for the matching challenge surface. The active Competition Profile supplies sandbox assumptions, node ownership, and evidence priorities.

Use this skill when the decisive edge is not just reaching metadata, but proving how metadata-derived identity becomes accepted privilege.

Reply in Simplified Chinese unless the user explicitly requests English.

## Quick Start

1. Identify which metadata surface is active: instance metadata, workload identity, node identity, task role, or platform-specific token endpoint.
2. Record the exact reachability path: local process, pod, container, proxy, SSRF surface, or host route.
3. Separate metadata reachability from credential issuance and from downstream privilege acceptance.
4. Keep token format, role identity, scope, and accepting API in compact evidence blocks.
5. Reproduce the smallest metadata-to-accepted-privilege path that proves the challenge edge.

## Workflow

### 1. Map Metadata Reachability

- Record the metadata endpoint, required headers, hop limits, session tokens, workload selectors, or path prefixes.
- Note whether access comes from direct local calls, pod networking, SSRF, sidecar, or host-level routing.
- Keep the reaching surface and the metadata endpoint in one chain.

### 2. Prove Credential Or Identity Issuance

- Show how the metadata response becomes a token, temporary credential, signed identity doc, or platform-specific workload identity.
- Record expiration, role name, subject, audience, issuer, or cloud account mapping that matters downstream.
- Distinguish raw metadata from usable credential material.

### 3. Reduce To The Decisive Trust Path

- Compress the result to the smallest sequence: reaching surface -> metadata call -> credential issued -> accepted cloud or cluster action.
- State clearly whether the weakness lives in reachability, metadata config, role trust, downstream policy, or workload binding.
- If the challenge narrows to RBAC or cluster mutation after credential issuance, switch back to the tighter control-plane skill.

## Read This Reference

- Load `references/cloud-metadata-path.md` for the reachability checklist, token checklist, and evidence packaging.
- If the hard part is first proving a server-side fetch primitive, SSRF reachability, or internal endpoint traversal before metadata itself, prefer `$competition-ssrf-metadata-pivot`.

## What To Preserve

- Metadata endpoints, required headers, reachability path, issued tokens or creds, and accepted APIs
- Role names, audiences, issuers, account bindings, and privilege-bearing actions
- The smallest replayable metadata-to-privilege chain
