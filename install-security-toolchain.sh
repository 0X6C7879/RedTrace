#!/usr/bin/env bash
# Install the RedTrace CTF/security toolchain without downloading vulnerability,
# PoC, or Nuclei template databases.
#
# Supported system package managers:
#   apt, dnf/yum, pacman, zypper, apk, brew
#
# Usage:
#   bash install-security-toolchain.sh [--dry-run] [--force] MODE
#
# Modes:
#   system, apt, dnf, yum, pacman, zypper, apk, brew
#   python, gems, go, rsactftool, qiling, all, --verify

set -Eeuo pipefail

PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
RUNTIME_DIR="$PROJECT_DIR/.redtrace/runtime"
BIN_DIR="$RUNTIME_DIR/bin"
QILING_WRAPPER="$PROJECT_DIR/skills/reverse-engineering/scripts/qiling-python"
DRY_RUN=false
FORCE=false
MODE=""
FAILED=()
SUCCEEDED=()
SKIPPED=()
SYSTEM_PACKAGES=()
LOG_DIR="${CTF_LOG_DIR:-$PROJECT_DIR/.redtrace/log/toolchain}"
LOG_FILE=""
CTF_VENV="${CTF_VENV:-$RUNTIME_DIR/ctf-tools}"
RSACTFTOOL_VENV="${RSACTFTOOL_VENV:-$RUNTIME_DIR/rsactftool}"
QILING_VENV="${QILING_VENV:-$RUNTIME_DIR/qiling}"
export REDTRACE_QILING_VENV="$QILING_VENV"
RSACTFTOOL_REVISION="${RSACTFTOOL_REVISION:-7c98848f1945de3e67a420871e8672f5ad9aa5d5}"
NUCLEI_VERSION="${NUCLEI_VERSION:-3.11.0}"
mkdir -p "$PROJECT_DIR/.redtrace/tmp" "$BIN_DIR"
export TMPDIR="$PROJECT_DIR/.redtrace/tmp"
export TMP="$TMPDIR"
export TEMP="$TMPDIR"
export XDG_CACHE_HOME="$PROJECT_DIR/.redtrace/cache"
export XDG_CONFIG_HOME="$PROJECT_DIR/.redtrace/config"
export XDG_DATA_HOME="$PROJECT_DIR/.redtrace/data"
export UV_CACHE_DIR="$PROJECT_DIR/.redtrace/cache/uv"
export GOPATH="$RUNTIME_DIR/go"
export GOBIN="$BIN_DIR"
export GEM_HOME="$RUNTIME_DIR/gems"
export PATH="$BIN_DIR:$GEM_HOME/bin:$PATH"

while (($#)); do
  case "$1" in
    --dry-run) DRY_RUN=true ;;
    --force) FORCE=true ;;
    -*) [[ -z "$MODE" ]] || { printf 'Unknown option: %s\n' "$1" >&2; exit 2; }
        MODE="$1" ;;
    *) [[ -z "$MODE" ]] || { printf 'Unexpected argument: %s\n' "$1" >&2; exit 2; }
       MODE="$1" ;;
  esac
  shift
done
MODE="${MODE:-all}"

log_info() { printf '==> %s\n' "$*" | tee -a "${LOG_FILE:-/dev/null}"; }
log_warn() { printf 'WARNING: %s\n' "$*" | tee -a "${LOG_FILE:-/dev/null}" >&2; }
log_error() { printf 'ERROR: %s\n' "$*" | tee -a "${LOG_FILE:-/dev/null}" >&2; }
log_detail() { printf '    %s\n' "$*" >>"${LOG_FILE:-/dev/null}"; }

setup_logging() {
  mkdir -p "$LOG_DIR"
  LOG_FILE="$LOG_DIR/install-$(date +%Y-%m-%d_%H%M%S).log"
  log_info "Logging to $LOG_FILE"
}

has() { command -v "$1" >/dev/null 2>&1; }

run_privileged() {
  if ((EUID == 0)); then
    "$@"
  elif has sudo; then
    sudo "$@"
  else
    log_error "sudo is required to install system packages"
    return 1
  fi
}

detect_package_manager() {
  local manager
  for manager in apt-get dnf yum pacman zypper apk brew; do
    has "$manager" || continue
    case "$manager" in
      apt-get) printf 'apt\n' ;;
      *) printf '%s\n' "$manager" ;;
    esac
    return
  done
  return 1
}

set_system_packages() {
  local manager="$1"
  case "$manager" in
    apt)
      SYSTEM_PACKAGES=(
        ca-certificates curl git xz-utils unzip build-essential pkg-config cmake ninja-build swig
        python3 python3-venv python3-pip python3-dev openjdk-21-jdk-headless
        libffi-dev libssl-dev libgmp-dev libmpfr-dev libmpc-dev zlib1g-dev
        ruby ruby-dev golang-go nodejs npm jq ripgrep
        gdb radare2 binutils binwalk foremost libimage-exiftool-perl tshark sleuthkit
        ffmpeg steghide testdisk john pcapfix nmap whois bind9-dnsutils hashcat strace ltrace
        imagemagick apktool upx-ucl qemu-system-x86 qrencode bsdextrautils iputils-ping
        netcat-openbsd sshpass rlwrap nikto dirsearch yq adb yara p7zip-full
        file xxd zbar-tools sox qsstv tesseract-ocr
      )
      ;;
    dnf|yum)
      SYSTEM_PACKAGES=(
        ca-certificates curl git xz unzip gcc gcc-c++ make pkgconf-pkg-config cmake ninja-build swig
        python3 python3-pip python3-devel java-21-openjdk-headless
        libffi-devel openssl-devel gmp-devel mpfr-devel libmpc-devel zlib-devel
        ruby ruby-devel golang nodejs npm jq ripgrep
        gdb radare2 binutils binwalk foremost perl-Image-ExifTool wireshark-cli sleuthkit
        ffmpeg-free steghide testdisk john pcapfix nmap whois bind-utils hashcat strace ltrace
        ImageMagick apktool upx qemu-system-x86-core qrencode util-linux iputils nmap-ncat
        sshpass rlwrap nikto dirsearch yq android-tools yara p7zip
        file vim-common zbar sox qsstv tesseract
      )
      ;;
    pacman)
      SYSTEM_PACKAGES=(
        ca-certificates curl git xz unzip base-devel pkgconf cmake ninja swig
        python python-pip jdk21-openjdk libffi openssl gmp mpfr libmpc zlib
        ruby go nodejs npm jq ripgrep
        gdb radare2 binutils binwalk foremost perl-image-exiftool wireshark-cli sleuthkit
        ffmpeg steghide testdisk john pcapfix nmap whois bind hashcat strace ltrace
        imagemagick apktool upx qemu-system-x86 qrencode util-linux iputils openbsd-netcat
        sshpass rlwrap nikto dirsearch yq android-tools yara p7zip
        file xxd zbar sox qsstv tesseract
      )
      ;;
    zypper)
      SYSTEM_PACKAGES=(
        ca-certificates curl git xz unzip gcc gcc-c++ make pkg-config cmake ninja swig
        python3 python3-pip python3-devel java-21-openjdk-headless
        libffi-devel libopenssl-devel gmp-devel mpfr-devel mpc-devel zlib-devel
        ruby ruby-devel go nodejs npm jq ripgrep
        gdb radare2 binutils binwalk foremost perl-Image-ExifTool wireshark sleuthkit
        ffmpeg steghide testdisk john pcapfix nmap whois bind-utils hashcat strace ltrace
        ImageMagick apktool upx qemu-x86 qrencode util-linux iputils netcat-openbsd
        sshpass rlwrap nikto dirsearch yq android-tools yara 7zip
        file vim-data zbar sox qsstv tesseract-ocr
      )
      ;;
    apk)
      SYSTEM_PACKAGES=(
        bash ca-certificates curl git xz unzip build-base pkgconf cmake ninja swig
        python3 py3-pip py3-virtualenv openjdk21-jre-headless
        libffi-dev openssl-dev gmp-dev mpfr-dev mpc1-dev zlib-dev
        ruby ruby-dev go nodejs-current npm jq ripgrep
        gdb radare2 binutils binwalk foremost exiftool wireshark-cli sleuthkit
        ffmpeg steghide testdisk john pcapfix nmap whois bind-tools hashcat strace
        imagemagick apktool upx qemu-system-x86_64 qrencode util-linux iputils
        netcat-openbsd sshpass rlwrap nikto py3-yq android-tools yara p7zip
        file xxd zbar sox tesseract-ocr
      )
      ;;
    brew)
      SYSTEM_PACKAGES=(
        ca-certificates curl git xz unzip pkg-config cmake ninja swig
        python@3.12 libffi openssl@3 gmp mpfr libmpc zlib libomp
        openjdk@21 ruby go node jq ripgrep ghidra nuclei
        gdb radare2 binutils binwalk exiftool wireshark sleuthkit ffmpeg testdisk
        john-jumbo nmap whois bind hashcat imagemagick apktool upx qemu qrencode
        sshpass rlwrap nikto dirsearch yq yara p7zip foremost pcapfix
        zbar sox tesseract
      )
      ;;
    *) log_error "unsupported package manager: $manager"; return 1 ;;
  esac
}

package_installed() {
  local manager="$1" package="$2"
  case "$manager" in
    apt) dpkg-query -W -f='${Status}' "$package" 2>/dev/null | grep -q 'install ok installed' ;;
    dnf|yum) rpm -q "$package" >/dev/null 2>&1 ;;
    pacman) pacman -Q "$package" >/dev/null 2>&1 ;;
    zypper) rpm -q "$package" >/dev/null 2>&1 ;;
    apk) apk info -e "$package" >/dev/null 2>&1 ;;
    brew) brew list --formula "$package" >/dev/null 2>&1 ;;
  esac
}

package_available() {
  local manager="$1" package="$2" candidate
  case "$manager" in
    apt)
      candidate="$(apt-cache policy "$package" 2>/dev/null | awk '$1 == "Candidate:" {print $2; exit}')"
      [[ -n "$candidate" && "$candidate" != "(none)" ]]
      ;;
    dnf) dnf -q list --available "$package" >/dev/null 2>&1 ;;
    yum) yum -q list available "$package" >/dev/null 2>&1 ;;
    pacman) pacman -Si "$package" >/dev/null 2>&1 ;;
    zypper) zypper --non-interactive info "$package" >/dev/null 2>&1 ;;
    apk) apk search -x "$package" 2>/dev/null | grep -Fqx "$package" ;;
    brew) brew info --formula "$package" >/dev/null 2>&1 ;;
  esac
}

refresh_package_metadata() {
  local manager="$1"
  case "$manager" in
    apt) run_privileged env DEBIAN_FRONTEND=noninteractive apt-get update -q ;;
    dnf) run_privileged dnf -q makecache ;;
    yum) run_privileged yum -q makecache ;;
    pacman)
      # Do not use `pacman -Sy`: refreshing without a full upgrade can create
      # an unsupported partial-upgrade state. `pacman -S --needed` below uses
      # the currently synchronized database.
      log_info "pacman metadata refresh skipped to avoid a partial upgrade"
      ;;
    zypper) run_privileged zypper --non-interactive refresh ;;
    apk) run_privileged apk update ;;
    brew) brew update ;;
  esac
}

install_system_package() {
  local manager="$1" package="$2"
  case "$manager" in
    apt) run_privileged env DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "$package" ;;
    dnf) run_privileged dnf install -y --setopt=install_weak_deps=False "$package" ;;
    yum) run_privileged yum install -y "$package" ;;
    pacman) run_privileged pacman -S --needed --noconfirm "$package" ;;
    zypper) run_privileged zypper --non-interactive install --no-recommends "$package" ;;
    apk) run_privileged apk add --no-cache "$package" ;;
    brew) HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK=1 brew install "$package" ;;
  esac
}

install_system() {
  local manager="${1:-}"
  local package
  [[ -n "$manager" ]] || manager="$(detect_package_manager)" \
    || { log_error "no supported package manager found"; return 1; }
  set_system_packages "$manager"
  log_info "System package manager: $manager (${#SYSTEM_PACKAGES[@]} mapped packages)"

  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would install with $manager: ${SYSTEM_PACKAGES[*]}"
    return
  fi

  case "$manager" in
    apt) has apt-get ;;
    *) has "$manager" ;;
  esac || { log_error "$manager is not available"; return 1; }

  refresh_package_metadata "$manager" \
    || log_warn "$manager metadata refresh failed; continuing with current metadata"

  for package in "${SYSTEM_PACKAGES[@]}"; do
    if [[ "$FORCE" == false ]] && package_installed "$manager" "$package"; then
      SKIPPED+=("$manager:$package")
      continue
    fi
    if ! package_available "$manager" "$package"; then
      log_warn "$manager package unavailable and skipped: $package"
      SKIPPED+=("$manager-unavailable:$package")
      continue
    fi
    if install_system_package "$manager" "$package" >>"${LOG_FILE:-/dev/null}" 2>&1; then
      SUCCEEDED+=("$manager:$package")
    else
      log_warn "$manager install failed: $package"
      FAILED+=("$manager:$package")
    fi
  done
}

PIP_PACKAGES=(
  "pwntools==4.15.0:pwn"
  "pycryptodome==3.23.0:Crypto"
  "z3-solver==4.13.0.0:z3"
  "sympy==1.14.0:sympy"
  "gmpy2==2.3.0:gmpy2"
  "hashpumpy==1.2:hashpumpy"
  "cysignals==1.12.6:cysignals"
  "fpylll==0.6.4:fpylll"
  "py_ecc==8.0.0:py_ecc"
  "pycparser==2.23:pycparser"
  "angr==9.2.193:angr"
  "frida-tools==14.8.0:frida"
  "requests==2.32.5:requests"
  "flask-unsign==1.2.1:flask_unsign"
  "sqlmap==1.10.3:sqlmap"
  "ropper==1.13.13:ropper"
  "ROPgadget==7.7:ropgadget"
  "volatility3==2.27.0:volatility3"
  "yara-python==4.5.4:yara"
  "pefile==2024.8.26:pefile"
  "capstone==5.0.3:capstone"
  "oletools==0.60.2:oletools"
  "unicorn==2.1.2:unicorn"
  "scapy==2.7.0:scapy"
  "Pillow==10.4.0:PIL"
  "numpy==2.2.6:numpy"
  "scipy==1.15.3:scipy"
  "matplotlib==3.10.8:matplotlib"
  "pyzbar==0.1.9:pyzbar"
  "pytesseract==0.3.13:pytesseract"
  "segno==1.6.6:segno"
  "shodan==1.31.0:shodan"
  "uncompyle6==3.9.3:uncompyle6"
  "lief==0.17.6:lief"
  "dnspython==2.8.0:dns"
  "dnslib==0.9.26:dnslib"
  "dissect.cobaltstrike==1.2.1:dissect.cobaltstrike"
)

install_python() {
  local python entry spec module name
  local to_install=()
  has python3 || { log_error "python3 is required"; return 1; }

  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would create $CTF_VENV and install ${#PIP_PACKAGES[@]} pinned Python packages"
    return
  fi

  [[ -x "$CTF_VENV/bin/python" ]] || python3 -m venv "$CTF_VENV"
  python="$CTF_VENV/bin/python"
  for entry in "${PIP_PACKAGES[@]}"; do
    spec="${entry%%:*}"
    module="${entry##*:}"
    name="${spec%%==*}"
    if [[ "$FORCE" == false ]] && "$python" -c "import $module" >/dev/null 2>&1; then
      SKIPPED+=("pip:$name")
    else
      to_install+=("$spec")
    fi
  done
  ((${#to_install[@]})) || { log_info "Python packages already installed"; return; }
  if "$python" -m pip install "${to_install[@]}" >>"$LOG_FILE" 2>&1; then
    for spec in "${to_install[@]}"; do SUCCEEDED+=("pip:${spec%%==*}"); done
  else
    log_warn "batch pip install failed; retrying packages individually"
    for spec in "${to_install[@]}"; do
      if "$python" -m pip install "$spec" >>"$LOG_FILE" 2>&1; then
        SUCCEEDED+=("pip:${spec%%==*}")
      else
        FAILED+=("pip:${spec%%==*}")
      fi
    done
  fi
}

install_gems() {
  local package gem_bin
  local packages=(one_gadget seccomp-tools zsteg)
  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would install Ruby gems: ${packages[*]}"
    return
  fi
  has gem || { log_warn "gem unavailable; Ruby tools skipped"; return; }
  for package in "${packages[@]}"; do
    if [[ "$FORCE" == false ]] && gem list -i "^${package}$" >/dev/null 2>&1; then
      SKIPPED+=("gem:$package")
    elif gem install "$package" >>"$LOG_FILE" 2>&1; then
      SUCCEEDED+=("gem:$package")
    else
      FAILED+=("gem:$package")
    fi
  done
  gem_bin="$GEM_HOME/bin"
  log_info "Ruby executables: $gem_bin"
}

install_go() {
  local command spec
  local tools=(
    "ffuf:github.com/ffuf/ffuf/v2@latest"
    "nuclei:github.com/projectdiscovery/nuclei/v3/cmd/nuclei@v$NUCLEI_VERSION"
  )
  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would install Go tools: ffuf nuclei-engine@$NUCLEI_VERSION"
    return
  fi
  has go || { log_error "go is required for ffuf and Nuclei"; return 1; }
  mkdir -p "$GOBIN"
  for spec in "${tools[@]}"; do
    command="${spec%%:*}"
    if [[ "$FORCE" == false ]] && has "$command"; then
      SKIPPED+=("go:$command")
    elif GOBIN="$GOBIN" go install "${spec#*:}" >>"$LOG_FILE" 2>&1; then
      SUCCEEDED+=("go:$command")
    else
      FAILED+=("go:$command")
    fi
  done
  configure_nuclei_engine
}

configure_nuclei_engine() {
  local config_path
  config_path="$XDG_CONFIG_HOME/nuclei/config.yaml"
  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would disable Nuclei template update checks in $config_path"
    return
  fi
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

install_rsactftool() {
  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would install pinned RsaCtfTool into $RSACTFTOOL_VENV"
    return
  fi
  has python3 || { log_error "python3 is required for RsaCtfTool"; return 1; }
  if [[ "$FORCE" == false && -x "$RSACTFTOOL_VENV/bin/RsaCtfTool" ]]; then
    SKIPPED+=("python:RsaCtfTool")
    return
  fi
  [[ -x "$RSACTFTOOL_VENV/bin/python" ]] || python3 -m venv "$RSACTFTOOL_VENV"
  if "$RSACTFTOOL_VENV/bin/python" -m pip install --upgrade \
    "git+https://github.com/RsaCtfTool/RsaCtfTool.git@$RSACTFTOOL_REVISION" \
    >>"$LOG_FILE" 2>&1; then
    mkdir -p "$BIN_DIR"
    ln -sfn "$RSACTFTOOL_VENV/bin/RsaCtfTool" "$BIN_DIR/RsaCtfTool"
    SUCCEEDED+=("python:RsaCtfTool")
  else
    FAILED+=("python:RsaCtfTool")
  fi
}

ensure_uv() {
  has uv && return
  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would install uv for the Qiling Python 3.11 environment"
    return
  fi
  curl -LsSf https://astral.sh/uv/install.sh | env UV_INSTALL_DIR="$BIN_DIR" sh
  export PATH="$BIN_DIR:$PATH"
  has uv || { log_error "uv installation failed"; return 1; }
}

install_qiling() {
  if [[ "$DRY_RUN" == true ]]; then
    log_info "Would install Qiling 1.4.6 in an isolated Python 3.11 environment"
    return
  fi
  ensure_uv
  if [[ "$FORCE" == false ]] \
    && "$QILING_VENV/bin/python" -c "import qiling" >/dev/null 2>&1; then
    SKIPPED+=("python:Qiling")
  else
    [[ -x "$QILING_VENV/bin/python" ]] || uv venv --python 3.11 "$QILING_VENV"
    "$QILING_VENV/bin/python" -m ensurepip --upgrade >>"$LOG_FILE" 2>&1
    if "$QILING_VENV/bin/python" -m pip install qiling==1.4.6 >>"$LOG_FILE" 2>&1; then
      SUCCEEDED+=("python:Qiling")
    else
      FAILED+=("python:Qiling")
      return
    fi
  fi
  mkdir -p "$BIN_DIR"
  ln -sfn "$QILING_VENV/bin/qltool" "$BIN_DIR/qltool"
  [[ -x "$QILING_WRAPPER" ]] || { log_error "Qiling Python wrapper is missing"; return 1; }
  ln -sfn "$QILING_WRAPPER" "$BIN_DIR/qiling-python"
}

verify() {
  local command entry module spec name
  local found=() missing=()
  local checks=(
    python3 r2 objdump binwalk exiftool tshark fls ffmpeg foremost
    testdisk john nmap whois hashcat convert curl jq apktool upx
    qemu-system-x86_64 qrencode ffuf nuclei RsaCtfTool qltool zsteg gem go
    zbarimg sox tesseract
  )
  if [[ "$(uname -s)" == "Linux" ]]; then
    checks+=(gdb steghide strace ltrace)
  fi
  export PATH="$CTF_VENV/bin:$BIN_DIR:$GOBIN:$PATH"
  has ruby && export PATH="$GEM_HOME/bin:$PATH"

  for command in "${checks[@]}"; do
    if has "$command"; then found+=("$command"); else missing+=("$command"); fi
  done
  if [[ -x "$CTF_VENV/bin/python" ]]; then
    for entry in "${PIP_PACKAGES[@]}"; do
      module="${entry##*:}"
      spec="${entry%%:*}"
      name="${spec%%==*}"
      if "$CTF_VENV/bin/python" -c "import $module" >/dev/null 2>&1; then
        found+=("py:$name")
      else
        missing+=("py:$name")
      fi
    done
  else
    missing+=("python-venv:$CTF_VENV")
  fi
  if "$QILING_VENV/bin/python" -c "import qiling" >/dev/null 2>&1; then
    found+=("py:Qiling")
  else
    missing+=("py:Qiling")
  fi
  printf 'Found: %s tools/modules\n' "${#found[@]}"
  printf 'Missing: %s tools/modules\n' "${#missing[@]}"
  if ((${#missing[@]})); then
    for command in "${missing[@]}"; do printf '  - %s\n' "$command"; done
  fi
  ((${#missing[@]} == 0))
}

print_manual() {
  cat <<'EOF'
Optional/manual tools:
  pwndbg   - https://github.com/pwndbg/pwndbg
  pycdc    - https://github.com/zrax/pycdc
  dnSpyEx  - https://github.com/dnSpyEx/dnSpy (Windows/.NET)
fpylll, cysignals, SymPy, gmpy2, Z3, py_ecc, and RsaCtfTool provide the
default Crypto workflow.
No vulnerability database, PoC collection, or Nuclei template repository is
downloaded. Agents perform live fingerprint-based research and fetch only the
specific candidate PoC/EXP or validation template they need.
EOF
}

print_summary() {
  printf '\nInstalled: %s\nSkipped: %s\nFailed: %s\n' \
    "${#SUCCEEDED[@]}" "${#SKIPPED[@]}" "${#FAILED[@]}"
  ((${#FAILED[@]} == 0)) || printf 'Failed entries: %s\n' "${FAILED[*]}"
  [[ -z "$LOG_FILE" ]] || printf 'Log: %s\n' "$LOG_FILE"
}

run_mode() {
  local manager
  case "$MODE" in
    system)
      manager="$(detect_package_manager)" \
        || { log_error "no supported package manager found"; return 1; }
      install_system "$manager"
      ;;
    apt|dnf|yum|pacman|zypper|apk|brew) install_system "$MODE" ;;
    python) install_python ;;
    gems) install_gems ;;
    go) install_go ;;
    rsactftool) install_rsactftool ;;
    qiling) install_qiling ;;
    manual) print_manual ;;
    --verify|verify) verify ;;
    all)
      manager="$(detect_package_manager)" \
        || { log_error "no supported package manager found"; return 1; }
      install_system "$manager"
      install_python
      install_gems
      install_go
      install_rsactftool
      install_qiling
      print_manual
      ;;
    *)
      log_error "Unknown mode: $MODE"
      printf 'Usage: %s [--dry-run] [--force] {system|apt|dnf|yum|pacman|zypper|apk|brew|python|gems|go|rsactftool|qiling|all|--verify}\n' "$0" >&2
      return 2
      ;;
  esac
}

if [[ "$DRY_RUN" == false && "$MODE" != "--verify" && "$MODE" != "verify" && "$MODE" != "manual" ]]; then
  setup_logging
fi
run_mode
[[ "$MODE" == "--verify" || "$MODE" == "verify" || "$MODE" == "manual" ]] || print_summary
((${#FAILED[@]} == 0))
