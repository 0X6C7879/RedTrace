#!/usr/bin/env bash
# Install the benchmark-only analysis, AI, multi-chain, and offline-cache tools.
# This is shared by Dockerfile.benchmark and install-security-toolchain.sh so
# the hosted image and a Linux deployment cannot silently drift apart.
set -Eeuo pipefail

PROFILE="${1:-all}"
TARGETARCH="${TARGETARCH:-amd64}"
BIN_DIR="${REDTRACE_BIN_DIR:-/usr/local/bin}"
DATA_DIR="${REDTRACE_DATA_DIR:-/opt/redtrace/data}"
OFFLINE_DIR="${REDTRACE_OFFLINE_DIR:-/opt/redtrace/offline}"
SECURITY_VENV="${REDTRACE_SECURITY_VENV:-/opt/redtrace/venvs/security}"
PYTHON="$SECURITY_VENV/bin/python"
export CARGO_HOME="${CARGO_HOME:-$OFFLINE_DIR/cargo}"
export RUSTUP_HOME="${RUSTUP_HOME:-$OFFLINE_DIR/rustup}"
export PATH="$BIN_DIR:$CARGO_HOME/bin:$PATH"

SEMGREP_VERSION="${SEMGREP_VERSION:-1.173.0}"
INSPECT_AI_VERSION="${INSPECT_AI_VERSION:-0.3.258}"
INSPECT_EVALS_VERSION="${INSPECT_EVALS_VERSION:-0.17.0}"
AGENTDOJO_VERSION="${AGENTDOJO_VERSION:-0.1.35}"
PROMPTMAP_REVISION="${PROMPTMAP_REVISION:-432e072ae654788ad5b30172d42f3b1bcbda21cf}"
PYCDC_REVISION="${PYCDC_REVISION:-b4289760970dbc399684f1e155ec6d1ea1cc787e}"
RUST_TOOLCHAIN_VERSION="${RUST_TOOLCHAIN_VERSION:-1.85.1}"

mkdir -p "$BIN_DIR" "$DATA_DIR" "$OFFLINE_DIR" /tmp/redtrace-extras

log() { printf '[benchmark-extras] %s\n' "$*"; }
has() { command -v "$1" >/dev/null 2>&1; }
fetch() {
  local url="$1" output="$2"
  curl -fL --retry 8 --retry-delay 2 --retry-all-errors "$url" -o "$output"
}
copy_found() {
  local root="$1" name="$2" destination="${3:-$name}" source
  source="$(find "$root" -type f -name "$name" -print -quit)"
  [[ -n "$source" ]] || { printf 'missing %s in %s\n' "$name" "$root" >&2; return 1; }
  install -m 0755 "$source" "$BIN_DIR/$destination"
}

install_analysis_ai() {
  log "installing Semgrep, decompilers, and AI security tools"
  "$PYTHON" -m pip install --no-cache-dir \
    "semgrep==$SEMGREP_VERSION" "uncompyle6==3.9.3" \
    "inspect-ai==$INSPECT_AI_VERSION" "inspect-evals==$INSPECT_EVALS_VERSION" \
    "agentdojo==$AGENTDOJO_VERSION"
  for command in semgrep uncompyle6 inspect; do
    ln -sfn "$SECURITY_VENV/bin/$command" "$BIN_DIR/$command"
  done

  local tmp=/tmp/redtrace-extras/analysis
  rm -rf "$tmp" && mkdir -p "$tmp"

  case "$TARGETARCH" in
    amd64) release_arch=x64; portable_arch=x86_64 ;;
    arm64) release_arch=arm64; portable_arch=arm64 ;;
    *) printf 'unsupported architecture: %s\n' "$TARGETARCH" >&2; return 1 ;;
  esac

  fetch "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${release_arch}.tar.gz" "$tmp/gitleaks.tgz"
  tar -xzf "$tmp/gitleaks.tgz" -C "$tmp"
  install -m 0755 "$tmp/gitleaks" "$BIN_DIR/gitleaks"

  fetch "https://github.com/pwndbg/pwndbg/releases/download/2026.07.29/pwndbg_2026.07.29_${portable_arch}-portable.tar.xz" "$tmp/pwndbg.tar.xz"
  mkdir -p "$DATA_DIR/pwndbg"
  tar -xJf "$tmp/pwndbg.tar.xz" -C "$DATA_DIR/pwndbg" --strip-components=1
  copy_found "$DATA_DIR/pwndbg" pwndbg pwndbg

  CARGO_INSTALL_ROOT="${CARGO_INSTALL_ROOT:-$OFFLINE_DIR/cargo-install}" \
    cargo install --locked --root "${CARGO_INSTALL_ROOT:-$OFFLINE_DIR/cargo-install}" pwninit --version 3.3.2
  ln -sfn "${CARGO_INSTALL_ROOT:-$OFFLINE_DIR/cargo-install}/bin/pwninit" "$BIN_DIR/pwninit"

  fetch "https://github.com/bytecodealliance/wasm-tools/releases/download/v1.256.0/wasm-tools-1.256.0-${portable_arch}-linux.tar.gz" "$tmp/wasm-tools.tgz"
  mkdir -p "$tmp/wasm-tools" && tar -xzf "$tmp/wasm-tools.tgz" -C "$tmp/wasm-tools"
  copy_found "$tmp/wasm-tools" wasm-tools wasm-tools

  git clone https://github.com/zrax/pycdc.git "$tmp/pycdc"
  git -C "$tmp/pycdc" checkout "$PYCDC_REVISION"
  cmake -S "$tmp/pycdc" -B "$tmp/pycdc/build" -DCMAKE_BUILD_TYPE=Release
  cmake --build "$tmp/pycdc/build" --parallel "$(nproc)"
  install -m 0755 "$tmp/pycdc/build/pycdc" "$BIN_DIR/pycdc"
  [[ -f "$tmp/pycdc/build/pycdas" ]] && install -m 0755 "$tmp/pycdc/build/pycdas" "$BIN_DIR/pycdas"

  local dotnet_root="$OFFLINE_DIR/dotnet"
  fetch https://dot.net/v1/dotnet-install.sh "$tmp/dotnet-install.sh"
  bash "$tmp/dotnet-install.sh" --channel 8.0 --install-dir "$dotnet_root" --no-path
  "$dotnet_root/dotnet" tool install ilspycmd --tool-path "$OFFLINE_DIR/dotnet-tools" --version 9.1.0.7988
  rm -rf "$dotnet_root/sdk" "$dotnet_root/sdk-manifests" "$dotnet_root/packs" \
    "$dotnet_root/templates" "$dotnet_root/metadata"
  ln -sfn "$dotnet_root/dotnet" "$BIN_DIR/dotnet"
  ln -sfn "$OFFLINE_DIR/dotnet-tools/ilspycmd" "$BIN_DIR/ilspycmd"

  git clone https://github.com/utkusen/promptmap.git "$DATA_DIR/promptmap2"
  git -C "$DATA_DIR/promptmap2" checkout "$PROMPTMAP_REVISION"
  "$PYTHON" -m pip install --no-cache-dir -r "$DATA_DIR/promptmap2/requirements.txt"
  rm -rf "$DATA_DIR/promptmap2/.git"
  printf '#!/usr/bin/env bash\nexec %q %q "$@"\n' "$PYTHON" "$DATA_DIR/promptmap2/promptmap2.py" > "$BIN_DIR/promptmap2"
  chmod 0755 "$BIN_DIR/promptmap2"
  printf '#!/usr/bin/env bash\nexec %q eval inspect_evals/agent_threat_bench "$@"\n' "$SECURITY_VENV/bin/inspect" > "$BIN_DIR/agent-threat-bench"
  chmod 0755 "$BIN_DIR/agent-threat-bench"

  "$PYTHON" -c 'import agentdojo, inspect_ai, inspect_evals'
  rm -rf "$tmp"
}

install_solana_move() {
  log "installing Solana/Agave, Anchor, Sui, Aptos, and Move tooling"
  local tmp=/tmp/redtrace-extras/solana-move
  rm -rf "$tmp" && mkdir -p "$tmp"
  case "$TARGETARCH" in
    amd64) gnu_arch=x86_64; ubuntu_arch=x86_64 ;;
    arm64) gnu_arch=aarch64; ubuntu_arch=aarch64 ;;
    *) printf 'unsupported architecture: %s\n' "$TARGETARCH" >&2; return 1 ;;
  esac

  fetch "https://github.com/anza-xyz/agave/releases/download/v4.2.1/solana-release-${gnu_arch}-unknown-linux-gnu.tar.bz2" "$tmp/agave.tar.bz2"
  mkdir -p "$tmp/agave" && tar -xjf "$tmp/agave.tar.bz2" -C "$tmp/agave"
  for command in solana solana-keygen solana-test-validator; do
    copy_found "$tmp/agave" "$command" "$command"
  done
  for command in cargo-build-sbf cargo-test-sbf; do
    source="$(find "$tmp/agave" -type f -name "$command" -print -quit)"
    [[ -z "$source" ]] || install -m 0755 "$source" "$BIN_DIR/$command"
  done
  if ! has cargo-build-sbf; then
    cargo install --locked --root "$OFFLINE_DIR/cargo-install" cargo-build-sbf --version 4.1.0
    ln -sfn "$OFFLINE_DIR/cargo-install/bin/cargo-build-sbf" "$BIN_DIR/cargo-build-sbf"
  fi

  fetch "https://github.com/otter-sec/anchor/releases/download/v1.1.2/anchor-1.1.2-${gnu_arch}-unknown-linux-gnu" "$BIN_DIR/anchor"
  chmod 0755 "$BIN_DIR/anchor"

  fetch "https://github.com/MystenLabs/sui/releases/download/mainnet-v1.77.2/sui-mainnet-v1.77.2-ubuntu-${ubuntu_arch}.tgz" "$tmp/sui.tgz"
  mkdir -p "$tmp/sui" && tar -xzf "$tmp/sui.tgz" -C "$tmp/sui"
  copy_found "$tmp/sui" sui sui

  APTOS_CLI_VERSION=9.5.0 npm install -g @aptos-labs/aptos-cli@3.0.0
  APTOS_CLI_VERSION=9.5.0 aptos --version >/dev/null

  cat > "$BIN_DIR/move" <<'EOF'
#!/usr/bin/env bash
set -e
case "${1:-}" in
  aptos) shift; exec aptos move "$@" ;;
  sui) shift; exec sui move "$@" ;;
  *) echo 'usage: move {aptos|sui} {build|test|...} [args...]' >&2; exit 2 ;;
esac
EOF
  chmod 0755 "$BIN_DIR/move"
  rm -rf "$tmp"
}

install_cairo_ton() {
  log "installing Cairo/Starknet and TON local toolchains"
  local tmp=/tmp/redtrace-extras/cairo-ton
  rm -rf "$tmp" && mkdir -p "$tmp"
  case "$TARGETARCH" in
    amd64) gnu_arch=x86_64 ;;
    arm64) gnu_arch=aarch64 ;;
    *) printf 'unsupported architecture: %s\n' "$TARGETARCH" >&2; return 1 ;;
  esac

  fetch "https://github.com/software-mansion/scarb/releases/download/v2.20.0/scarb-v2.20.0-${gnu_arch}-unknown-linux-gnu.tar.gz" "$tmp/scarb.tgz"
  mkdir -p "$tmp/scarb" && tar -xzf "$tmp/scarb.tgz" -C "$tmp/scarb"
  copy_found "$tmp/scarb" scarb scarb

  fetch "https://github.com/foundry-rs/starknet-foundry/releases/download/v0.63.0/starknet-foundry-v0.63.0-${gnu_arch}-unknown-linux-gnu.tar.gz" "$tmp/snfoundry.tgz"
  mkdir -p "$tmp/snfoundry" && tar -xzf "$tmp/snfoundry.tgz" -C "$tmp/snfoundry"
  copy_found "$tmp/snfoundry" snforge snforge
  copy_found "$tmp/snfoundry" sncast sncast

  fetch "https://github.com/starknet-io/starknet-devnet/releases/download/v0.9.2/starknet-devnet-${gnu_arch}-unknown-linux-gnu.tar.gz" "$tmp/starknet-devnet.tgz"
  mkdir -p "$tmp/starknet-devnet" && tar -xzf "$tmp/starknet-devnet.tgz" -C "$tmp/starknet-devnet"
  copy_found "$tmp/starknet-devnet" starknet-devnet starknet-devnet

  npm install -g \
    @ton/blueprint@0.45.0 @tact-lang/compiler@1.6.13 \
    @ton-community/func-js@0.11.0 @ton/sandbox@0.44.0
  rm -rf "$tmp"
}

install_cosmos_substrate() {
  log "installing Cosmos/CosmWasm and Substrate contract test tooling"
  local tmp=/tmp/redtrace-extras/rustup
  apt-get -o Acquire::Retries=5 update
  apt-get -o Acquire::Retries=5 install -y --no-install-recommends protobuf-compiler
  rm -rf /var/lib/apt/lists/*
  export GOMODCACHE="${GOMODCACHE:-$OFFLINE_DIR/go/pkg/mod}"
  export GOPATH="${GOPATH:-$OFFLINE_DIR/go}"
  mkdir -p "$GOMODCACHE" "$GOPATH/bin" "$OFFLINE_DIR/cargo-install" "$tmp"
  if ! has rustup; then
    fetch https://static.rust-lang.org/rustup/dist/x86_64-unknown-linux-gnu/rustup-init "$tmp/rustup-init"
    chmod 0755 "$tmp/rustup-init"
    "$tmp/rustup-init" -y --profile minimal --default-toolchain "$RUST_TOOLCHAIN_VERSION" --no-modify-path
  fi
  # cosmwasm-check 3.0.9 locks Wasmer 5.0.6, whose stack-probe ABI predates
  # Rust 1.97. Pin the contemporary compiler instead of relying on moving
  # `stable`; this also makes the offline Cargo toolchain reproducible.
  rustup toolchain install "$RUST_TOOLCHAIN_VERSION" --profile minimal
  rustup default "$RUST_TOOLCHAIN_VERSION"
  rustup target add --toolchain "$RUST_TOOLCHAIN_VERSION" wasm32-unknown-unknown
  git clone --depth 1 --branch v0.70.3 https://github.com/CosmWasm/wasmd.git "$tmp/wasmd"
  (cd "$tmp/wasmd" && GOBIN="$BIN_DIR" go install ./cmd/wasmd)

  cargo install --locked --root "$OFFLINE_DIR/cargo-install" cosmwasm-check --version 3.0.9
  cargo install --locked --root "$OFFLINE_DIR/cargo-install" cargo-contract --version 5.0.3
  cargo install --locked --root "$OFFLINE_DIR/cargo-install" contracts-node --version 0.42.0
  for command in cosmwasm-check cargo-contract substrate-contracts-node; do
    [[ -x "$OFFLINE_DIR/cargo-install/bin/$command" ]] && ln -sfn "$OFFLINE_DIR/cargo-install/bin/$command" "$BIN_DIR/$command"
  done
  rm -rf "$tmp"
}

build_offline_caches() {
  log "building curated Python, npm/pnpm, Cargo, Go, Maven, Gradle, and Solidity caches"
  local wheelhouse="$OFFLINE_DIR/wheelhouse" npm_cache="$OFFLINE_DIR/npm" tmp=/tmp/redtrace-extras/cache
  rm -rf "$tmp" && mkdir -p "$tmp" "$wheelhouse" "$npm_cache" "$OFFLINE_DIR/pnpm-store"
  "$PYTHON" -m pip download --dest "$wheelhouse" \
    "requests==2.32.5" "PyYAML==6.0.2" "pwntools==4.15.0" \
    "web3==7.6.1" "semgrep==$SEMGREP_VERSION" \
    "inspect-ai==$INSPECT_AI_VERSION" "agentdojo==$AGENTDOJO_VERSION"

  (cd "$npm_cache" && npm pack \
    hardhat@2.22.17 @openzeppelin/contracts@5.4.0 forge-std@1.1.2 \
    @solana/web3.js@1.98.4 @ton/blueprint@0.45.0 @tact-lang/compiler@1.6.13)
  printf '{"dependencies":{"@openzeppelin/contracts":"5.4.0","@solana/web3.js":"1.98.4","@ton/blueprint":"0.45.0"}}\n' > "$tmp/package.json"
  (cd "$tmp" && pnpm fetch --store-dir "$OFFLINE_DIR/pnpm-store")

  mkdir -p "$DATA_DIR/solidity-libs"
  git clone --branch v1.9.7 --depth 1 https://github.com/foundry-rs/forge-std.git "$DATA_DIR/solidity-libs/forge-std"
  git clone --branch v5.4.0 --depth 1 https://github.com/OpenZeppelin/openzeppelin-contracts.git "$DATA_DIR/solidity-libs/openzeppelin-contracts"
  rm -rf "$DATA_DIR/solidity-libs/forge-std/.git" "$DATA_DIR/solidity-libs/openzeppelin-contracts/.git"

  if has mvn; then
    MAVEN_OPTS="-Dmaven.repo.local=$OFFLINE_DIR/maven" mvn -q dependency:get -Dartifact=org.apache.commons:commons-lang3:3.17.0
  fi
  if has gradle; then
    mkdir -p "$tmp/gradle"
    printf 'repositories { mavenCentral() }\nconfigurations { offlineCache }\ndependencies { offlineCache "org.apache.commons:commons-lang3:3.17.0" }\ntasks.register("cacheDeps") { doLast { configurations.offlineCache.files.each { println it } } }\n' > "$tmp/gradle/build.gradle"
    GRADLE_USER_HOME="$OFFLINE_DIR/gradle" gradle -q -p "$tmp/gradle" cacheDeps
  fi
  rm -rf "$tmp"
}

cache_grype_db() {
  log "caching Grype vulnerability database"
  mkdir -p "$DATA_DIR/grype-db"
  GRYPE_DB_CACHE_DIR="$DATA_DIR/grype-db" grype db update
  GRYPE_DB_CACHE_DIR="$DATA_DIR/grype-db" GRYPE_DB_AUTO_UPDATE=false grype db status
}

case "$PROFILE" in
  analysis-ai) install_analysis_ai ;;
  solana-move) install_solana_move ;;
  cairo-ton) install_cairo_ton ;;
  cosmos-substrate) install_cosmos_substrate ;;
  caches) build_offline_caches; cache_grype_db ;;
  all)
    install_analysis_ai
    install_solana_move
    install_cairo_ton
    install_cosmos_substrate
    build_offline_caches
    cache_grype_db
    ;;
  *) printf 'usage: %s {analysis-ai|solana-move|cairo-ton|cosmos-substrate|caches|all}\n' "$0" >&2; exit 2 ;;
esac
