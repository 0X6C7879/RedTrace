---
name: src-hunting
description: Guide authorized enterprise SRC and bug-bounty hunting through asset prioritization, business-object and state-machine modeling, trust-boundary analysis, differential testing, bounded vulnerability hypotheses, minimal validation, cross-function attack-chain reasoning, evidence capture, RedTrace Fact/Intent collaboration, and report preparation. Use for long-running or multi-Worker SRC assessments of web, App, mini-program, API, partner, activity, test, or legacy business surfaces, especially identity, authorization, tenant, order, payment, refund, coupon, points, file, export, sharing, binding, and approval workflows. Invoke exploit-specific Skills only after a concrete vulnerability class is identified.
---

# SRC Hunting

Start from business invariants and trust boundaries. Do not treat request volume,
scanner findings, HTTP 200 responses, or a long vulnerability checklist as progress.

## Trigger conditions

Use this Skill when the task is an explicitly authorized enterprise SRC,
bug-bounty, security assessment, or test-environment investigation and the goal is
to understand business behavior, generate high-value vulnerability hypotheses,
validate them safely, connect functions into attack chains, or prepare auditable
findings.

Use another exact `exploit-*` Skill only after evidence identifies a concrete
vulnerability class. Keep this Skill responsible for prioritization, business
context, safety, evidence, and graph coordination.

## Applicability and scope

Before active testing, record:

- authorized assets, clients, API versions, accounts, roles, tenants, dates, and
  test window;
- program rules, exclusions, rate/concurrency limits, forbidden actions, and
  emergency stop conditions;
- whether payment, messaging, file processing, export, approval, concurrency, and
  third-party systems may be exercised;
- available test accounts/data and the owner of each test object.

If authorization or a material boundary is unknown, remain in advisory mode:
analyze supplied artifacts and prepare hypotheses without contacting the target.
Never infer that a related domain, partner system, test environment, or old API is
in scope.

## Workflow

### 1. Align with the task graph

Read the current Goal, confirmed Facts, open Intents, Hints, and assigned Intent.
Do not create a parallel task-state or memory store.

- In a Reason task, propose a small number of independent Intents, each covering
  one high-value hypothesis or non-overlapping trust boundary.
- In an Explore task, work only on the assigned Intent. Reuse existing evidence
  and avoid repeating another Worker's baseline or failed boundary.
- Conclude with the smallest confirmed incremental result. Put large or sensitive
  raw material in a protected evidence artifact and reference it.
- Query shared state only when newer context would change the next action; never
  poll it.

For long tasks, keep lanes independent, for example: identity lifecycle,
object/tenant authorization, transaction state, and cross-client/cross-function
trust. Split by hypothesis, not by arbitrary tool or URL batches.

### 2. Rank exploration surfaces

Score each candidate surface from 0 to 3 on:

- `F` freshness: recent launch/change or uncertain maturity;
- `V` business value and consequence of a broken invariant;
- `S` data/account/financial sensitivity;
- `C` trust complexity across roles, tenants, services, clients, or partners;
- `G` validation gap: little recent testing or inconsistent historical coverage;
- `R` operational risk/noise required for proof.

Use `priority = 2F + 2V + 2S + C + G - 2R` only as a triage aid. Record the
evidence behind each score; do not manufacture precision. Prefer high-value,
low-risk workflows and then newly launched activities, partner/test surfaces, and
legacy or versioned APIs where validation gaps are plausible. Deprioritize a
well-covered surface unless new behavior, a new client, or a new trust edge
changes the model.

### 3. Model objects, authority, and state

Read [business-modeling.md](references/business-modeling.md) when the task contains
accounts, roles, tenants, orders, money, files, sharing, binding, or approvals.

For every important operation, identify:

1. actor, authenticated principal, effective role, tenant, and channel;
2. target object, owner, tenant, identifiers, parent objects, and current state;
3. client-controlled fields and server-authoritative fields;
4. the source of identity and ownership used at each step;
5. the permission decision point and required business invariant;
6. direct and delayed side effects, including messages, balances, entitlements,
   files, audit records, and downstream jobs.

Build a state machine for registration, login, binding, password recovery, order,
payment, refund, coupon, points, upload, export, sharing, and approval flows that
matter to the Goal. Mark preconditions and authority checks on every transition,
not only at creation.

### 4. Establish bounded controls

Use owned test objects and at least two authorized accounts when ownership or
identity is in question. Capture a stable baseline before changing anything.

Compare only dimensions that can change the security decision:

- account A versus account B;
- user versus privileged role;
- tenant A versus tenant B;
- before versus after a state transition;
- Web versus App versus mini-program;
- old versus new API version;
- fresh versus expired/revoked credential.

Change one variable at a time and keep the remaining request context stable.
Record the expected owner and expected side effect before testing. Do not use
unrelated real-user objects merely because their identifiers are visible.

### 5. Express a falsifiable hypothesis

Write every direction in this compact form:

```text
H-ID / title:
Premise + evidence:
Actor, object, owner, state, channel:
Trust boundary / decision point:
Security invariant:
Controlled variable:
Safe expected result:
Vulnerable expected result:
Evidence required:
Verified impact / inferred impact:
Cost and risk:
Stop conditions:
Status and confidence:
```

A good hypothesis names one invariant and one controlled variable. It can be
disproved. It states what evidence would distinguish a secure rejection from an
unsafe success and stops before unnecessary impact.

Read [hypothesis-patterns.md](references/hypothesis-patterns.md) when generating or
ranking hypotheses. Use its patterns as decision rules and questions, not as a
payload list.

### 6. Validate minimally and differentially

Prefer passive review, normal feature use, replay against owned objects, and
single-variable comparisons. For an ownership hypothesis:

1. create or identify an object owned by test account A;
2. prove A can perform the normal operation;
3. prove test account B's own baseline is stable;
4. use B against A's object while changing only the ownership-bearing input;
5. verify the returned object's provenance and the actual business side effect;
6. repeat once only when needed to rule out caching, eventual consistency, or a
   stale client view.

Judge transport status, response semantics, object fields, owner/tenant identity,
and durable side effects together. HTTP 200, a success string, or a changed UI
alone never confirms a vulnerability.

For a state-machine hypothesis, exercise the smallest safe transition that tests
step skipping, replay, ordering, expired credential reuse, cross-account
continuation, or validation drift. Use concurrency only when rules allow it and a
non-concurrent baseline plus the smallest pair of controlled requests can answer
the question.

### 7. Connect trust across functions

Treat each output field as a possible input to another function. Build a bounded
data-flow edge:

```text
producer function -> value and meaning -> consumer function
-> consumer's trust decision -> resulting object/state/side effect
```

Prioritize identifiers, reset/binding artifacts, share references, order or
payment context, role/tenant fields, file handles, export references, and business
eligibility parameters. A chain is valuable when individually normal functions
cross a trust boundary together. Confirm each link with test data and distinguish
the verified chain from plausible extensions.

### 8. Route exact technical depth

After the primitive is concrete, load only the matching existing Skill:

- business-state, pricing, coupon, order, refund, or race primitive:
  `exploit-logic`;
- confirmed SQL injection, SSRF, XSS, SSTI, XXE, or RCE direction:
  `exploit-sqli`, `exploit-ssrf`, `exploit-xss`, `exploit-ssti`,
  `exploit-xxe`, or `exploit-rce`;
- another exact class: load its single matching `exploit-*` Skill.

Do not scan or load the whole Skill catalog. Do not duplicate payloads, scanner
usage, bypass catalogs, or exploit internals into this Skill.

### 9. Close the loop

Promote a hypothesis only when the evidence meets the validation standard below.
Stop expanding impact immediately after proof. Record:

- confirmed behavior and exact tested bounds;
- evidence references and redaction status;
- confidence and alternative explanations ruled out;
- verified impact separately from inferred impact;
- excluded hypotheses and their tested boundary;
- the next highest-value, non-overlapping direction;
- cleanup or rollback completed.

Read [fact-graph-and-reporting.md](references/fact-graph-and-reporting.md) for
Fact, Intent, Hint, evidence, confidence, finding, and report-ready templates.
Read [evolution.md](references/evolution.md) only at the final Skill feedback
checkpoint or when preparing a verified evolution candidate.

## Validation standard

Classify results as:

- **Confirmed**: a controlled test reproducibly violates the named invariant and
  proves the object provenance or business side effect with bounded evidence.
- **Not supported in tested conditions**: a stable control and one justified
  variation produced the secure outcome; state the exact boundary tested.
- **Inconclusive**: caching, unstable state, missing authority, ambiguous object
  provenance, or forbidden validation prevents a decision.
- **Hypothesis**: a reasoned lead not yet validated; never report it as a Fact.

Use high confidence only when controls, ownership/state, and side effects agree.
Use medium confidence when the primitive is confirmed but an impact boundary
cannot safely be exercised. Keep low-confidence leads as Intents or Hints.

## Failure handling

- If a baseline is unstable, restore the known state once or choose a cleaner
  owned object; otherwise mark the result inconclusive.
- If a response changes without a matching object or side effect, investigate
  caching, localization, asynchronous processing, or generic success handling
  before continuing.
- If two controlled variations produce the secure outcome and no new evidence
  changes the model, record the tested boundary and deprioritize or close the
  hypothesis. Do not rotate payloads indefinitely.
- If rate limiting, account lock risk, payment, messaging, destructive state, or
  real-user exposure would be required, stop and use a test environment, mock,
  or report the bounded evidence.
- If scope or program rules conflict with a proposed test, stop that branch rather
  than bypassing the restriction.

## Safety boundaries

- Operate only under explicit authorization and current SRC rules.
- Prefer low-noise, low-risk, reversible, minimal tests and owned test data.
- Do not perform destructive actions, denial of service, persistence, mass
  scanning, credential attacks, bulk reads, or bulk modification of user data.
- Do not send uncontrolled payments/messages or trigger costly downstream jobs.
- Do not increase sample size after the invariant and bounded impact are proven.
- Redact secrets, cookies, tokens, personal data, and complete sensitive
  responses. Preserve only the minimum evidence necessary for audit.
- Never convert an inference into a confirmed impact or use automation volume as
  the success metric.
