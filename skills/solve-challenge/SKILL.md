---
name: solve-challenge
description: |
  Universal CTF challenge dispatcher with hardened one‑shot platform‑termination handling,
  Blackboard‑coordinated multi‑worker termination guard, cross‑instance blockade detection,
  batch infrastructure pre‑sweep, and delegation to specialist skills.
  On HTTP 409 invalid_state “task already finished” immediately sets a persistent Blackboard
  termination flag, writes the local `platform_terminated.flag`, cancels all probes, produces
  a complete offline deliverable package exactly once within the same Intent, and then
  hard‑stops—any subsequent Intent that queries the Blackboard flag before starting network
  activity jumps directly to offline delivery without any VPN pre‑checks or API probing.
license: MIT
allowed-tools: Bash Read Write Edit Glob Grep Task WebFetch WebSearch Skill
metadata:
  user-invocable: "true"
  argument-hint: "[category] [challenge-file-or-url]"
  trust: provisional
---

# CTF Challenge Solver

## Trigger conditions
- A challenge directory, URL, service, or description is provided without a clear category.
- Reconnaissance is required before choosing a specialist skill.
- A previous approach failed and retriage is requested.
- The challenge is **not** marked with a terminal blockade (unless the user explicitly instructs re‑evaluation).
- The platform has **not** been terminated (absent user‑provided new `BENCHMARK_TOKEN` and verified VPN).

## Applicability and scope
- Dispatcher, first‑pass recon, and audit‑report fast‑path entrypoint.
- Does **not** contain deep exploit chains; after categorisation, invoke the matching `ctf-*` skill.
- Includes stable common patterns, cross‑instance blockade detection, batch infrastructure pre‑sweep, and a **one‑shot** liveness pre‑check that globally terminates on platform invalid_state.
- After termination, produces a complete offline deliverable package **once**, within the same Intent, and then permanently halts all automatic operations.
- **Multi‑Worker coordination**: a persistent Blackboard flag (`platform_terminated`) is the single source of truth for all parallel Workers. Before any network‑touching step (VPN, platform API, container start) each Worker must query it and, if set, immediately move to offline delivery.

## Workflow

### 1. Blackboard & Delivery‑Guard Check (first action every Intent)
1. **Query Blackboard** for the key `platform_terminated`. If it holds a truthy value:
   - If `.delivery_executed` exists in the project root, output the contents of the last saved status report (e.g., `restart_status.md`) and stop immediately.
   - If `.delivery_executed` does **not** exist, treat this as an interrupted termination: produce a minimal final report one‑shot (see “Minimal variant” in section 4), write `.delivery_executed`, and stop.
   - Do **not** run any tool other than those required for the check and report generation.
2. **Fallback to file markers** (for isolated instances):
   - If `platform_terminated.flag` exists but `.delivery_executed` does **not**, treat as interrupted termination and follow the minimal variant.
   - If `.delivery_executed` exists output the existing `restart_status.md` and stop.
3. If neither the Blackboard flag nor the file markers indicate termination, continue.

### 2. Pre‑Flight: Terminal Blockade Pre‑check
If project metadata indicates the challenge is already classified as `infrastructure_blocked` (incl. `docker_compose_defect`), `credential_blocked`, `container_crash`, or `blocked_by_architecture`, **do not proceed**. Output the classification and evidence, then stop. Override only on explicit user instruction.

### 3. Platform Liveness & 409 Termination Detection
Platform termination is detected when **any** API call returns `HTTP 409` with JSON containing `"code": "invalid_state"` and a `"message"` that includes “task already finished” (case‑insensitive).

**Upon first detection – within the same Intent, in strict order:**
1. **Set the Blackboard flag** – write persistent key `platform_terminated` with value `true` (include timestamp and trigger evidence). This immediately notifies all other Workers that the environment is dead.
2. **Write `platform_terminated.flag`** (timestamp + trigger evidence) for local fallback.
3. **Cancel in‑flight and scheduled activity:** abort platform API calls, container operations, VPN probes, and any periodic tasks. Do **not** start any new network probe.
4. **Prohibit sub‑Intent creation:** the remaining steps must execute inside this single Intent without delegating to separate tasks.
5. **Jump to Offline Deliverable Production** (section 4).

### 4. Offline Deliverable Production (ONE‑SHOT, within same Intent)

Before starting, check for `.delivery_executed`; if present, output existing status report and stop.  
If interrupted later, output whatever partial results exist and **do not restart**.

Produce the following artifacts **sequentially, without any network calls**:

1. **Blocked‑Challenge Summary** – List every challenge previously classified as `infrastructure_blocked`, `credential_blocked`, `container_crash`, or `blocked_by_architecture`. Include ID, blockade type, and evidence snippet.
2. **Attack‑Path Verification** – For all unfinished challenges, extract the best known attack path from available reports or PoCs. Tag as “verified” or “needs re‑evaluation”. When two independent reports agree on a path, mark it “cross‑verified”.
3. **Offline Exploit Scripts** – For each verified path without an existing offline script, generate a minimal Python or shell script that:
   - Accepts `TARGET_URL` via environment variable.
   - Contains no hardcoded targets, credentials, or flags.
   - Includes a multi‑level fallback cascade (alternate paths, environment differences).
   - Passes syntax check (`python -m py_compile` / `bash -n`).
4. **Restart Playbook** – Build `restart_playbook.sh` or `run_all.py` that, given a fresh session, will:
   - Check VPN and platform liveness.
   - Start containers and execute the corresponding exploit scripts.
   - Order challenges by exploitability.
   - Validate syntax and existence of all referenced files.
5. **Final Status Report** (`restart_status.md`) – Summarise: total/finished/blocked/incomplete counts, blocked evidence, exploitability assessment, script/playbook locations, step‑by‑step restart instructions.
6. **Write `.delivery_executed`** marker.
7. **Hard‑stop** – Output the `restart_status.md` content and signal that no further automatic operations are permitted. The intent ends; do **not** create any follow‑up Intent.

**Minimal variant** (when Blackboard flag or `platform_terminated.flag` exists without `.delivery_executed`):  
Produce only steps 1, 2, and 5 (summary + status report), write `.delivery_executed`, and stop.

### 5. Platform & Container Detection (Step 0)
*(Only after a healthy liveness response – i.e., no termination flag on Blackboard or files.)*
- **CTFd:** probe `$CTF_URL/api/v1/`; if confirmed, ask for API token, set credentials, load `/ctf-misc` and `ctfd-navigation.md`.
- **Ephemeral‑container platforms:** start a fresh container *via query parameter* `?unique_code=CHALLENGE_ID` (never JSON body).
  - `resource_unavailable` → increment counter, wait 30 s, retry up to 3 cumulative; on third, classify `infrastructure_blocked_docker_compose_defect` and stop.
  - On success, re‑fetch the container address each attempt (IPs may rotate).

### 6. Application Health Check & Two‑Strike Rule (Step 0.1)
*(Requires no termination flag.)*
1. HTTP reachability: `curl -s --max-time 10 -o /dev/null -w '%{http_code}' <addr>`. 2xx/3xx → alive; 401/403 → alive (not infrastructure failure); 5xx/000 → potential backend failure.
2. Expected behaviour probe. Watch for consistent DB errors (e.g., “getaddrinfo failed”).
3. Non‑credential failure: record signature, close container, wait 30 s, start new instance.
4. If the **same** non‑credential failure repeats, classify `infrastructure_blocked` immediately and stop.
5. If failure pattern changes, reset counter.
6. 401/403 responses are **never** infrastructure failures.

### 7. HTTP Basic Auth Pre‑check – Verb Tampering Priority (Step 0.15)
When an Apache server responds with 401 `WWW-Authenticate: Basic` **or** all authentication attempts produce 500 with `WWW-Authenticate: Basic`, attempt verb tampering before brute‑force:
1. Identify the actual backend script path (HTML `action`, headers, common entries).
2. For each path send **PUT, DELETE, PATCH, OPTIONS, or an arbitrary verb** without `Authorization`.
3. 2xx → bypass succeeded; proceed with authenticated flow.
4. 500 on an unlisted verb → backend executed; bypass succeeded; inspect the error.
5. Exhaust verb tampering before ever attempting password brute‑force.

### 8. Cross‑Challenge Infrastructure Pre‑Sweep (Step 0.2)
When `resource_unavailable` or a container dependency defect (e.g., DB hostname resolution failure) appears on any unsolved challenge, suspend deep exploration and perform a lightweight start‑probe sweep of all remaining unsolved challenges:
- Single start probe per challenge, record status.
- Mark `resource_unavailable` ones as `infrastructure_blocked_candidate`; mark the original as `container_dependency_defect`.
- Allocate deep‑triage only to challenges that start successfully **and** behaviour matches audit reports.
- Retry blocked candidates once at the final stage; if still blocked, report and move on.

### 9. Fast‑Path via Prior Audit Reports (Step 0.5)
Trigger: project contains previously validated exploit reports for the current challenge.
1. Ensure container live and healthy.
2. Extract attack path (vulnerability type, creds, endpoint, payload); discard old flags.
3. Verify endpoint; test common variations if 404/403.
4. Execute exploit via appropriate `ctf-*` skill.
5. Adapt flag file path if needed; submit fresh flag.
6. If no flag obtained within 60 s, abandon fast‑path and fall back to normal triage.

### 10. WordPress Pre‑checks (Step 0.6)
- REST API: probe `/wp-json/`; fallback `/?rest_route=/`.
- Verify target version against PoC affected ranges.
- XML‑RPC user enumeration: `wp.getUsersBlogs`; if undifferentiated, parse login errors.

### 11. Steps 1‑4: Recon → Categorise → Invoke → Pivot
1. **Recon:** `file`, `strings`, `xxd | head`, `binwalk`, `checksec` on artifacts; fetch URLs; `nc` services.
2. **Categorise** by file type, description keywords, and service behaviour (see original mapping).
3. **Invoke the category skill:** `ctf-web`, `ctf-pwn`, `ctf-crypto`, `ctf-reverse`, `ctf-forensics`, `ctf-osint`, `ctf-malware`, `ctf-misc`.
4. **Pivot when stuck:** re‑examine assumptions, try a different skill, check edge cases.

### 12. Proven Common Patterns (quick‑reference)
| Pattern | Trigger | Action |
|---------|---------|--------|
| Apache CGI Path Traversal RCE (CVE‑2021‑41773/42013) | Apache 2.4.49/2.4.50 + CGI | Verify `/etc/passwd` read; RCE via `POST /cgi-bin/.%2e/.%2e/.%2e/.%2e/bin/sh`; delegate to `ctf-web`/`ctf-pwn` |
| SSTI | `{%print(7*7)%}` → 49 | Route to `ctf-web` |
| Flask Signed Session IDOR | signed Flask cookie | Brute‑force secret, forge; use `flask-unsign` |
| MongoDB ObjectId prefix brute‑force | 24‑char hex ID | Leak timestamp, brute‑force remaining bytes |
| PhantomJS XSS window.name bug | `window.name='test'` errors | Use `</script><script>…` injection or Werkzeug PIN RCE |
| Apache `<Limit>` verb tampering | Auth 401/500 + Apache | Test unlisted verbs against actual script path |
| Command injection regex bypass | output must match a regex | Inject command + fake format lines |
| LFI str_replace single‑replacement bypass | `str_replace('../', ...)` | Encode beyond single removal depth |
| PHP Base64 cookie IDOR | base64‑encoded cookie | Decode, modify user field, re‑encode |
| Flask SSRF chain (form → admin takeover) | Register form + SSRF to localhost admin | Replicate all form fields, steal credentials, forge session |
| Dual‑service race condition + backtick `eval()` RCE | two services share config | Race‑write payload + trigger; inject Python `os.popen()` |
| Command injection via program flag | program’s own flag changes execution path | Prepend flag before user input |
| File upload + LFI include() RCE | upload possible, LFI present | Upload PHP shell, include via LFI |
| Python pickle filesystem enumeration | pickle deserialization endpoint | Build payloads to list directories / read files |
| MySQL internal pivot + dual auth bypass | internal MySQL separate auth | Combine Flask session IDOR + SSRF pivot |

### 13. Cross‑Instance Blockade Classification (Step 5.5)
| Blockade Type | Failure Signature | Threshold |
|---------------|-------------------|-----------|
| `infrastructure_blocked` (incl. docker defect) | `resource_unavailable` / consistent non‑credential backend failure | Start: 3 cumulative; health: 2 consecutive identical |
| `credential_blocked` | All creds fail + obtained only via container | 1 retry (2 total); no brute‑force >50 attempts |
| `container_crash` | HTTP 000 consistently seconds after start | 1 retry (2 total) |
| `blocked_by_architecture` | Exploit surface broken by version/config mismatch | 1 retry (2 total) |

Procedure: record failure → close container → wait → request new instance → re‑test after health & liveness checks. On threshold met, classify immediately and stop. **Before marking Apache‑backed as blocked, exhaust verb tampering against the actual backend script path.**

## Validation standard
- Flags match CTF formats (`flag{…}`, `FLAG{…}`, `CTF{…}`, `ENO{…}` etc.). Use `grep -rnE '(flag|ctf|eno|htb|pico)\\\\{' .` and strings analysis.
- Fast‑path flag must be freshly obtained, not a copy from the old report.
- WordPress REST API: test both `/wp-json/` **and** `/?rest_route=/`.
- Infrastructure blockade must meet the required failure count with evidence preserved.
- Platform liveness: any `409 invalid_state` with “task already finished” is terminal; after detection, **no further network operations** and the Blackboard flag is set to prevent other Workers from probing.
- Verb tampering bypass: all unlisted verbs tested against the actual backend path before classifying as blocked.
- PhantomJS XSS: confirm `window.name` setter bug before abandoning JSFuck; try alternatives.
- Offline deliverables: scripts pass syntax check, include multi‑level fallback cascades, contain no hardcoded targets/creds/flags. Playbook references valid files.
- `.delivery_executed` marker prevents duplicate delivery generation; any post‑termination intent must only read and output the existing final report.
- Cross‑challenge pre‑sweep: only single start probe per unsolved challenge; blocked candidates set aside until final retry.
- **Blackboard `platform_terminated` overrides file‑only checks** – any Intent that finds the Blackboard flag set before it touches the network must immediately switch to offline delivery.

## Failure handling
- **First approach failed:** recategorise, try a different `ctf-*` skill, look for missed clues.
- **Apache CGI empty response:** add `echo Content-Type` header before command.
- **Flask session brute‑force fails:** search `SECRET_KEY` in source, config, common weak keys.
- **Container appears dead:** query platform status; wait for recycling.
- **SSTI `{{ }}` blocked:** switch to `{%print()%}` / `{%include%}` with URL encoding.
- **MongoDB ObjectId not guessable:** enumerate `/info`, `/status`, debug endpoints for timestamps.
- **Verb tampering returns 500:** backend executed; inspect error, refine request.
- **Termination delivery interrupted:** output partial artifacts, set `.delivery_executed`, hard‑stop – **do not restart generation**.
- **Any attempt to probe, poll VPN, or iterate delivery after termination flag is set (Blackboard or file)** is a violation; the guard check at intent start must intercept it.

## Safety boundaries
- **No automatic resumption after termination.** Only a user‑explicit command providing a new valid `BENCHMARK_TOKEN` **and** verified VPN connectivity can clear the termination block and the Blackboard flag.
- **Credentials, tokens, and target addresses** must never appear in generated offline exploit scripts or playbooks; use environment variables.
- **Offline scripts must default to non‑destructive behaviour** unless the user explicitly opts into destructive actions.
- **Blockade markers are authoritative** – do not override `infrastructure_blocked`, `credential_blocked`, or `blocked_by_architecture` without user instruction and new evidence.
- **Multiple parallel workers** must honour the shared Blackboard `platform_terminated` flag and the `.delivery_executed` marker. The first detection writes both the Blackboard flag and the local file; all other Workers short‑circuit after their pre‑network Blackboard check.
