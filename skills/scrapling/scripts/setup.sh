#!/usr/bin/env bash
set -Eeuo pipefail

SCRAPLING_VERSION="${REDTRACE_SCRAPLING_VERSION:-0.4.12}"
VENV_DIR="${REDTRACE_SCRAPLING_VENV:-$HOME/.local/share/redtrace-tools/scrapling}"
PYTHON_BIN="${REDTRACE_SCRAPLING_PYTHON:-python3}"
PYPI_INDEX="${UV_INDEX_URL:-${PIP_INDEX_URL:-}}"
MARKER="$VENV_DIR/.redtrace-scrapling-${SCRAPLING_VERSION}.ready"

log() { printf '[RedTrace/Scrapling] %s\n' "$*" >&2; }
die() { printf '[RedTrace/Scrapling] ERROR: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

python_ok() {
  "$PYTHON_BIN" - <<'PY' >/dev/null 2>&1
import sys
raise SystemExit(0 if sys.version_info >= (3, 10) else 1)
PY
}

install_package() {
  mkdir -p "$(dirname "$VENV_DIR")"
  if has uv; then
    log "creating isolated environment with uv: $VENV_DIR"
    uv venv --python "$PYTHON_BIN" "$VENV_DIR"
    local args=(uv pip install --python "$VENV_DIR/bin/python")
    [[ -n "$PYPI_INDEX" ]] && args+=(--index-url "$PYPI_INDEX")
    args+=("scrapling[all]==$SCRAPLING_VERSION")
    "${args[@]}"
  else
    log "creating isolated environment with venv: $VENV_DIR"
    "$PYTHON_BIN" -m venv "$VENV_DIR"
    "$VENV_DIR/bin/python" -m pip install --upgrade pip
    local args=("$VENV_DIR/bin/python" -m pip install)
    [[ -n "$PYPI_INDEX" ]] && args+=(--index-url "$PYPI_INDEX")
    args+=("scrapling[all]==$SCRAPLING_VERSION")
    "${args[@]}"
  fi
}

install_browsers() {
  if [[ "${REDTRACE_SCRAPLING_SKIP_BROWSER_INSTALL:-0}" == "1" ]]; then
    log "browser installation skipped by REDTRACE_SCRAPLING_SKIP_BROWSER_INSTALL=1"
    return
  fi
  log "installing Scrapling browser assets"
  "$VENV_DIR/bin/scrapling" install --force
}

[[ "$1" == "--print-bin" ]] 2>/dev/null && PRINT_BIN=1 || PRINT_BIN=0
has "$PYTHON_BIN" || die "$PYTHON_BIN is required"
python_ok || die "Python 3.10 or newer is required"

if [[ ! -x "$VENV_DIR/bin/scrapling" ]]; then
  install_package
fi

installed_version="$($VENV_DIR/bin/python - <<'PY'
from importlib.metadata import version
print(version('scrapling'))
PY
)"

if [[ "$installed_version" != "$SCRAPLING_VERSION" ]]; then
  log "updating Scrapling from $installed_version to $SCRAPLING_VERSION"
  if has uv; then
    args=(uv pip install --python "$VENV_DIR/bin/python" --upgrade)
    [[ -n "$PYPI_INDEX" ]] && args+=(--index-url "$PYPI_INDEX")
    args+=("scrapling[all]==$SCRAPLING_VERSION")
    "${args[@]}"
  else
    args=("$VENV_DIR/bin/python" -m pip install --upgrade)
    [[ -n "$PYPI_INDEX" ]] && args+=(--index-url "$PYPI_INDEX")
    args+=("scrapling[all]==$SCRAPLING_VERSION")
    "${args[@]}"
  fi
  rm -f "$VENV_DIR"/.redtrace-scrapling-*.ready
fi

if [[ ! -f "$MARKER" ]]; then
  install_browsers
  "$VENV_DIR/bin/python" - <<'PY'
from scrapling.fetchers import DynamicFetcher, Fetcher, StealthyFetcher
print('Scrapling import smoke test passed')
PY
  touch "$MARKER"
fi

if ((PRINT_BIN)); then
  printf '%s\n' "$VENV_DIR/bin/scrapling"
else
  log "ready: $VENV_DIR/bin/scrapling"
fi
