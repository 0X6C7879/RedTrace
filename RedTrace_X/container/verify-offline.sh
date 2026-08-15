#!/usr/bin/env bash
# Offline smoke test (spec §27). Run inside a `--network none` container.
# Verifies the headless benchmark runtime can start without any network access.
set -Eeuo pipefail

fail=0
check() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING: $1"; fail=1; }; }
redtrace_py() { (cd /opt/redtrace/app && uv run --project redtrace python -c "$1" >/dev/null 2>&1) \
  || { echo "MISSING redtrace py: $1"; fail=1; }; }
sec_py() { /opt/redtrace/venvs/security/bin/python -c "import $1" >/dev/null 2>&1 \
  || { echo "MISSING security py: $1"; fail=1; }; }
qiling_py() { /opt/redtrace/venvs/qiling/bin/python -c "import $1" >/dev/null 2>&1 \
  || { echo "MISSING qiling py: $1"; fail=1; }; }

# -- RedTrace core -----------------------------------------------------------
echo "== RedTrace core =="
check uv
check python3
redtrace_py "import fastapi, uvicorn, yaml, click"
(cd /opt/redtrace/app && uv run --project redtrace redtrace --help >/dev/null 2>&1) \
  || { echo "WARN: redtrace CLI --help failed"; fail=1; }

# -- Agent CLIs (basic startup only; model call is a separate check) --------
echo "== Agent CLIs =="
for t in claude codex pi; do check "$t"; done
claude --version >/dev/null 2>&1 || { echo "WARN: claude --version failed"; }
codex --version >/dev/null 2>&1 || { echo "WARN: codex --version failed"; }
pi --version >/dev/null 2>&1 || { echo "WARN: pi --version failed"; }

# -- Web ---------------------------------------------------------------------
echo "== Web =="
for t in nmap socat httpx ffuf feroxbuster dirsearch arjun katana whatweb \
         wafw00f nuclei nikto sqlmap dalfox commix sstimap jwt_tool grpcurl \
         websocat jq sqlite3 semgrep gitleaks syft grype john hashcat; do
  check "$t"
done

# -- Binary ------------------------------------------------------------------
echo "== Binary =="
for t in file strings readelf objdump patchelf checksec binwalk upx radare2 \
         gdb strace ltrace ROPgadget ropper one_gadget seccomp-tools \
         qemu-x86_64 qemu-aarch64-static qemu-arm-static qemu-mips-static \
         qemu-riscv64-static RsaCtfTool jadx apktool pwndbg pwninit \
         uncompyle6 pycdc wasm-tools ilspycmd; do
  check "$t"
done
sec_py angr
sec_py yara
qiling_py qiling

# -- AI ----------------------------------------------------------------------
echo "== AI =="
for t in promptfoo mitmproxy promptmap2 inspect agent-threat-bench; do check "$t"; done
sec_py inspect_ai
sec_py inspect_evals
sec_py agentdojo

# -- Blockchain --------------------------------------------------------------
echo "== Blockchain =="
for t in forge cast anvil chisel solc solc-select slither crytic-compile \
         echidna halmos aderyn heimdall myth solana solana-keygen \
         solana-test-validator cargo-build-sbf anchor sui aptos move scarb \
         snforge sncast starknet-devnet blueprint tact wasmd cosmwasm-check \
         cargo-contract substrate-contracts-node; do check "$t"; done
sec_py web3
sec_py eth_abi

# -- Offline data ------------------------------------------------------------
echo "== Offline data =="
for d in nuclei-templates seclists payloads-all-the-things semgrep-rules exploitdb; do
  [[ -d "/opt/redtrace/data/$d" ]] || { echo "MISSING data: $d"; fail=1; }
done
for d in wheelhouse npm pnpm-store cargo go maven gradle; do
  [[ -d "/opt/redtrace/offline/$d" ]] || { echo "MISSING offline cache: $d"; fail=1; }
done
[[ -d /opt/redtrace/data/solidity-libs/forge-std ]] || { echo "MISSING forge-std"; fail=1; }
[[ -d /opt/redtrace/data/solidity-libs/openzeppelin-contracts ]] || { echo "MISSING OpenZeppelin Contracts"; fail=1; }
GRYPE_DB_CACHE_DIR=/opt/redtrace/data/grype-db GRYPE_DB_AUTO_UPDATE=false \
  grype db status >/dev/null 2>&1 || { echo "MISSING Grype offline DB"; fail=1; }
command -v searchsploit >/dev/null 2>&1 || echo "WARN: searchsploit missing"

# -- solc versions -----------------------------------------------------------
echo "== solc versions =="
[[ -d /root/.solc-select/artifacts ]] || { echo "MISSING solc artifacts"; fail=1; }

# -- Ghidra / angr / Qiling --------------------------------------------------
echo "== Ghidra headless =="
check analyzeHeadless

if (( fail )); then echo "OFFLINE VERIFY FAILED"; exit 1; fi
echo "offline verify ok"
