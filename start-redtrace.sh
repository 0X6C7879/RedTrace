#!/usr/bin/env bash

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
PROJECT_DIR="$SCRIPT_DIR/redtrace"
CONFIG_PATH="$SCRIPT_DIR/redtrace.yaml"
HOST="${REDTRACE_HOST:-127.0.0.1}"
PORT="${REDTRACE_PORT:-8000}"
START_TIMEOUT="${REDTRACE_START_TIMEOUT:-40}"
SHUTDOWN_TIMEOUT="${REDTRACE_SHUTDOWN_TIMEOUT:-8}"

SERVER_PID=""
DISPATCHER_PID=""
OWNS_SERVER=0
SHUTTING_DOWN=0

usage() {
  cat <<'EOF'
Usage: ./start-redtrace.sh [options]

Start the RedTrace Server and Dispatcher together.

Options:
  --config PATH   Runtime config (default: ./redtrace.yaml)
  --host HOST     Server bind host (default: 127.0.0.1)
  --port PORT     Server bind port (default: 8000)
  -h, --help      Show this help

Environment:
  REDTRACE_HOST
  REDTRACE_PORT
  REDTRACE_START_TIMEOUT
  REDTRACE_SHUTDOWN_TIMEOUT
  REDTRACE_PYTHON            Healthy Python >= 3.12 used to repair a broken .venv

Press Ctrl+C to stop the components started by this script.
If a healthy Server is already listening, the script starts only the Dispatcher
and leaves the existing Server running when it exits.
EOF
}

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

is_positive_integer() {
  case "$1" in
    ''|*[!0-9]*|0) return 1 ;;
    *) return 0 ;;
  esac
}

python_is_healthy() {
  local interpreter="$1"
  local identity

  [[ -x "$interpreter" ]] || return 1
  identity="$("$interpreter" -c 'import sys; print(f"redtrace-python:{sys.version_info.major}.{sys.version_info.minor}")' 2>/dev/null)" || return 1
  case "$identity" in
    redtrace-python:3.1[2-9]|redtrace-python:3.[2-9][0-9]) return 0 ;;
    *) return 1 ;;
  esac
}

find_healthy_python() {
  local requested="${REDTRACE_PYTHON:-}"
  local name
  local candidate

  if [[ -n "$requested" ]]; then
    python_is_healthy "$requested" || die "REDTRACE_PYTHON is not a working Python >= 3.12: $requested"
    printf '%s\n' "$requested"
    return 0
  fi
  for name in python3.13 python3.12 python3; do
    candidate="$(command -v "$name" 2>/dev/null || true)"
    if [[ -n "$candidate" ]] && python_is_healthy "$candidate"; then
      printf '%s\n' "$candidate"
      return 0
    fi
  done
  return 1
}

ensure_project_environment() {
  local environment="$PROJECT_DIR/.venv"
  local project_python="$environment/bin/python3"
  local healthy_python

  [[ -d "$environment" ]] || return 0
  python_is_healthy "$project_python" && return 0
  healthy_python="$(find_healthy_python)" || die "project .venv is broken and no healthy Python >= 3.12 was found"
  printf 'RedTrace project Python environment is damaged; rebuilding it with %s ...\n' "$healthy_python"
  uv venv --clear --python "$healthy_python" "$environment" >/dev/null
  python_is_healthy "$project_python" || die "project .venv rebuild did not produce a working Python"
}

absolute_file_path() {
  local path="$1"
  local directory
  directory="$(cd "$(dirname "$path")" && pwd -P)"
  printf '%s/%s\n' "$directory" "$(basename "$path")"
}

server_url() {
  local probe_host="$HOST"
  case "$probe_host" in
    0.0.0.0|::|'[::]') probe_host="127.0.0.1" ;;
  esac
  printf 'http://%s:%s/projects\n' "$probe_host" "$PORT"
}

server_is_ready() {
  curl -fsS --max-time 2 "$(server_url)" >/dev/null 2>&1
}

child_pids() {
  local parent_pid="$1"
  if command -v pgrep >/dev/null 2>&1; then
    pgrep -P "$parent_pid" 2>/dev/null || true
  fi
}

process_is_alive() {
  local pid="$1"
  local state

  kill -0 "$pid" 2>/dev/null || return 1
  state="$(ps -o stat= -p "$pid" 2>/dev/null || true)"
  case "$state" in
    *Z*) return 1 ;;
    *) return 0 ;;
  esac
}

signal_tree() {
  local signal_name="$1"
  local parent_pid="$2"
  local child_pid

  for child_pid in $(child_pids "$parent_pid"); do
    signal_tree "$signal_name" "$child_pid"
  done
  kill "-$signal_name" "$parent_pid" 2>/dev/null || true
}

stop_process() {
  local pid="$1"
  local deadline=$((SECONDS + SHUTDOWN_TIMEOUT))

  process_is_alive "$pid" || {
    wait "$pid" 2>/dev/null || true
    return 0
  }
  signal_tree TERM "$pid"
  while process_is_alive "$pid" && ((SECONDS < deadline)); do
    sleep 0.1
  done
  if process_is_alive "$pid"; then
    signal_tree KILL "$pid"
  fi
  wait "$pid" 2>/dev/null || true
}

cleanup() {
  local exit_code=$?
  ((SHUTTING_DOWN == 0)) || return "$exit_code"
  SHUTTING_DOWN=1
  trap - EXIT INT TERM HUP

  if [[ -n "$DISPATCHER_PID" ]]; then
    printf '\nStopping Dispatcher...\n'
    stop_process "$DISPATCHER_PID"
  fi
  if ((OWNS_SERVER == 1)) && [[ -n "$SERVER_PID" ]]; then
    printf 'Stopping Server...\n'
    stop_process "$SERVER_PID"
  fi
  return "$exit_code"
}

handle_signal() {
  local exit_code="$1"
  exit "$exit_code"
}

while (($# > 0)); do
  case "$1" in
    --config)
      (($# >= 2)) || die "--config requires a path"
      CONFIG_PATH="$2"
      shift 2
      ;;
    --host)
      (($# >= 2)) || die "--host requires a value"
      HOST="$2"
      shift 2
      ;;
    --port)
      (($# >= 2)) || die "--port requires a value"
      PORT="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

command -v uv >/dev/null 2>&1 || die "uv is not installed or not on PATH"
command -v curl >/dev/null 2>&1 || die "curl is not installed or not on PATH"
[[ -d "$PROJECT_DIR" ]] || die "Python project not found: $PROJECT_DIR"
[[ -f "$CONFIG_PATH" ]] || die "dispatcher config not found: $CONFIG_PATH"
is_positive_integer "$PORT" || die "--port must be a positive integer"
is_positive_integer "$START_TIMEOUT" || die "REDTRACE_START_TIMEOUT must be a positive integer"
is_positive_integer "$SHUTDOWN_TIMEOUT" || die "REDTRACE_SHUTDOWN_TIMEOUT must be a positive integer"

CONFIG_PATH="$(absolute_file_path "$CONFIG_PATH")"
ensure_project_environment
trap cleanup EXIT
trap 'handle_signal 130' INT
trap 'handle_signal 143' TERM
trap 'handle_signal 129' HUP

if server_is_ready; then
  printf 'RedTrace Server is already available at http://%s:%s; reusing it.\n' "$HOST" "$PORT"
else
  printf 'Starting RedTrace Server at http://%s:%s ...\n' "$HOST" "$PORT"
  REDTRACE_DISPATCH_CONFIG="$CONFIG_PATH" \
    uv run --project "$PROJECT_DIR" redtrace serve --host "$HOST" --port "$PORT" &
  SERVER_PID=$!
  OWNS_SERVER=1

  start_deadline=$((SECONDS + START_TIMEOUT))
  until server_is_ready; do
    if ! process_is_alive "$SERVER_PID"; then
      server_status=0
      wait "$SERVER_PID" || server_status=$?
      SERVER_PID=""
      die "Server exited before becoming ready (status $server_status)"
    fi
    if ((SECONDS >= start_deadline)); then
      die "Server health check timed out after ${START_TIMEOUT}s"
    fi
    sleep 0.1
  done
fi

printf 'Starting RedTrace Dispatcher with %s ...\n' "$CONFIG_PATH"
uv run --project "$PROJECT_DIR" redtrace dispatch --config "$CONFIG_PATH" &
DISPATCHER_PID=$!

printf 'RedTrace is running. Press Ctrl+C to stop.\n'
while :; do
  if ! process_is_alive "$DISPATCHER_PID"; then
    dispatcher_status=0
    wait "$DISPATCHER_PID" || dispatcher_status=$?
    DISPATCHER_PID=""
    printf 'Dispatcher exited (status %s).\n' "$dispatcher_status" >&2
    exit "$dispatcher_status"
  fi
  if ((OWNS_SERVER == 1)) && ! process_is_alive "$SERVER_PID"; then
    server_status=0
    wait "$SERVER_PID" || server_status=$?
    SERVER_PID=""
    printf 'Server exited (status %s).\n' "$server_status" >&2
    exit "$server_status"
  fi
  sleep 1
done
