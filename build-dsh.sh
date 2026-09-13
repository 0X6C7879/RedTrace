#!/usr/bin/env bash
# RedTrace DSH build script (Linux/macOS).
#
# Installs DSH dependencies and compiles the server runtime artifacts.
# Run this once after cloning, and again after pulling changes that touch
# vendor/deepseek-harness or packages/redtrace-dsh.
#
#   ./build-dsh.sh            full install + build
#   ./build-dsh.sh --rebuild  delete node_modules and reinstall before building

set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
if [[ -n "${WSL_DISTRO_NAME:-}" && "$ROOT" == /mnt/* ]]; then
  RUNTIME_ROOT="${REDTRACE_DSH_ROOT:-${HOME}/redtrace-dsh}"
  DSH_ROOT="$RUNTIME_ROOT/vendor/deepseek-harness"
  mkdir -p "$DSH_ROOT"
  rsync -a --exclude='.git/' --exclude='node_modules/' --exclude='*/lib/' \
    "$ROOT/vendor/deepseek-harness/" "$DSH_ROOT/"
  WSL_PROXY_URL="${REDTRACE_WSL_PROXY:-http://192.168.252.170:7890}"
  export HTTP_PROXY="${HTTP_PROXY:-$WSL_PROXY_URL}" HTTPS_PROXY="${HTTPS_PROXY:-$WSL_PROXY_URL}"
  export ALL_PROXY="${ALL_PROXY:-$WSL_PROXY_URL}"
  export http_proxy="${http_proxy:-$HTTP_PROXY}" https_proxy="${https_proxy:-$HTTPS_PROXY}"
  export all_proxy="${all_proxy:-$ALL_PROXY}"
else
  DSH_ROOT="$ROOT/vendor/deepseek-harness"
  RUNTIME_ROOT="$ROOT"
fi

command -v node >/dev/null 2>&1 || {
  printf 'error: Node.js >= 22.19 is required\n' >&2
  exit 1
}
command -v npm >/dev/null 2>&1 || {
  printf 'error: npm is required\n' >&2
  exit 1
}

REBUILD=0
[[ "${1:-}" == "--rebuild" ]] && REBUILD=1
[[ ! -x "$DSH_ROOT/node_modules/.bin/tsx" ]] && REBUILD=1
[[ ! -x "$DSH_ROOT/node_modules/.bin/tsc" ]] && REBUILD=1
[[ ! -d "$DSH_ROOT/node_modules/@types/node" ]] && REBUILD=1

if [[ "$REBUILD" -eq 1 ]]; then
  printf '==> installing DSH dependencies\n' >&2
  rm -rf "$DSH_ROOT/node_modules"
  (cd "$DSH_ROOT" && REDTRACE_DSH_ROOT="$DSH_ROOT" node "$ROOT/scripts/dsh-pnpm.mjs" install --force --no-frozen-lockfile --ignore-scripts) || exit 1
fi

printf '==> building DSH runtime\n' >&2
(cd "$DSH_ROOT" && "$DSH_ROOT/node_modules/.bin/tsc" -b tsconfig.host.json && "$DSH_ROOT/node_modules/.bin/tsdown" --env.DSH_BUILD_FACE host) || exit 1
(cd "$ROOT" && node "$DSH_ROOT/node_modules/typescript/bin/tsc" -p "$ROOT/packages/redtrace-dsh/tsconfig.json") || exit 1

if [[ -n "${WSL_DISTRO_NAME:-}" && "$ROOT" == /mnt/* ]]; then
  mkdir -p "$RUNTIME_ROOT/scripts" "$RUNTIME_ROOT/profiles/redtrace" "$RUNTIME_ROOT/packages/redtrace-dsh"
  cp "$ROOT/scripts/run-redtrace-dsh.mjs" "$RUNTIME_ROOT/scripts/"
  cp "$ROOT/scripts/run-dsh.sh" "$RUNTIME_ROOT/scripts/" 2>/dev/null || true
  cp "$ROOT/scripts/chrome-cdp-daemon.sh" "$RUNTIME_ROOT/scripts/" 2>/dev/null || true
  chmod +x "$RUNTIME_ROOT/scripts/run-dsh.sh" "$RUNTIME_ROOT/scripts/chrome-cdp-daemon.sh" 2>/dev/null || true
  cp "$ROOT/profiles/redtrace/runtime.cordis.yml" "$RUNTIME_ROOT/profiles/redtrace/"
  cp "$ROOT/packages/redtrace-dsh/package.json" "$RUNTIME_ROOT/packages/redtrace-dsh/"
  rm -rf "$RUNTIME_ROOT/packages/redtrace-dsh/lib"
  cp -a "$ROOT/packages/redtrace-dsh/lib" "$RUNTIME_ROOT/packages/redtrace-dsh/"
fi

printf '==> build complete\n' >&2
