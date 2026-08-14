#!/usr/bin/env bash

set -Eeuo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
ENV_FILE="$DIR/.env"
PYTHON="${PYTHON:-python3}"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
else
  echo "warning: $ENV_FILE 不存在，按系统环境变量运行（参考 .env.example）" >&2
fi

if [[ -z "${BENCHMARK_TOKEN:-}" ]]; then
  echo "error: BENCHMARK_TOKEN 为空，请编辑 $ENV_FILE 后重试" >&2
  exit 1
fi

command -v "$PYTHON" >/dev/null 2>&1 || { echo "error: python3 未安装或不在 PATH" >&2; exit 1; }

# 1) 用环境变量渲染 redtrace.yaml（敏感配置不写入代码包）
"$PYTHON" "$DIR/bench/render_config.py" "$DIR/redtrace.yaml.template" "$DIR/redtrace.yaml"

# 2) 后台启动 RedTrace（Server + Dispatcher，本地模式）
"$DIR/start-redtrace.sh" --config "$DIR/redtrace.yaml" &
RT_PID=$!

cleanup() {
  if [[ -n "${RT_PID:-}" ]]; then
    kill "$RT_PID" 2>/dev/null || true
    wait "$RT_PID" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

# 3) 等待 RedTrace Server 就绪
ready=0
for _ in $(seq 1 200); do
  if curl -fsS --max-time 2 "http://127.0.0.1:8000/projects" >/dev/null 2>&1; then
    ready=1
    break
  fi
  if ! kill -0 "$RT_PID" 2>/dev/null; then
    echo "error: RedTrace 启动进程提前退出" >&2
    exit 1
  fi
  sleep 0.25
done
if [[ "$ready" != "1" ]]; then
  echo "error: RedTrace Server 启动超时" >&2
  exit 1
fi

# 4) 开始评测（VPN 预检通过后自动逐题推进）；RedTrace 中途挂掉则终止跑分
"$PYTHON" "$DIR/bench/benchctl.py" run &
BENCH_PID=$!
while kill -0 "$BENCH_PID" 2>/dev/null; do
  if ! kill -0 "$RT_PID" 2>/dev/null; then
    echo "error: RedTrace 进程已退出，终止跑分" >&2
    kill "$BENCH_PID" 2>/dev/null || true
    break
  fi
  sleep 1
done
bench_status=0
wait "$BENCH_PID" || bench_status=$?
exit "$bench_status"
