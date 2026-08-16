# ============================================================================
# RedTrace_X Benchmark 单镜像（Headless / Pi-only，local mode）
#
# 依据《RedTrace_X-docker构建.md》+ 用户裁剪清单：
#   - 只保留 Pi Agent（无 Claude/Codex/Mock/Docker-in-Docker/无 MCP 扩展）
#   - Blockchain 只保留 EVM（无多链 SDK）；solc 多版本缓存/John/hashcat 移除
#   - 离线语料库（nuclei-templates/SecLists/PayloadsAllTheThings/semgrep-rules）
#     与 nuclei 本体、Grype/Grype DB、syft、ExploitDB 均不保留
#   - Python 环境只留两套：/opt/redtrace/app/redtrace/.venv 与
#     /opt/redtrace/venvs/security（halmos/RsaCtfTool/qiling/mythril 已删）
#   - AD/Kerberos/SMB 横向/Pivot/Cloud CLI与SDK/移动端/取证/无线/ICS/浏览器/
#   - 隧道工具/大型攻击框架 均不安装；保留 Web/Binary/Pwn/EVM/AI 核心
#   - Ghidra/JDK 移除；收尾 purge 全部构建期编译器（go/cmake/gcc）
#
# 启动即自动跑分：CMD = bash start.sh（渲染配置 → 起 Headless API →
# Dispatcher → benchctl run → 结束后退出）。
#
# 构建（代理默认走宿主机 7890；宿主机网络下 127.0.0.1 与
# host.docker.internal 均可达）：
#   docker build --network=host \
#     --build-arg BUILD_PROXY=http://127.0.0.1:7890 \
#     -t redtrace-x-benchmark:latest .
# ============================================================================

# --- Build args（版本全部 pin，禁止 latest）--------------------------------
ARG PI_CODING_AGENT_VERSION=0.83.0
ARG NODE_VERSION=22.19.0
ARG RTK_VERSION=0.45.0
ARG KALI_MIRROR=http://mirrors.aliyun.com/kali
ARG JWT_TOOL_COMMIT=
# 构建期代理：Docker Desktop 下可用 http://host.docker.internal:7890；
# --network=host 时可用 http://127.0.0.1:7890。仅构建期生效，不写入镜像。
ARG BUILD_PROXY=http://host.docker.internal:7890

FROM kalilinux/kali-rolling:latest

ARG TARGETARCH
ARG PI_CODING_AGENT_VERSION
ARG NODE_VERSION
ARG RTK_VERSION
ARG KALI_MIRROR
ARG JWT_TOOL_COMMIT
ARG BUILD_PROXY

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    PYTHONUNBUFFERED=1
RUN rm -f /etc/apt/sources.list.d/* && \
    printf 'deb %s kali-rolling main contrib non-free non-free-firmware\n' \
      "$KALI_MIRROR" > /etc/apt/sources.list

# ============================================================================
# 0. 基础运行时 + 构建期编译器。maven/gradle/rustc/cargo 不再安装
#    （缓存构建已删除）；go/cmake/ninja 仅为构建期服务，收尾 purge。
# ============================================================================
RUN apt-get -o Acquire::Retries=5 update && \
    apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    ca-certificates curl wget git unzip xz-utils sudo \
    build-essential cmake \
    python3 python3-venv python3-pip python3-dev \
    ruby ruby-dev golang-go perl \
    libffi-dev libssl-dev libgmp-dev libmpfr-dev libmpc-dev zlib1g-dev \
    jq ripgrep file procps iproute2 zstd tree \
    && rm -rf /var/lib/apt/lists/*

# uv（与应用 Dockerfile 相同的固定版本）
COPY --from=ghcr.io/astral-sh/uv:0.8.9 /uv /uvx /usr/local/bin/

# ============================================================================
# 1. Web + Binary 系统包（qemu-user only，无 qemu-system）。
#    AD/Kerberos/SMB 横向/Pivot/移动端/取证类工具均不安装。
# ============================================================================
RUN apt-get -o Acquire::Retries=5 update && \
    apt-get -o Acquire::Retries=5 install -y --no-install-recommends \
    gdb radare2 binutils binwalk nmap whois \
    bind9-dnsutils strace ltrace upx-ucl dirsearch yq \
    netcat-openbsd p7zip-full patchelf valgrind qemu-user \
    afl++ checksec sqlite3 snmp ftp telnet socat \
    libxml2-utils xmlstarlet openssh-client \
    && rm -rf /var/lib/apt/lists/*

# ============================================================================
# 2. Node.js（>= 22）。pnpm 不再安装（离线 pnpm store 已删除）。
# ============================================================================
RUN case "$TARGETARCH" in amd64) node_arch=x64 ;; arm64) node_arch=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac && \
    curl --retry 8 --retry-delay 3 --retry-all-errors -fsSL \
      "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
      -o /tmp/node.tar.xz && \
    tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 && \
    rm -f /tmp/node.tar.xz

# ============================================================================
# 3. Pi Coding-Agent CLI（唯一 Agent）。pi-mcp-extension 按用户要求不安装；
#    镜像内无任何 MCP 配置。npm 走国内镜像源（无需代理），带重试。
# ============================================================================
RUN npm config set registry https://registry.npmmirror.com && \
    npm config set fetch-retries 5 && \
    npm config set fetch-retry-mintimeout 3000 && \
    npm config set fetch-retry-maxtimeout 15000 && \
    npm config set fetch-timeout 600000 && \
    i=0; until npm install -g "@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}" --ignore-scripts; do \
      i=$((i+1)); [ "$i" -ge 6 ] && exit 1; echo "npm install pi retry $i" >&2; sleep 10; \
    done

# ============================================================================
# 3b. RTK（Rust Token Killer，rtk-ai/rtk）—— 预编译 musl 静态二进制，
#     不把 Rust/Cargo 带入 Runtime。
# ============================================================================
RUN case "$TARGETARCH" in \
      amd64) rtk_asset="rtk-x86_64-unknown-linux-musl.tar.gz" ;; \
      arm64) rtk_asset="rtk-aarch64-unknown-linux-gnu.tar.gz" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac && \
    curl --retry 8 --retry-delay 3 --retry-all-errors -fsSL \
      "https://github.com/rtk-ai/rtk/releases/download/v${RTK_VERSION}/${rtk_asset}" \
      -o /tmp/rtk.tar.gz && \
    tar -xzf /tmp/rtk.tar.gz -C /usr/local/bin && \
    chmod 0755 /usr/local/bin/rtk && rm -f /tmp/rtk.tar.gz && \
    rtk --version && \
    { HOME=/root RTK_TELEMETRY_DISABLED=1 rtk init -g --agent pi || \
      echo "WARN: rtk init --agent pi skipped (non-fatal)"; }

# ============================================================================
# 4. Python 工具链 —— 版本与原 Dockerfile.benchmark 完全一致。
# ============================================================================
RUN uv venv --python 3.12 /opt/redtrace/venvs/security && \
    /opt/redtrace/venvs/security/bin/python -m ensurepip --upgrade && \
    /opt/redtrace/venvs/security/bin/python -m pip install --no-cache-dir \
    pwntools==4.15.0 pycryptodome==3.23.0 z3-solver==4.13.0.0 sympy==1.14.0 \
    gmpy2==2.3.0 cysignals==1.12.6 fpylll==0.6.4 py_ecc==8.0.0 pycparser==2.23 \
    angr==9.2.193 ropper==1.13.13 ROPgadget==7.7 \
    pefile==2024.8.26 capstone==5.0.3 unicorn==2.1.2 keystone-engine==0.9.2 \
    pyelftools==0.32 lief==0.17.6 \
    requests==2.32.5 sqlmap==1.10.3 arjun==2.2.2 wafw00f==2.2.0 \
    web3==6.20.4 slither-analyzer==0.11.2 \
    crytic-compile==0.3.10 \
    && rm -rf /root/.cache/pip

# Cloud CLI/SDK（awscli/boto3/Azure SDK）按用户要求不安装。
# 仅保留 RedTrace 自身 venv 与 Security 主 venv 两套 Python 环境；
# halmos/RsaCtfTool/qiling/mythril 独立 venv 均不创建。

# Ruby gems（pwn 辅助）
RUN gem install one_gadget seccomp-tools --no-document

# ============================================================================
# 5. Web Go 工具 —— pin 版本，go install 构建；golang-go 收尾 purge。
# ============================================================================
RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" \
      GOPROXY="https://goproxy.cn,$BUILD_PROXY,direct" \
      GOCACHE=/tmp/gocache GOPATH=/tmp/gopath && \
    for module in \
      github.com/projectdiscovery/httpx/cmd/httpx@v1.6.10 \
      github.com/ffuf/ffuf/v2@v2.1.0 \
      github.com/assetnote/kiterunner/cmd/kr@v1.0.2 \
      github.com/fullstorydev/grpcurl/cmd/grpcurl@v1.9.3; \
    do GOBIN=/usr/local/bin go install "$module"; done && \
    rm -rf /tmp/gocache /tmp/gopath

RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    curl() { command curl --retry 8 --retry-delay 3 --retry-all-errors "$@"; } && \
    case "$TARGETARCH" in \
      amd64) ferox_arch=x86_64; websocat_asset=websocat_max.x86_64-unknown-linux-musl ;; \
      arm64) ferox_arch=aarch64; websocat_asset=websocat_max.aarch64-unknown-linux-musl ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/epi052/feroxbuster/releases/download/v2.11.0/${ferox_arch}-linux-feroxbuster.zip" -o /tmp/feroxbuster.zip && \
    unzip -j /tmp/feroxbuster.zip feroxbuster -d /usr/local/bin && \
    curl -fsSL "https://github.com/vi/websocat/releases/download/v1.14.0/${websocat_asset}" -o /usr/local/bin/websocat && \
    chmod 0755 /usr/local/bin/feroxbuster /usr/local/bin/websocat && \
    rm -f /tmp/feroxbuster.zip

# --- Web 二进制（pin release）；grype/Grype DB/syft 均已删除 ----------------
# curl 统一加重试，抵御代理隧道偶发中断（exit 56）
RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    curl() { command curl --retry 8 --retry-delay 3 --retry-all-errors "$@"; } && \
    case "$TARGETARCH" in amd64|arm64) asset_arch="$TARGETARCH" ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac && \
    curl -fsSL "https://github.com/projectdiscovery/katana/releases/download/v1.5.0/katana_1.5.0_linux_${asset_arch}.zip" -o /tmp/katana.zip && \
    unzip -qo /tmp/katana.zip katana -d /usr/local/bin && \
    curl -fsSL "https://github.com/hahwul/dalfox/releases/download/v2.12.0/dalfox-linux-${asset_arch}.tar.gz" -o /tmp/dalfox.tgz && \
    tar -xzf /tmp/dalfox.tgz -C /usr/local/bin && \
    mv "/usr/local/bin/dalfox-linux-${asset_arch}" /usr/local/bin/dalfox && \
    rm -f /tmp/katana.zip /tmp/dalfox.tgz

RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    retry() { local i=0; until "$@"; do i=$((i+1)); [ "$i" -ge 8 ] && return 1; echo "retry $i: $*" >&2; sleep 5; done; } && \
    /opt/redtrace/venvs/security/bin/python -m pip install --no-cache-dir \
    "git+https://github.com/commixproject/commix.git@785843cfb7f50444582d4255dc95636fd9d2aec0" && \
    ln -sfn /opt/redtrace/venvs/security/bin/commix /usr/local/bin/commix && \
    retry git clone --filter=blob:none https://github.com/vladko312/SSTImap.git /opt/redtrace/tools/sstimap && \
    git -C /opt/redtrace/tools/sstimap checkout d4f09055b15967b0e2265f20eb348a7ec2f25a2c && \
    /opt/redtrace/venvs/security/bin/python -m pip install --no-cache-dir -r /opt/redtrace/tools/sstimap/requirements.txt && \
    sed -i '1c #!/opt/redtrace/venvs/security/bin/python' /opt/redtrace/tools/sstimap/sstimap.py && \
    chmod 0755 /opt/redtrace/tools/sstimap/sstimap.py && \
    ln -sfn /opt/redtrace/tools/sstimap/sstimap.py /usr/local/bin/sstimap && \
    rm -rf /opt/redtrace/tools/sstimap/.git

# jwt_tool：单脚本工具，pin commit
RUN [ -n "$JWT_TOOL_COMMIT" ] || { echo "ERROR: JWT_TOOL_COMMIT build-arg is empty (pin it)" >&2; exit 1; } && \
    export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    retry() { local i=0; until "$@"; do i=$((i+1)); [ "$i" -ge 8 ] && return 1; echo "retry $i: $*" >&2; sleep 5; done; } && \
    retry git clone https://github.com/ticarpi/jwt_tool.git /opt/redtrace/data/jwt_tool && \
    git -C /opt/redtrace/data/jwt_tool checkout "$JWT_TOOL_COMMIT" && \
    /opt/redtrace/venvs/security/bin/python -m pip install --no-cache-dir -r /opt/redtrace/data/jwt_tool/requirements.txt && \
    ln -sfn /opt/redtrace/data/jwt_tool/jwt_tool.py /usr/local/bin/jwt_tool && \
    rm -rf /opt/redtrace/data/jwt_tool/.git

# ============================================================================
# 6. Blockchain 二进制（仅 EVM）：Foundry / Echidna / Aderyn / heimdall。
#    Solana/Sui/Aptos/Cairo/TON/Cosmos/Substrate/Hardhat 全部不安装。
# ============================================================================
RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    curl() { command curl --retry 8 --retry-delay 3 --retry-all-errors "$@"; } && \
    case "$TARGETARCH" in \
      amd64) asset_arch=amd64; rust_arch=x86_64 ;; \
      arm64) asset_arch=arm64; rust_arch=aarch64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac && \
    curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/v1.2.0/foundry_v1.2.0_linux_${asset_arch}.tar.gz" -o /tmp/foundry.tgz && \
    tar -xzf /tmp/foundry.tgz -C /usr/local/bin && \
    curl -fsSL "https://github.com/crytic/echidna/releases/download/v2.3.3/echidna-2.3.3-${rust_arch}-linux.tar.gz" -o /tmp/echidna.tgz && \
    tar -xzf /tmp/echidna.tgz -C /usr/local/bin echidna && \
    curl -fsSL "https://github.com/Cyfrin/aderyn/releases/download/aderyn-v0.6.8/aderyn-${rust_arch}-unknown-linux-gnu.tar.xz" -o /tmp/aderyn.tar.xz && \
    tar -xJf /tmp/aderyn.tar.xz -C /usr/local/bin --strip-components=1 "aderyn-${rust_arch}-unknown-linux-gnu/aderyn" && \
    curl -fsSL "https://github.com/Jon-Becker/heimdall-rs/releases/download/0.9.3/heimdall-linux-${asset_arch}" -o /usr/local/bin/heimdall && \
    chmod +x /usr/local/bin/heimdall && \
    rm -f /tmp/foundry.tgz /tmp/echidna.tgz /tmp/aderyn.tar.xz

# ============================================================================
# 7. solc 多版本离线缓存与 john/hashcat 已按用户要求移除。
# ============================================================================

# ============================================================================
# 8. AI 红队 CLI：promptfoo。hardhat/promptmap2 不装；
#    inspect-ai/inspect-evals/AgentDojo 按文档禁止安装。
#    npm 走国内镜像源（无需代理），带重试；registry.npmjs.org 隧道不稳定。
# ============================================================================
RUN npm config set registry https://registry.npmmirror.com && \
    i=0; until PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g promptfoo@0.104.0; do \
      i=$((i+1)); [ "$i" -ge 6 ] && exit 1; echo "npm install promptfoo retry $i" >&2; sleep 10; \
    done && \
    rm -rf /root/.npm

RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    /opt/redtrace/venvs/security/bin/python -m pip install --no-cache-dir \
    "semgrep==1.173.0" "uncompyle6==3.9.3" && \
    ln -sfn /opt/redtrace/venvs/security/bin/semgrep /usr/local/bin/semgrep && \
    ln -sfn /opt/redtrace/venvs/security/bin/uncompyle6 /usr/local/bin/uncompyle6

# ============================================================================
# 8b. 扩展分析工具（原 install-benchmark-extras.sh analysis-ai 的裁剪内联：
#     去掉 inspect/agentdojo/wasm-tools/pwninit）。
# ============================================================================
RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    case "$TARGETARCH" in \
      amd64) release_arch=x64; portable_arch=x86_64 ;; \
      arm64) release_arch=arm64; portable_arch=arm64 ;; \
      *) echo "unsupported arch: $TARGETARCH" >&2; exit 1 ;; esac && \
    curl -fL --retry 8 --retry-delay 2 --retry-all-errors \
      "https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_${release_arch}.tar.gz" -o /tmp/gitleaks.tgz && \
    tar -xzf /tmp/gitleaks.tgz -C /tmp && install -m 0755 /tmp/gitleaks /usr/local/bin/gitleaks && \
    curl -fL --retry 8 --retry-delay 2 --retry-all-errors \
      "https://github.com/pwndbg/pwndbg/releases/download/2026.07.29/pwndbg_2026.07.29_${portable_arch}-portable.tar.xz" -o /tmp/pwndbg.tar.xz && \
    mkdir -p /opt/redtrace/data/pwndbg && \
    tar -xJf /tmp/pwndbg.tar.xz -C /opt/redtrace/data/pwndbg --strip-components=1 && \
    pwndbg_bin="$(find /opt/redtrace/data/pwndbg -type f -name pwndbg -print -quit)" && \
    install -m 0755 "$pwndbg_bin" /usr/local/bin/pwndbg && \
    rm -f /tmp/gitleaks.tgz /tmp/gitleaks /tmp/pwndbg.tar.xz

# pycdc：cmake 构建后只留二进制（cmake/ninja 收尾 purge）
RUN export http_proxy="$BUILD_PROXY" https_proxy="$BUILD_PROXY" \
      HTTP_PROXY="$BUILD_PROXY" HTTPS_PROXY="$BUILD_PROXY" && \
    retry() { local i=0; until "$@"; do i=$((i+1)); [ "$i" -ge 8 ] && return 1; echo "retry $i: $*" >&2; sleep 5; done; } && \
    retry git clone https://github.com/zrax/pycdc.git /tmp/pycdc && \
    git -C /tmp/pycdc checkout b4289760970dbc399684f1e155ec6d1ea1cc787e && \
    cmake -S /tmp/pycdc -B /tmp/pycdc/build -DCMAKE_BUILD_TYPE=Release && \
    cmake --build /tmp/pycdc/build --parallel "$(nproc)" && \
    install -m 0755 /tmp/pycdc/build/pycdc /usr/local/bin/pycdc && \
    install -m 0755 /tmp/pycdc/build/pycdas /usr/local/bin/pycdas && \
    rm -rf /tmp/pycdc

# dotnet/ilspycmd 安装异常（exit 134），按用户要求整体移除。

# ============================================================================
# 9. Ghidra 已按用户要求移除（JDK 一并移除）。
# ============================================================================

# ============================================================================
# 10. 离线数据语料（nuclei-templates/SecLists/PayloadsAllTheThings/
#     semgrep-rules）已按用户要求全部移除。
# ============================================================================

# ============================================================================
# 11. venv 工具 → PATH 快捷方式
# ============================================================================
RUN ln -sfn /opt/redtrace/venvs/security/bin/sqlmap /usr/local/bin/sqlmap && \
    ln -sfn /opt/redtrace/venvs/security/bin/arjun /usr/local/bin/arjun && \
    ln -sfn /opt/redtrace/venvs/security/bin/wafw00f /usr/local/bin/wafw00f && \
    ln -sfn /opt/redtrace/venvs/security/bin/slither /usr/local/bin/slither && \
    ln -sfn /opt/redtrace/venvs/security/bin/crytic-compile /usr/local/bin/crytic-compile && \
    ln -sfn /opt/redtrace/venvs/security/bin/ROPgadget /usr/local/bin/ROPgadget && \
    ln -sfn /opt/redtrace/venvs/security/bin/ropper /usr/local/bin/ropper

# ============================================================================
# 12. 复制应用（headless runtime + bench + skills 白名单）。
#     RedTrace 以 REDTRACE_ROOT=/opt/redtrace/app 解析 skills/mcp/plugins。
# ============================================================================
RUN mkdir -p /opt/redtrace/app /opt/redtrace/app/plugins /opt/redtrace/app/mcp \
    /data/redtrace
COPY redtrace /opt/redtrace/app/redtrace
COPY bench /opt/redtrace/app/bench
COPY start.sh start-redtrace.sh redtrace.yaml.template /opt/redtrace/app/
COPY container/toolchain-manifest.py container/skill-tool-check.py \
     container/verify-offline.sh container/verify-headless.sh \
     container/install-benchmark-extras.sh container/pi-noop-extension.js \
     /opt/redtrace/app/container/
COPY skills /opt/redtrace/app/skills-full

# Skills 白名单裁剪：浏览器/移动端/取证/隐写/无线/ICS/AD 域/文档类全部移除
RUN cd /opt/redtrace/app/skills-full && \
    for s in brave-search browser-automation playwright browser-extension-reverse \
             competition-browser-persistence cloud-k8s competition-agent-cloud \
             competition-cloud-metadata-path competition-k8s-control-plane \
             windows-ad attack-chain competition-ad-certificate-abuse \
             competition-kerberos-delegation \
             competition-lsass-ticket-material competition-relay-coercion-chain \
             competition-identity-windows competition-windows-pivot \
             competition-linux-credential-pivot identity-federation \
             digital-forensics competition-forensic-timeline competition-stego-media \
             competition-pcap-protocol ot-ics radio-sdr wifi-wireless \
             diagram-generator docs-generator threat-hunting \
             apk-reverse mobile-reverse competition-android-hooking \
             competition-ios-runtime ctf-sandbox-orchestrator; do \
      rm -rf "$s"; \
    done && \
    mkdir -p /opt/redtrace/app/skills && \
    mv /opt/redtrace/app/skills-full/* /opt/redtrace/app/skills/ && \
    rmdir /opt/redtrace/app/skills-full

RUN cd /opt/redtrace/app/skills && rm -rf continuous-learning continuous-learning-v2 proactive-agent self-improving--proactive-agent 2>/dev/null || true

# Pi 原生 skills 目录零拷贝指向同一份（文档要求 /root/.pi/agent/skills 唯一副本）
RUN mkdir -p /root/.pi/agent && \
    ln -sfn /opt/redtrace/app/skills /root/.pi/agent/skills

# ============================================================================
# 13. 从 pin 的 lock 构建 RedTrace Python 环境
# ============================================================================
RUN cd /opt/redtrace/app && \
    uv sync --frozen --project redtrace --no-install-project -i https://mirrors.aliyun.com/pypi/simple/ && \
    uv sync --frozen --project redtrace -i https://mirrors.aliyun.com/pypi/simple/

# ============================================================================
# 14. 收尾裁剪：构建期编译器全部 purge（含 gcc/clang/llvm，用户要求；
#     flatten 后这些层不进入最终镜像），各类缓存清空。
# ============================================================================
RUN apt-get purge -y golang-go cmake build-essential \
      python3-dev ruby-dev \
      libffi-dev libssl-dev libgmp-dev libmpfr-dev libmpc-dev zlib1g-dev && \
    apt-get autoremove -y --purge && \
    rm -rf /var/lib/apt/lists/* /root/.cache /root/.npm /root/.gem \
           /tmp/* /var/tmp/* && \
    mkdir -p /tmp

# ============================================================================
# 15. 构建期冒烟测试（只验存在的核心链路；禁用组件检查交给
#     container/verify-headless.sh 离线验证）。PATH 前置 venv bin。
# ============================================================================
RUN export PATH="/opt/redtrace/venvs/security/bin:$PATH" && \
    pi --version && \
    rtk --version && \
    cd /opt/redtrace/app && uv run --project redtrace redtrace --help >/dev/null && \
    uv run --project redtrace python -c "import fastapi, uvicorn, yaml, click" && \
    test -x /usr/local/bin/httpx && \
    gdb --version | head -1 && \
    forge --version && slither --version && \
    rm -rf /root/.solc-select /usr/local/bin/solc /opt/redtrace/venvs/security/bin/solc

# ============================================================================
# 16. 运行环境 + 入口。/opt/redtrace 为只读能力区；/data/redtrace 承接增长。
# ============================================================================
ENV PATH="/opt/redtrace/app/redtrace/.venv/bin:/usr/local/bin:/opt/redtrace/venvs/security/bin:${PATH}" \
    RTK_TELEMETRY_DISABLED=1 \
    REDTRACE_PI_MCP_EXTENSION=/opt/redtrace/app/container/pi-noop-extension.js \
    REDTRACE_ROOT=/opt/redtrace/app \
    REDTRACE_DATA_DIR=/opt/redtrace/data \
    REDTRACE_MANAGED_DIR=/data/redtrace

WORKDIR /opt/redtrace/app

CMD ["bash", "start.sh"]
