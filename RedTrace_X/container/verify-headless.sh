#!/usr/bin/env bash
# Headless 测评镜像冒烟测试（对应《RedTrace_X-docker构建.md》构建质量门）。
# 在 `--network none` 容器中运行：验证离线状态下核心链路可用，
# 且被禁用的组件（Claude/Codex/Docker/Playwright/Chromium/多链工具）不存在。
set -Eeuo pipefail

# login shell 会重置 PATH，这里显式带上镜像内的 venv/工具路径
export PATH="/opt/redtrace/app/redtrace/.venv/bin:/opt/redtrace/venvs/security/bin:/usr/local/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin:$PATH"

fail=0
check() { command -v "$1" >/dev/null 2>&1 || { echo "MISSING: $1"; fail=1; }; }
absent() { command -v "$1" >/dev/null 2>&1 && { echo "FORBIDDEN PRESENT: $1"; fail=1; } || true; }
redtrace_py() { (cd /opt/redtrace/app && uv run --project redtrace python -c "$1" >/dev/null 2>&1) \
  || { echo "MISSING redtrace py: $1"; fail=1; }; }
sec_py() { /opt/redtrace/venvs/security/bin/python -c "import $1" >/dev/null 2>&1 \
  || { echo "MISSING security py: $1"; fail=1; }; }

# -- RedTrace core -----------------------------------------------------------
echo "== RedTrace core =="
check uv
check python3
redtrace_py "import fastapi, uvicorn, yaml, click"
(cd /opt/redtrace/app && uv run --project redtrace redtrace --help >/dev/null 2>&1) \
  || { echo "FAIL: redtrace CLI --help"; fail=1; }

# -- Agent / RTK -------------------------------------------------------------
echo "== Agent =="
check pi
pi --version >/dev/null 2>&1 || { echo "WARN: pi --version failed"; }
check rtk
rtk --version >/dev/null 2>&1 || { echo "FAIL: rtk --version"; fail=1; }

# -- Web ---------------------------------------------------------------------
echo "== Web =="
for t in nmap socat httpx ffuf feroxbuster dirsearch arjun katana \
         wafw00f sqlmap dalfox commix sstimap jwt_tool grpcurl \
         websocat jq sqlite3 semgrep gitleaks curl wget \
         git rg; do
  check "$t"
done

# -- Binary ------------------------------------------------------------------
echo "== Binary =="
for t in file strings readelf objdump patchelf checksec binwalk upx radare2 \
         gdb strace ltrace ROPgadget ropper one_gadget seccomp-tools \
         qemu-x86_64 pwndbg uncompyle6 pycdc; do
  check "$t"
done
sec_py angr

# -- AI ----------------------------------------------------------------------
echo "== AI =="
for t in promptfoo; do check "$t"; done

# -- Blockchain（仅 EVM；chisel 为 Foundry 链上调试器，非隧道工具） ---------
echo "== Blockchain =="
for t in forge cast anvil chisel slither crytic-compile \
         echidna aderyn heimdall; do check "$t"; done
sec_py web3
sec_py eth_abi

# -- Skills（单一副本 + Pi 原生目录 symlink） --------------------------------
echo "== Skills =="
[[ -d /opt/redtrace/app/skills ]] || { echo "MISSING skills dir"; fail=1; }
skill_count="$(find /opt/redtrace/app/skills -mindepth 1 -maxdepth 1 -type d | wc -l)"
(( skill_count > 0 )) || { echo "FAIL: no skills installed"; fail=1; }
[[ -L /root/.pi/agent/skills ]] || { echo "MISSING /root/.pi/agent/skills symlink"; fail=1; }
echo "skills installed: $skill_count"

# -- Offline data（语料库已按用户要求全部移除，仅验 pwndbg/jwt_tool） --------
echo "== Offline data =="
[[ -d /opt/redtrace/data/pwndbg ]] || { echo "MISSING data: pwndbg"; fail=1; }
[[ -d /opt/redtrace/data/jwt_tool ]] || { echo "MISSING data: jwt_tool"; fail=1; }

# -- Ghidra（已按用户要求移除） --------------------------------------------
echo "== Ghidra =="
absent analyzeHeadless

# -- 禁用组件必须不存在 -------------------------------------------------------
echo "== Forbidden components =="
for t in claude codex docker chromium playwright grype solana sui aptos scarb \
         snforge sncast wasmd cargo rustc go mvn gradle ligolo-ng \
         aws smbclient ldapsearch proxychains4 apktool jadx promptmap2 \
         msfconsole sliver gobuster syft mitmproxy frida ilspycmd dotnet \
         nikto whatweb nuclei john hashcat halmos myth RsaCtfTool solc \
         gcc clang javac; do
  absent "$t"
done
# 隧道/AD 域工具不安装（ligolo agent/proxy 以通用名存在，故按文件判）
[[ -e /usr/local/bin/agent || -e /usr/local/bin/proxy ]] && \
  { echo "FORBIDDEN PRESENT: ligolo-ng agent/proxy"; fail=1; } || true

if (( fail )); then echo "HEADLESS VERIFY FAILED"; exit 1; fi
echo "headless verify ok"
