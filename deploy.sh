#!/usr/bin/env bash
# RedTrace local-mode bootstrap for macOS and Linux.
# Run as the same user that should own and reuse Claude/Codex/Pi login state.
set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_PATH="${REDTRACE_CONFIG_PATH:-$PROJECT_DIR/dispatch.local.yaml}"
RUN_DIR="$PROJECT_DIR/.redtrace/run"
LOG_DIR="$PROJECT_DIR/.redtrace/log"
TOOL_VENV="${REDTRACE_TOOL_VENV:-$HOME/.local/share/redtrace-tools}"
NPM_REGISTRY="${NPM_CONFIG_REGISTRY:-https://registry.npmmirror.com}"
PYPI_INDEX="${UV_INDEX_URL:-https://mirrors.aliyun.com/pypi/simple}"
OS="$(uname -s)"
case "$OS" in
  Darwin) DEFAULT_HOST=127.0.0.1 ;;
  Linux) DEFAULT_HOST=0.0.0.0 ;;
  *) printf '[RedTrace] ERROR: deploy.sh supports macOS and Linux only\n' >&2; exit 1 ;;
esac
REDTRACE_HOST="${REDTRACE_HOST:-$DEFAULT_HOST}"
REDTRACE_PORT="${REDTRACE_PORT:-8000}"
DEFAULT_USE_LAUNCHD=0
if [[ "$OS" == "Darwin" ]]; then
  case "$PROJECT_DIR" in
    "$HOME/Downloads/"*|"$HOME/Desktop/"*|"$HOME/Documents/"*) ;;
    *) DEFAULT_USE_LAUNCHD=1 ;;
  esac
fi
REDTRACE_USE_LAUNCHD="${REDTRACE_USE_LAUNCHD:-$DEFAULT_USE_LAUNCHD}"
if [[ "$OS" == "Darwin" ]]; then
  DEFAULT_PLAINTEXT_SECRETS=1
else
  DEFAULT_PLAINTEXT_SECRETS=0
fi
REDTRACE_PLAINTEXT_SECRETS="${REDTRACE_PLAINTEXT_SECRETS:-$DEFAULT_PLAINTEXT_SECRETS}"
export REDTRACE_PLAINTEXT_SECRETS
BRAVE_SKILL_DIR="$PROJECT_DIR/skills/brave-search"
GHIDRA_SKILL_DIR="$PROJECT_DIR/skills/ghidra-headless"
PLAYWRIGHT_SKILL_DIR="$PROJECT_DIR/skills/playwright"
GHIDRA_INSTALL_DIR="${REDTRACE_GHIDRA_HOME:-$HOME/.local/share/redtrace-tools/ghidra}"
RSACTFTOOL_VENV="${REDTRACE_RSACTFTOOL_VENV:-$HOME/.local/share/redtrace-rsactftool}"
QILING_VENV="${REDTRACE_QILING_VENV:-$HOME/.local/share/redtrace-qiling}"
QILING_WRAPPER="$PROJECT_DIR/skills/ctf-reverse/scripts/qiling-python"
NUCLEI_VERSION="${REDTRACE_NUCLEI_VERSION:-3.11.0}"
RSACTFTOOL_REVISION="${REDTRACE_RSACTFTOOL_REVISION:-7c98848f1945de3e67a420871e8672f5ad9aa5d5}"
CTF_TOOL_INSTALLER="$PROJECT_DIR/install_ctf_tools.sh"
JAVA_INSTALL_DIR="${REDTRACE_JAVA_HOME:-$HOME/.local/share/redtrace-tools/temurin-21}"
DISTRO_ID=""
PACKAGE_MANAGER=""

log() { printf '[RedTrace] %s\n' "$*"; }
warn() { printf '[RedTrace] WARNING: %s\n' "$*" >&2; }
die() { printf '[RedTrace] ERROR: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

if [[ "$OS" == "Darwin" ]]; then
  case "$(uname -m)" in
    arm64|x86_64) ;;
    *) die "unsupported macOS architecture: $(uname -m)" ;;
  esac
fi
chmod +x "$0" 2>/dev/null || true

detect_system_package_manager() {
  if has apt-get; then
    printf 'apt\n'
  elif has dnf; then
    printf 'dnf\n'
  elif has yum; then
    printf 'yum\n'
  elif has pacman; then
    printf 'pacman\n'
  elif has zypper; then
    printf 'zypper\n'
  elif has apk; then
    printf 'apk\n'
  else
    return 1
  fi
}

initialize_linux() {
  [[ -r /etc/os-release ]] || die "cannot detect Linux distribution (/etc/os-release is missing)"
  # shellcheck disable=SC1091
  source /etc/os-release
  DISTRO_ID="${ID:-}"
  PACKAGE_MANAGER="$(detect_system_package_manager)" \
    || die "supported package managers are apt, dnf/yum, pacman, zypper, and apk"
  log "detected Linux distribution ${DISTRO_ID:-unknown} with $PACKAGE_MANAGER"
  if grep -qi microsoft /proc/version 2>/dev/null; then
    log "detected Windows WSL"
  else
    warn "the primary deployment target is Windows WSL; continuing on native Linux"
  fi
}

configure_linux_paths() {
  export PATH="$TOOL_VENV/bin:$HOME/.local/bin:$HOME/go/bin:$HOME/.cargo/bin:$PATH"
}

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

repair_brew_formula_cli() {
  local formula="$1" command="$2"
  shift 2
  if has "$command" && "$command" "$@" >/dev/null 2>&1; then
    return
  fi
  warn "$command is missing or broken; reinstalling Homebrew formula $formula"
  HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 brew reinstall "$formula"
  hash -r
  has "$command" && "$command" "$@" >/dev/null 2>&1 \
    || die "$command smoke test failed after reinstalling $formula"
}

repair_tshark() {
  if has tshark && tshark -v >/dev/null 2>&1; then
    return
  fi
  warn "tshark is missing or broken; reinstalling lz4 and Wireshark"
  HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 brew reinstall lz4
  HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 brew reinstall wireshark
  hash -r
  tshark -v >/dev/null 2>&1 || die "tshark smoke test failed after dependency repair"
}

ensure_brew_formula_cli_path() {
  local formula="$1" command="$2" candidate
  has "$command" && return
  candidate="$(brew --prefix "$formula")/bin/$command"
  [[ -x "$candidate" ]] || {
    warn "$formula is installed but $command is unavailable"
    return
  }
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$candidate" "$HOME/.local/bin/$command"
  hash -r
  has "$command" || die "failed to expose $command from $formula"
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
  if [[ "$OS" == "Darwin" ]]; then
    log "installing/upgrading Node.js through Homebrew"
    brew list --formula node >/dev/null 2>&1 && brew upgrade node || brew install node
  else
    if ldd --version 2>&1 | grep -qi musl; then
      die "Node.js 22 or newer is required on musl Linux; install the distribution's nodejs-current package"
    fi
    local machine node_arch version archive base temp_dir node_dir
    machine="$(uname -m)"
    case "$machine" in
      x86_64|amd64) node_arch="x64" ;;
      aarch64|arm64) node_arch="arm64" ;;
      *) die "unsupported Node.js architecture: $machine" ;;
    esac
    version="$(
      curl -fsSL https://npmmirror.com/mirrors/node/index.json \
        | python3 -c 'import json,sys; print(next(v["version"] for v in json.load(sys.stdin) if v.get("lts") and int(v["version"].split(".")[0][1:]) >= 22))'
    )"
    archive="node-${version}-linux-${node_arch}.tar.xz"
    base="https://npmmirror.com/mirrors/node/${version}"
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
    node_dir="$HOME/.local/lib/node-${version}-linux-${node_arch}"
    ln -sfn "$node_dir/bin/node" "$HOME/.local/bin/node"
    ln -sfn "$node_dir/bin/npm" "$HOME/.local/bin/npm"
    ln -sfn "$node_dir/bin/npx" "$HOME/.local/bin/npx"
    rm -rf -- "$temp_dir"
  fi
  hash -r
  major="$(node --version 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/' || true)"
  has npm && has npx && [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 22)) \
    || die "Node.js 22 or newer with npm/npx is required"
}

ensure_java() {
  [[ "$OS" == "Linux" ]] || return
  local major=0 machine java_arch temp_dir asset_info asset_url asset_digest extracted_dir
  if has java; then
    major="$(java_major_version || true)"
  fi
  if [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 21)); then
    log "Java $(java -version 2>&1 | head -n 1) already satisfies Ghidra"
    return
  fi

  machine="$(uname -m)"
  case "$machine" in
    x86_64|amd64) java_arch="x64" ;;
    aarch64|arm64) java_arch="aarch64" ;;
    *) die "unsupported Temurin architecture: $machine" ;;
  esac
  temp_dir="$(mktemp -d)"
  log "resolving the latest Temurin 21 JDK for $java_arch"
  curl -fsSL \
    "https://api.adoptium.net/v3/assets/latest/21/hotspot?architecture=$java_arch&image_type=jdk&os=linux&vendor=eclipse" \
    -o "$temp_dir/assets.json"
  asset_info="$(
    python3 - "$temp_dir/assets.json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    assets = json.load(handle)
if not assets:
    raise SystemExit("Temurin API returned no matching Java 21 asset")
package = assets[0]["binary"]["package"]
print(f'{package["link"]}\t{package["checksum"]}')
PY
  )"
  asset_url="${asset_info%%$'\t'*}"
  asset_digest="${asset_info#*$'\t'}"
  curl -fL --retry 3 "$asset_url" -o "$temp_dir/temurin.tar.gz"
  (
    cd "$temp_dir"
    printf '%s  temurin.tar.gz\n' "$asset_digest" | sha256sum -c -
  )
  mkdir -p "$temp_dir/extracted" "$(dirname "$JAVA_INSTALL_DIR")"
  tar -xzf "$temp_dir/temurin.tar.gz" -C "$temp_dir/extracted"
  extracted_dir="$(find "$temp_dir/extracted" -mindepth 1 -maxdepth 1 -type d -print -quit)"
  [[ -n "$extracted_dir" ]] || die "Temurin archive has an unexpected layout"
  [[ ! -e "$JAVA_INSTALL_DIR" ]] || die "Java fallback path exists but is unusable: $JAVA_INSTALL_DIR"
  mv -- "$extracted_dir" "$JAVA_INSTALL_DIR"
  mkdir -p "$HOME/.local/bin"
  local command
  for command in java javac jar keytool; do
    [[ -x "$JAVA_INSTALL_DIR/bin/$command" ]] \
      && ln -sfn "$JAVA_INSTALL_DIR/bin/$command" "$HOME/.local/bin/$command"
  done
  rm -rf -- "$temp_dir"
  hash -r
  major="$(java_major_version || true)"
  [[ "$major" =~ ^[0-9]+$ ]] && ((major >= 21)) \
    || die "Temurin 21 installation failed verification"
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

ensure_playwright_cli_skill() {
  local wrapper="$PLAYWRIGHT_SKILL_DIR/scripts/playwright_cli.sh"
  [[ -f "$PLAYWRIGHT_SKILL_DIR/SKILL.md" ]] || die "playwright SKILL.md is missing"
  [[ -f "$wrapper" ]] || die "playwright CLI wrapper is missing"
  chmod +x "$wrapper"
  ensure_npm_cli playwright-cli '@playwright/cli@latest'
  playwright-cli install-browser chromium
  "$wrapper" --help >/dev/null
  log "playwright CLI skill and Chromium are ready"
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
  local openssl libffi gmp mpfr mpc zlib zbar
  openssl="$(brew --prefix openssl@3)"
  libffi="$(brew --prefix libffi)"
  gmp="$(brew --prefix gmp)"
  mpfr="$(brew --prefix mpfr)"
  mpc="$(brew --prefix libmpc)"
  zlib="$(brew --prefix zlib)"
  zbar="$(brew --prefix zbar)"
  export CPPFLAGS="-I$openssl/include -I$libffi/include -I$gmp/include -I$mpfr/include -I$mpc/include -I$zlib/include ${CPPFLAGS:-}"
  export LDFLAGS="-L$openssl/lib -L$libffi/lib -L$gmp/lib -L$mpfr/lib -L$mpc/lib -L$zlib/lib ${LDFLAGS:-}"
  export PKG_CONFIG_PATH="$openssl/lib/pkgconfig:$libffi/lib/pkgconfig:$gmp/lib/pkgconfig:$mpfr/lib/pkgconfig:$mpc/lib/pkgconfig:$zlib/lib/pkgconfig:${PKG_CONFIG_PATH:-}"
  export DYLD_FALLBACK_LIBRARY_PATH="$zbar/lib:${DYLD_FALLBACK_LIBRARY_PATH:-}"
}

install_skill_python_dependencies() {
  local python="$TOOL_VENV/bin/python" entry spec module
  [[ -x "$python" ]] || { log "creating security-tools Python environment"; uv venv --python 3.12 "$TOOL_VENV"; }
  local entries=(
    'pwntools==4.15.0|pwn' 'pycryptodome==3.23.0|Crypto' 'z3-solver==4.13.0.0|z3'
    'sympy==1.14.0|sympy' 'gmpy2==2.3.0|gmpy2' 'hashpumpy==1.2|hashpumpy'
    'cysignals==1.12.6|cysignals'
    'fpylll==0.6.4|fpylll' 'py_ecc==8.0.0|py_ecc'
    'pycparser==2.23|pycparser' 'angr==9.2.193|angr'
    'frida-tools==14.8.0|frida' 'requests==2.32.5|requests'
    'flask-unsign==1.2.1|flask_unsign' 'sqlmap==1.10.3|sqlmap' 'ropper==1.13.13|ropper'
    'ROPgadget==7.7|ropgadget' 'volatility3==2.27.0|volatility3' 'yara-python==4.5.4|yara'
    'pefile==2024.8.26|pefile' 'capstone==5.0.3|capstone' 'oletools==0.60.2|oletools'
    'unicorn==2.1.2|unicorn' 'scapy==2.7.0|scapy' 'Pillow==10.4.0|PIL'
    'numpy==2.2.6|numpy' 'scipy==1.15.3|scipy' 'matplotlib==3.10.8|matplotlib'
    'pyzbar==0.1.9|pyzbar' 'pytesseract==0.3.13|pytesseract'
    'segno==1.6.6|segno' 'shodan==1.31.0|shodan'
    'uncompyle6==3.9.3|uncompyle6' 'lief==0.17.6|lief' 'dnspython==2.8.0|dns'
    'dnslib==0.9.26|dnslib' 'dissect.cobaltstrike==1.2.1|dissect.cobaltstrike'
  )
  for entry in "${entries[@]}"; do
    spec="${entry%%|*}"; module="${entry##*|}"
    "$python" -c "import $module" >/dev/null 2>&1 && continue
    log "installing Python security package $spec"
    uv pip install --python "$python" --index-url "$PYPI_INDEX" "$spec" \
      || uv pip install --python "$python" --index-url https://pypi.org/simple "$spec" \
      || warn "Python package unsupported on this platform and skipped: $spec"
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

java_major_version() {
  java -version 2>&1 | awk -F '[".]' '/version/ {
    if ($2 == "1") print $3
    else print $2
    exit
  }'
}

install_ghidra_release() {
  local temp_dir release_json asset_info asset_url asset_digest extracted_dir
  temp_dir="$(mktemp -d)"
  release_json="$temp_dir/release.json"
  log "resolving the latest official Ghidra release"
  curl -fsSL https://api.github.com/repos/NationalSecurityAgency/ghidra/releases/latest \
    -o "$release_json"
  asset_info="$(
    python3 - "$release_json" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    release = json.load(handle)
for asset in release.get("assets", []):
    name = asset.get("name", "")
    if name.startswith("ghidra_") and name.endswith(".zip"):
        digest = asset.get("digest", "")
        if not digest.startswith("sha256:"):
            raise SystemExit("official Ghidra release zip has no SHA-256 digest")
        print(f'{asset["browser_download_url"]}\t{digest}')
        break
else:
    raise SystemExit("official Ghidra release zip was not found")
PY
  )"
  asset_url="${asset_info%%$'\t'*}"
  asset_digest="${asset_info#*$'\t'}"
  asset_digest="${asset_digest#sha256:}"
  curl -fL --retry 3 "$asset_url" -o "$temp_dir/ghidra.zip"
  (
    cd "$temp_dir"
    printf '%s  ghidra.zip\n' "$asset_digest" | sha256sum -c -
  )
  mkdir -p "$temp_dir/extracted" "$(dirname "$GHIDRA_INSTALL_DIR")"
  unzip -q "$temp_dir/ghidra.zip" -d "$temp_dir/extracted"
  extracted_dir="$(
    find "$temp_dir/extracted" -mindepth 1 -maxdepth 1 -type d \
      -name 'ghidra_*' -print -quit
  )"
  [[ -n "$extracted_dir" ]] || die "Ghidra release archive has an unexpected layout"
  [[ ! -e "$GHIDRA_INSTALL_DIR" ]] || die "Ghidra install path exists but is unusable: $GHIDRA_INSTALL_DIR"
  mv -- "$extracted_dir" "$GHIDRA_INSTALL_DIR"
  chmod +x "$GHIDRA_INSTALL_DIR/support/analyzeHeadless"
  rm -rf -- "$temp_dir"
}

ensure_ghidra_headless_skill() {
  local java_home java_major analyze_headless
  [[ -f "$GHIDRA_SKILL_DIR/SKILL.md" ]] || die "ghidra-headless SKILL.md is missing"
  [[ -f "$GHIDRA_SKILL_DIR/scripts/ghidra-analyze.sh" ]] \
    || die "ghidra-headless wrapper is missing"
  [[ -f "$GHIDRA_SKILL_DIR/scripts/ghidra_scripts/ExportAll.java" ]] \
    || die "ghidra-headless export scripts are missing"
  chmod +x \
    "$GHIDRA_SKILL_DIR/scripts/find-ghidra.sh" \
    "$GHIDRA_SKILL_DIR/scripts/ghidra-analyze.sh"

  if [[ "$OS" == "Darwin" ]]; then
    java_home="$(brew --prefix openjdk@21)/libexec/openjdk.jdk/Contents/Home"
    [[ -x "$java_home/bin/java" ]] || java_home="$(brew --prefix openjdk@21)"
    export JAVA_HOME="$java_home"
    export PATH="$JAVA_HOME/bin:$PATH"
  fi
  java_major="$(java_major_version)"
  [[ "$java_major" =~ ^[0-9]+$ ]] && ((java_major >= 21)) \
    || die "Ghidra requires OpenJDK 21 or newer; detected: ${java_major:-unknown}"

  if ! analyze_headless="$("$GHIDRA_SKILL_DIR/scripts/find-ghidra.sh" 2>/dev/null)"; then
    [[ "$OS" == "Linux" ]] || die "Homebrew Ghidra installation is missing"
    install_ghidra_release
    export GHIDRA_HOME="$GHIDRA_INSTALL_DIR"
    analyze_headless="$("$GHIDRA_SKILL_DIR/scripts/find-ghidra.sh")"
  fi
  [[ -x "$analyze_headless" ]] || die "Ghidra analyzeHeadless is not executable"
  export GHIDRA_HOME
  GHIDRA_HOME="$(dirname "$(dirname "$analyze_headless")")"
  log "ghidra-headless ready: $analyze_headless"
}

ensure_nuclei() {
  local nuclei_bin config_path
  if [[ "$OS" == "Darwin" ]]; then
    nuclei_bin="$(brew --prefix nuclei)/bin/nuclei"
    [[ -x "$nuclei_bin" ]] || die "Homebrew Nuclei binary is missing"
    mkdir -p "$HOME/.local/bin"
    ln -sfn "$nuclei_bin" "$HOME/.local/bin/nuclei"
    hash -r
    config_path="$HOME/Library/Application Support/nuclei/config.yaml"
  else
    if ! has nuclei || ! nuclei -version >/dev/null 2>&1; then
      log "installing Nuclei $NUCLEI_VERSION"
      GOBIN="$HOME/go/bin" go install \
        "github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v$NUCLEI_VERSION"
      hash -r
    fi
    config_path="$HOME/.config/nuclei/config.yaml"
  fi
  nuclei -version >/dev/null 2>&1 || die "Nuclei smoke test failed"
  mkdir -p "$(dirname "$config_path")"
  python3 - "$config_path" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
lines = [line for line in lines if not line.lstrip().startswith("disable-update-check:")]
lines.append("disable-update-check: true")
path.write_text("\n".join(lines) + "\n", encoding="utf-8")
PY
}

ensure_rsactftool() {
  if has RsaCtfTool && RsaCtfTool --help >/dev/null 2>&1; then
    log "RsaCtfTool already installed"
    return
  fi
  log "installing RsaCtfTool at revision $RSACTFTOOL_REVISION"
  [[ -x "$RSACTFTOOL_VENV/bin/python" ]] \
    || uv venv --python 3.12 "$RSACTFTOOL_VENV"
  uv pip install --python "$RSACTFTOOL_VENV/bin/python" --upgrade \
    "git+https://github.com/RsaCtfTool/RsaCtfTool.git@$RSACTFTOOL_REVISION"
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$RSACTFTOOL_VENV/bin/RsaCtfTool" "$HOME/.local/bin/RsaCtfTool"
  hash -r
  RsaCtfTool --help >/dev/null 2>&1 || die "RsaCtfTool smoke test failed"
}

ensure_qiling() {
  if [[ -x "$QILING_VENV/bin/python" ]] \
    && "$QILING_VENV/bin/python" -c "import qiling" >/dev/null 2>&1; then
    log "Qiling already installed in its Python 3.11 environment"
  else
    log "installing Qiling in an isolated Python 3.11 environment"
    [[ -x "$QILING_VENV/bin/python" ]] || uv venv --python 3.11 "$QILING_VENV"
    "$QILING_VENV/bin/python" -m ensurepip --upgrade
    "$QILING_VENV/bin/python" -m pip install qiling==1.4.6
  fi
  mkdir -p "$HOME/.local/bin"
  ln -sfn "$QILING_VENV/bin/qltool" "$HOME/.local/bin/qltool"
  [[ -x "$QILING_WRAPPER" ]] || die "Qiling Python wrapper is missing"
  ln -sfn "$QILING_WRAPPER" "$HOME/.local/bin/qiling-python"
  qiling-python -c "import qiling; print(qiling.__version__)" >/dev/null \
    || die "Qiling verification failed"
}

install_optional_language_tools() {
  local gem_name
  if ! has ffuf; then
    log "installing missing ffuf"
    GOBIN="$HOME/go/bin" GOPROXY=https://goproxy.cn,direct \
      go install github.com/ffuf/ffuf/v2@latest
  fi
  for gem_name in one_gadget seccomp-tools zsteg; do
    gem list -i "^${gem_name}$" >/dev/null 2>&1 && continue
    gem install --user-install "$gem_name" || warn "optional Ruby gem failed and was skipped: $gem_name"
  done
}

verify_security_toolchain() {
  local python="$TOOL_VENV/bin/python"
  local gem_bin
  gem_bin="$(ruby -e 'print Gem.user_dir')/bin"
  nuclei -version >/dev/null 2>&1 || die "Nuclei verification failed"
  RsaCtfTool --help >/dev/null 2>&1 || die "RsaCtfTool verification failed"
  qiling-python -c "import qiling" >/dev/null 2>&1 || die "Qiling verification failed"
  hashcat --version >/dev/null 2>&1 || die "hashcat verification failed"
  ffmpeg -version >/dev/null 2>&1 || die "FFmpeg verification failed"
  if [[ "$OS" == "Darwin" ]]; then
    tshark -v >/dev/null 2>&1 || die "TShark verification failed"
  fi
  qrencode --version >/dev/null 2>&1 || die "qrencode verification failed"
  zbarimg --version >/dev/null 2>&1 || die "zbarimg verification failed"
  sox --version >/dev/null 2>&1 || die "SoX verification failed"
  tesseract --version >/dev/null 2>&1 || die "Tesseract verification failed"
  if [[ -x "$gem_bin/zsteg" ]]; then
    "$gem_bin/zsteg" --help >/dev/null 2>&1 || die "zsteg verification failed"
  elif has zsteg; then
    zsteg --help >/dev/null 2>&1 || die "zsteg verification failed"
  else
    die "zsteg verification failed: executable not found"
  fi
  "$python" - <<'PY'
from Crypto.Cipher import AES
from cysignals import signals
from fpylll import IntegerMatrix
from gmpy2 import mpz
import pytesseract
import segno
from py_ecc import bn128
from pyzbar import pyzbar
from scipy import signal
from sympy import factorint
from z3 import Solver

assert AES.block_size == 16
assert IntegerMatrix(1, 1).nrows == 1
assert mpz(7) == 7
assert bn128.curve_order > 0
assert factorint(15) == {3: 1, 5: 1}
assert Solver() is not None
assert signals is not None
assert pytesseract is not None
assert segno.make("RedTrace")
assert pyzbar is not None
assert signal is not None
PY
  log "vulnerability-search, Crypto, and Misc tool smoke tests passed"
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

configure_brave_search_key() {
  local api_key="${BRAVE_API_KEY:-}"
  BRAVE_API_KEY="$api_key" uv run --project "$PROJECT_DIR/redtrace" python - "$CONFIG_PATH" <<'PY'
import os
import sys
import yaml
from pathlib import Path

from redtrace.config_secrets import (
    SecretStore,
    atomic_write_text,
    resolve_config_secrets,
)

path = Path(sys.argv[1]).expanduser().resolve()
with open(path, encoding="utf-8") as handle:
    raw = yaml.safe_load(handle) or {}
resolved = resolve_config_secrets(path, raw)
common_env = resolved.setdefault("common_env", {})
supplied = os.environ.get("BRAVE_API_KEY", "")
if supplied:
    common_env["BRAVE_API_KEY"] = supplied
common_env["NODE_USE_ENV_PROXY"] = "1"
value = common_env.get("BRAVE_API_KEY")
if not isinstance(value, str) or not value:
    raise SystemExit("BRAVE_API_KEY is not configured")

atomic_write_text(path, yaml.safe_dump(resolved, sort_keys=False), mode=0o600)
store = SecretStore(path)
store.data_path.unlink(missing_ok=True)
store.key_path.unlink(missing_ok=True)
try:
    store.data_path.parent.rmdir()
except OSError:
    pass
PY
  unset BRAVE_API_KEY
  log "stored BRAVE_API_KEY as plaintext in the local Worker configuration"
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
    if BRAVE_API_KEY="$api_key" NODE_USE_ENV_PROXY=1 node "$BRAVE_SKILL_DIR/search.js" \
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
    "$HOME" "$WORKER_PATH:$PATH" "$REDTRACE_LOCAL_PATH_PREPEND" \
    "${DYLD_FALLBACK_LIBRARY_PATH:-}" "$@" <<'PY'
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
    dyld_fallback_library_path,
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
        "REDTRACE_PLAINTEXT_SECRETS": "1",
        "REDTRACE_LOCAL_PATH_PREPEND": worker_path,
        "DYLD_FALLBACK_LIBRARY_PATH": dyld_fallback_library_path,
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

setup_macos() {
  ensure_command_line_tools
  ensure_homebrew
  configure_paths
  repair_homebrew_remotes
  update_homebrew
  local required_formulae=(
    ca-certificates curl git xz pkg-config cmake ninja swig
    python@3.12 libffi openssl@3 gmp mpfr libmpc zlib libomp
    openjdk@21 ghidra ruby go jq ripgrep nuclei
  )
  brew_install_required "${required_formulae[@]}"
  ensure_node

  if [[ "${REDTRACE_SKIP_OPTIONAL_TOOLS:-0}" != "1" ]]; then
    local optional_formulae=(
      ffuf gdb radare2 binutils binwalk exiftool sleuthkit ffmpeg wireshark steghide testdisk
      john-jumbo nmap hashcat imagemagick apktool upx qemu qrencode sshpass rlwrap
      nikto dirsearch yq yara p7zip foremost pcapfix zbar sox tesseract
    )
    brew_install_optional "${optional_formulae[@]}"
    repair_brew_formula_cli ffmpeg ffmpeg -version
    repair_tshark
    ensure_brew_formula_cli_path qemu qemu-system-x86_64
  else
    log "skipping optional security tools (REDTRACE_SKIP_OPTIONAL_TOOLS=1)"
  fi

  if [[ "${REDTRACE_INSTALL_CASKS:-0}" == "1" ]]; then
    local cask
    for cask in wireshark android-platform-tools; do
      brew list --cask "$cask" >/dev/null 2>&1 && continue
      brew info --cask "$cask" >/dev/null 2>&1 && brew install --cask "$cask" \
        || warn "optional cask unavailable or failed: $cask"
    done
  fi
  configure_paths
}

setup_linux() {
  initialize_linux
  [[ -f "$CTF_TOOL_INSTALLER" ]] || die "CTF tool installer is missing: $CTF_TOOL_INSTALLER"
  log "installing system and CTF dependencies with $PACKAGE_MANAGER"
  bash "$CTF_TOOL_INSTALLER" system
  configure_linux_paths
  ensure_node
  ensure_java
}

if [[ "$OS" == "Darwin" ]]; then
  setup_macos
else
  setup_linux
fi

ensure_uv
ensure_npm_cli claude '@anthropic-ai/claude-code@latest'
ensure_npm_cli codex '@openai/codex@latest'
ensure_npm_cli pi '@earendil-works/pi-coding-agent@latest' --ignore-scripts
ensure_pi_mcp_extension
ensure_rtk
ensure_playwright_cli_skill
ensure_brave_search_skill
ensure_ghidra_headless_skill
ensure_nuclei
if [[ "${REDTRACE_SKIP_OPTIONAL_TOOLS:-0}" != "1" ]]; then
  ensure_rsactftool
  ensure_qiling
  [[ "$OS" == "Linux" ]] || configure_native_build_env
  install_skill_python_dependencies
  install_optional_language_tools
  verify_security_toolchain
else
  log "skipping optional Python and Ruby security tools"
fi

log "syncing RedTrace Python environment"
if ! UV_INDEX_URL="$PYPI_INDEX" uv sync --frozen --project "$PROJECT_DIR/redtrace"; then
  warn "configured PyPI mirror failed; retrying from official PyPI"
  UV_INDEX_URL=https://pypi.org/simple uv sync --frozen --project "$PROJECT_DIR/redtrace"
fi
prepare_local_config
if [[ "$REDTRACE_PLAINTEXT_SECRETS" == "1" ]]; then
  configure_brave_search_key
else
  configure_brave_search_secret
fi
test_brave_search_skill

mkdir -p "$RUN_DIR" "$LOG_DIR" "$PROJECT_DIR/workspaces"
GEM_BIN="$(ruby -e 'print Gem.user_dir')/bin"
if [[ "$OS" == "Darwin" ]]; then
  WORKER_PATH="$JAVA_HOME/bin:$TOOL_VENV/bin:$HOME/.local/bin:$HOME/go/bin:$GEM_BIN:$(brew --prefix)/bin:$(brew --prefix)/sbin"
else
  WORKER_PATH="$TOOL_VENV/bin:$HOME/.local/bin:$HOME/go/bin:$GEM_BIN"
fi
export REDTRACE_LOCAL_PATH_PREPEND="$WORKER_PATH"
export REDTRACE_DISPATCH_CONFIG="$CONFIG_PATH"

if [[ "$REDTRACE_USE_LAUNCHD" == "1" ]]; then
  [[ "$OS" == "Darwin" ]] || die "REDTRACE_USE_LAUNCHD=1 is supported on macOS only"
  start_launch_agents
else
  [[ "$OS" == "Linux" ]] || stop_launch_agents
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
if [[ "$OS" == "Linux" ]] && grep -qi microsoft /proc/version 2>/dev/null; then
  WSL_IP="$(hostname -I 2>/dev/null | awk '{ if ($1) ip = $1 } END { print ip }')"
  [[ -n "$WSL_IP" ]] && UI_URL="http://$WSL_IP:$REDTRACE_PORT"
fi
cat <<SUMMARY

RedTrace local mode is running on $OS.
  UI:         $UI_URL
  Config:     $CONFIG_PATH
  Server:     pid $(cat "$RUN_DIR/server.pid"), log $LOG_DIR/server.log
  Dispatcher: pid $(cat "$RUN_DIR/dispatcher.pid"), log $LOG_DIR/dispatcher.log

Worker API settings override each process; empty settings keep the CLI's existing login/global configuration.

Optional controls:
  REDTRACE_SKIP_OPTIONAL_TOOLS=1  Skip the large security-tool set
  REDTRACE_SKIP_BRAVE_TEST=1      Skip the brave-search API smoke test
  REDTRACE_PLAINTEXT_SECRETS=1    Keep local API settings as plaintext
  REDTRACE_USE_LAUNCHD=0          Use detached processes instead of launchd
  REDTRACE_NO_OPEN=1              Do not open the browser automatically
$(
  if [[ "$OS" == "Darwin" ]]; then
    printf '  REDTRACE_INSTALL_CASKS=1        Install Wireshark and Android platform tools\n'
    printf '  REDTRACE_SKIP_BREW_UPDATE=1     Skip brew update\n'
  fi
)

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

if [[ "$OS" == "Darwin" && "${REDTRACE_NO_OPEN:-0}" != "1" ]]; then
  open "$UI_URL" >/dev/null 2>&1 || true
fi
