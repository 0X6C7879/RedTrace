# Fact Graph, Evidence, and Reporting

Use these templates to keep long, multi-Worker hunts verifiable and resumable.
RedTrace's graph remains the only shared source of task truth.

## Contents

- Multi-Worker partitioning
- Evidence records
- Fact, Intent, and Hint rules
- Confidence and excluded hypotheses
- Finding and report preparation

## Multi-Worker partitioning

Create an Intent only when it is:

- derived from one or more current Facts;
- high-value and bounded by a clear invariant;
- independently executable with owned data;
- non-overlapping with open Intents;
- equipped with a validation signal and stop condition.

Good partitions follow independent trust decisions:

```text
Identity subject binding in recovery and account binding
Owner/tenant enforcement for file and export objects
Price/eligibility revalidation from order creation through fulfillment
Parity of one high-value transition across canonical and legacy APIs
Producer-consumer trust edge from sharing to a sensitive operation
```

Avoid partitions such as "scan all APIs", "try more payloads", or separate Workers
testing the same invariant with different tools.

Before work, check whether another Fact already confirms the result, an open Intent
owns the direction, or a prior bounded failure makes the proposed test redundant.
At conclusion, publish only the incremental result from the assigned Intent.

## Evidence records

Keep raw evidence outside the Fact description. Reference it by stable evidence ID
or protected workspace path.

```text
Evidence ID:
Captured at:
Authorized asset/channel/API version:
Test actors, roles, tenants (aliases only):
Object alias and expected owner:
Pre-state:
Controlled variable:
Request/interaction summary:
Response status and semantic result:
Returned object provenance:
Observed direct/delayed side effect:
Post-state:
Redactions:
Hash or immutable reference:
```

Store the minimum necessary excerpt. Mask cookies, tokens, credentials, personal
data, full payment details, and unrelated response fields. Do not copy secrets or
complete sensitive responses into Facts, Intents, Hints, or reports.

## Fact rules

A Fact is a confirmed objective conclusion, not a lead, plan, raw response, or
confidence guess. Make it compact and causal:

```text
[CONFIRMED] Under <actor/role/tenant/state/channel> and within <tested bound>,
changing <single variable> caused/did not cause <authoritative object or side
effect>, establishing <violated or enforced invariant>. Evidence: <refs>.
Limits: <what was not tested or inferred>.
```

A negative result may be a Fact when it confirms a precise tested boundary:

```text
[BOUNDARY] With test account B and an A-owned object in <state>, the service
rejected the cross-account operation and produced no observed side effect in one
control plus two bounded variations. Evidence: <refs>. This does not establish
safety for other states, clients, or API versions.
```

Never create a Fact for "possibly vulnerable", a bare HTTP 200, or an impact that
was not observed.

## Intent rules

Use an Intent for a falsifiable next direction:

```text
Test whether <decision point> derives <authority/state/value> from
<server-authoritative source> or trusts <client/other-service source>, using
<owned controls and single variable>. Confirm via <object provenance/side effect>;
stop on <secure result, proof, or safety boundary>.
```

Link the Intent from every Fact required for its premise. Keep unrelated
hypotheses separate so Workers can execute them independently.

## Hint rules

Use a Hint for graph-external coordination, not objective truth:

- current priority ranking and why it changed;
- a cluster of excluded or deprioritized hypotheses;
- scope/rules clarification supplied externally;
- an alternative explanation that a future Worker must control;
- a recommended next direction that is not yet ready as an Intent.

Do not use Hints as a second evidence database.

## Confidence and excluded hypotheses

Attach confidence to the assessment summary, not as a substitute for evidence:

| Confidence | Required basis |
|---|---|
| High | stable controls, correct object/owner/state attribution, reproducible invariant violation, and authoritative side effect |
| Medium | primitive confirmed, but a material impact boundary was intentionally not exercised or a delayed effect remains bounded |
| Low | incomplete provenance, unstable state, or untested assumptions; keep as hypothesis rather than confirmed finding |

Record exclusions:

```text
Hypothesis ID:
Tested actor/object/state/channel:
Controls and variations:
Observed secure behavior:
Evidence:
Alternative explanations still open:
Scope not covered:
Reason to close or deprioritize:
```

"Not supported" means only the stated conditions were tested. Do not generalize a
single secure path to all objects, roles, states, clients, or versions.

## Finding promotion gate

Prepare a finding only when all applicable items are known:

- affected in-scope asset, client, and API/business flow;
- actor, privileges, owner/tenant, object, and pre-state;
- violated security/business invariant and decision point;
- minimal reproduction using owned test data;
- authoritative response/object provenance and actual side effect;
- evidence references with redactions;
- verified impact separated from inferred impact;
- exact tested bounds, cleanup, and stopping point;
- severity rationale tied to demonstrated business consequence;
- remediation at the correct authority or state-transition boundary.

If provenance or side effect is ambiguous, keep the item as a hypothesis.

## Report-ready structure

```text
Title:
Summary:
Authorization and tested scope:
Affected business flow and assets:
Preconditions and required privileges:
Business objects, owners, tenants, and states:
Violated invariant / trust boundary:
Minimal reproduction:
Expected secure behavior:
Observed behavior:
Verified impact:
Inferred impact (clearly labeled):
Evidence references and redactions:
Alternative explanations ruled out:
Tested limits and stop point:
Cleanup:
Severity rationale:
Remediation:
Retest guidance:
```

Recommend remediation that restores server authority:

- derive identity from the authenticated session or a correctly bound grant;
- authorize the exact object and current tenant at every sensitive operation;
- recompute economic values from server records;
- bind benefits/references to actor, object, channel, state, audience, and expiry;
- revalidate invariants at irreversible transitions;
- make one-time operations atomic and idempotent;
- enforce equivalent checks across clients, API versions, callbacks, and jobs;
- log rejected and successful security-relevant transitions without exposing
  sensitive values.
