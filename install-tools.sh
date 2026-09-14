#!/usr/bin/env bash
# ============================================================================
# RedTrace Security Tools Installer
# Cross-platform: macOS · Linux (apt/dnf/pacman) · Windows (Git Bash/WSL + choco/scoop)
#
# Guarantees:
#   - Already-installed tools are never reinstalled
#   - Already-downloaded assets (tools/bin/*, wordlists/*, etc.) are never re-downloaded
#   - Empty/corrupt files from prior failed downloads are cleaned up and retried
#   - Works with or without a local proxy (auto-detects clash/mihomo/surge)
#
# Usage:
#   chmod +x install-tools.sh
#   ./install-tools.sh              # Install everything
#   ./install-tools.sh --check      # Only check what's installed
#   ./install-tools.sh --system     # Only install system packages
#   ./install-tools.sh --python     # Only install Python packages
#   ./install-tools.sh --assets     # Only download wordlists/payloads/binaries
#   ./install-tools.sh --binaries   # Only download portable binaries
#   ./install-tools.sh --help       # Show help
# ============================================================================
set -euo pipefail

# ── Constants ───────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS_DIR="${SCRIPT_DIR}/tools"
BIN_DIR="${TOOLS_DIR}/bin"
WORDLISTS_DIR="${TOOLS_DIR}/wordlists"
PAYLOADS_DIR="${TOOLS_DIR}/payloads"
POC_DIR="${TOOLS_DIR}/poc"
REQUIREMENTS_FILE="${SCRIPT_DIR}/requirements.txt"

# Portable temp dir (respects $TMPDIR on macOS/Linux, $TEMP on Windows Git Bash)
: "${TMPDIR:=/tmp}"
: "${TEMP:=$TMPDIR}"
RTMP="${TMPDIR}"

# Colors (disable if not a terminal)
if [[ -t 1 ]]; then
    RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
    BLUE='\033[0;34m'; CYAN='\033[0;36m'; NC='\033[0m'
else
    RED=''; GREEN=''; YELLOW=''; BLUE=''; CYAN=''; NC=''
fi

# ── Logging (printf for portability — echo -e is not POSIX) ─────────────────
log_info()  { printf "${BLUE}[INFO]${NC}  %s\n" "$*"; }
log_ok()    { printf "${GREEN}[OK]${NC}    %s\n" "$*"; }
log_skip()  { printf "${CYAN}[SKIP]${NC}  %s\n" "$*"; }
log_warn()  { printf "${YELLOW}[WARN]${NC}  %s\n" "$*"; }
log_err()   { printf "${RED}[ERR]${NC}   %s\n" "$*"; }
log_action(){ printf "${YELLOW}[>>]${NC}   %s\n" "$*"; }

# ── Core helpers ────────────────────────────────────────────────────────────
has() { command -v "$1" &>/dev/null; }

check_tool() {
    local name="$1" cmd="${2:-$1}"
    if has "$cmd"; then
        log_ok "$name → $(command -v "$cmd")"
        return 0
    else
        log_warn "$name → NOT FOUND"
        return 1
    fi
}

# ── Proxy Detection ────────────────────────────────────────────────────────
# Tries common local proxy ports; falls back to env vars.
# Sets CURL_PROXY_ARGS (array) and GIT_PROXY_ARGS (array).
CURL_PROXY_ARGS=()
GIT_PROXY_ARGS=()
DETECTED_PROXY=""

detect_proxy() {
    CURL_PROXY_ARGS=()
    GIT_PROXY_ARGS=()
    DETECTED_PROXY=""

    # 1) Check env vars first
    local env_proxy="${HTTPS_PROXY:-${HTTP_PROXY:-${https_proxy:-${http_proxy:-}}}}"
    if [[ -n "$env_proxy" ]]; then
        DETECTED_PROXY="$env_proxy"
    else
        # 2) Probe common local proxy ports (clash/mihomo/surge/v2ray)
        for port in 7890 7891 1080 8080; do
            # Use bash /dev/tcp if available, otherwise try curl itself
            if (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null; then
                DETECTED_PROXY="http://127.0.0.1:${port}"
                break
            fi
        done
    fi

    if [[ -n "$DETECTED_PROXY" ]]; then
        CURL_PROXY_ARGS=("--proxy" "$DETECTED_PROXY")
        GIT_PROXY_ARGS=(-c "http.proxy=${DETECTED_PROXY}" -c "https.proxy=${DETECTED_PROXY}")
        log_info "Using proxy: $DETECTED_PROXY"
    fi
}

# Wrapper: curl with proxy, timeout, retry
curl_dl() {
    curl ${CURL_PROXY_ARGS[@]+"${CURL_PROXY_ARGS[@]}"} --connect-timeout 30 --max-time 300 --retry 2 "$@"
}

# Check if a file exists AND is non-empty (skip corrupt/empty prior downloads)
file_ready() { [[ -f "$1" && -s "$1" ]]; }

# ── Platform Detection ─────────────────────────────────────────────────────
detect_platform() {
    OS="$(uname -s)"
    ARCH="$(uname -m)"

    case "$OS" in
        Darwin*)  PLATFORM="macos";   PKG_MANAGER="brew" ;;
        Linux*)   PLATFORM="linux"
            if has apt-get; then       PKG_MANAGER="apt"
            elif has dnf; then         PKG_MANAGER="dnf"
            elif has pacman; then      PKG_MANAGER="pacman"
            else                       PKG_MANAGER="unknown"
            fi ;;
        MINGW*|MSYS*|CYGWIN*) PLATFORM="windows"
            if has choco; then         PKG_MANAGER="choco"
            elif has scoop; then       PKG_MANAGER="scoop"
            else                       PKG_MANAGER="unknown"
            fi ;;
        *)        PLATFORM="unknown";  PKG_MANAGER="unknown" ;;
    esac

    case "$ARCH" in
        x86_64|amd64)  BIN_ARCH="amd64" ;;
        aarch64|arm64) BIN_ARCH="arm64" ;;
        i386|i686)     BIN_ARCH="386"   ;;
        *)             BIN_ARCH="amd64" ;;
    esac

    case "$PLATFORM" in
        macos)   BIN_OS="darwin" ;;
        linux)   BIN_OS="linux"  ;;
        windows) BIN_OS="windows" ;;
        *)       BIN_OS="linux" ;;
    esac
}

# ── Directory Setup ─────────────────────────────────────────────────────────
setup_dirs() {
    mkdir -p "$BIN_DIR" "$WORDLISTS_DIR" "$PAYLOADS_DIR" "$POC_DIR"
    log_ok "Tools directory: $TOOLS_DIR"
}

# ============================================================================
# SAFE INSTALL HELPERS — all skip-on-present, fail-safe
# ============================================================================

# Install a system package. Skips if command already exists.
# Args: <cmd_name> [brew_pkg] [apt_pkg] [choco_pkg] [scoop_pkg]
ensure_pkg() {
    local name="$1"
    local brew_pkg="${2:-$1}"
    local apt_pkg="${3:-$1}"
    local choco_pkg="${4:-$1}"
    local scoop_pkg="${5:-$1}"

    if has "$name"; then
        log_skip "$name already installed"
        return 0
    fi

    log_action "Installing $name ..."
    local rc=0
    case "$PKG_MANAGER" in
        brew)   brew install "$brew_pkg" ;;
        apt)    sudo apt-get install -y "$apt_pkg" ;;
        pacman) sudo pacman -S --noconfirm "$brew_pkg" ;;
        dnf)    sudo dnf install -y "$apt_pkg" ;;
        choco)  choco install -y "$choco_pkg" ;;
        scoop)  scoop install "$scoop_pkg" ;;
        *)      log_err "No package manager. Install $name manually."; return 1 ;;
    esac || rc=$?

    if [[ $rc -ne 0 ]]; then
        log_warn "$name install failed (rc=$rc), skipping"
    elif has "$name"; then
        log_ok "$name installed"
    else
        log_warn "$name install returned ok but command not found"
    fi
    return 0  # never abort the whole script
}

# Install a Python package via pip. Handles PEP 668 (--break-system-packages).
pip_install() {
    local pkg="$1"
    if python3 -c "import ${pkg%%[>=<!]*}" 2>/dev/null; then
        log_skip "python:$pkg already installed"
        return 0
    fi
    log_action "pip install $pkg ..."
    local pip_cmd="pip3"
    if ! has pip3; then pip_cmd="python3 -m pip"; fi
    # Try --user first, fall back to --break-system-packages
    $pip_cmd install --user "$pkg" 2>/dev/null \
        || $pip_cmd install --user --break-system-packages "$pkg" 2>/dev/null \
        || $pip_cmd install --break-system-packages "$pkg" 2>/dev/null \
        || { log_warn "pip install $pkg failed"; return 0; }
    log_ok "python:$pkg installed"
}

# Git clone shallow. Skips if dest dir exists and is non-empty.
clone_if_missing() {
    local dest="$1" url="$2" desc="${3:-$(basename "$dest")}"

    if [[ -d "$dest" && -n "$(ls -A "$dest" 2>/dev/null)" ]]; then
        log_skip "$desc already exists"
        return 0
    fi

    # Clean up partial clone
    [[ -d "$dest" ]] && rm -rf "$dest"

    log_action "Cloning $desc ..."

    # Auto-detect proxy for GitHub
    local git_extra=()
    if [[ "$url" == *github.com* && -n "$DETECTED_PROXY" ]]; then
        git_extra=(-c "http.proxy=${DETECTED_PROXY}" -c "https.proxy=${DETECTED_PROXY}")
    fi

    git ${git_extra[@]+"${git_extra[@]}"} clone --depth 1 "$url" "$dest" && log_ok "Cloned $desc" \
        || { log_warn "Clone $desc failed"; rm -rf "$dest"; return 0; }
}

# Download a file. Skips if dest exists and is non-empty.
# Re-downloads if file exists but is empty (prior failed download).
download_if_missing() {
    local dest="$1" url="$2" desc="${3:-$(basename "$dest")}"

    if file_ready "$dest"; then
        log_skip "$desc already exists"
        return 0
    fi

    # Clean up empty/corrupt file
    [[ -f "$dest" ]] && rm -f "$dest"

    log_action "Downloading $desc ..."
    mkdir -p "$(dirname "$dest")"
    curl_dl -fsSL -o "$dest" "$url" && log_ok "Downloaded $desc" \
        || { log_warn "Download $desc failed"; rm -f "$dest"; return 0; }
}

# ============================================================================
# CHECK MODE — Report what's installed and what's missing
# ============================================================================
check_all() {
    printf "\n==========================================\n"
    printf "  RedTrace Tool Check — %s (%s)\n" "$PLATFORM" "$BIN_ARCH"
    printf "==========================================\n\n"

    local missing=0 found=0

    echo "── Core System Tools ──"
    for t in bash curl wget git jq tmux expect openssl base64 xxd strings file; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── Compression ──"
    for t in tar gzip bzip2 xz zip unzip; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done
    check_tool "7z" "7z" || check_tool "7z" "p7zip" || ((missing++)) || true

    echo ""
    echo "── Network Tools ──"
    for t in ping dig nslookup traceroute socat ncat tcpdump; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── Scanning & Discovery ──"
    for t in nmap naabu masscan rustscan fping; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── Web / HTTP Testing ──"
    for t in httpx nikto dirsearch ffuf gobuster feroxbuster nuclei sqlmap; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done
    # These tools may be installed via gem/git/pipx — check multiple locations quietly
    for t in whatweb wfuzz dirb; do
        if command -v "$t" &>/dev/null; then
            log_ok "$t → $(command -v "$t")"; ((found++))
        elif [[ -x "$HOME/local/bin/$t" ]]; then
            log_ok "$t → $HOME/local/bin/$t"; ((found++))
        elif [[ -x "$HOME/.local/bin/$t" ]]; then
            log_ok "$t → $HOME/.local/bin/$t"; ((found++))
        else
            log_warn "$t → NOT FOUND"; ((missing++))
        fi
    done

    echo ""
    echo "── Brute Force / Auth ──"
    for t in hydra medusa john hashcat sshpass; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── Tunneling / Pivot ──"
    for t in proxychains4; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── Packet Analysis ──"
    for t in tshark tcpdump; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── RE / Binary ──"
    for t in checksec ROPgadget ropper radare2 rizin binwalk objdump; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done
    # readelf is Linux-only (macOS uses otool/objdump)
    if [[ "$PLATFORM" == "linux" ]]; then
        for t in readelf gdb strace ltrace; do
            if check_tool "$t"; then ((found++)); else ((missing++)); fi
        done
    else
        log_skip "readelf/gdb/strace/ltrace (Linux-only)"
    fi

    echo ""
    echo "── Database Clients ──"
    for t in sqlite3 mysql psql redis-cli; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── OCR / Image ──"
    for t in tesseract exiftool; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done
    # ImageMagick convert — check 'magick' (v7) or 'convert' (v6), skip on Windows (name clash)
    if [[ "$PLATFORM" == "windows" ]]; then
        check_tool "imagemagick (magick)" "magick" && ((found++)) || ((missing++))
    else
        check_tool "imagemagick (convert)" "convert" && ((found++)) || ((missing++))
    fi

    echo ""
    echo "── Encoding / Hash ──"
    for t in openssl base64 xxd; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done
    if [[ "$PLATFORM" == "macos" ]]; then
        check_tool "sha256 (shasum)" "shasum" && ((found++)) || ((missing++))
        check_tool "md5 (md5)" "md5" && ((found++)) || ((missing++))
    else
        for t in sha256sum md5sum; do
            if check_tool "$t"; then ((found++)); else ((missing++)); fi
        done
    fi

    echo ""
    echo "── Language Runtimes ──"
    for t in python3 node go java php; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── Data Processing ──"
    for t in jq xmlstarlet; do
        if check_tool "$t"; then ((found++)); else ((missing++)); fi
    done

    echo ""
    echo "── Assets in tools/ ──"
    if [[ -d "$WORDLISTS_DIR/SecLists" && -n "$(ls -A "$WORDLISTS_DIR/SecLists" 2>/dev/null)" ]]; then
        log_ok "SecLists"; ((found++))
    else
        log_warn "SecLists → NOT FOUND"; ((missing++))
    fi
    if [[ -d "$PAYLOADS_DIR/PayloadsAllTheThings" && -n "$(ls -A "$PAYLOADS_DIR/PayloadsAllTheThings" 2>/dev/null)" ]]; then
        log_ok "PayloadsAllTheThings"; ((found++))
    else
        log_warn "PayloadsAllTheThings → NOT FOUND"; ((missing++))
    fi
    local chisel_count
    chisel_count=$(find "$BIN_DIR" -name "chisel*" -size +1k 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$chisel_count" -gt 0 ]]; then
        log_ok "Chisel binaries ($chisel_count variants)"; ((found++))
    else
        log_warn "Chisel binaries → NOT FOUND"; ((missing++))
    fi
    local ligolo_count
    ligolo_count=$(find "$BIN_DIR" -name "ligolo*" -size +1k 2>/dev/null | wc -l | tr -d ' ')
    if [[ "$ligolo_count" -gt 0 ]]; then
        log_ok "Ligolo-ng binaries ($ligolo_count variants)"; ((found++))
    else
        log_warn "Ligolo-ng binaries → NOT FOUND"; ((missing++))
    fi

    printf "\n==========================================\n"
    printf "  Found: %d  |  Missing: %d\n" "$found" "$missing"
    printf "==========================================\n\n"
}

# ============================================================================
# SYSTEM PACKAGES — Install via OS package manager
# ============================================================================
install_system_packages() {
    log_info "Installing system packages via $PKG_MANAGER ..."

    if [[ "$PKG_MANAGER" == "unknown" ]]; then
        log_err "No supported package manager detected."
        log_info "Install brew (macOS), apt/dnf/pacman (Linux), or choco/scoop (Windows) first."
        return 1
    fi

    # Update package lists
    if [[ "$PKG_MANAGER" == "apt" ]]; then
        log_action "Updating apt package lists ..."
        sudo apt-get update -qq
    fi

    # ── Core System ──
    log_info "── Core System ──"
    ensure_pkg jq
    ensure_pkg tmux
    ensure_pkg expect
    ensure_pkg parallel
    ensure_pkg "xmlstarlet" "xmlstarlet" "xmlstarlet" "xmlstarlet" "xmlstarlet"

    # ── Compression ──
    log_info "── Compression ──"
    ensure_pkg p7zip "p7zip" "p7zip-full" "7zip" "7zip"

    # ── Network ──
    log_info "── Network Tools ──"
    ensure_pkg socat
    ensure_pkg ncat "nmap" "ncat" "nmap" "nmap"
    ensure_pkg mtr "mtr" "mtr" "mtr" "mtr"
    ensure_pkg fping
    ensure_pkg traceroute

    # ── Scanning & Discovery ──
    log_info "── Scanning & Discovery ──"
    ensure_pkg nmap
    ensure_pkg masscan "masscan" "masscan" "masscan" "masscan"
    ensure_pkg naabu "naabu" "naabu" "naabu" "naabu"
    ensure_pkg rustscan "rustscan" "rustscan" "rustscan" "rustscan"

    # ── Web / HTTP (core set via package manager) ──
    log_info "── Web / HTTP Testing ──"
    ensure_pkg nikto
    ensure_pkg ffuf
    ensure_pkg gobuster
    ensure_pkg feroxbuster "feroxbuster" "feroxbuster" "feroxbuster" "feroxbuster"
    ensure_pkg nuclei "nuclei" "nuclei" "nuclei" "nuclei"
    ensure_pkg sqlmap "sqlmap" "sqlmap" "sqlmap" "sqlmap"
    ensure_pkg httpx "httpx" "httpx" "httpx" "httpx"

    # ── Brute Force / Auth ──
    log_info "── Brute Force / Auth ──"
    ensure_pkg hydra "hydra" "hydra" "hydra" "hydra"
    ensure_pkg medusa "medusa" "medusa" "medusa" "medusa"
    ensure_pkg john "john" "john" "john" "john"
    ensure_pkg hashcat "hashcat" "hashcat" "hashcat" "hashcat"
    ensure_pkg sshpass "sshpass" "sshpass" "sshpass" "sshpass"

    # ── Tunneling / Pivot ──
    log_info "── Tunneling / Pivot ──"
    ensure_pkg proxychains4 "proxychains-ng" "proxychains4" "proxychains-ng" "proxychains-ng"

    # ── Packet Analysis ──
    log_info "── Packet Analysis ──"
    ensure_pkg tshark "wireshark" "tshark" "wireshark" "wireshark"

    # ── RE / Binary ──
    log_info "── RE / Binary ──"
    if [[ "$PLATFORM" == "linux" ]]; then
        ensure_pkg gdb
        ensure_pkg strace
        ensure_pkg ltrace
    fi
    ensure_pkg radare2 "radare2" "radare2" "radare2" "radare2"
    ensure_pkg rizin "rizin" "rizin" "rizin" "rizin"
    ensure_pkg binwalk
    ensure_pkg readelf "binutils" "binutils" "binutils" "binutils"

    # ── Database Clients ──
    log_info "── Database Clients ──"
    ensure_pkg sqlite3 "sqlite" "sqlite3" "sqlite" "sqlite"
    ensure_pkg mysql "mysql-client" "default-mysql-client" "mysql" "mysql"
    ensure_pkg psql "postgresql-client" "postgresql-client" "postgresql" "postgresql"
    ensure_pkg redis-cli "redis" "redis-tools" "redis" "redis"

    # ── OCR / Image ──
    log_info "── OCR / Image ──"
    ensure_pkg tesseract "tesseract" "tesseract-ocr" "tesseract" "tesseract"
    if [[ "$PLATFORM" == "windows" ]]; then
        ensure_pkg magick "imagemagick" "imagemagick" "imagemagick" "imagemagick"
    else
        ensure_pkg convert "imagemagick" "imagemagick" "imagemagick" "imagemagick"
    fi
    ensure_pkg exiftool "exiftool" "libimage-exiftool-perl" "exiftool" "exiftool"

    # ── Language Runtimes ──
    log_info "── Language Runtimes ──"
    ensure_pkg python3 "python3" "python3" "python3" "python3"
    ensure_pkg node "node@22" "nodejs" "nodejs" "nodejs"
    ensure_pkg go "go" "golang-go" "golang" "go"
    ensure_pkg java "openjdk@17" "openjdk-17-jdk-headless" "openjdk17" "openjdk17"
    ensure_pkg php "php" "php-cli" "php" "php"

    # ── Tools not in standard repos (install via pipx/gem/git) ──
    log_info "── Extra tools (pipx/gem/git) ──"

    # whatweb (Ruby gem / git clone)
    if ! has whatweb && ! file_ready "$HOME/local/bin/whatweb"; then
        if has gem; then
            log_action "Installing whatweb via gem ..."
            gem install whatweb 2>/dev/null && log_ok "whatweb (gem)" \
                || log_warn "gem install whatweb failed"
        elif has git; then
            log_action "Installing whatweb from GitHub ..."
            local whatweb_dir="/opt/homebrew/share/whatweb"
            [[ "$PLATFORM" == "linux" ]] && whatweb_dir="/opt/whatweb"
            git clone --depth 1 https://github.com/urbanadventurer/WhatWeb.git "$whatweb_dir" 2>/dev/null \
                && mkdir -p "$HOME/local/bin" \
                && printf '#!/bin/bash\ncd "%s" && exec ruby whatweb "$@"\n' "$whatweb_dir" > "$HOME/local/bin/whatweb" \
                && chmod +x "$HOME/local/bin/whatweb" \
                && log_ok "whatweb (git → ~/local/bin/whatweb)" \
                || log_warn "whatweb install failed"
        fi
    else
        log_skip "whatweb already installed"
    fi

    # dirsearch (pipx)
    if ! has dirsearch; then
        if has pipx; then
            log_action "Installing dirsearch via pipx ..."
            pipx install dirsearch 2>/dev/null && log_ok "dirsearch (pipx)" \
                || log_warn "pipx install dirsearch failed"
        else
            log_warn "pipx not found, skipping dirsearch (install with: brew install pipx)"
        fi
    else
        log_skip "dirsearch already installed"
    fi

    # ropper (pipx with Python 3.12 for compatibility)
    if ! has ropper && ! file_ready "$HOME/.local/bin/ropper"; then
        if has uv; then
            log_action "Installing ropper via uv ..."
            uv tool install ropper --python 3.12 2>/dev/null && log_ok "ropper (uv)" \
                || log_warn "uv install ropper failed"
        elif has pipx; then
            log_action "Installing ropper via pipx ..."
            pipx install ropper 2>/dev/null && log_ok "ropper (pipx)" \
                || log_warn "pipx install ropper failed"
        fi
    else
        log_skip "ropper already installed"
    fi

    # dirb (build from source on Linux/macOS)
    if ! has dirb && ! file_ready "$HOME/local/bin/dirb"; then
        if has gcc && has make; then
            log_action "Building dirb from source ..."
            local dirb_tmp="$RTMP/dirb_build_$$"
            git clone --depth 1 https://gitlab.com/kalilinux/packages/dirb.git "$dirb_tmp" 2>/dev/null \
                && cd "$dirb_tmp" && chmod +x configure && ./configure --quiet 2>/dev/null && make -j"$(nproc 2>/dev/null || echo 2)" 2>/dev/null \
                && mkdir -p "$HOME/local/bin" \
                && cp src/dirb "$HOME/local/bin/dirb" && chmod +x "$HOME/local/bin/dirb" \
                && cd "$SCRIPT_DIR" && rm -rf "$dirb_tmp" \
                && log_ok "dirb (built → ~/local/bin/dirb)" \
                || { cd "$SCRIPT_DIR"; rm -rf "$dirb_tmp"; log_warn "dirb build failed"; }
        else
            log_warn "gcc/make not found, skipping dirb build"
        fi
    else
        log_skip "dirb already installed"
    fi

    log_ok "System packages done."
}

# ============================================================================
# PYTHON PACKAGES — Install via pip (handles PEP 668)
# ============================================================================
install_python_packages() {
    log_info "Installing Python packages ..."

    if ! has python3; then
        log_err "python3 not found. Install Python first."
        return 1
    fi

    if [[ ! -f "$REQUIREMENTS_FILE" ]]; then
        log_err "requirements.txt not found at $REQUIREMENTS_FILE"
        return 1
    fi

    # Determine pip command
    local pip_cmd="pip3"
    if ! has pip3; then pip_cmd="python3 -m pip"; fi

    log_action "Installing from requirements.txt ..."

    # Strategy: try --user first (works on clean systems),
    # then --break-system-packages (PEP 668 override),
    # then bare (in a venv or unrestricted system).
    local install_rc=1
    $pip_cmd install --user --upgrade -r "$REQUIREMENTS_FILE" 2>/dev/null && install_rc=0 \
        || $pip_cmd install --user --break-system-packages --upgrade -r "$REQUIREMENTS_FILE" 2>/dev/null && install_rc=0 \
        || $pip_cmd install --break-system-packages --upgrade -r "$REQUIREMENTS_FILE" 2>/dev/null && install_rc=0 \
        || true

    if [[ $install_rc -eq 0 ]]; then
        log_ok "Python packages installed"
    else
        log_warn "Some Python packages may have failed — check output above"
    fi

    # Playwright browser (optional)
    if python3 -c "import playwright" 2>/dev/null; then
        log_action "Installing Playwright Chromium ..."
        python3 -m playwright install chromium 2>&1 | tail -3 || true
    fi

    # Pwntools / z3-solver via uv (isolated, compatible with Python 3.14)
    if has uv; then
        for tool in pwntools z3-solver; do
            if ! uv tool list 2>/dev/null | grep -qi "^${tool}"; then
                log_action "Installing $tool via uv ..."
                uv tool install "$tool" --python 3.12 2>/dev/null && log_ok "$tool (uv)" \
                    || log_warn "uv install $tool failed"
            else
                log_skip "$tool already installed (uv)"
            fi
        done
    fi

    log_ok "Python packages done."
}

# ============================================================================
# PORTABLE BINARIES — Download to tools/bin/
# ============================================================================
install_portable_binaries() {
    log_info "Installing portable binaries to $BIN_DIR ..."
    detect_proxy

    local ext=""
    [[ "$PLATFORM" == "windows" ]] && ext=".exe"

    # ── Chisel (tunnel tool — all variants for target upload) ──
    local chisel_ver="1.12.0"
    local chisel_base="https://github.com/jpillora/chisel/releases/download/v${chisel_ver}"

    # Current platform binary
    local chisel_dest="${BIN_DIR}/chisel${ext}"
    if ! file_ready "$chisel_dest"; then
        log_action "Downloading Chisel ${chisel_ver} (${BIN_OS}_${BIN_ARCH}) ..."
        rm -f "$chisel_dest" 2>/dev/null
        if [[ "$PLATFORM" == "windows" ]]; then
            local tmpzip="$RTMP/chisel_current_$$.zip"
            curl_dl -fsSL -o "$tmpzip" "${chisel_base}/chisel_${chisel_ver}_${BIN_OS}_${BIN_ARCH}.zip" \
                && unzip -o "$tmpzip" -d "$BIN_DIR/" \
                && mv -f "${BIN_DIR}/chisel.exe" "$chisel_dest" \
                && rm -f "$tmpzip" \
                && log_ok "Chisel → $chisel_dest" \
                || { rm -f "$tmpzip"; log_warn "Chisel download failed"; }
        else
            curl_dl -fsSL -o "${chisel_dest}.gz" "${chisel_base}/chisel_${chisel_ver}_${BIN_OS}_${BIN_ARCH}.gz" \
                && gunzip -f "${chisel_dest}.gz" \
                && chmod +x "$chisel_dest" \
                && log_ok "Chisel → $chisel_dest" \
                || { rm -f "${chisel_dest}.gz"; log_warn "Chisel download failed"; }
        fi
    else
        log_skip "Chisel already installed"
    fi

    # Unix chisel variants
    for variant in linux_amd64 linux_arm64 linux_386 darwin_amd64 darwin_arm64; do
        local v_dest="${BIN_DIR}/chisel_${variant}"
        if file_ready "$v_dest"; then
            log_skip "chisel_${variant} already exists"
            continue
        fi
        rm -f "$v_dest" "${v_dest}.gz" 2>/dev/null
        log_action "Downloading Chisel for ${variant} ..."
        curl_dl -fsSL -o "${v_dest}.gz" "${chisel_base}/chisel_${chisel_ver}_${variant}.gz" \
            && gunzip -f "${v_dest}.gz" \
            && chmod +x "$v_dest" \
            && log_ok "chisel_${variant}" \
            || { rm -f "$v_dest" "${v_dest}.gz" 2>/dev/null; log_warn "chisel_${variant} download failed"; }
    done

    # Windows chisel variants (zip format)
    for variant in windows_amd64 windows_386 windows_arm64; do
        local v_dest="${BIN_DIR}/chisel_${variant}.exe"
        if file_ready "$v_dest"; then
            log_skip "chisel_${variant}.exe already exists"
            continue
        fi
        rm -f "$v_dest" 2>/dev/null
        log_action "Downloading Chisel for ${variant} ..."
        local tmpzip="$RTMP/chisel_${variant}_$$.zip"
        curl_dl -fsSL -o "$tmpzip" "${chisel_base}/chisel_${chisel_ver}_${variant}.zip" \
            && unzip -o "$tmpzip" -d "$BIN_DIR/" \
            && mv -f "${BIN_DIR}/chisel.exe" "$v_dest" \
            && rm -f "$tmpzip" \
            && log_ok "chisel_${variant}.exe" \
            || { rm -f "$tmpzip" "$v_dest" 2>/dev/null; log_warn "chisel_${variant} download failed"; }
    done

    # ── Ligolo-ng (pivot: proxy=attacker, agent=target) ──
    local ligolo_ver="0.9.1"
    local ligolo_base="https://github.com/nicocha30/ligolo-ng/releases/download/v${ligolo_ver}"

    # Proxy binaries
    for variant in linux_amd64 linux_arm64 darwin_amd64 darwin_arm64; do
        local v_dest="${BIN_DIR}/ligolo-ng_proxy_${variant}"
        if file_ready "$v_dest"; then
            log_skip "ligolo-ng_proxy_${variant} already exists"
            continue
        fi
        rm -f "$v_dest" 2>/dev/null
        log_action "Downloading Ligolo-ng proxy for ${variant} ..."
        local tmpdir="$RTMP/ligolo_p_${variant}_$$"
        mkdir -p "$tmpdir"
        curl_dl -fsSL -o "${tmpdir}/archive.tar.gz" \
            "${ligolo_base}/ligolo-ng_proxy_${ligolo_ver}_${variant}.tar.gz" \
            && tar xzf "${tmpdir}/archive.tar.gz" -C "$tmpdir/" \
            && cp "$tmpdir/proxy" "$v_dest" \
            && chmod +x "$v_dest" \
            && rm -rf "$tmpdir" \
            && log_ok "ligolo-ng_proxy_${variant}" \
            || { rm -rf "$tmpdir"; log_warn "ligolo-ng_proxy_${variant} download failed"; }
    done

    # Agent binaries
    for variant in linux_amd64 linux_arm64 linux_armv6 linux_armv7; do
        local v_dest="${BIN_DIR}/ligolo-ng_agent_${variant}"
        if file_ready "$v_dest"; then
            log_skip "ligolo-ng_agent_${variant} already exists"
            continue
        fi
        rm -f "$v_dest" 2>/dev/null
        log_action "Downloading Ligolo-ng agent for ${variant} ..."
        local tmpdir="$RTMP/ligolo_a_${variant}_$$"
        mkdir -p "$tmpdir"
        curl_dl -fsSL -o "${tmpdir}/archive.tar.gz" \
            "${ligolo_base}/ligolo-ng_agent_${ligolo_ver}_${variant}.tar.gz" \
            && tar xzf "${tmpdir}/archive.tar.gz" -C "$tmpdir/" \
            && cp "$tmpdir/agent" "$v_dest" \
            && chmod +x "$v_dest" \
            && rm -rf "$tmpdir" \
            && log_ok "ligolo-ng_agent_${variant}" \
            || { rm -rf "$tmpdir"; log_warn "ligolo-ng_agent_${variant} download failed"; }
    done

    # Windows agent
    local win_agent="${BIN_DIR}/ligolo-ng_agent_windows_amd64.exe"
    if ! file_ready "$win_agent"; then
        rm -f "$win_agent" 2>/dev/null
        log_action "Downloading Ligolo-ng agent for windows_amd64 ..."
        local tmpdir="$RTMP/ligolo_aw_$$_$$"
        mkdir -p "$tmpdir"
        curl_dl -fsSL -o "${tmpdir}/archive.zip" \
            "${ligolo_base}/ligolo-ng_agent_${ligolo_ver}_windows_amd64.zip" \
            && unzip -o "${tmpdir}/archive.zip" -d "$tmpdir/" \
            && cp "$tmpdir/agent.exe" "$win_agent" \
            && rm -rf "$tmpdir" \
            && log_ok "ligolo-ng_agent_windows_amd64.exe" \
            || { rm -rf "$tmpdir"; log_warn "ligolo-ng windows agent download failed"; }
    else
        log_skip "ligolo-ng_agent_windows_amd64.exe already exists"
    fi

    # ── plink (PuTTY link, useful for Windows pivoting) ──
    if ! file_ready "${BIN_DIR}/plink.exe"; then
        rm -f "${BIN_DIR}/plink.exe" 2>/dev/null
        log_action "Downloading plink.exe ..."
        curl_dl -fsSL -o "${BIN_DIR}/plink.exe" \
            "https://the.earth.li/~sgtatham/putty/latest/w64/plink.exe" \
            && log_ok "plink.exe" \
            || log_warn "plink download failed"
    else
        log_skip "plink.exe already exists"
    fi

    log_ok "Portable binaries done."
}

# ============================================================================
# ASSETS — Wordlists, Payloads, PoC repos
# ============================================================================
install_assets() {
    log_info "Downloading wordlists, payloads, and PoC collections ..."

    # ── SecLists (wordlists) ──
    clone_if_missing "$WORDLISTS_DIR/SecLists" \
        "https://github.com/danielmiessler/SecLists.git" \
        "SecLists"

    # ── PayloadsAllTheThings ──
    clone_if_missing "$PAYLOADS_DIR/PayloadsAllTheThings" \
        "https://github.com/swisskyrepo/PayloadsAllTheThings.git" \
        "PayloadsAllTheThings"

    # ── Nuclei Templates ──
    if has nuclei; then
        local nuclei_templates="${WORDLISTS_DIR}/nuclei-templates"
        if [[ ! -d "$nuclei_templates" || -z "$(ls -A "$nuclei_templates" 2>/dev/null)" ]]; then
            log_action "Downloading nuclei-templates ..."
            nuclei -update-templates 2>&1 | tail -3 || true
            # Symlink from default location
            local default_templates
            default_templates="$(find "$HOME/.nuclei-templates" -maxdepth 0 -type d 2>/dev/null || true)"
            if [[ -n "$default_templates" && -d "$default_templates" ]]; then
                ln -sf "$default_templates" "$nuclei_templates" 2>/dev/null || true
                log_ok "nuclei-templates → $nuclei_templates"
            fi
        else
            log_skip "nuclei-templates already exists"
        fi
    else
        log_skip "nuclei not installed, skipping templates"
    fi

    # ── Vulhub (PoC knowledge base) ──
    clone_if_missing "$POC_DIR/vulhub" \
        "https://github.com/vulhub/vulhub.git" \
        "Vulhub PoC collection"

    # ── Pwntools tutorials ──
    clone_if_missing "$POC_DIR/pwntools-tutorial" \
        "https://github.com/Gallopsled/pwntools-tutorial.git" \
        "Pwntools tutorials"

    log_ok "Assets done."
}

# ============================================================================
# POST-INSTALL — Summary and PATH hints
# ============================================================================
post_install() {
    printf "\n==========================================\n"
    printf "  RedTrace Tools Installation Complete\n"
    printf "==========================================\n\n"
    printf "  Directory layout:\n"
    printf "    tools/bin/          Portable binaries (chisel, ligolo-ng, plink)\n"
    printf "    tools/wordlists/    SecLists, nuclei-templates\n"
    printf "    tools/payloads/     PayloadsAllTheThings\n"
    printf "    tools/poc/          Vulhub PoC, pwntools tutorials\n\n"

    # Shell profile PATH hint
    local profile=""
    if [[ -n "${ZSH_VERSION:-}" || -f "$HOME/.zshrc" ]]; then
        profile="$HOME/.zshrc"
    elif [[ -n "${BASH_VERSION:-}" || -f "$HOME/.bashrc" ]]; then
        profile="$HOME/.bashrc"
    fi

    if [[ -n "$profile" ]]; then
        if grep -qF "tools/bin" "$profile" 2>/dev/null; then
            log_ok "tools/bin already in $profile"
        else
            log_info "Add to your shell profile for persistent PATH:"
            printf "  echo 'export PATH=\"%s:\$PATH\"' >> %s\n" "$BIN_DIR" "$profile"
        fi
    fi

    # Windows Git Bash PATH hint
    if [[ "$PLATFORM" == "windows" ]]; then
        log_info "On Windows Git Bash, add to ~/.bash_profile:"
        printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.bash_profile\n" "$BIN_DIR"
    fi

    printf "\n"
    log_info "Run './install-tools.sh --check' to verify installation."
    printf "\n"
}

# ============================================================================
# MAIN
# ============================================================================
usage() {
    cat <<EOF
RedTrace Security Tools Installer

Usage: $0 [OPTIONS]

Options:
  (none)       Install everything (system + python + binaries + assets)
  --check      Check what's installed (no changes)
  --system     Install system packages only
  --python     Install Python packages only
  --assets     Download wordlists/payloads/PoC repos only
  --binaries   Download portable binaries only
  --help       Show this help
EOF
}

main() {
    detect_platform
    setup_dirs

    printf "\n==========================================\n"
    printf "  RedTrace Security Tools Installer\n"
    printf "  Platform: %s (%s)\n" "$PLATFORM" "$BIN_ARCH"
    printf "  Package Manager: %s\n" "$PKG_MANAGER"
    printf "  Tools Dir: %s\n" "$TOOLS_DIR"
    printf "==========================================\n"

    local mode="${1:-all}"

    case "$mode" in
        --check)    check_all ;;
        --system)   install_system_packages ;;
        --python)   install_python_packages ;;
        --assets)   install_assets ;;
        --binaries) install_portable_binaries ;;
        --help|-h)  usage ;;
        all)
            install_system_packages
            install_python_packages
            install_portable_binaries
            install_assets
            post_install
            ;;
        *)
            log_err "Unknown option: $mode"
            usage
            exit 1
            ;;
    esac
}

main "$@"
