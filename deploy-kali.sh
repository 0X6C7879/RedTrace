#!/usr/bin/env bash
# RedTrace — Local Mode deployment inside WSL2 Kali (no Docker).
# Workers run as host processes reusing the claude / codex CLIs installed in Kali.
#
# Usage (run from inside Kali):
#   cd /mnt/d/AI/RedTrace        # or copy this folder to ~/redtrace first
#   bash deploy-kali.sh
#
# Prerequisites inside Kali:
#   - python3.12+  (apt install python3 python3-venv)
#   - uv           (curl -LsSf https://astral.sh/uv/install.sh | sh)
#   - claude       (npm install -g @anthropic-ai/claude-code)  AND logged in (claude login)
#   - codex        (npm install -g codex)                      AND logged in (codex login)
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$PROJECT_DIR"

echo "==> RedTrace project dir: $PROJECT_DIR"

# Make workspace_root absolute & correct for wherever this script is run from.
sed -i "s|^  workspace_root:.*|  workspace_root: \"$PROJECT_DIR/workspaces\"|" dispatch.yaml

echo "==> Checking required tools..."
for t in uv python3 claude codex; do
  if ! command -v "$t" >/dev/null 2>&1; then
    echo "ERROR: '$t' not found in PATH."
    case "$t" in
      uv)     echo "  Install uv : curl -LsSf https://astral.sh/uv/install.sh | sh" ;;
      claude) echo "  Install    : npm install -g @anthropic-ai/claude-code  (then: claude login)" ;;
      codex)  echo "  Install    : npm install -g codex                       (then: codex login)" ;;
    esac
    exit 1
  fi
done

echo "==> Installing Python deps (uv sync) ..."
uv sync --frozen --project redtrace

echo "==> Starting RedTrace server on :8000 ..."
nohup uv run --project redtrace redtrace serve --host 0.0.0.0 --port 8000 \
  > "$PROJECT_DIR/server.log" 2>&1 &
SERVER_PID=$!
echo "    server pid=$SERVER_PID  (log: $PROJECT_DIR/server.log)"

echo "==> Waiting for server health ..."
for i in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8000/projects >/dev/null 2>&1; then
    echo "    server is up."
    break
  fi
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    echo "ERROR: server exited. Tail of server.log:"; tail -n 25 "$PROJECT_DIR/server.log"; exit 1
  fi
  sleep 1
done

echo "==> Starting RedTrace dispatcher (local mode) ..."
nohup uv run --project redtrace redtrace dispatch --config dispatch.yaml \
  > "$PROJECT_DIR/dispatcher.log" 2>&1 &
DISPATCHER_PID=$!
echo "    dispatcher pid=$DISPATCHER_PID  (log: $PROJECT_DIR/dispatcher.log)"

sleep 3
echo
echo "=================================================================="
echo " RedTrace deployed — Local Mode, WSL2 Kali (no Docker)"
echo " Server (in Kali) : http://127.0.0.1:8000"
echo " Server (Windows) : http://localhost:8000   (or WSL2 IP from: hostname -I)"
echo " Server PID       : $SERVER_PID"
echo " Dispatcher PID   : $DISPATCHER_PID"
echo " Logs             : $PROJECT_DIR/server.log"
echo "                   $PROJECT_DIR/dispatcher.log"
echo " Stop             : kill $SERVER_PID $DISPATCHER_PID"
echo "=================================================================="
