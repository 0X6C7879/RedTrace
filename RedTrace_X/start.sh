#!/usr/bin/env bash
set -Eeuo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PYTHON="${PYTHON:-python3}"

if [[ -f "$ROOT/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT/.env"
  set +a
fi

: "${API_KEY:?set API_KEY in .env or the environment}"
: "${BENCHMARK_TOKEN:?set BENCHMARK_TOKEN in .env or the environment}"

export MODEL="${MODEL:-glm-5.2-agent-chanllenge}"
export AGENT_BASE_URL="${AGENT_BASE_URL:-https://agent-awd.baidu.com}"
export BENCHMARK_BASE_URL="${BENCHMARK_BASE_URL:-https://tsecbench.zc.tencent.com}"
export VPN_CHECK_URL="${VPN_CHECK_URL:-http://10.0.100.58}"
export CAIRN_BASE_URL="${CAIRN_BASE_URL:-http://127.0.0.1:8000}"
export PI_CODING_AGENT_DIR="$ROOT/container/.pi/agent"

"$PYTHON" "$ROOT/bench/render_config.py" "$ROOT/dispatch.yaml.template" "$ROOT/dispatch.yaml"

uv run --project "$ROOT/cairn" cairn serve --no-access-log &
SERVER_PID=$!
DISPATCHER_PID=""
cleanup() {
  [[ -z "$DISPATCHER_PID" ]] || kill "$DISPATCHER_PID" 2>/dev/null || true
  kill "$SERVER_PID" 2>/dev/null || true
  [[ -z "$DISPATCHER_PID" ]] || wait "$DISPATCHER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 120); do
  curl -fsS --max-time 2 "$CAIRN_BASE_URL/projects" >/dev/null 2>&1 && break
  kill -0 "$SERVER_PID" 2>/dev/null || { echo "Cairn server exited during startup" >&2; exit 1; }
  sleep 0.25
done
curl -fsS --max-time 2 "$CAIRN_BASE_URL/projects" >/dev/null

uv run --project "$ROOT/cairn" cairn dispatch --config "$ROOT/dispatch.yaml" &
DISPATCHER_PID=$!
"$PYTHON" "$ROOT/bench/benchctl.py" run
