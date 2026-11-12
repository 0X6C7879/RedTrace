#!/bin/sh
set -eu
if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then echo "Usage: ROLLBACK.sh TARGET_COPY [--frontend]" >&2; exit 2; fi
case "${2-}" in ""|--frontend) ;; *) echo "Unknown rollback scope" >&2; exit 2 ;; esac
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=$(CDPATH= cd -- "$1" && pwd)
# Source-copy rollback only; never a production database backup.
if [ "${2-}" = "--frontend" ]; then
  rm -f -- "$TARGET/static/legion.css" "$TARGET/packages/redtrace-engine/test/legion-console.test.ts"
  tar -xzf "$HERE/FRONTEND-BASELINE.tar.gz" -C "$TARGET"
  exit 0
fi
rm -f -- "$TARGET/packages/redtrace-engine/compat/legion-context.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/compat/legion.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/src/benchmark.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-cutover.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-experience.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-missions.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-store.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-tools.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/project-evidence.ts"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-commander-context.fixture.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-console.test.ts"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-context.fixture.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-cutover-cli.fixture.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-cutover.fixture.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-cutover.test.ts"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-experience.test.ts"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-organization.test.ts"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-recovery.fixture.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-runtime.fixture.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-runtime.test.ts"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-state.test.ts"
rm -f -- "$TARGET/scripts/migrate-legion.mjs"
rm -f -- "$TARGET/static/legion.css"
tar -xzf "$HERE/BASELINE.tar.gz" -C "$TARGET"
tar -xzf "$HERE/BASELINE-EXTRA.tar.gz" -C "$TARGET"
