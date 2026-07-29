# General SRC Hypothesis Patterns

These patterns compress recurring case lessons into decisions. They contain no
target-specific route, account, identifier, or payload.

## Contents

- Priority signals
- Trust and authorization patterns
- State and transaction patterns
- Cross-function patterns
- Evidence and stopping rules

## Priority signals

Raise priority when evidence shows:

- a newly launched or recently changed business, activity, client, or API;
- a partner, test, campaign, edge service, or legacy interface with separate
  implementation or ownership;
- the same business operation implemented in multiple clients or versions;
- a high-value side effect guarded by a client-visible identifier or state;
- inconsistent responses, schemas, identity sources, or validation timing;
- little recent testing, or historical testing that covered only one channel or
  lifecycle stage.

Lower priority when proof would require prohibited noise, real-user exposure, or
irreversible effects, or when recent evidence covers the same invariant across the
same clients and states.

## Trust and authorization patterns

| Pattern | Decision question | Falsifiable hypothesis | Minimal evidence | Stop condition |
|---|---|---|---|---|
| Public identifier becomes identity | Does a public page, ranking, search, share, or profile expose a value later accepted as login, binding, recovery, or delegation identity? | The sensitive consumer treats a public identifier as proof instead of resolving it through the authenticated relation. | Two owned identities; producer provenance; one consumer comparison; resulting session/account subject | Stop after the consumer securely rejects it or one owned-account subject change is proven |
| Resource/owner/tenant substitution | Does the server authorize the target object after a client-supplied user, object, tenant, parent, or role value changes? | The operation trusts the supplied identifier without rechecking owner and tenant against the actor. | A-owned object; B control; single changed identifier; object provenance and side effect | Never enumerate; close after one cross-account owned object |
| Frontend-only restriction | Is a hidden button, page, menu, or role gate mirrored at the backend decision point? | A lower role can call the operation because only the client enforces the restriction. | Same operation under allowed and disallowed test roles; backend effect | Stop after backend denial or one bounded effect |
| Identity-source split | Do registration, binding, recovery, OTP, and login steps use the same subject source? | Verification is bound to one subject, while continuation/finalization accepts another client-controlled subject. | Identity-source matrix; owned A/B accounts; final mutation subject | Stop before taking over or locking any non-test account |
| Grant/reference as authorization | Does a file, share, export, invitation, order, or approval reference carry authority into another service? | The consumer accepts possession of a reference without checking current owner, tenant, audience, state, or expiry. | Controlled grant; unrelated test actor; consumer decision and resulting object | Stop after one owned object or secure rejection |

## State and transaction patterns

| Pattern | Decision question | Falsifiable hypothesis | Minimal evidence | Stop condition |
|---|---|---|---|---|
| Client-authoritative economics | Are price, amount, quantity, discount, variant, currency, or payment status recomputed from server records? | A valuable transition uses a client-controlled economic field directly. | Normal quote/order; one field changed; settled test amount and entitlement | Use the lowest allowed value; stop after one bounded discrepancy |
| Low-value context carried upward | Can a low-value item, eligible channel, promotional order, or partner benefit be combined with a higher-value object or alternate payment path? | Eligibility is checked for one object/context but not bound at final use. | Two test products/contexts; unchanged eligibility reference; final order binding | Do not repeat or stack benefits after proof |
| Creation-only validation | Which rules are checked at create versus pay, confirm, activate, fulfill, refund, or approve? | A later high-value transition assumes stale creation checks and does not revalidate current price, ownership, eligibility, limit, or state. | State map; control flow; one later transition under changed precondition | Stop at the first proven stale-check effect |
| Replay/order confusion | Are one-time grants, orders, coupons, or transitions bound to state and invalidated atomically? | A previously valid artifact can be reused, reordered, or continued after cancellation/revocation. | One test artifact; normal use; one bounded replay or reordered step; ledger/state | Stop after one duplicate effect or secure idempotent response |
| Cross-account continuation | Can one account initiate and another continue or finalize a flow? | Flow state is bound to client data or a loose reference instead of the initiating subject. | Owned A/B accounts; same flow identifier; final subject and side effect | Stop after one test-account mismatch |
| Minimal concurrency | Is the invariant enforced atomically at the side-effect boundary? | Two simultaneous uses both pass a check that should permit one effect. | Stable serial baseline; smallest concurrent pair; authoritative ledger | Run only if allowed; stop after one duplicate or atomic rejection |
| Client/version drift | Are Web, App, mini-program, partner, old API, new API, callback, and job paths equivalent? | One path omits an invariant enforced by the canonical path. | Same actor/object/state across two in-scope paths; server-side result | Do not broaden to every version after the drift is located |

## Cross-function patterns

Use the producer-consumer rule:

> If function P returns a security-relevant value, identify every in-scope
> function C that accepts the same semantic value. Ask whether C verifies the
> relationship that P merely reveals.

Prioritize these edges:

- public listing/share/profile -> identity, binding, recovery, delegation;
- order/list/export -> object modification, cancellation, refund, fulfillment;
- upload/file handle -> preview, import, sharing, processing, export;
- product/quote/promotion -> order, payment, entitlement, refund;
- invitation/approval reference -> membership, role, activation, data access;
- one client/API schema -> another client's sensitive operation.

Model a chain as individually verified links. Do not claim a complete attack chain
because two endpoints share a parameter name. Confirm the value's meaning,
provenance, and consumer decision with owned data.

## Composite hypothesis templates

### Cross-account authorization

```text
Given B is authenticated and A owns object O,
when only the ownership-bearing input changes from B's object to O,
the server should reject without revealing or changing O.
A response tied to O plus a durable read/write side effect would violate the
owner/tenant invariant.
```

### Identity lifecycle

```text
Given verification grant G was issued for subject A,
when continuation or finalization claims subject B,
the server should derive A from G and reject the mismatch.
A mutation/session for B would show a subject-binding failure.
```

### Transaction state

```text
Given transition T requires server state S and invariant I,
when a stale, skipped, replayed, or alternate-channel request reaches T,
the server should reload S and enforce I.
A durable value/entitlement/state change without I would show validation drift.
```

### Cross-function trust

```text
Given producer P reveals reference R without granting authority,
when unrelated test actor B supplies R to consumer C,
C should independently verify owner, tenant, audience, state, and expiry.
Acceptance with an owned-object side effect would verify the trust-chain break.
```

## Evidence and stopping rules

- Use two accounts or roles when attribution or ownership is the claim.
- Record the expected owner, tenant, state, and side effect before the variation.
- Treat status, text, object data, and side effect as separate observations.
- Repeat only to resolve a concrete alternative explanation such as cache or
  eventual consistency.
- Record a secure rejection as a bounded negative result, not as proof that every
  endpoint or state is safe.
- After two controlled secure outcomes with no new signal, close or deprioritize
  the hypothesis instead of changing payloads indefinitely.
- After one controlled invariant violation, stop expanding the sample and prepare
  evidence.
