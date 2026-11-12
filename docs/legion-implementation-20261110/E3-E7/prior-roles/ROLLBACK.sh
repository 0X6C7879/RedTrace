#!/bin/sh
set -eu
if [ "$#" -ne 1 ]; then printf '%s\n' 'Usage: ROLLBACK.sh TARGET_COPY' >&2; exit 2; fi
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=$(CDPATH= cd -- "$1" && pwd)
# Restore pre-migration working bytes, not Git HEAD. Source rollback is NOT a database backup.
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-store.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/project-evidence.ts"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-state.test.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-missions.ts"
rm -f -- "$TARGET/packages/redtrace-engine/src/legion-tools.ts"
rm -f -- "$TARGET/packages/redtrace-engine/compat/legion.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-runtime.fixture.mjs"
rm -f -- "$TARGET/packages/redtrace-engine/test/legion-runtime.test.ts"
tar -xzf "$HERE/BASELINE.tar.gz" -C "$TARGET"
