#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
VENV_DIR="${REDTRACE_SCRAPLING_VENV:-$HOME/.local/share/redtrace-tools/scrapling}"
PYTHON_BIN="$VENV_DIR/bin/python"

if [[ ! -x "$PYTHON_BIN" ]]; then
  if [[ "${REDTRACE_SCRAPLING_AUTO_INSTALL:-1}" != "1" ]]; then
    printf '[RedTrace/Scrapling] ERROR: Scrapling is not installed and auto-install is disabled\n' >&2
    printf 'Run: bash %q\n' "$SCRIPT_DIR/setup.sh" >&2
    exit 1
  fi
  bash "$SCRIPT_DIR/setup.sh"
fi

exec "$PYTHON_BIN" "$SCRIPT_DIR/capture.py" "$@"
