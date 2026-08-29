#!/usr/bin/env bash
# Chrome CDP daemon for WSL — runs Chrome in headless mode with remote
# debugging, auto-restarts on crash. Used by chrome-devtools-mcp.
#
# Usage:  bash scripts/chrome-cdp-daemon.sh [start|stop|status]
# Default CDP port: 9222

set -Eeuo pipefail

CDP_PORT="${CHROME_CDP_PORT:-9222}"
PIDFILE="/tmp/chrome-cdp-daemon.pid"
LOGFILE="/tmp/chrome-cdp-daemon.log"

find_chrome() {
  for cmd in google-chrome chromium chromium-browser; do
    if command -v "$cmd" >/dev/null 2>&1; then
      command -v "$cmd"
      return
    fi
  done
  echo "ERROR: no Chrome/Chromium found" >&2
  return 1
}

is_alive() {
  curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" >/dev/null 2>&1
}

start_chrome() {
  local chrome
  chrome="$(find_chrome)" || exit 1

  # Kill any existing Chrome on the CDP port
  if [[ -f "$PIDFILE" ]]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
    sleep 1
  fi
  # Also kill stale Chrome processes from previous runs
  pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true
  sleep 1

  echo "Starting Chrome (CDP port ${CDP_PORT})..." >&2
  "$chrome" \
    --headless \
    --no-sandbox \
    --disable-gpu \
    --disable-dev-shm-usage \
    --disable-extensions \
    --disable-background-networking \
    --remote-debugging-port="${CDP_PORT}" \
    --user-data-dir="/tmp/chrome-cdp-profile" \
    about:blank \
    >>"$LOGFILE" 2>&1 &

  local pid=$!
  echo "$pid" > "$PIDFILE"
  echo "Chrome PID: $pid" >&2

  # Wait for CDP to be ready (up to 15s)
  for i in $(seq 1 30); do
    if is_alive; then
      echo "Chrome CDP ready on port ${CDP_PORT}" >&2
      return 0
    fi
    sleep 0.5
  done
  echo "ERROR: Chrome failed to start within 15s" >&2
  return 1
}

watchdog() {
  # Foreground watchdog: restart Chrome if it dies
  echo "Watchdog started — monitoring Chrome on CDP port ${CDP_PORT}" >&2
  while true; do
    if ! is_alive; then
      echo "$(date -Iseconds) Chrome dead, restarting..." >&2
      start_chrome
    fi
    sleep 5
  done
}

stop_chrome() {
  if [[ -f "$PIDFILE" ]]; then
    kill "$(cat "$PIDFILE")" 2>/dev/null || true
    rm -f "$PIDFILE"
  fi
  pkill -f "remote-debugging-port=${CDP_PORT}" 2>/dev/null || true
  echo "Chrome stopped" >&2
}

status_chrome() {
  if is_alive; then
    echo "Chrome CDP alive on port ${CDP_PORT}"
    curl -sf "http://127.0.0.1:${CDP_PORT}/json/version" 2>/dev/null
  else
    echo "Chrome CDP not responding on port ${CDP_PORT}"
  fi
}

case "${1:-start}" in
  start)   start_chrome ;;
  stop)    stop_chrome ;;
  status)  status_chrome ;;
  watchdog) start_chrome && watchdog ;;
  *)       echo "Usage: $0 {start|stop|status|watchdog}" >&2; exit 1 ;;
esac
