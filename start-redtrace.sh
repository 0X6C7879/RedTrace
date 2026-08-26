#!/usr/bin/env bash
# RedTrace one-click launcher (Linux/macOS).
#
# Boots the whole system with a single command: the RedTrace API server plus,
# when provider Workers are configured, the long-lived DSH Cordis runtime that
# schedules them. Prerequisites are checked and bootstrapped in order:
#
#   1. uv (Python environment)          3. DSH git submodule
#   2. Node.js >= 22.19 (DSH runtime)   4. DSH build artifacts (auto-built once)
#
# Configuration lives in redtrace.yaml at the repository root; see
# redtrace.dsh.example.yaml for the worker-centric providers format.
# Extra arguments pass through to `redtrace start` (e.g. --port 8001).

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT="$ROOT/redtrace"

# ── 1. Python environment (uv) ─────────────────────────────────────────────
command -v uv >/dev/null 2>&1 || {
  printf 'error: uv is not installed or not on PATH\n' >&2
  printf '  install: curl -LsSf https://astral.sh/uv/install.sh | sh\n' >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) PLATFORM=macos ;;
  Linux) PLATFORM=linux ;;
  *) PLATFORM=unix ;;
esac

export UV_PROJECT_ENVIRONMENT="${UV_PROJECT_ENVIRONMENT:-$PROJECT/.venv-$PLATFORM}"
if [[ ! -x "$UV_PROJECT_ENVIRONMENT/bin/redtrace" ]]; then
  printf '==> preparing the Python environment (uv sync)\n' >&2
  uv sync --project "$PROJECT"
fi

# ── 2. Node.js (the DSH Cordis runtime needs >= 22.19) ─────────────────────
if ! command -v node >/dev/null 2>&1; then
  printf 'error: Node.js >= 22.19 is required for the DSH runtime and was not found\n' >&2
  printf '  install: https://nodejs.org/ (or: brew install node / apt install nodejs)\n' >&2
  exit 1
fi
NODE_VERSION="$(node --version | sed 's/^v//')"
NODE_MAJOR="${NODE_VERSION%%.*}"
NODE_MINOR="$(printf '%s' "$NODE_VERSION" | cut -d. -f2)"
NODE_MINOR="${NODE_MINOR%%[!0-9]*}"
if [[ "$NODE_MAJOR" -lt 22 ]] || { [[ "$NODE_MAJOR" -eq 22 ]] && [[ "$NODE_MINOR" -lt 19 ]]; }; then
  printf 'error: Node.js >= 22.19 is required for DSH; found %s\n' "$NODE_VERSION" >&2
  exit 1
fi

# ── 3. DSH submodule ───────────────────────────────────────────────────────
if [[ ! -f "$ROOT/vendor/deepseek-harness/package.json" ]]; then
  command -v git >/dev/null 2>&1 || {
    printf 'error: the DSH submodule is missing and git is unavailable to fetch it\n' >&2
    exit 1
  }
  printf '==> initializing the DSH submodule (first run)\n' >&2
  git -C "$ROOT" submodule update --init --recursive
fi

# ── 4. DSH build artifacts (built once; re-run with `npm run dsh:build`) ────
if [[ ! -f "$ROOT/packages/redtrace-dsh/lib/index.js" ]] \
  || [[ ! -f "$ROOT/vendor/deepseek-harness/packages/boot/app-boot/lib/index.js" ]]; then
  command -v npm >/dev/null 2>&1 || {
    printf 'error: DSH build artifacts are missing and npm is unavailable to build them\n' >&2
    exit 1
  }
  printf '==> building the DSH runtime (first run; a few minutes)\n' >&2
  (cd "$ROOT" && npm run dsh:install && npm run dsh:build)
fi

# ── 5. Dispatcher configuration ────────────────────────────────────────────
# --help is answered by `redtrace start` itself and needs no config file.
case " $* " in
  *" --help "*|*" -h "*) exec uv run --no-sync --project "$PROJECT" redtrace start "$@" ;;
esac
if [[ ! -f "$ROOT/redtrace.yaml" ]]; then
  printf 'error: %s/redtrace.yaml not found\n' "$ROOT" >&2
  printf '  copy redtrace.dsh.example.yaml to redtrace.yaml, fill in a provider\n' >&2
  printf '  api_key, and adjust the Workers — then start again\n' >&2
  exit 1
fi

exec uv run --no-sync --project "$PROJECT" redtrace start "$@"
