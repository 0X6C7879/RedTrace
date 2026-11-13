#!/bin/sh
set -eu
TARGET_COPY=${1:?Usage: ROLLBACK.sh /absolute/path/to/target-copy}
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
tar -xzf "$HERE/BASELINE.tar.gz" -C "$TARGET_COPY"
while IFS= read -r file; do
  rm -f "$TARGET_COPY/$file"
done <<'NEW_SOURCE_FILES'
packages/redtrace-engine/test/project-commanders.fixture.mjs
packages/redtrace-engine/test/project-commanders.test.ts
packages/redtrace-engine/test/project-graph-api.test.ts
packages/redtrace-engine/test/project-graph-migration.test.ts
packages/redtrace-engine/test/project-graphs.test.ts
packages/redtrace-engine/test/project-ui.fixture.mjs
docs/project-commander-20261113/GUIDE.md
NEW_SOURCE_FILES
printf '%s\n' 'ROLLBACK: pristine baseline source restored; database not downgraded'
