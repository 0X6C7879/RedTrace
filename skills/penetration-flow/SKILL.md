---
name: penetration-flow
description: Structured web-application penetration-testing orchestration with infrastructure health checks, platform liveness validation via multi‑endpoint cross‑check, and Apache <Limit> verb bypass detection. Immediately confirms platform termination and transitions to offline deliverables—no wasteful recovery probes. Covers fingerprinting, CMS/modern credential acquisition, and delegates exploitation to specialist skills.
trust: provisional
---

# Penetration Testing Flow

## Trigger conditions

- Beginning a penetration test against a web application or API.
- Probing a target with unknown stack.
- After spinning up a fresh containerised target that must be validated.
- Encountering Basic Auth challenge or any `5xx` response with Apache headers.
- Receiving a `409 Conflict` response with `invalid_state` and `already finished` from any task management API endpoint.

## Applicability and scope

Any HTTP/HTTPS target. Branches by technology fingerprint. Excludes network-layer attacks.

## Workflow

### Phase -1 – Platform termination cross‑check

On first `409 Conflict` containing `already finished` from any task‑management API:

1. Perform a **single‑shot cross‑check** of four distinct probes, each attempted exactly once:
   - **VPN/tunnel health** – ping the tunnel gateway or equivalent connectivity check.
   - **Challenges list** – fetch the available challenge definitions.
   - **Start challenge** – attempt `POST /start` (or equivalent) for any challenge.
   - **Submit flag** – attempt `POST /submit` (or equivalent) with a dummy payload.
2. If **all four** probes return `409`, a timeout, or a tunnel‑down error, mark `platform_terminated` **permanently**.
3. Immediately halt **all** start, submit, close, and container‑lifecycle calls.
4. Jump directly to **Phase R – Termination recovery**.

*No retry, no interval‑based recovery loops – the cross‑check is definitive.*

### Phase 0 – Infrastructure health and blocking triage

Execute only when a start/stop API exists; otherwise skip to Phase 1.

1. **Baseline health probe** – `GET /` and a realistic `POST`. 2xx/3xx → healthy.  
2. **Apache verb bypass check (PRIORITY)**  
   Whenever a resource is protected by Basic Auth (`401`) or returns `5xx` with an `Apache`‑branded `Server` header, try `PUT`, `DELETE`, `PATCH`, `OPTIONS` **without** an `Authorization` header on the same path.  
   If any verb returns `200` with protected content, the target is exploitable via a `<Limit GET POST>` misconfiguration. **Bypass authentication and proceed directly to exploitation**; do not flag as `infrastructure_blocked`.  
   Distinguish Apache‑generated `500` from backend‑application `500`; a backend `500` must not prevent further probing.  
   This step **must** be executed before password enumeration or brute‑force attempts.  

3. **Smoke‑test** – detect missing‑schema or backend errors without marking blocked.  
4. **Start‑API health** – check for `resource_unavailable`, `504`. If the platform returns `409` `already finished`, treat as immediate termination → Phase R.  
5. **Retry protocol** – on non‑409 failure, close/stop the instance and start a fresh container. After three identical consecutive failures, mark `infrastructure_blocked`. Save all request/response logs. Release container. Retry each blocked target once late‑stage (< 10 min).  
6. **Post‑marking** – exclude blocked instances from attack cycles.

### Phase R – Platform termination recovery (offline‑first)

1. **Freeze lifecycle** – permanently stop all start, submit, close, and container‑lifecycle calls.  
2. **Inventory paths** – list every challenge exploitable but not completed. Write a self‑contained offline exploit script for each, with only the target address replaceable.  
3. **Restart playbook** – produce an ordered playbook (execution order, time per challenge, prerequisites, command to run each offline script after fresh container allocation).  
4. **Flag freshness** – note that previously captured flags are invalid after a platform reset; every exploit must re‑extract flags from scratch.  
5. **No recovery probes** – do **not** create any periodic probes to “wait for platform recovery”. The cross‑check in Phase -1 is definitive.  
6. **Offline review** – dedicate remaining time to: exploit‑script review, cross‑validation of dual reports, restart‑playbook completeness check, user handover documentation.  

Categorise each blocked challenge as `platform_terminated`, `docker_compose_defect`, or `external_service_blocked`.

### Phase 1 – Fingerprint the stack

Fetch `/` and two random paths; inspect headers and body. Probe technology markers (`/wp-login.php`, `/user/login`, `/api/v1/`, `/graphql`). Branch: CMS → Phase 3A; else → Phase 2.

### Phase 2 – Modern API reconnaissance

Fetch OpenAPI/Swagger schemas, GraphQL introspection. Identify unauthenticated endpoints, IDOR patterns, admin paths. If auth required → Phase 3B.

### Phase 3A – CMS credential acquisition (legacy/PHP)

**WordPress** – `POST /xmlrpc.php` enumeration, user enumeration via fault differentiation, weak passwords (≤10/user, ≤3/min), plugin inventory, unauthenticated CVE checks.  
**Drupal** – `/rest/`, user enumeration via `/user/password`, module fingerprinting.  
**Joomla** – login error differentiation, `/administrator/manifests/`.

### Phase 3B – Credential acquisition (non‑CMS)

Try default credentials, register a low‑privilege account, weak credentials (≤5 attempts/user), exposed config files (`.env`, `.git/config`).

### Phase 4 – Exploitation routing

Delegate to the appropriate skill: `exploit-rce`, `exploit-ssrf`, `exploit-auth-bypass`, `exploit-sqli`. File‑upload exploits → `exploit-rce` Phase 9.

### Phase 5 – Post‑exploitation and extraction

After code execution or file read, enumerate environment variables and flag paths (`/flag`, `/root/flag.txt`). Use single‑shot compound commands for ephemeral containers. In dual‑container architectures, pivot through the compromised container.

## Validation standard

| Phase | Passes when |
|-------|-------------|
| -1 | Cross‑check confirms permanent `platform_terminated`; all lifecycle calls halted. |
| 0 | Fresh instance returns 2xx/3xx; **or** Apache verb bypass yields `200`. |
| R | Lifecycle frozen, inventory created, offline scripts packaged, playbook written, handover docs prepared; **no recovery probes attempted**. |
| 1 | ≥ 2 independent markers agree. |
| 2 | OpenAPI/GraphQL introspection returns valid schema. |
| 3A | `system.listMethods` non‑empty; ≥ 1 user confirmed via fault differentiation. |
| 3B | Valid session token obtained; protected endpoint returns `200`. |
| 4 | Delegated skill’s own validation satisfied. |
| 5 | Flag or target data retrieved and readable. |

## Failure handling

- **Platform termination** – after a single‑shot multi‑endpoint cross‑check confirms all probes failed with `409`/timeout, permanently halt lifecycle calls, jump to Phase R, and **never retry**.  
- **Infrastructure‑blocked** – after three identical consecutive failures, mark and release the container. Retry once late‑stage; if still blocked, retire.  
- **Apache verb bypass fails** – if all unlisted verbs return `401/403`, apply the standard retry protocol. **Do not** mark `infrastructure_blocked` solely because of a backend `500` or a `401` on GET/POST.  
- **Fingerprint fails** – fall back to generic discovery (`robots.txt`, `sitemap.xml`, `.git/HEAD`); if still unknown, treat as legacy PHP.  
- **XML‑RPC disabled** – fall back to REST user endpoint (`/wp-json/wp/v2/users`) or `?author=` parameter.  
- **No users/credentials** – extend candidate lists; if empty, limit to unauthenticated vectors.  
- **Missed bypass vector** – if a Basic Auth challenge was encountered but verb bypass was not attempted, cross‑reference HTTP method‑fuzzing results (e.g., scan tags like `http_method_tamper`) to quickly expose hidden bypass paths.

## Safety boundaries

- **Authorisation** – test only within authorised scope; verify before any probe.  
- **Rate limiting** – ≤ 3 login attempts per user per minute; use multicall batching only to reduce requests, not accelerate brute‑force.  
- **No full dictionary attacks** – curated short lists (≤ 20 usernames, ≤ 10 passwords/user).  
- **Non‑destructive defaults** – Phases 0–3B are read‑only/low‑impact; exploitation follows delegated skill rules. Do not drop tables or disrupt live services without explicit authorisation.  
- **Ephemeral containers** – batch commands into single‑shot payloads.  
- **Infrastructure‑blocked targets** – once marked, exclude from all attack lists; never attempt vulnerability analysis on blocked instances.  
- **Apache verb bypass** – operate only with unauthenticated methods against the discovered path; no verb spraying (limited set: PUT, DELETE, PATCH, OPTIONS).  
- **Platform termination** – immediately cease all start, submit, close, and container‑lifecycle calls. After multi‑endpoint cross‑check confirms permanent termination, **zero recovery probes**; never resubmit previously captured flags.
