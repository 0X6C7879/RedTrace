# Penetration Flow Workflow

## Phase 0 — Intake and ROE

Capture:

- Objective: what decision the assessment must support.
- Scope: assets, CIDRs, domains, repos, apps, accounts, artifacts, environments.
- Authorization: owner, dates, allowed windows, forbidden actions, rate limits.
- Constraints: production sensitivity, test data, logging contacts, emergency stop.
- Deliverables: interim report, final report, reproduction package, executive summary.

If active testing is not yet approved, limit work to passive review, artifact analysis, threat modeling, documentation review, and report planning.

## Phase 1 — Analysis

Produce an assessment map:

- Asset inventory and trust boundaries.
- Entry points and exposed interfaces.
- Authentication and authorization surfaces.
- Data flows and sensitive assets.
- Dependency and supply-chain exposure.
- Known vulnerability leads with source and confidence.
- Reverse-engineering candidates: binaries, APK/IPA, firmware, captures, macros, protocols, obfuscated scripts.

Output an evidence table and a hypothesis backlog.

## Phase 1.5 — Known-Vulnerability Research

Before original vulnerability discovery or custom exploit development, convert every
actionable fingerprint into a bounded known-vulnerability search:

- Capture the product, component, version or build, platform, configuration,
  protocol/banner, headers, dependency versions, hashes, and distinctive errors.
- Check the shared task graph first so another Worker's completed research is reused.
- Perform a live search of vendor advisories, CVE records, Exploit-DB, public PoC
  repositories, and reputable research; preserve URLs and publication dates.
- Do not install, clone, or synchronize bulk vulnerability databases, PoC
  collections, or complete template repositories. Fetch only the specific
  candidate PoC/EXP or exact validation template selected by online research.
- When using Nuclei, pass the exact fetched template path and do not invoke
  automatic template discovery, installation, synchronization, or update.
- Match affected versions, prerequisites, authentication, configuration, target
  platform, and expected success signals against observed evidence.
- Inspect PoC/EXP source and dependencies before running it. Reject opaque,
  mismatched, or unrelated code with a recorded reason.
- Run the smallest available PoC first. If it confirms the vulnerability, continue
  with the matching EXP or adapt the verified primitive to achieve the current
  authorized objective.
- Only pivot to original exploit development after bounded searches find no
  applicable candidate or applicable candidates fail with captured evidence.

Record fingerprint, query, source, applicability, PoC result, EXP result, and
evidence references as shared Facts/Intents. The PoC-to-EXP transition does not
require a separate approval pause when exploitation is already in scope.

## Phase 2 — Report Snapshot

After every meaningful step, produce a compact snapshot:

- What changed since last snapshot.
- Evidence collected.
- Confirmed findings and severity.
- Unconfirmed leads.
- Risk to schedule/scope.
- Recommended next step.

## Phase 3 — Deep Penetration

Pick one lane at a time:

- Web/API: authn/authz, session, input validation, business logic, SSRF, file handling, deserialization, CORS, GraphQL, rate limits.
- Network/internal: exposed services, segmentation, weak protocols, credential hygiene, AD/Kerberos review when in scope.
- Cloud/container: IAM, storage, metadata access, secrets, CI/CD, image provenance, Kubernetes RBAC/network policies.
- Code/dependency audit: dangerous sinks, unsafe deserialization, injection, path traversal, crypto misuse, secrets, third-party CVEs.
- Reverse engineering: follow `reverse-engineering.md`.
- Configuration review: default credentials, debug flags, missing hardening, unsafe headers, permissive policies.

Before executing a test, state: target, method, expected signal, risk, rollback/stop condition.

## Phase 4 — Vulnerability Reporting

Promote a lead to a finding only when evidence supports:

- Affected asset/component/version.
- Preconditions and required privileges.
- Reproduction summary.
- Impact and business consequence.
- Severity rationale, preferably CVSS plus context.
- Remediation and verification steps.

## Phase 5 — PoC Validation and Exploitation

Use the smallest applicable PoC first to confirm the security property:

- Match its expected success signal to captured target evidence.
- Record the exact inputs, outputs, version assumptions, and result.
- If it confirms the vulnerability and exploitation is already in scope, continue
  directly with the matching EXP or adapt the verified primitive to achieve the
  current objective; do not add a second approval pause.
- Avoid actions unrelated to the objective and preserve rollback or stop conditions.
- Prefer screenshots/logs/hashes over unnecessary bulk output.

Document exact bounds, inputs, outputs, timestamps, and cleanup.

## Phase 6 — Continue or Escalate

Continue automatically while the next action stays within the current objective and
authorization. Use the menu from SKILL.md only when the objective is complete,
genuinely blocked, or requires a materially different scope or authority. If the
user supplies new evidence, return to analysis.
