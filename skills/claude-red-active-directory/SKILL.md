---
name: claude-red-active-directory
description: Authorized Active Directory security assessment for identity discovery, trust and privilege-path analysis, credential exposure checks, and minimally invasive validation. Use for Windows domain, Kerberos, LDAP, AD CS, delegation, or lateral-movement questions; do not use for generic host exploitation.
---

# Claude Red: Active Directory

Use this Skill to turn an authorized AD objective into a scoped discovery and validation workflow.

## Workflow

1. Confirm domains, forests, accounts, hosts, allowed techniques, and stop conditions.
2. Read [offensive-active-directory.md](references/offensive-active-directory.md) and select only the sections relevant to the objective.
3. Enumerate identity, trust, delegation, certificate-service, and privilege relationships before attempting validation.
4. Rank paths by reachability, required privilege, blast radius, and evidence quality.
5. Validate the smallest safe step that proves or disproves the path. Avoid domain-wide changes and disruptive authentication activity unless explicitly authorized.
6. Record prerequisites, sanitized commands, evidence, negative results, cleanup, and the exact boundary of any unverified claim.

## Tool readiness

Check required commands before use. If a tool is missing, follow RedTrace's common missing-tool bootstrap: search official documentation or releases online, choose an OS/architecture-compatible user-local installation, verify its checksum or provenance and run a version/smoke check, then reuse it. Do not guess command syntax, loop on installation, or block the assessment when a bounded fallback exists.

## Validation standard

Accept a finding only when the identity path and its prerequisites are reproducible from collected evidence. Treat graph-only reachability, stale directory objects, and untested privilege assumptions as hypotheses.

## Safety boundary

Operate only within the authorized domain scope. Prefer read-only enumeration and reversible checks; do not persist access, exfiltrate unrelated credentials, or weaken production controls.
