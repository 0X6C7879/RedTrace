#!/usr/bin/env bash
# RedTrace Node launcher (Linux/macOS). Node 24.15+ is the only runtime required.
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"

# Preserve the user's shell for shell tools launched by an Agent.
if [[ -z "${REDTRACE_PARENT_SHELL:-}" ]] && command -v ps >/dev/null 2>&1; then
  parent_shell_name="$(ps -p "$PPID" -o comm= 2>/dev/null | sed 's/^[[:space:]-]*//; s/[[:space:]]*$//')"
  case "${parent_shell_name##*/}" in
    bash|zsh|sh|dash|ksh|fish)
      parent_shell_path="$(command -v "${parent_shell_name##*/}" 2>/dev/null || true)"
      [[ -n "$parent_shell_path" ]] && export REDTRACE_PARENT_SHELL="$parent_shell_path"
      ;;
  esac
fi
export REDTRACE_PARENT_PATH="${REDTRACE_PARENT_PATH:-$PATH}"
export REDTRACE_PARENT_VIRTUAL_ENV="${REDTRACE_PARENT_VIRTUAL_ENV-${VIRTUAL_ENV-}}"

command -v node >/dev/null 2>&1 || {
  printf 'error: Node.js 24.15 or newer from the Node 24 line is required\n' >&2
  printf '  install: https://nodejs.org/\n' >&2
  exit 1
}
IFS=. read -r NODE_MAJOR NODE_MINOR _ <<<"$(node --version | sed 's/^v//')"
if [[ "$NODE_MAJOR" -ne 24 || "$NODE_MINOR" -lt 15 ]]; then
  printf 'error: Node.js 24.15+ (<25) is required; found %s\n' "$(node --version)" >&2
  exit 1
fi
command -v npm >/dev/null 2>&1 || {
  printf 'error: npm is required to install the Node runtime dependencies\n' >&2
  exit 1
}
if [[ ! -f "$ROOT/vendor/deepseek-harness/package.json" ]]; then
  printf 'error: vendor/deepseek-harness is missing from the checkout\n' >&2
  exit 1
fi
DSH_CODE_ROOT="$ROOT"
RUN_SCRIPT="$ROOT/scripts/run-redtrace-node.mjs"
[[ "$(uname -s)" == "Darwin" ]] && KOFFI_OS=darwin || KOFFI_OS=linux
if [[ -n "${WSL_DISTRO_NAME:-}" && "$ROOT" == /mnt/* ]]; then
  export REDTRACE_DSH_ROOT="${REDTRACE_DSH_ROOT:-${HOME}/redtrace-dsh}"
  export REDTRACE_DATA_ROOT="${REDTRACE_DATA_ROOT:-${REDTRACE_DSH_ROOT}/.redtrace}"
  DSH_CODE_ROOT="$REDTRACE_DSH_ROOT"
fi
if [[ "$DSH_CODE_ROOT" == "$ROOT" && ! -f "$ROOT/packages/redtrace-engine/node_modules/yaml/package.json" ]]; then
  printf '==> first run: installing RedTrace Node dependencies\n' >&2
  npm ci --prefix "$ROOT/packages/redtrace-engine"
fi
# The compat host imports the compiled adapter from packages/redtrace-dsh/lib;
# lib output older than its sources crashes startup at import time, so treat
# staleness exactly like a missing build.
DSH_LIB_STALE=0
if [[ -f "$ROOT/packages/redtrace-dsh/lib/index.js" ]] \
  && [[ -n "$(find "$ROOT/packages/redtrace-dsh/src" -name '*.ts' -newer "$ROOT/packages/redtrace-dsh/lib/index.js" -print -quit 2>/dev/null)" ]]; then
  printf '==> packages/redtrace-dsh sources are newer than the compiled lib: rebuilding\n' >&2
  DSH_LIB_STALE=1
fi
if [[ ! -f "$DSH_CODE_ROOT/vendor/deepseek-harness/packages/boot/app-boot/lib/index.js" \
  || ! -f "$ROOT/packages/redtrace-dsh/lib/index.js" \
  || "$DSH_LIB_STALE" -eq 1 ]] \
  || ! compgen -G "$DSH_CODE_ROOT/vendor/deepseek-harness/node_modules/.pnpm/@koromix+koffi-$KOFFI_OS-*" >/dev/null; then
  printf '==> first run: installing and building the Cordis compatibility runtime\n' >&2
  "$ROOT/build-dsh.sh"
fi

if [[ "$DSH_CODE_ROOT" != "$ROOT" ]]; then
  ENGINE_RUNTIME="$DSH_CODE_ROOT/packages/redtrace-engine"
  DSH_ADAPTER_RUNTIME="$DSH_CODE_ROOT/packages/redtrace-dsh"
  mkdir -p "$ENGINE_RUNTIME/src" "$ENGINE_RUNTIME/compat" "$DSH_ADAPTER_RUNTIME/lib" "$DSH_CODE_ROOT/scripts"
  rsync -a --delete "$ROOT/packages/redtrace-engine/src/" "$ENGINE_RUNTIME/src/"
  rsync -a --delete "$ROOT/packages/redtrace-engine/compat/" "$ENGINE_RUNTIME/compat/"
  rsync -a --delete "$ROOT/packages/redtrace-dsh/lib/" "$DSH_ADAPTER_RUNTIME/lib/"
  cp "$ROOT/packages/redtrace-engine/package.json" "$ROOT/packages/redtrace-engine/package-lock.json" "$ENGINE_RUNTIME/"
  cp "$ROOT/packages/redtrace-dsh/package.json" "$DSH_ADAPTER_RUNTIME/"
  cp "$ROOT/scripts/run-redtrace-node.mjs" "$DSH_CODE_ROOT/scripts/"

  ENGINE_LOCK_HASH="$(sha256sum "$ENGINE_RUNTIME/package-lock.json" | cut -d' ' -f1)"
  if [[ ! -f "$ENGINE_RUNTIME/node_modules/yaml/package.json" \
    || "$(cat "$ENGINE_RUNTIME/.package-lock.sha256" 2>/dev/null || true)" != "$ENGINE_LOCK_HASH" ]]; then
    printf '==> first run: installing RedTrace runtime dependencies in WSL ext4\n' >&2
    npm ci --prefix "$ENGINE_RUNTIME" --omit=dev --ignore-scripts
    printf '%s\n' "$ENGINE_LOCK_HASH" > "$ENGINE_RUNTIME/.package-lock.sha256"
  fi
  export REDTRACE_SOURCE_ROOT="$ROOT"
  RUN_SCRIPT="$DSH_CODE_ROOT/scripts/run-redtrace-node.mjs"
fi

printf '==> starting RedTrace (loading Cordis services)\n' >&2
exec node "$RUN_SCRIPT" --compat --root "$ROOT" "$@"
