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

log() { printf '[RedTrace] %s\n' "$*"; }
warn() { printf '[RedTrace] WARNING: %s\n' "$*" >&2; }
die() { printf '[RedTrace] ERROR: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

[[ "$(uname -s)" == "Darwin" ]] || die "deploy-macos.sh supports macOS only"
case "$(uname -m)" in
  arm64|x86_64) ;;
  *) die "unsupported macOS architecture: $(uname -m)" ;;
esac

# GitHub's contents API may create this file without the executable bit. Running
# it once with `bash deploy-macos.sh` fixes permissions for subsequent runs.
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
  if has brew; then
    return
  fi

  log "installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c \
    "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

  if [[ -x /opt/homebrew/bin/brew ]]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  elif [[ -x /usr/local/bin/brew ]]; then
    eval "$(/usr/local/bin/brew shellenv)"
  fi
  has brew || die "Homebrew installation completed but brew is not on PATH"
}

configure_brew_path() {
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

  export PATH="$HOME/.local/share/redtrace-tools/bin:$HOME/.local/bin:$HOME/go/bin:$brew_prefix/bin:$brew_prefix/sbin:$PATH"
}

brew_install_required() {
  local formula
  for formula in "$@"; do
    if brew list --formula "$formula" >/dev/null 2>&1; then
      log "$formula already installed"
      continue
    fi
    brew info --formula "$formula" >/dev/null 2>&1 \
      || die "required Homebrew formula is unavailable: $formula"
    log "installing required Homebrew formula $formula"
    brew install "$formula"
  done
}

brew_install_optional() {
  local formula
  for formula in "$@"; do
    if brew list --formula "$formula" >/dev/null 2>&1; then
      continue
    fi
    if ! brew info --formula "$formula" >/dev/null 2>&1; then
      warn "optional Homebrew formula unavailable and skipped: $formula"
      continue
    fi
    log "installing optional security tool $formula"
    brew install "$formula" || warn "optional security tool failed and was skipped: $formula"
  done
}

ensure_node() {
  local major=0
  if has node; then
    major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
  fi
  if has npm && [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )); then
    log "Node.js $(node --version) and npm are already installed"
    return
  fi

  log "installing/upgrading Node.js through Homebrew"
  if brew list --formula node >/dev/null 2>&1; then
    brew upgrade node || true
  else
    brew install node
  fi
  hash -r
  major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
  has npm && [[ "$major" =~ ^[0-9]+$ ]] && (( major >= 22 )) \
    || die "Node.js 22 or newer is required"
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

configure_native_build_env() {
  local openssl_prefix libffi_prefix gmp_prefix mpfr_prefix libmpc_prefix zlib_prefix
  openssl_prefix="$(brew --prefix openssl@3)"
  libffi_prefix="$(brew --prefix libffi)"
  gmp_prefix="$(brew --prefix gmp)"
  mpfr_prefix="$(brew --prefix mpfr)"
  libmpc_prefix="$(brew --prefix libmpc)"
  zlib_prefix="$(brew --prefix zlib)"

  export CPPFLAGS="-I$openssl_prefix/include -I$libffi_prefix/include -I$gmp_prefix/include -I$mpfr_prefix/include -I$libmpc_prefix/include -I$zlib_prefix/include ${CPPFLAGS:-}"
  export LDFLAGS="-L$openssl_prefix/lib -L$libffi_prefix/lib -L$gmp_prefix/lib -L$mpfr_prefix/lib -L$libmpc_prefix/lib -L$zlib_prefix/lib ${LDFLAGS:-}"
  export PKG_CONFIG_PATH="$openssl_prefix/lib/pkgconfig:$libffi_prefix/lib/pkgconfig:$gmp_prefix/lib/pkgconfig:$mpfr_prefix/lib/pkgconfig:$libmpc_prefix/lib/pkgconfig:$zlib_prefix/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
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
  if uv pip install --python "$python" --index-url "$PYPI_INDEX" "${missing[@]}"; then
    return
  fi

  warn "bulk install failed; retrying packages individually so unsupported macOS packages do not block deployment"
  for entry in "${entries[@]}"; do
    spec="${entry%%|*}"
    module="${entry##*|}"
    "$python" -c "import $module" >/dev/null 2>&1 && continue
    if uv pip install --python "$python" --index-url "$PYPI_INDEX" "$spec" \
      || uv pip install --python "$python" --index-url https://pypi.org/simple "$spec"; then
      continue
    fi
    warn "Python security package is unsupported or failed on this Mac and was skipped: $spec"
  done
}

install_optional_language_tools() {
  local gem_name
  for gem_name in one_gadget zsteg; do
    if gem list -i "^${gem_name}$" >/dev/null 2>&1; then
      continue
    fi
    log "installing missing Ruby gem $gem_name"
    gem install --user-install "$gem_name" \
      || warn "optional Ruby gem failed and was skipped: $gem_name"
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

  local temp_config="$CONFIG_PATH.tmp.$$"
  awk -v workspace="$PROJECT_DIR/workspaces" '
    /^  # workspace_root:/ { print "  workspace_root: \"" workspace "\""; next }
    { print }
  ' "$CONFIG_PATH" >"$temp_config"
  mv -- "$temp_config" "$CONFIG_PATH"
  log "created local config: $CONFIG_PATH"
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

ensure_command_line_tools
ensure_homebrew
configure_brew_path

if [[ "${REDTRACE_SKIP_BREW_UPDATE:-0}" != "1" ]]; then
  log "updating Homebrew metadata"
  brew update
fi

REQUIRED_FORMULAE=(
  ca-certificates curl git xz pkg-config cmake ninja swig
  python@3.12 libffi openssl@3 gmp mpfr libmpc zlib libomp
  ruby go jq ripgrep
)
brew_install_required "${REQUIRED_FORMULAE[@]}"
ensure_node

if [[ "${REDTRACE_SKIP_OPTIONAL_TOOLS:-0}" != "1" ]]; then
  OPTIONAL_FORMULAE=(
    ffuf gdb radare2 binutils binwalk exiftool sleuthkit ffmpeg
    steghide testdisk john-jumbo nmap hashcat imagemagick apktool
    upx qemu qrencode sshpass rlwrap nikto dirsearch yq yara
    p7zip foremost pcapfix
  )
  brew_install_optional "${OPTIONAL_FORMULAE[@]}"
else
  log "skipping optional security tools (REDTRACE_SKIP_OPTIONAL_TOOLS=1)"
fi

if [[ "${REDTRACE_INSTALL_CASKS:-0}" == "1" ]]; then
  for cask in wireshark android-platform-tools; do
    if brew list --cask "$cask" >/dev/null 2>&1; then
      continue
    fi
    if brew info --cask "$cask" >/dev/null 2>&1; then
      log "installing optional Homebrew cask $cask"
      brew install --cask "$cask" || warn "optional cask failed and was skipped: $cask"
    fi
  done
fi

configure_brew_path
ensure_uv
ensure_npm_cli claude '@anthropic-ai/claude-code@latest'
ensure_npm_cli codex '@openai/codex@latest'
ensure_npm_cli pi '@earendil-works/pi-coding-agent@latest' --ignore-scripts
ensure_pi_mcp_extension
ensure_rtk
configure_native_build_env
install_skill_python_dependencies
install_optional_language_tools

log "syncing RedTrace Python environment"
if ! UV_INDEX_URL="$PYPI_INDEX" uv sync --frozen --project "$PROJECT_DIR/redtrace"; then
  warn "configured PyPI mirror failed; retrying RedTrace sync from official PyPI"
  UV_INDEX_URL=https://pypi.org/simple uv sync --frozen --project "$PROJECT_DIR/redtrace"
fi
prepare_local_config

mkdir -p "$RUN_DIR" "$LOG_DIR" "$PROJECT_DIR/workspaces"
GEM_BIN="$(ruby -e 'print Gem.user_dir')/bin"
WORKER_PATH="$TOOL_VENV/bin:$HOME/.local/bin:$HOME/go/bin:$GEM_BIN:$(brew --prefix)/bin:$(brew --prefix)/sbin"
export REDTRACE_LOCAL_PATH_PREPEND="$WORKER_PATH"
export REDTRACE_DISPATCH_CONFIG="$CONFIG_PATH"

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
(( server_ready == 1 )) || {
  tail -n 40 "$LOG_DIR/server.log" >&2 || true
  die "server health check timed out"
}

start_component dispatcher \
  uv run --project "$PROJECT_DIR/redtrace" redtrace dispatch --config "$CONFIG_PATH"

UI_URL="http://127.0.0.1:$REDTRACE_PORT"
cat <<SUMMARY

RedTrace local mode is running on macOS.
  UI:         $UI_URL
  Config:     $CONFIG_PATH
  Server:     pid $(cat "$RUN_DIR/server.pid"), log $LOG_DIR/server.log
  Dispatcher: pid $(cat "$RUN_DIR/dispatcher.pid"), log $LOG_DIR/dispatcher.log

Worker API settings override each process; empty API settings keep the CLI's
existing login/global configuration. Configure Workers from the Settings page.

Optional controls:
  REDTRACE_SKIP_OPTIONAL_TOOLS=1  Skip the large security-tool set
  REDTRACE_INSTALL_CASKS=1        Install Wireshark and Android platform tools
  REDTRACE_SKIP_BREW_UPDATE=1     Skip brew update
  REDTRACE_NO_OPEN=1              Do not open the browser automatically

Stop with:
  kill $(cat "$RUN_DIR/server.pid") $(cat "$RUN_DIR/dispatcher.pid")
SUMMARY

if [[ "${REDTRACE_NO_OPEN:-0}" != "1" ]]; then
  open "$UI_URL" >/dev/null 2>&1 || true
fi
