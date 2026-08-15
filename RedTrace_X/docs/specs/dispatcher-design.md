# Pi-only Dispatcher Design

RedTrace_X follows Cairn's upstream Blackboard scheduler without RedTrace control-plane
extensions. Production execution has one model backend: Pi.

## Worker topology

| Worker | Task types | Per-worker limit |
| --- | --- | ---: |
| `pi-coordinator` | `bootstrap`, `reason` | 1 |
| `pi-explore-1` | `explore` | 1 |
| `pi-explore-2` | `explore` | 1 |
| `pi-explore-3` | `explore` | 1 |

The runtime and per-project caps are both 4. `reason.max_intents` is 3, so one Reason
step can create enough work for all three Explore workers. Separate worker names make
the three concurrent Explore leases visible and independently bounded.

## Pi runtime

Every production worker uses `PI_BASE_URL`, `PI_MODEL`, `PI_API_KEY`, and
`PI_PROVIDER_API`. The adapter atomically writes the matching `models.json` under
`PI_CODING_AGENT_DIR`, starts Pi with extensions disabled, and leaves native Skill
discovery enabled. Sessions use per-worker subdirectories.

The `mock` driver remains only for deterministic offline tests. It is not present in
production configuration and does not call a model.

## Removed surfaces

There are no Claude Code or Codex adapters, registry entries, configuration types, or
container packages. No MCP or plugin capability directories are materialized. Cairn's
Fact, Intent, Hint, Bootstrap, Reason, Explore, heartbeat, and leasing contracts remain
upstream behavior.
