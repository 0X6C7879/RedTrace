#!/usr/bin/env bash
# RedTrace one-click launcher (Linux/macOS).
#
# Boots the whole system with a single command: the RedTrace API server plus,
# when provider Workers are configured, the long-lived DSH Cordis runtime that
# schedules them. Prerequisites are checked and bootstrapped in order:
#
#   1. uv (Python environment)          3. DSH vendored runtime tree
#   2. Node.js >= 22.19 (DSH runtime)   4. DSH install + build (first run)
#
# Configuration lives in redtrace.yaml at the repository root; see
# redtrace.dsh.example.yaml for the worker-centric providers format.
# Extra arguments pass through to `redtrace start` (e.g. --port 8001).

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT="$ROOT/redtrace"

# Preserve the shell that invoked this launcher. The launcher itself is Bash,
# so inspecting the Python/Node parent later would otherwise always report
# Bash even when the user started RedTrace from zsh.
if [[ -z "${REDTRACE_PARENT_SHELL:-}" ]] && command -v ps >/dev/null 2>&1; then
  parent_shell_name="$(ps -p "$PPID" -o comm= 2>/dev/null | sed 's/^[[:space:]-]*//; s/[[:space:]]*$//')"
  case "${parent_shell_name##*/}" in
    bash|zsh|sh|dash|ksh|fish)
      if parent_shell_path="$(command -v "${parent_shell_name##*/}" 2>/dev/null)"; then
        export REDTRACE_PARENT_SHELL="$parent_shell_path"
      fi
      ;;
  esac
fi

# `uv run` replaces PATH/VIRTUAL_ENV for the RedTrace process. Keep the
# invoking shell's Python environment so only the DSH Worker can restore it.
export REDTRACE_PARENT_PATH="${REDTRACE_PARENT_PATH:-$PATH}"
export REDTRACE_PARENT_VIRTUAL_ENV="${REDTRACE_PARENT_VIRTUAL_ENV-${VIRTUAL_ENV-}}"

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

# ── 3. DSH vendored runtime tree ───────────────────────────────────────────
if [[ ! -f "$ROOT/vendor/deepseek-harness/package.json" ]]; then
  printf 'error: vendor/deepseek-harness is missing from the checkout\n' >&2
  exit 1
fi

# ── 4. DSH install + build (first run only) ────────────────────────────────
command -v npm >/dev/null 2>&1 || {
  printf 'error: npm is required for the DSH runtime and was not found\n' >&2
  exit 1
}
if [[ ! -f "$ROOT/vendor/deepseek-harness/packages/boot/app-boot/lib/index.js" ]] \
  || [[ ! -f "$ROOT/packages/redtrace-dsh/lib/index.js" ]]; then
  printf '==> first run: installing and building DSH runtime\n' >&2
  "$ROOT/build-dsh.sh" || exit 1
fi

if [[ -n "${WSL_DISTRO_NAME:-}" && "$ROOT" == /mnt/* ]]; then
  DSH_ROOT="${REDTRACE_DSH_ROOT:-${HOME}/redtrace-dsh}"
  if [[ -f "$DSH_ROOT/scripts/run-redtrace-dsh.mjs" ]]; then
    export REDTRACE_DSH_ROOT="$DSH_ROOT"
  else
    printf 'warning: WSL DSH build not found; using the source runtime (run ./build-dsh.sh to prepare it)\n' >&2
  fi
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
