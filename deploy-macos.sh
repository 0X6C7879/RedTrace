#!/usr/bin/env bash
# RedTrace local-mode bootstrap for macOS (Apple Silicon and Intel).
# Run as the same user that should own and reuse Claude/Codex/Pi login state.
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${REDTRACE_CONFIG_PATH:-$PROJECT_DIR/dispatch.local.yaml}"
RUN_DIR="$PROJECT_DIR/.redtrace/run"
LOG_DIR="$PROJECT_DIR/.redtrace/log"
TOOL_VENV="${REDTRACE_TOOL_VENV:-$HOME/.local/share/redtrace-tools}"
NPM_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
PYPI_INDEX="${UV_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}"
REDTRACE_HOST="${REDTRACE_HOST:-127.0.0.1}"
REDTRACE_PORT="${REDTRACE_PORT:-8000}"
case "$PROJECT_DIR" in
  "$HOME/Downloads/"*|"$HOME/Desktop/"*|"$HOME/Documents/"*)
    DEFAULT_USE_LAUNCHD=0
    ;;
  *)
    DEFAULT_USE_LAUNCHD=1
    ;;
esac
REDTRACE_USE_LAUNCHD="${REDTRACE_USE_LAUNCHD:-$DEFAULT_USE_LAUNCHD}"
BRAVE_SKILL_DIR="$PROJECT_DIR/skills/brave-search"

log() { printf '[RedTrace] %s\n' "$*"; }
warn() { printf '[RedTrace] WARNING: %s\n' "$*" >&2; }
die() { printf '[RedTrace] ERROR: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

[[ "$(uname -s)" == "Darwin" ]] || die "deploy-macos.sh supports macOS only"
case "$(uname -m)" in
  arm64|x86_64) ;;
  *) die "unsupported macOS architecture: $(uname -m)" ;;
esac
chmod +x "$0" 2>/dev/null || true

ensure_command_line_tools() {
  if xcode-select -p >/dev/null 2>&1; then
    log "Xcode Command Line Tools are installed"
    return
  fi
  warn "Xcode Command Line Tools are required; opening Apple's installer"
  xcode-select --install >/dev/null 2>&1 || true
  die "complete the Command Line Tools installation, then rerun this script"
}

ensure_homebrew() {
  if ! has brew; then
    log "installing Homebrew"
    NONINTERACTIVE=1 /bin/bash -c \
      "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  fi
  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  has brew || die "Homebrew installation completed but brew is not on PATH"
}

configure_paths() {
  local brew_bin brew_prefix shellenv_line path_line profile
  brew_bin="$(command -v brew)"
  brew_prefix="$(brew --prefix)"
  eval "$("$brew_bin" shellenv)"
  shellenv_line="eval \"\$($brew_bin shellenv)\""
  path_line='export PATH="$HOME/.local/share/redtrace-tools/bin:$HOME/.local/bin:$HOME/go/bin:$PATH"'
  for profile in "$HOME/.zprofile" "$HOME/.zshrc"; do
    touch "$profile"
    grep -Fqx "$shellenv_line" "$profile" || printf '\n%s\n' "$shellenv_line" >>"$profile"
    grep -Fqx "$path_line" "$profile" || printf '%s\n' "$path_line" >>"$profile"
  done
  export PATH="$TOOL_VENV/bin:$HOME/.local/bin:$HOME/go/bin:$brew_prefix/bin:$brew_prefix/sbin:$PATH"
}

repair_homebrew_remotes() {
  local brew_repo tap repo remote official variable value

  # USTC stopped serving homebrew-core.git and homebrew-cask.git in June 2026.
  # An inherited HOMEBREW_CORE_GIT_REMOTE would otherwise rewrite the remote on
  # every `brew update`, so ignore obsolete USTC Git settings in this process.
  for variable in HOMEBREW_CORE_GIT_REMOTE HOMEBREW_CASK_GIT_REMOTE; do
    value="${!variable:-}"
    if [[ "$value" == *mirrors.ustc.edu.cn* ]]; then
      warn "ignoring obsolete $variable=$value"
      unset "$variable"
    fi
  done

  brew_repo="$(brew --repository)"
  remote="$(git -C "$brew_repo" remote get-url origin 2>/dev/null || true)"
  if [[ "$remote" == *mirrors.ustc.edu.cn/homebrew-brew* ]]; then
    log "repairing legacy Homebrew brew mirror remote"
    git -C "$brew_repo" remote set-url origin https://github.com/Homebrew/brew
  fi

  for tap in core cask; do
    case "$tap" in
      core) official="https://github.com/Homebrew/homebrew-core" ;;
      cask) official="https://github.com/Homebrew/homebrew-cask" ;;
    esac
    repo="$(brew --repository "homebrew/$tap" 2>/dev/null || true)"
    [[ -n "$repo" && -d "$repo/.git" ]] || continue
    remote="$(git -C "$repo" remote get-url origin 2>/dev/null || true)"
    if [[ "$remote" == *mirrors.ustc.edu.cn* ]]; then
      log "repairing obsolete homebrew/$tap mirror remote"
      git -C "$repo" remote set-url origin "$official"
    fi
  done
}

update_homebrew() {
  [[ "${REDTRACE_SKIP_BREW_UPDATE:-0}" == "1" ]] && {
    log "skipping brew update (REDTRACE_SKIP_BREW_UPDATE=1)"
    return
  }
  log "updating Homebrew metadata"
  if brew update; then
    return
  fi
  warn "brew update failed; continuing with existing metadata"
  warn "remove obsolete HOMEBREW_*_GIT_REMOTE entries from ~/.zshrc or ~/.zprofile"
  export HOMEBREW_NO_AUTO_UPDATE=1
}

brew_install_required() {
  local formula missing=()
  for formula in "$@"; do
    brew list --formula "$formula" >/dev/null 2>&1 || missing+=("$formula")
  done
  ((${#missing[@]} == 0)) && { log "required Homebrew dependencies already installed"; return; }
  log "installing ${#missing[@]} required Homebrew formulae"
  brew install "${missing[@]}"
}

brew_install_optional() {
  local formula available=()
  for formula in "$@"; do
    brew list --formula "$formula" >/dev/null 2>&1 && continue
    if brew info --formula "$formula" >/dev/null 2>&1; then
      available+=("$formula")
    else
      warn "optional Homebrew formula unavailable and skipped: $formula"
    fi
  done
  for formula in "${available[@]}"; do
    log "installing optional security tool $formula"
    brew install "$formula" || warn "optional security tool failed and was skipped: $formula"
  done
}

ensure_node() {
  local major=0
  if has node; then
    major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
  fi
  if has npm && [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)); then
    log "Node.js $(node --version) and npm are already installed"
    return
  fi
  log "installing/upgrading Node.js through Homebrew"
  brew list --formula node >/dev/null 2>&1 && brew upgrade node || brew install node
  hash -r
  major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
  has npm && [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)) || die "Node.js 22 or newer is required"
}

ensure_npm_cli() {
  local command="$1" package="$2"
  shift 2
  if has "$command"; then
    log "$command already installed: $("$command" --version 2>/dev/null | head -n 1 || true)"
    return
  fi
  log "installing missing CLI $command ($package)"
  NPM_CONFIG_PREFIX="$HOME/.local" npm install -g --registry="$NPM_REGISTRY" "$@" "$package"
  hash -r
  has "$command" || die "$command installation completed but command is not on PATH"
}

ensure_uv() {
  if has uv; then
    log "uv already installed: $(uv --version)"
    return
  fi
  log "installing missing uv"
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$HOME/.local/bin" sh
  hash -r
  has uv || die "uv installation failed"
}

ensure_rtk() {
  if has rtk && rtk gain >/dev/null 2>&1; then
    log "RTK already installed: $(rtk --version)"
    return
  fi
  log "installing Rust Token Killer from rtk-ai/rtk"
  curl -fsSL https://raw.githubusercontent.com/rtk-ai/rtk/master/install.sh | sh
  hash -r
  has rtk && rtk gain >/dev/null 2>&1 || die "RTK installation failed"
}

ensure_pi_mcp_extension() {
  pi list 2>/dev/null | grep -Fq 'pi-mcp-extension' && {
    log "Pi MCP extension already configured"
    return
  }
  log "installing missing Pi MCP extension"
  pi install npm:pi-mcp-extension@1.5.0
}

configure_native_build_env() {
  local openssl libffi gmp mpfr mpc zlib
  openssl="$(brew --prefix openssl@3)"
  libffi="$(brew --prefix libffi)"
  gmp="$(brew --prefix gmp)"
  mpfr="$(brew --prefix mpfr)"
  mpc="$(brew --prefix libmpc)"
  zlib="$(brew --prefix zlib)"
  export CPPFLAGS="-I$openssl/include -I$libffi/include -I$gmp/include -I$mpfr/include -I$mpc/include -I$zlib/include ${CPPFLAGS:-}"
  export LDFLAGS="-L$openssl/lib -L$libffi/lib -L$gmp/lib -L$mpfr/lib -L$mpc/lib -L$zlib/lib ${LDFLAGS:-}"
  export PKG_CONFIG_PATH="$openssl/lib/pkgconfig:$libffi/lib/pkgconfig:$gmp/lib/pkgconfig:$mpfr/lib/pkgconfig:$mpc/lib/pkgconfig:$zlib/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
}

install_skill_python_dependencies() {
  local python="$TOOL_VENV/bin/python" entry spec module
  [[ -x "$python" ]] || { log "creating security-tools Python environment"; uv venv --python 3.12 "$TOOL_VENV"; }
  local entries=(
    'pwntools==4.15.0|pwn' 'pycryptodome==3.23.0|Crypto' 'z3-solver==4.13.0.0|z3'
    'sympy==1.14.0|sympy' 'gmpy2==2.3.0|gmpy2' 'hashpumpy==1.2|hashpumpy'
    'fpylll==0.6.4|fpylll' 'py_ecc==8.0.0|py_ecc' 'angr==9.2.193|angr'
    'frida-tools==14.8.0|frida' 'qiling==1.4.6|qiling' 'requests==2.32.5|requests'
    'flask-unsign==1.2.1|flask_unsign' 'sqlmap==1.10.3|sqlmap' 'ropper==1.13.13|ropper'
    'ROPgadget==7.7|ropgadget' 'volatility3==2.27.0|volatility3' 'yara-python==4.5.4|yara'
    'pefile==2024.8.26|pefile' 'capstone==5.0.3|capstone' 'oletools==0.60.2|oletools'
    'unicorn==2.1.2|unicorn' 'scapy==2.7.0|scapy' 'Pillow==10.4.0|PIL'
    'numpy==2.2.6|numpy' 'matplotlib==3.10.8|matplotlib' 'shodan==1.31.0|shodan'
    'uncompyle6==3.9.3|uncompyle6' 'lief==0.17.6|lief' 'dnspython==2.8.0|dns'
    'dnslib==0.9.26|dnslib' 'dissect.cobaltstrike==1.2.1|dissect.cobaltstrike'
  )
  for entry in "${entries[@]}"; do
    spec="${entry%%|*}"; module="${entry##*|}"
    "$python" -c "import $module" >/dev/null 2>&1 && continue
    log "installing Python security package $spec"
    uv pip install --python "$python" --index-url "$PYPI_INDEX" "$spec" \
      || uv pip install --python "$python" --index-url https://pypi.org/simple "$spec" \
      || warn "Python package unsupported on this Mac and skipped: $spec"
  done
}

ensure_brave_search_skill() {
  [[ -f "$BRAVE_SKILL_DIR/SKILL.md" ]] || die "brave-search SKILL.md is missing"
  [[ -f "$BRAVE_SKILL_DIR/package-lock.json" ]] || die "brave-search package-lock.json is missing"
  if npm --prefix "$BRAVE_SKILL_DIR" ls --depth=0 >/dev/null 2>&1; then
    log "brave-search Node dependencies are already installed"
  else
    log "installing brave-search Node dependencies"
    npm ci --prefix "$BRAVE_SKILL_DIR" --registry="$NPM_REGISTRY"
  fi
  chmod +x "$BRAVE_SKILL_DIR/search.js" "$BRAVE_SKILL_DIR/content.js"
}

install_optional_language_tools() {
  local gem_name
  for gem_name in one_gadget zsteg; do
    gem list -i "^${gem_name}$" >/dev/null 2>&1 && continue
    gem install --user-install "$gem_name" || warn "optional Ruby gem failed and was skipped: $gem_name"
  done
}

prepare_local_config() {
  if [[ -f "$CONFIG_PATH" ]]; then
    chmod 600 "$CONFIG_PATH"
    log "using existing local config: $CONFIG_PATH"
    return
  fi
  [[ -f "$PROJECT_DIR/dispatch.local.example.yaml" ]] || die "dispatch.local.example.yaml is missing"
  cp -- "$PROJECT_DIR/dispatch.local.example.yaml" "$CONFIG_PATH"
  awk -v workspace="$PROJECT_DIR/workspaces" '
    /^  # workspace_root:/ { print "  workspace_root: \"" workspace "\""; next }
    { print }
  ' "$CONFIG_PATH" >"$CONFIG_PATH.tmp.$$"
  mv -- "$CONFIG_PATH.tmp.$$" "$CONFIG_PATH"
  chmod 600 "$CONFIG_PATH"
  log "created local config: $CONFIG_PATH"
}

configure_brave_search_secret() {
  local api_key="${BRAVE_API_KEY:-}"
  if [[ -z "$api_key" ]]; then
    if uv run --project "$PROJECT_DIR/redtrace" python - "$CONFIG_PATH" <<'PY'
import sys
import yaml

from redtrace.config_secrets import secret_id_from_reference
from redtrace.worker_config import WorkerConfigService

with open(sys.argv[1], encoding="utf-8") as handle:
    raw = yaml.safe_load(handle) or {}
value = (raw.get("common_env") or {}).get("BRAVE_API_KEY")
if secret_id_from_reference(value):
    raise SystemExit(0)
if isinstance(value, str) and value:
    WorkerConfigService(sys.argv[1]).set_common_env_secret("BRAVE_API_KEY", value)
    raise SystemExit(0)
raise SystemExit(1)
PY
    then
      log "BRAVE_API_KEY is already configured for all local workers"
      return
    fi
    warn "BRAVE_API_KEY is not configured; export it and rerun to enable brave-search"
    return
  fi

  BRAVE_API_KEY="$api_key" uv run --project "$PROJECT_DIR/redtrace" python - "$CONFIG_PATH" <<'PY'
import os
import sys

from redtrace.worker_config import WorkerConfigService

WorkerConfigService(sys.argv[1]).set_common_env_secret(
    "BRAVE_API_KEY",
    os.environ["BRAVE_API_KEY"],
)
PY
  unset BRAVE_API_KEY
  log "stored BRAVE_API_KEY in the encrypted local Worker configuration"
}

test_brave_search_skill() {
  [[ "${REDTRACE_SKIP_BRAVE_TEST:-0}" == "1" ]] && {
    log "skipping brave-search API test (REDTRACE_SKIP_BRAVE_TEST=1)"
    return
  }

  local api_key attempt
  api_key="$(
    uv run --project "$PROJECT_DIR/redtrace" python - "$CONFIG_PATH" <<'PY'
import sys
from pathlib import Path

from redtrace.dispatcher.config import DispatchConfig

print(
    DispatchConfig.load(Path(sys.argv[1])).common_env.get("BRAVE_API_KEY", "")
)
PY
  )"
  if [[ -z "$api_key" ]]; then
    warn "brave-search API test skipped because BRAVE_API_KEY is not configured"
    return
  fi

  log "testing brave-search API"
  for attempt in 1 2 3; do
    if BRAVE_API_KEY="$api_key" node "$BRAVE_SKILL_DIR/search.js" \
      "RedTrace collaborative agent framework" -n 1 >/dev/null; then
      unset api_key
      log "brave-search API test passed"
      return
    fi
    warn "brave-search API test attempt $attempt failed"
    ((attempt < 3)) && sleep 2
  done
  unset api_key
  die "brave-search API test failed after 3 attempts"
}

pid_is_running() {
  local pid_file="$1" pid
  [[ -s "$pid_file" ]] || return 1
  pid="$(cat "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

start_component() {
  local name="$1" pid_file pid
  shift
  pid_file="$RUN_DIR/$name.pid"
  if pid_is_running "$pid_file"; then
    log "$name already running (pid $(cat "$pid_file"))"
    return
  fi
  rm -f -- "$pid_file"
  log "starting $name"
  uv run --project "$PROJECT_DIR/redtrace" python - \
    "$PROJECT_DIR" "$pid_file" "$LOG_DIR/$name.log" "$@" <<'PY'
import os
import sys
from pathlib import Path

working_directory, pid_path, log_path, *arguments = sys.argv[1:]
first_child = os.fork()
if first_child:
    _, status = os.waitpid(first_child, 0)
    raise SystemExit(os.waitstatus_to_exitcode(status))

os.setsid()
daemon_pid = os.fork()
if daemon_pid:
    path = Path(pid_path)
    temporary = path.with_suffix(".pid.tmp")
    temporary.write_text(f"{daemon_pid}\n", encoding="utf-8")
    temporary.replace(path)
    os._exit(0)

os.chdir(working_directory)
stdin = os.open(os.devnull, os.O_RDONLY)
output = os.open(log_path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
os.dup2(stdin, 0)
os.dup2(output, 1)
os.dup2(output, 2)
os.close(stdin)
os.close(output)
os.execvpe(arguments[0], arguments, os.environ.copy())
PY
  pid="$(cat "$pid_file")"
  sleep 1
  kill -0 "$pid" 2>/dev/null || { tail -n 40 "$LOG_DIR/$name.log" >&2 || true; die "$name failed to start"; }
}

write_launch_agent() {
  local label="$1" log_path="$2" plist_path="$3"
  shift 3
  uv run --project "$PROJECT_DIR/redtrace" python - \
    "$plist_path" "$label" "$PROJECT_DIR" "$log_path" "$CONFIG_PATH" \
    "${REDTRACE_CONFIG_SECRETS_DIR:-$PROJECT_DIR/.redtrace-secrets}" \
    "$HOME" "$WORKER_PATH:$PATH" "$REDTRACE_LOCAL_PATH_PREPEND" "$@" <<'PY'
import plistlib
import sys
from pathlib import Path

(
    plist_path,
    label,
    working_directory,
    log_path,
    config_path,
    secrets_directory,
    home_directory,
    process_path,
    worker_path,
    *arguments,
) = sys.argv[1:]
payload = {
    "Label": label,
    "ProgramArguments": arguments,
    "WorkingDirectory": working_directory,
    "EnvironmentVariables": {
        "PATH": process_path,
        "HOME": home_directory,
        "REDTRACE_DISPATCH_CONFIG": config_path,
        "REDTRACE_CONFIG_SECRETS_DIR": secrets_directory,
        "REDTRACE_LOCAL_PATH_PREPEND": worker_path,
        "PYTHONUNBUFFERED": "1",
    },
    "RunAtLoad": True,
    "KeepAlive": True,
    "ProcessType": "Background",
    "ThrottleInterval": 5,
    "StandardOutPath": log_path,
    "StandardErrorPath": log_path,
}
path = Path(plist_path)
path.parent.mkdir(parents=True, exist_ok=True)
temporary = path.with_suffix(".plist.tmp")
with temporary.open("wb") as handle:
    plistlib.dump(payload, handle, sort_keys=False)
temporary.replace(path)
path.chmod(0o600)
PY
}

launchd_pid() {
  local label="$1"
  launchctl print "gui/$(id -u)/$label" 2>/dev/null \
    | awk '/^[[:space:]]*pid = / { print $3; exit }'
}

stop_launch_agents() {
  local uid_value
  uid_value="$(id -u)"
  launchctl bootout "gui/$uid_value/com.redtrace.dispatcher" >/dev/null 2>&1 || true
  launchctl bootout "gui/$uid_value/com.redtrace.server" >/dev/null 2>&1 || true
}

start_launch_agents() {
  local uid_value uv_path agent_dir server_label dispatcher_label
  local server_plist dispatcher_plist server_pid dispatcher_pid
  uid_value="$(id -u)"
  uv_path="$(command -v uv)"
  agent_dir="$HOME/Library/LaunchAgents"
  server_label="com.redtrace.server"
  dispatcher_label="com.redtrace.dispatcher"
  server_plist="$agent_dir/$server_label.plist"
  dispatcher_plist="$agent_dir/$dispatcher_label.plist"

  write_launch_agent \
    "$server_label" "$LOG_DIR/server.log" "$server_plist" \
    "$uv_path" run --project "$PROJECT_DIR/redtrace" redtrace serve \
    --host "$REDTRACE_HOST" --port "$REDTRACE_PORT"
  write_launch_agent \
    "$dispatcher_label" "$LOG_DIR/dispatcher.log" "$dispatcher_plist" \
    "$uv_path" run --project "$PROJECT_DIR/redtrace" redtrace dispatch \
    --config "$CONFIG_PATH"

  stop_launch_agents
  log "starting server with launchd"
  launchctl bootstrap "gui/$uid_value" "$server_plist"

  log "waiting for RedTrace server"
  for _ in $(seq 1 40); do
    curl -fsS "http://127.0.0.1:$REDTRACE_PORT/projects" >/dev/null 2>&1 && break
    sleep 1
  done
  curl -fsS "http://127.0.0.1:$REDTRACE_PORT/projects" >/dev/null 2>&1 \
    || { tail -n 40 "$LOG_DIR/server.log" >&2 || true; die "server health check timed out"; }

  log "starting dispatcher with launchd"
  launchctl bootstrap "gui/$uid_value" "$dispatcher_plist"
  sleep 2
  server_pid="$(launchd_pid "$server_label")"
  dispatcher_pid="$(launchd_pid "$dispatcher_label")"
  [[ "$server_pid" =~ ^[0-9]+$ ]] || die "launchd server has no running pid"
  [[ "$dispatcher_pid" =~ ^[0-9]+$ ]] || die "launchd dispatcher has no running pid"
  printf '%s\n' "$server_pid" >"$RUN_DIR/server.pid"
  printf '%s\n' "$dispatcher_pid" >"$RUN_DIR/dispatcher.pid"
}

ensure_command_line_tools
ensure_homebrew
configure_paths
repair_homebrew_remotes
update_homebrew

REQUIRED_FORMULAE=(
  ca-certificates curl git xz pkg-config cmake ninja swig
  python@3.12 libffi openssl@3 gmp mpfr libmpc zlib libomp
  ruby go jq ripgrep
)
brew_install_required "${REQUIRED_FORMULAE[@]}"
ensure_node

if [[ "${REDTRACE_SKIP_OPTIONAL_TOOLS:-0}" != "1" ]]; then
  OPTIONAL_FORMULAE=(
    ffuf gdb radare2 binutils binwalk exiftool sleuthkit ffmpeg steghide testdisk
    john-jumbo nmap hashcat imagemagick apktool upx qemu qrencode sshpass rlwrap
    nikto dirsearch yq yara p7zip foremost pcapfix
  )
  brew_install_optional "${OPTIONAL_FORMULAE[@]}"
else
  log "skipping optional security tools (REDTRACE_SKIP_OPTIONAL_TOOLS=1)"
fi

if [[ "${REDTRACE_INSTALL_CASKS:-0}" == "1" ]]; then
  for cask in wireshark android-platform-tools; do
    brew list --cask "$cask" >/dev/null 2>&1 && continue
    brew info --cask "$cask" >/dev/null 2>&1 && brew install --cask "$cask" \
      || warn "optional cask unavailable or failed: $cask"
  done
fi

configure_paths
ensure_uv
ensure_npm_cli claude '@anthropic-ai/claude-code@latest'
ensure_npm_cli codex '@openai/codex@latest'
ensure_npm_cli pi '@earendil-works/pi-coding-agent@latest' --ignore-scripts
ensure_pi_mcp_extension
ensure_rtk
ensure_brave_search_skill
if [[ "${REDTRACE_SKIP_OPTIONAL_TOOLS:-0}" != "1" ]]; then
  configure_native_build_env
  install_skill_python_dependencies
  install_optional_language_tools
else
  log "skipping optional Python and Ruby security tools"
fi

log "syncing RedTrace Python environment"
if ! UV_INDEX_URL="$PYPI_INDEX" uv sync --frozen --project "$PROJECT_DIR/redtrace"; then
  warn "configured PyPI mirror failed; retrying from official PyPI"
  UV_INDEX_URL=https://pypi.org/simple uv sync --frozen --project "$PROJECT_DIR/redtrace"
fi
prepare_local_config
configure_brave_search_secret
test_brave_search_skill

mkdir -p "$RUN_DIR" "$LOG_DIR" "$PROJECT_DIR/workspaces"
GEM_BIN="$(ruby -e 'print Gem.user_dir')/bin"
WORKER_PATH="$TOOL_VENV/bin:$HOME/.local/bin:$HOME/go/bin:$GEM_BIN:$(brew --prefix)/bin:$(brew --prefix)/sbin"
export REDTRACE_LOCAL_PATH_PREPEND="$WORKER_PATH"
export REDTRACE_DISPATCH_CONFIG="$CONFIG_PATH"

if [[ "$REDTRACE_USE_LAUNCHD" == "1" ]]; then
  start_launch_agents
else
  stop_launch_agents
  start_component server \
    uv run --project "$PROJECT_DIR/redtrace" redtrace serve --host "$REDTRACE_HOST" --port "$REDTRACE_PORT"

  log "waiting for RedTrace server"
  server_ready=0
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:$REDTRACE_PORT/projects" >/dev/null 2>&1; then
      server_ready=1
      break
    fi
    sleep 1
  done
  ((server_ready == 1)) || { tail -n 40 "$LOG_DIR/server.log" >&2 || true; die "server health check timed out"; }

  start_component dispatcher \
    uv run --project "$PROJECT_DIR/redtrace" redtrace dispatch --config "$CONFIG_PATH"
fi

UI_URL="http://127.0.0.1:$REDTRACE_PORT"
cat <<SUMMARY

RedTrace local mode is running on macOS.
  UI:         $UI_URL
  Config:     $CONFIG_PATH
  Server:     pid $(cat "$RUN_DIR/server.pid"), log $LOG_DIR/server.log
  Dispatcher: pid $(cat "$RUN_DIR/dispatcher.pid"), log $LOG_DIR/dispatcher.log

Worker API settings override each process; empty settings keep the CLI's existing login/global configuration.

Optional controls:
  REDTRACE_SKIP_OPTIONAL_TOOLS=1  Skip the large security-tool set
  REDTRACE_INSTALL_CASKS=1        Install Wireshark and Android platform tools
  REDTRACE_SKIP_BREW_UPDATE=1     Skip brew update
  REDTRACE_SKIP_BRAVE_TEST=1      Skip the brave-search API smoke test
  REDTRACE_USE_LAUNCHD=0          Use detached processes instead of launchd
  REDTRACE_NO_OPEN=1              Do not open the browser automatically

Stop with:
$(
  if [[ "$REDTRACE_USE_LAUNCHD" == "1" ]]; then
    printf '  launchctl bootout gui/%s/com.redtrace.dispatcher\n' "$(id -u)"
    printf '  launchctl bootout gui/%s/com.redtrace.server\n' "$(id -u)"
  else
    printf '  kill %s %s\n' "$(cat "$RUN_DIR/server.pid")" "$(cat "$RUN_DIR/dispatcher.pid")"
  fi
)
SUMMARY

[[ "${REDTRACE_NO_OPEN:-0}" == "1" ]] || open "$UI_URL" >/dev/null 2>&1 || true
