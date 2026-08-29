#!/usr/bin/env bash
# RedTrace DSH launcher for Linux/macOS/WSL.
# Ensures Chrome CDP daemon is running before starting the DSH runtime.

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
RUNTIME_ROOT="${REDTRACE_DSH_ROOT:-$(dirname "$ROOT")}"

# Start Chrome CDP daemon (WSL/Linux only)
if [[ "$(uname -s)" == "Linux" ]]; then
  CHROME_DAEMON="$ROOT/../scripts/chrome-cdp-daemon.sh"
  [[ -f "$CHROME_DAEMON" ]] && bash "$CHROME_DAEMON" start 2>/dev/null || true
fi

exec node "$ROOT/run-redtrace-dsh.mjs" "$@"
