#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then echo "Usage: $0 TARGET_COPY" >&2; exit 2; fi
here=$(CDPATH= cd "$(dirname "$0")" && pwd)
target=$(CDPATH= cd "$1" && pwd)
list=$(mktemp "${TMPDIR:-/tmp}/redtrace-rollback.XXXXXX")
trap 'rm -f "$list"' 0
cat > "$list" <<'REDTRACE_BASELINE_FILES'
packages/redtrace-engine/compat/cordis.mjs
packages/redtrace-engine/compat/legion.mjs
packages/redtrace-engine/src/fgs.ts
packages/redtrace-engine/src/graph-api.ts
packages/redtrace-engine/src/index.ts
packages/redtrace-engine/src/legion-missions.ts
packages/redtrace-engine/src/legion-tools.ts
packages/redtrace-engine/src/plan-guard.ts
packages/redtrace-engine/src/project-evidence.ts
packages/redtrace-engine/src/runner.ts
packages/redtrace-engine/src/scheduler.ts
packages/redtrace-engine/src/store.ts
packages/redtrace-engine/src/types.ts
packages/redtrace-engine/test/dsh-loop.test.ts
packages/redtrace-engine/test/fgs.test.ts
packages/redtrace-engine/test/legion-experience.test.ts
packages/redtrace-engine/test/legion-runtime.fixture.mjs
packages/redtrace-engine/test/legion-todos.fixture.mjs
packages/redtrace-engine/test/runtime-contract.test.ts
packages/redtrace-engine/test/tsecbench-reason.test.ts
static/audit.js
static/fgs-view.js
static/index.html
REDTRACE_BASELINE_FILES
tar -xzf "$here/BASELINE.tar.gz" -C "$target" -T "$list"
while IFS= read -r file; do
  [ -z "$file" ] || rm -f "$target/$file"
done <<'REDTRACE_ADDED_FILES'
packages/redtrace-engine/prompts/UPSTREAM.md
packages/redtrace-engine/prompts/artex-report-template.md
packages/redtrace-engine/prompts/reporter.md
packages/redtrace-engine/prompts/sapper-fact-layers.md
packages/redtrace-engine/prompts/upstream/ARTEX-LICENSE
packages/redtrace-engine/prompts/upstream/SAPPER-LICENSE
packages/redtrace-engine/prompts/upstream/artex-reporter.md
packages/redtrace-engine/prompts/upstream/sapper-explore.md
packages/redtrace-engine/src/graph-content.ts
packages/redtrace-engine/src/reporter.ts
packages/redtrace-engine/test/fact-finding.test.ts
packages/redtrace-engine/test/reporter-runtime.fixture.mjs
packages/redtrace-engine/test/reporter-runtime.test.ts
REDTRACE_ADDED_FILES
printf 'Restored baseline code bytes in %s\n' "$target"
