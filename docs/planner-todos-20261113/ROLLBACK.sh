#!/bin/sh
set -eu
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=$1
tar -xzf "$HERE/BASELINE.tar.gz" -C "$TARGET"
rm -f "$TARGET/packages/redtrace-engine/src/legion-todos.ts"
rm -f "$TARGET/packages/redtrace-engine/test/legion-todos.test.ts"
rm -f "$TARGET/packages/redtrace-engine/test/legion-todos.fixture.mjs"
