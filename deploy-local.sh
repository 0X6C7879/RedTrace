#!/usr/bin/env bash
# RedTrace local-mode bootstrap. The primary deployment target is Kali running
# as root inside Windows WSL; Ubuntu and non-root Linux remain supported.
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${REDTRACE_CONFIG_PATH:-$PROJECT_DIR/dispatch.local.yaml}"
RUN_DIR="$PROJECT_DIR/.redtrace/run"
LOG_DIR="$PROJECT_DIR/.redtrace/log"
TOOL_VENV="${REDTRACE_TOOL_VENV:-$HOME/.local/share/redtrace-tools}"
NPM_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
PYPI_INDEX="${UV_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}"
BRAVE_SKILL_DIR="$PROJECT_DIR/skills/brave-search"

log() { printf '[RedTrace] %s\n' "$*"; }
warn() { printf '[RedTrace] WARNING: %s\n' "$*" >&2; }
die() { printf '[RedTrace] ERROR: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

if [[ "$(uname -s)" != "Linux" ]]; then
  die "deploy-local.sh supports Linux local mode only"
fi
if [[ ! -r /etc/os-release ]]; then
  die "cannot detect Linux distribution (/etc/os-release is missing)"
fi

# shellcheck disable=SC1091
source /etc/os-release
DISTRO_ID="${ID:-}"
DISTRO_CODENAME="${VERSION_CODENAME:-}"
case "$DISTRO_ID" in
  ubuntu|kali) ;;
  *) die "supported distributions are Ubuntu and Kali; detected: ${DISTRO_ID:-unknown}" ;;
esac

if grep -qi microsoft /proc/version 2>/dev/null; then
  log "detected Windows WSL"
else
  warn "the primary deployment target is Windows WSL; continuing on native Linux"
fi

if (( EUID == 0 )); then
  SUDO=()
else
  warn "the primary Kali/WSL deployment runs as root; continuing with sudo"
  has sudo || die "sudo is required for apt source and package setup"
  SUDO=(sudo)
fi

backup_once() {
  local path="$1"
  [[ -e "$path" ]] || return 0
  [[ -e "${path}.redtrace.bak" ]] || "${SUDO[@]}" cp -a -- "$path" "${path}.redtrace.bak"
}

configure_china_apt_mirror() {
  if [[ "${REDTRACE_KEEP_APT_SOURCES:-0}" == "1" ]]; then
    log "keeping existing apt sources (REDTRACE_KEEP_APT_SOURCES=1)"
    return
  fi

  log "configuring Aliyun apt mirror for $DISTRO_ID"
  if [[ "$DISTRO_ID" == "kali" ]]; then
    backup_once /etc/apt/sources.list
    printf '%s\n' \
      'deb https://mirrors.aliyun.com/kali kali-rolling main non-free contrib non-free-firmware' \
      | "${SUDO[@]}" tee /etc/apt/sources.list >/dev/null
    if [[ -d /etc/apt/sources.list.d ]]; then
      while IFS= read -r file; do
        backup_once "$file"
        "${SUDO[@]}" sed -Ei \
          's#https?://(http\.kali\.org|kali\.download)/kali#https://mirrors.aliyun.com/kali#g' \
          "$file"
      done < <(find /etc/apt/sources.list.d -maxdepth 1 -type f \( -name '*.list' -o -name '*.sources' \) -print)
    fi
    return
  fi

  [[ -n "$DISTRO_CODENAME" ]] || die "Ubuntu VERSION_CODENAME is missing"
  local changed=0
  local file
  for file in /etc/apt/sources.list /etc/apt/sources.list.d/ubuntu.sources; do
    [[ -f "$file" ]] || continue
    backup_once "$file"
    "${SUDO[@]}" sed -Ei \
      -e 's#https?://([a-zA-Z0-9.-]+\.)?archive\.ubuntu\.com/ubuntu/?#https://mirrors.aliyun.com/ubuntu/#g' \
      -e 's#https?://security\.ubuntu\.com/ubuntu/?#https://mirrors.aliyun.com/ubuntu/#g' \
      "$file"
    changed=1
  done
  if (( changed == 0 )); then
    printf 'deb https://mirrors.aliyun.com/ubuntu/ %s main restricted universe multiverse\n' \
      "$DISTRO_CODENAME" | "${SUDO[@]}" tee /etc/apt/sources.list >/dev/null
    printf 'deb https://mirrors.aliyun.com/ubuntu/ %s-updates main restricted universe multiverse\n' \
      "$DISTRO_CODENAME" | "${SUDO[@]}" tee -a /etc/apt/sources.list >/dev/null
    printf 'deb https://mirrors.aliyun.com/ubuntu/ %s-security main restricted universe multiverse\n' \
      "$DISTRO_CODENAME" | "${SUDO[@]}" tee -a /etc/apt/sources.list >/dev/null
  fi
}

install_missing_apt_packages() {
  local requested=("$@")
  local missing=()
  local unavailable=()
  local package
  local candidate
  local provider
  for package in "${requested[@]}"; do
    if dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed'; then
      continue
    fi
    # `apt-cache show` can still return metadata for packages that have no
    # installable candidate in the current distro/repository (for example,
    # sagemath on Kali rolling). Check the actual candidate before including
    # the package in the all-or-nothing apt install below.
    candidate="$(apt-cache policy "$package" 2>/dev/null | awk '
      $1 == "Candidate:" { candidate = $2 }
      END { if (candidate) print candidate }
    ')"
    if [[ -z "$candidate" || "$candidate" == "(none)" ]]; then
      # Debian-family repositories may expose a transitional/virtual package
      # only through Reverse Provides (Kali's `dnsutils` -> `bind9-dnsutils`
      # is a common example). Keep the requested name so apt can resolve it,
      # but accept it when one of its providers has an installable candidate.
      provider="$(apt-cache showpkg "$package" 2>/dev/null | awk '
        /^Reverse Provides:/ { in_reverse_provides = 1; next }
        in_reverse_provides && NF && !found { print $1; found = 1 }
      ')"
      if [[ -n "$provider" ]]; then
        candidate="$(apt-cache policy "$provider" 2>/dev/null | awk '
          $1 == "Candidate:" { candidate = $2 }
          END { if (candidate) print candidate }
        ')"
      fi
    fi
    if [[ -n "$candidate" && "$candidate" != "(none)" ]]; then
      missing+=("$package")
    else
      unavailable+=("$package")
    fi
  done
  if ((${#missing[@]})); then
    log "installing ${#missing[@]} missing apt package(s)"
    "${SUDO[@]}" env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends "${missing[@]}"
  else
    log "apt dependencies already installed"
  fi
  if ((${#unavailable[@]})); then
    warn "packages unavailable for $DISTRO_ID and skipped: ${unavailable[*]}"
  fi
}

ensure_profile_path() {
  local line='export PATH="$HOME/.local/share/redtrace-tools/bin:$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"'
  touch "$HOME/.profile"
  grep -Fqx "$line" "$HOME/.profile" || printf '\n%s\n' "$line" >>"$HOME/.profile"
  export PATH="$HOME/.local/share/redtrace-tools/bin:$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"
}

ensure_node() {
  local major=0
  if has node; then
    major="$(node --version | sed -E 's/^v([0-9]+).*/\1/' || true)"
  fi
  if has npm && [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
    log "Node.js $(node --version) and npm are already installed"
    return
  fi

  local machine node_arch
  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) node_arch="x64" ;;
    aarch64|arm64) node_arch="arm64" ;;
    *) die "unsupported Node.js architecture: $machine" ;;
  esac
  local version
  version="$(
    curl -fsSL https://npmmirror.com/mirrors/node/index.json \
      | python3 -c 'import json,sys; print(next(v["version"] for v in json.load(sys.stdin) if v.get("lts") and int(v["version"].split(".")[0][1:]) >= 22))'
  )"
  local archive="node-${version}-linux-${node_arch}.tar.xz"
  local base="https://npmmirror.com/mirrors/node/${version}"
  local temp_dir
  temp_dir="$(mktemp -d)"
  log "installing Node.js $version from npmmirror"
  curl -fsSL "$base/$archive" -o "$temp_dir/$archive"
  curl -fsSL "$base/SHASUMS256.txt" -o "$temp_dir/SHASUMS256.txt"
  (
    cd "$temp_dir"
    grep "  $archive\$" SHASUMS256.txt | sha256sum -c -
  )
  mkdir -p "$HOME/.local/lib" "$HOME/.local/bin"
  tar -xJf "$temp_dir/$archive" -C "$HOME/.local/lib"
  local node_dir="$HOME/.local/lib/node-${version}-linux-${node_arch}"
  ln -sfn "$node_dir/bin/node" "$HOME/.local/bin/node"
  ln -sfn "$node_dir/bin/npm" "$HOME/.local/bin/npm"
  ln -sfn "$node_dir/bin/npx" "$HOME/.local/bin/npx"
  rm -rf -- "$temp_dir"
  hash -r
  node --version
  npm --version
}

ensure_npm_cli() {
  local command="$1"
  local package="$2"
  shift 2
  if has "$command"; then
    log "$command already installed: $("$command" --version 2>/dev/null | head -n 1 || true)"
    return
  fi
  log "installing missing CLI $command ($package)"
  NPM_CONFIG_PREFIX="$HOME/.local" \
    npm install -g --registry="$NPM_REGISTRY" "$@" "$package"
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
  has rtk && rtk gain >/dev/null 2>&1 \
    || die "RTK is missing or is not the rtk-ai Rust Token Killer"
}

ensure_pi_mcp_extension() {
  if pi list 2>/dev/null | grep -Fq 'pi-mcp-extension'; then
    log "Pi MCP extension already configured"
    return
  fi
  log "installing missing Pi MCP extension"
  pi install npm:pi-mcp-extension@1.5.0
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

install_skill_python_dependencies() {
  local python="$TOOL_VENV/bin/python"
  if [[ ! -x "$python" ]]; then
    log "creating security-tools Python environment"
    uv venv --python 3.12 "$TOOL_VENV"
  fi
  local entries=(
    'pwntools==4.15.0|pwn'
    'pycryptodome==3.23.0|Crypto'
    'z3-solver==4.13.0.0|z3'
    'sympy==1.14.0|sympy'
    'gmpy2==2.3.0|gmpy2'
    'hashpumpy==1.2|hashpumpy'
    'fpylll==0.6.4|fpylll'
    'py_ecc==8.0.0|py_ecc'
    'angr==9.2.193|angr'
    'frida-tools==14.8.0|frida'
    'qiling==1.4.6|qiling'
    'requests==2.32.5|requests'
    'flask-unsign==1.2.1|flask_unsign'
    'sqlmap==1.10.3|sqlmap'
    'ropper==1.13.13|ropper'
    'ROPgadget==7.7|ropgadget'
    'volatility3==2.27.0|volatility3'
    'yara-python==4.5.4|yara'
    'pefile==2024.8.26|pefile'
    'capstone==5.0.3|capstone'
    'oletools==0.60.2|oletools'
    'unicorn==2.1.2|unicorn'
    'scapy==2.7.0|scapy'
    # qiling 1.4.6 pulls python-fx, whose supported Pillow range is <11.
    'Pillow==10.4.0|PIL'
    'numpy==2.2.6|numpy'
    'matplotlib==3.10.8|matplotlib'
    'shodan==1.31.0|shodan'
    'uncompyle6==3.9.3|uncompyle6'
    'lief==0.17.6|lief'
    'dnspython==2.8.0|dns'
    'dnslib==0.9.26|dnslib'
    'dissect.cobaltstrike==1.2.1|dissect.cobaltstrike'
  )
  local missing=()
  local entry spec module
  for entry in "${entries[@]}"; do
    spec="${entry%%|*}"
    module="${entry##*|}"
    "$python" -c "import $module" >/dev/null 2>&1 || missing+=("$spec")
  done
  if ((${#missing[@]} == 0)); then
    log "security-skill Python dependencies already installed"
    return
  fi
  log "installing ${#missing[@]} missing security-skill Python package(s)"
  if ! uv pip install --python "$python" --index-url "$PYPI_INDEX" "${missing[@]}"; then
    warn "China PyPI mirror failed; retrying missing packages from official PyPI"
    uv pip install --python "$python" --index-url https://pypi.org/simple "${missing[@]}"
  fi
}

install_optional_language_tools() {
  if ! has ffuf; then
    log "installing missing ffuf"
    GOBIN="$HOME/go/bin" GOPROXY=https://goproxy.cn,direct \
      go install github.com/ffuf/ffuf/v2@latest
  else
    log "ffuf already installed"
  fi

  local gem_name
  for gem_name in one_gadget seccomp-tools zsteg; do
    if gem list -i "^${gem_name}$" >/dev/null 2>&1; then
      continue
    fi
    log "installing missing Ruby gem $gem_name"
    gem install --user-install "$gem_name"
  done
}

prepare_local_config() {
  if [[ -f "$CONFIG_PATH" ]]; then
    log "using existing local config: $CONFIG_PATH"
    return
  fi
  [[ -f "$PROJECT_DIR/dispatch.local.example.yaml" ]] \
    || die "dispatch.local.example.yaml is missing"
  cp -- "$PROJECT_DIR/dispatch.local.example.yaml" "$CONFIG_PATH"
  local escaped_project
  escaped_project="${PROJECT_DIR//&/\\&}"
  escaped_project="${escaped_project//|/\\|}"
  sed -i \
    "s|^  # workspace_root:.*|  workspace_root: \"$escaped_project/workspaces\"|" \
    "$CONFIG_PATH"
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
    warn "BRAVE_API_KEY is not configured; export it and rerun to enable Brave fallback"
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
  if [[ "${REDTRACE_SKIP_BRAVE_TEST:-0}" == "1" ]]; then
    log "skipping brave-search API test (REDTRACE_SKIP_BRAVE_TEST=1)"
    return
  fi

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
  local pid_file="$1"
  [[ -s "$pid_file" ]] || return 1
  local pid
  pid="$(cat "$pid_file")"
  [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null
}

start_component() {
  local name="$1"
  shift
  local pid_file="$RUN_DIR/$name.pid"
  if pid_is_running "$pid_file"; then
    log "$name already running (pid $(cat "$pid_file"))"
    return
  fi
  rm -f -- "$pid_file"
  log "starting $name"
  nohup "$@" >"$LOG_DIR/$name.log" 2>&1 &
  local pid=$!
  printf '%s\n' "$pid" >"$pid_file"
  sleep 1
  kill -0 "$pid" 2>/dev/null || {
    tail -n 40 "$LOG_DIR/$name.log" >&2 || true
    die "$name failed to start"
  }
}

configure_china_apt_mirror
"${SUDO[@]}" apt-get update

BASE_PACKAGES=(
  ca-certificates curl git xz-utils build-essential pkg-config
  python3 python3-venv python3-pip python3-dev
  libffi-dev libssl-dev libgmp-dev libmpfr-dev libmpc-dev zlib1g-dev
  ruby ruby-dev golang-go jq ripgrep
)
SECURITY_PACKAGES=(
  gdb radare2 binutils binwalk foremost libimage-exiftool-perl
  tshark sleuthkit ffmpeg steghide testdisk john pcapfix
  nmap whois dnsutils hashcat strace ltrace imagemagick curl jq
  apktool upx-ucl qemu-system-x86 sagemath qrencode
  bsdextrautils iputils-ping netcat-openbsd sshpass rlwrap nikto dirsearch yq adb
)
install_missing_apt_packages "${BASE_PACKAGES[@]}" "${SECURITY_PACKAGES[@]}"

ensure_profile_path
ensure_node
ensure_uv
ensure_npm_cli claude '@anthropic-ai/claude-code@latest'
ensure_npm_cli codex '@openai/codex@latest'
ensure_npm_cli pi '@earendil-works/pi-coding-agent@latest' --ignore-scripts
ensure_pi_mcp_extension
ensure_brave_search_skill
ensure_rtk
install_skill_python_dependencies
install_optional_language_tools

log "syncing RedTrace Python environment"
UV_INDEX_URL="$PYPI_INDEX" uv sync --frozen --project "$PROJECT_DIR/redtrace"
prepare_local_config
chmod 600 "$CONFIG_PATH"
configure_brave_search_secret
test_brave_search_skill

mkdir -p "$RUN_DIR" "$LOG_DIR" "$PROJECT_DIR/workspaces"
GEM_BIN="$(ruby -e 'print Gem.user_dir')/bin"
WORKER_PATH="$TOOL_VENV/bin:$HOME/.local/bin:$HOME/go/bin:$GEM_BIN"
export REDTRACE_LOCAL_PATH_PREPEND="$WORKER_PATH"
export REDTRACE_DISPATCH_CONFIG="$CONFIG_PATH"

start_component server \
  uv run --project "$PROJECT_DIR/redtrace" redtrace serve --host 0.0.0.0 --port 8000

log "waiting for RedTrace server"
server_ready=0
for _ in $(seq 1 40); do
  if curl -fsS http://127.0.0.1:8000/projects >/dev/null 2>&1; then
    server_ready=1
    break
  fi
  sleep 1
done
(( server_ready == 1 )) || {
  tail -n 40 "$LOG_DIR/server.log" >&2 || true
  die "server health check timed out"
}

start_component dispatcher \
  uv run --project "$PROJECT_DIR/redtrace" redtrace dispatch --config "$CONFIG_PATH"

UI_URL="http://127.0.0.1:8000"
if grep -qi microsoft /proc/version 2>/dev/null; then
  WSL_IP="$(hostname -I 2>/dev/null | awk '{ if ($1) ip = $1 } END { print ip }')"
  [[ -n "$WSL_IP" ]] && UI_URL="http://$WSL_IP:8000"
fi

cat <<EOF

RedTrace local mode is running.
  UI:         $UI_URL
  Config:     $CONFIG_PATH
  Server:     pid $(cat "$RUN_DIR/server.pid"), log $LOG_DIR/server.log
  Dispatcher: pid $(cat "$RUN_DIR/dispatcher.pid"), log $LOG_DIR/dispatcher.log

Worker API settings override each process; empty API settings keep the CLI's
existing login/global configuration. Configure Workers from the Settings page.
Stop with:
  kill \$(cat "$RUN_DIR/server.pid") \$(cat "$RUN_DIR/dispatcher.pid")
EOF
