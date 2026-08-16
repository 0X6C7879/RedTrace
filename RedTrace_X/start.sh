#!/usr/bin/env bash
set -Eeuo pipefail

# 单任务测评启动器：
#   渲染配置 → 起 RedTrace 服务与调度器（本地包）→ 自动跑一次 bench/benchctl.py run → 结束后退出。
# 容器默认 CMD 即本文件。Worker 仅 Pi：1 个跑 Reason(+bootstrap)，3 个跑 Explore。
#
# 环境变量来自 .env（参考 .env.example）。必需项缺失即报错退出，不静默继续。

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$ROOT/redtrace"
CONFIG_TEMPLATE="${REDTRACE_CONFIG_TEMPLATE:-$ROOT/redtrace.yaml.template}"
CONFIG_PATH="$ROOT/redtrace.yaml"
DATA_DIR="$ROOT/.redtrace"
DB_PATH="$DATA_DIR/redtrace.db"
HOST="${REDTRACE_HOST:-127.0.0.1}"
PORT="${REDTRACE_PORT:-8000}"
START_TIMEOUT="${REDTRACE_START_TIMEOUT:-120}"
SHUTDOWN_TIMEOUT="${REDTRACE_SHUTDOWN_TIMEOUT:-8}"

SERVER_PID=""
DISPATCHER_PID=""
OWNS_SERVER=0
EXITCODE=0

[[ -f "$ROOT/.env" ]] && { set -a; . "$ROOT/.env"; set +a; }

need_var() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf 'error: 缺少平台下发机密: 环境变量 %s（运行前须经交互式 export 或容器启动注入）\n' "$name" >&2
    exit 1
  fi
}
for v in API_KEY BENCHMARK_TOKEN BENCHMARK_BASE_URL; do need_var "$v"; done

command -v uv >/dev/null 2>&1 || { printf 'error: 需要 uv 但未找到\n' >&2; exit 1; }
command -v curl >/dev/null 2>&1 || { printf 'error: 需要 curl 但未找到\n' >&2; exit 1; }

mkdir -p "$DATA_DIR/tmp" "$PROJECT_DIR/workspaces"
export REDTRACE_ROOT="$ROOT"
export TMPDIR="$DATA_DIR/tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export CAIRN_BASE_URL="http://127.0.0.1:${PORT}"   # benchctl 默认探测此地址
export REDTRACE_BASE_URL="http://127.0.0.1:${PORT}"

probe_host() {
  case "$HOST" in 0.0.0.0|::|'[::]') printf '%s' 127.0.0.1 ;; *) printf '%s' "$HOST" ;; esac
}
server_url() { printf 'http://%s:%s/projects' "$(probe_host)" "$PORT"; }
is_ready()   { curl -fsS --max-time 2 "$(server_url)" >/dev/null 2>&1; }

stop_pid() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -TERM "$pid" >/dev/null 2>&1 || true
  local i=0
  while ((i < SHUTDOWN_TIMEOUT * 10)) && kill -0 "$pid" >/dev/null 2>&1; do sleep 0.1; i=$((i + 1)); done
  kill -KILL "$pid" >/dev/null 2>&1 || true
  wait "$pid" 2>/dev/null || true
}

finish() {
  trap - EXIT INT TERM HUP
  stop_pid "$DISPATCHER_PID"
  if ((OWNS_SERVER == 1)); then stop_pid "$SERVER_PID"; fi
  return "$EXITCODE"
}
trap finish EXIT
trap 'trap - INT; EXITCODE=130; exit 130' INT
trap 'trap - TERM; EXITCODE=143; exit 143' TERM

printf '[config] rendering %s ← %s\n' "$CONFIG_PATH" "$CONFIG_TEMPLATE"
python3 "$ROOT/bench/render_config.py" "$CONFIG_TEMPLATE" "$CONFIG_PATH"

if ! is_ready; then
  printf '[serve] starting RedTrace server @ http://%s:%s\n' "$HOST" "$PORT"
  REDTRACE_DISPATCH_CONFIG="$CONFIG_PATH" \
    uv run --project "$PROJECT_DIR" redtrace serve --db-path "$DB_PATH" --host "$HOST" --port "$PORT" &
  SERVER_PID=$!
  OWNS_SERVER=1

  deadline=$((SECONDS + START_TIMEOUT))
  until is_ready; do
    if ! kill -0 "$SERVER_PID" >/dev/null 2>&1; then
      st=0; wait "$SERVER_PID" || st=$?
      printf 'error: 服务进程在就绪前退出(status=%s)\n' "$st" >&2
      EXITCODE=1; exit 1
    fi
    ((SECONDS >= deadline)) && { printf 'error: 服务健康检查超时(%ss)\n' "$START_TIMEOUT" >&2; EXITCODE=1; exit 1; }
    sleep 0.25
  done
else
  printf '[serve] 复用已在运行的 RedTrace server (%s)\n' "$(server_url)"
fi

printf '[dispatch] starting scheduler with %s\n' "$CONFIG_PATH"
uv run --project "$PROJECT_DIR" redtrace dispatch --config "$CONFIG_PATH" &
DISPATCHER_PID=$!

# 给调度器一个起步窗口再开测；失败不致命，仅记录。
i=0
while ((i < 40)) && kill -0 "$DISPATCHER_PID" >/dev/null 2>&1; do sleep 0.25; i=$((i + 1)); done

printf '[bench] starting single-project evaluation now...\n'
set +e
python3 "$ROOT/bench/benchctl.py" run
rc=$?
set -e
printf '[bench] finished with status=%s\n' "$rc"
EXITCODE=$rc
exit "$rc"
