# Business Modeling for SRC Hunting

Use this reference only for the business domains present in the assigned Intent.

## Contents

- Object and relationship map
- Authority and field map
- Identity-source map
- State-machine construction
- Differential test matrix

## Object and relationship map

Represent a business operation as:

```text
actor --role/session/channel--> action
action --targets--> object --owned by--> user/tenant
object --belongs to / derives from--> parent object
action --changes--> state/value/entitlement
action --emits--> message/file/job/audit/downstream call
```

Record only properties that affect a security decision.

| Object family | Typical objects | Questions that expose trust boundaries |
|---|---|---|
| Identity | user, session, login method, device, verification challenge, reset/binding grant | Which identity is authenticated, claimed, verified, and finally modified? Are they the same at every step? |
| Authorization | role, permission, tenant, organization, membership, delegated relation | Who owns the resource? Is authorization checked against the effective actor and current tenant at the point of use? |
| Commerce | product, SKU, cart, order, quote, payment, refund, invoice, entitlement | Which fields are authoritative? Where are price, eligibility, inventory, ownership, and state revalidated? |
| Benefit | coupon, promotion, points, balance, quota, membership | Is the benefit bound to user, tenant, product, channel, time, and lifecycle state? Can it be replayed or carried elsewhere? |
| Content/data | file, upload handle, export, report, media, download grant | Does a reference carry authorization, or does the consumer re-check owner, tenant, visibility, and expiry? |
| Collaboration | share, invitation, binding, delegate, approver, approval request | Who issued and may redeem the grant? Can a different account or state continue the flow? |
| Catalog | product, variant, quantity, inventory, region, partner offer | Can a low-value or eligible context be detached and applied to another object? |
| Workflow | draft, submission, review, approval, activation, cancellation | Which transition owns each invariant, and which later transitions assume an earlier check? |

For every relevant object, capture:

```text
Object:
Identifiers and aliases:
Owner and tenant:
Parent/child relationships:
Visibility:
Lifecycle states:
Allowed actors/actions:
Authoritative fields:
Derived or cached fields:
Sensitive data:
Direct and delayed side effects:
Evidence reference:
```

## Authority and field map

Classify every security-relevant field by source and use.

| Field | Supplied by | Authoritative source | Decision that consumes it | Owner/tenant bound? | Revalidated at use? | Side effect |
|---|---|---|---|---|---|---|
| actor identity | session, token, signed assertion | authentication service | access and audit | n/a | every sensitive operation | attribution |
| target identity | path/body/query/client state | server lookup from authorized relation | account change or delegation | required | at final mutation | account state |
| resource id | route/body/reference | object store | read/write/transition | required | every operation | data/state |
| role/tenant | token, route, header, client choice | membership/authorization service | permission scope | required | current membership | privilege |
| price/amount | quote/client display | pricing/order service | settlement/refund | order/product bound | each financial transition | money |
| quantity/variant | cart/client | catalog/inventory/order service | eligibility and fulfillment | order bound | creation and confirmation | inventory/value |
| discount/points | client or benefit reference | promotion/ledger service | settlement | user/product/channel bound | reservation and redemption | value |
| payment status | callback/client | verified payment record | fulfillment/refund | order bound | before side effect | entitlement/money |
| file/share ref | URL/client | file/share service | read/export/process | owner/visibility bound | each redemption | data |
| approval state | client/workflow | workflow engine | activation/release | request and approver bound | transition-time | business effect |

Ask six questions at each decision:

1. Can the client choose this field?
2. Does the server derive it independently?
3. Is the authenticated actor the same identity used for the decision?
4. Is ownership or tenant membership checked on the exact target object?
5. Is the invariant checked again at the irreversible or valuable transition?
6. Can a stale cache, alternate service, or downstream consumer bypass the check?

## Identity-source map

Create a row for every step of registration, login, binding, recovery, verification,
sharing, invitation, or approval:

| Step | Claimed identity | Authenticated identity | Verified channel/object | Stored grant subject | Final mutation subject | Credential binding |
|---|---|---|---|---|---|---|
| initiate | source and value | principal/session | channel selected | expected subject | none | state/nonce |
| verify | source and value | principal/session | proof consumed | actual subject | none | expiry/use count |
| continue | source and value | principal/session | prior grant | subject loaded | proposed target | account/session/channel |
| finalize | source and value | principal/session | grant rechecked | subject loaded | actual target | revoked after use |

Treat any disagreement between columns as a hypothesis source. In particular,
check whether a later step trusts a client field instead of the subject bound to
the prior verified grant.

## State-machine construction

For each material flow:

1. List states observed from UI, API responses, object fields, and side effects.
2. List transitions and the endpoint/client/version that performs each one.
3. Attach actor, owner, prerequisites, authority checks, idempotency/replay rule,
   expiry, and side effects to every transition.
4. Mark irreversible or high-value transitions.
5. Compare the same transition across Web, App, mini-program, old API, new API,
   partner service, asynchronous callback, and scheduled job only when in scope.

Use this transition record:

```text
from_state -> action -> to_state
actor / role / tenant:
object / owner:
required prior evidence:
server-authoritative inputs:
client-controlled inputs:
authorization and invariant checks:
credential freshness and one-time use:
idempotency / concurrency control:
direct and delayed side effects:
alternate clients or versions:
```

Generate hypotheses from:

- skipped transitions or direct access to later steps;
- repeated or reversed transitions;
- expired, revoked, or already-used grants;
- continuation under a different account, tenant, role, or device;
- duplicate execution or a minimal race;
- validation present at create but missing at pay, confirm, activate, refund, or
  approve;
- different checks across clients, API versions, services, or callbacks.

## Differential test matrix

Choose the smallest matrix that can distinguish the hypothesis:

| Dimension | Control | Variation | Evidence required |
|---|---|---|---|
| account | A acts on A object | B acts on A object | owner/tenant and durable side effect |
| role | allowed role | lower or unrelated role | backend authorization result |
| tenant | actor and object in tenant A | actor in B, object in A | current membership and object tenant |
| state | valid predecessor state | skipped/replayed/expired state | transition history and final state |
| channel | canonical client/API | alternate client/version | same object, actor, and invariant |
| credential | fresh and correctly bound | stale/reused/cross-account | subject, expiry, use count, mutation target |
| economics | server-generated quote/order | one client field changed | settled amount and entitlement |

Do not combine dimensions in the first validation. A multi-variable request may
show a symptom but cannot identify which trust decision failed.
