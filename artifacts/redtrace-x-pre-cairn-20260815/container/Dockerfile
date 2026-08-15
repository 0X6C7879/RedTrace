FROM kalilinux/kali-rolling:latest

ARG TARGETARCH
ARG CODEX_VERSION=0.146.0
ARG CLAUDE_CODE_VERSION=2.1.220
ARG PI_CODING_AGENT_VERSION=0.83.0
ARG PLAYWRIGHT_CLI_VERSION=0.1.17
ARG CODEGRAPH_VERSION=1.5.0

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    apt-get -o Acquire::Retries=5 update && \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 \
    install -y --no-install-recommends ca-certificates

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    sed -i 's|http://http.kali.org|https://http.kali.org|g' \
    /etc/apt/sources.list.d/kali.sources && \
    apt-get -o Acquire::Retries=5 update && \
    DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
    install -y --no-install-recommends \
    kali-linux-core sudo curl wget git unzip xz-utils \
    build-essential pkg-config cmake ninja-build swig liblzma-dev \
    python3 python3-dev python3-pip python3-venv \
    libffi-dev libssl-dev libgmp-dev libmpfr-dev libmpc-dev zlib1g-dev \
    openjdk-21-jdk-headless ruby ruby-dev golang-go nodejs npm jq \
    fd-find ripgrep

RUN useradd -m -s /bin/bash kali && \
    echo "kali ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER kali

RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    sudo apt-get -o Acquire::Retries=5 update && \
    sudo DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
    install -y --no-install-recommends \
    gdb radare2 binutils binwalk foremost libimage-exiftool-perl tshark sleuthkit \
    ffmpeg steghide testdisk john pcapfix nmap whois bind9-dnsutils hashcat \
    strace ltrace imagemagick apktool upx-ucl qemu-system-x86 qrencode \
    bsdextrautils iputils-ping netcat-openbsd sshpass ncat rlwrap \
    nikto dirsearch yq adb yara p7zip-full file xxd \
    zbar-tools sox tesseract-ocr \
    bloodyad coercer enum4linux-ng pwncat chisel-common-binaries \
    krb5-user gitleaks naabu netexec && \
    pip3 install pwntools pymongo pycryptodome z3-solver sympy gmpy2 \
    cysignals fpylll py_ecc pycparser==2.23 Pillow numpy scipy requests dnslib \
    pyzbar pytesseract segno \
    --break-system-packages && \
    sudo npm install -g "@playwright/cli@${PLAYWRIGHT_CLI_VERSION}" && \
    cd /tmp && playwright-cli install-browser chromium --with-deps

RUN case "$TARGETARCH" in amd64|arm64) asset_arch="$TARGETARCH" ;; \
      *) echo "unsupported worker architecture: $TARGETARCH" >&2; exit 1 ;; esac && \
    nuclei_archive="nuclei_3.11.0_linux_${asset_arch}.zip" && \
    cd /tmp && \
    wget -q "https://github.com/projectdiscovery/katana/releases/download/v1.5.0/katana_1.5.0_linux_${asset_arch}.zip" -O katana.zip && \
    wget -q "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.0/${nuclei_archive}" -O "$nuclei_archive" && \
    wget -q "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.0/nuclei_3.11.0_checksums.txt" -O nuclei-checksums.txt && \
    wget -q "https://github.com/hahwul/dalfox/releases/download/v2.12.0/dalfox-linux-${asset_arch}.tar.gz" -O dalfox.tar.gz && \
    wget -q "https://github.com/BishopFox/cloudfox/releases/download/v2.0.1/cloudfox-linux-${asset_arch}.zip" -O cloudfox.zip && \
    grep "nuclei_3.11.0_linux_${asset_arch}.zip" nuclei-checksums.txt | sha256sum -c - && \
    unzip -q katana.zip katana && sudo mv katana /usr/local/bin/ && \
    unzip -q "$nuclei_archive" nuclei && sudo mv nuclei /usr/local/bin/ && \
    tar -xzf dalfox.tar.gz && sudo mv "dalfox-linux-${asset_arch}" /usr/local/bin/dalfox && \
    unzip -q cloudfox.zip cloudfox/cloudfox && sudo mv cloudfox/cloudfox /usr/local/bin/ && \
    GOBIN=/tmp go install github.com/ropnop/kerbrute@v1.0.3 && \
    sudo mv /tmp/kerbrute /usr/local/bin/kerbrute && \
    sudo rm -rf /tmp/*

RUN mkdir -p /home/kali/tools && cd /home/kali/tools && \
    wget -q "https://github.com/frohoff/ysoserial/releases/download/v0.0.6/ysoserial-all.jar" -O ysoserial.jar && \
    git clone --depth=1 https://github.com/ticarpi/jwt_tool.git && \
    cd jwt_tool && pip3 install -r requirements.txt --break-system-packages && \
    git clone --depth=1 https://github.com/IOActive/jdwp-shellifier.git

RUN python3 -m venv /home/kali/tools/rsactftool-venv && \
    /home/kali/tools/rsactftool-venv/bin/pip install \
    "git+https://github.com/RsaCtfTool/RsaCtfTool.git@7c98848f1945de3e67a420871e8672f5ad9aa5d5" && \
    sudo ln -s /home/kali/tools/rsactftool-venv/bin/RsaCtfTool /usr/local/bin/RsaCtfTool

RUN command -v fd >/dev/null 2>&1 || sudo ln -s /usr/bin/fdfind /usr/local/bin/fd
    
RUN sudo pip3 install tccli awscli --break-system-packages && \
    sudo bash -c "$(curl -fsSL https://aliyuncli.alicdn.com/install.sh)"

RUN sudo npm install -g "@openai/codex@${CODEX_VERSION}"
RUN sudo npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"
RUN sudo npm install -g "@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}" --ignore-scripts && \
    sudo env HOME=/home/kali /usr/local/bin/pi install npm:pi-mcp-extension@1.5.0 && \
    sudo chown -R kali:kali /home/kali

RUN sudo npm install -g "@colbymchenry/codegraph@${CODEGRAPH_VERSION}" && \
    codegraph --version && \
    codegraph serve --help >/dev/null

# ============================================================================
# RedTrace benchmark offline toolchain — supplemental (Web / Binary / AI / EVM)
# ============================================================================

# --- 0. Base / build / DB / middleware / static system packages -------------
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt/lists,sharing=locked \
    sudo apt-get -o Acquire::Retries=5 update && \
    sudo DEBIAN_FRONTEND=noninteractive apt-get -o Acquire::Retries=5 \
    -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 \
    install -y --no-install-recommends \
    clang llvm lld autoconf automake libtool \
    socat iproute2 libxml2-utils xmlstarlet zstd tree procps psmisc time \
    patchelf libcap2-bin valgrind qemu-user qemu-user-static afl++ radamsa checksec \
    sqlite3 mariadb-client postgresql-client redis-tools \
    ldap-utils smbclient snmp ftp telnet \
    jadx whatweb exploitdb \
    rustc cargo perl \
    && sudo rm -rf /var/lib/apt/lists/*

# --- 1. Web discovery / fuzzing / protocol Go tools (pinned) ----------------
RUN GOBIN=/tmp/redtrace-go go install \
        github.com/projectdiscovery/httpx/cmd/httpx@v1.6.10 \
        github.com/ffuf/ffuf/v2@v2.1.0 \
        github.com/epi052/feroxbuster/v2@v2.11.0 \
        github.com/OJ/gobuster/v3@v3.6.0 \
        github.com/assetnote/kiterunner/cmd/kr@v1.0.2 \
        github.com/fullstorydev/grpcurl/cmd/grpcurl@v1.9.3 \
        github.com/vi/websocat@v1.14.0 \
    && sudo mv /tmp/redtrace-go/* /usr/local/bin/ \
    && sudo rm -rf /tmp/redtrace-go

# --- 2. Web / binary / blockchain / AI Python packages (pinned) --------------
RUN sudo pip3 install --break-system-packages --no-cache-dir \
        arjun==2.2.2 sqlmap==1.10.3 wafw00f==2.2.0 \
        angr==9.2.193 lief==0.17.6 pefile==2024.8.26 pyelftools==0.32 \
        capstone==5.0.3 unicorn==2.1.2 keystone-engine==0.9.2 \
        ROPgadget==7.7 ropper==1.13.13 uncompyle6==3.9.3 frida-tools==14.8.0 \
        web3==7.6.1 eth-account==0.13.5 eth-abi==5.2.0 eth-utils==5.1.0 \
        eth-hash==0.7.1 rlp==4.1.0 solc-select==1.0.6 \
        slither-analyzer==0.11.2 crytic-compile==0.3.10 halmos==0.2.4 \
        garak==0.10.0 mitmproxy==11.1.3 \
    && sudo pip3 install --break-system-packages --no-cache-dir \
        "git+https://github.com/commixproject/commix.git@785843cfb7f50444582d4255dc95636fd9d2aec0" \
    && sudo git clone --filter=blob:none https://github.com/vladko312/SSTImap.git /opt/redtrace/tools/sstimap \
    && sudo git -C /opt/redtrace/tools/sstimap checkout d4f09055b15967b0e2265f20eb348a7ec2f25a2c \
    && sudo pip3 install --break-system-packages --no-cache-dir -r /opt/redtrace/tools/sstimap/requirements.txt \
    && sudo chmod 0755 /opt/redtrace/tools/sstimap/sstimap.py \
    && sudo ln -sfn /opt/redtrace/tools/sstimap/sstimap.py /usr/local/bin/sstimap \
    && sudo rm -rf /root/.cache/pip

# --- 3. Ruby gems (pwn helpers) ----------------------------------------------
RUN sudo gem install one_gadget seccomp-tools --no-document

# --- 4. EVM blockchain binaries (Foundry / Echidna / Aderyn / heimdall) ------
RUN case "$TARGETARCH" in \
      amd64) asset_arch=amd64; rust_arch=x86_64 ;; \
      arm64) asset_arch=arm64; rust_arch=aarch64 ;; \
      *) echo "unsupported worker architecture: $TARGETARCH" >&2; exit 1 ;; esac && \
    cd /tmp && \
    wget -q "https://github.com/foundry-rs/foundry/releases/download/v1.2.0/foundry_v1.2.0_linux_${asset_arch}.tar.gz" -O foundry.tgz && \
    tar -xzf foundry.tgz && \
    sudo mv forge cast anvil chisel /usr/local/bin/ && \
    wget -q "https://github.com/crytic/echidna/releases/download/v2.3.3/echidna-2.3.3-${rust_arch}-linux.tar.gz" -O echidna.tgz && \
    tar -xzf echidna.tgz echidna && sudo mv echidna /usr/local/bin/ && \
    sudo rm -rf /tmp/*

# Aderyn + heimdall-rs: prebuilt Rust binaries; asset names vary by release,
# so pin the version and verify the URL at build time.
RUN case "$TARGETARCH" in \
      amd64) asset_arch=amd64; rust_arch=x86_64 ;; \
      arm64) asset_arch=arm64; rust_arch=aarch64 ;; \
      *) echo "unsupported worker architecture: $TARGETARCH" >&2; exit 1 ;; esac && \
    cd /tmp && \
    wget -q "https://github.com/Cyfrin/aderyn/releases/download/aderyn-v0.6.8/aderyn-${rust_arch}-unknown-linux-gnu.tar.xz" -O aderyn.tar.xz && \
    tar -xJf aderyn.tar.xz --strip-components=1 "aderyn-${rust_arch}-unknown-linux-gnu/aderyn" && chmod +x aderyn && sudo mv aderyn /usr/local/bin/aderyn && \
    wget -q "https://github.com/Jon-Becker/heimdall-rs/releases/download/0.9.3/heimdall-linux-${asset_arch}" -O heimdall && \
    chmod +x heimdall && sudo mv heimdall /usr/local/bin/heimdall && \
    sudo rm -rf /tmp/*

# --- 5. solc multi-version cache (offline after build) ----------------------
RUN HOME=/home/kali solc-select install 0.8.19 0.8.24 0.8.28 && \
    HOME=/home/kali solc-select use 0.8.28 && \
    sudo ln -sfn /home/kali/.solc-select/solc /usr/local/bin/solc

# --- 6. Mythril in an isolated venv (per spec) ------------------------------
RUN sudo python3 -m venv /opt/redtrace/venvs/mythril && \
    sudo /opt/redtrace/venvs/mythril/bin/pip install --no-cache-dir mythril==0.24.8 && \
    sudo ln -s /opt/redtrace/venvs/mythril/bin/myth /usr/local/bin/myth

# --- 7. AI red-team Node tools + package managers ----------------------------
RUN sudo npm install -g pnpm@9.15.0 promptfoo@0.104.0 hardhat@2.22.17

# --- 8. Offline data corpora (baked into the image) --------------------------
RUN sudo mkdir -p /opt/redtrace/data && sudo chown -R kali:kali /opt/redtrace/data && \
    cd /opt/redtrace/data && \
    git clone --depth=1 https://github.com/projectdiscovery/nuclei-templates.git nuclei-templates && \
    git clone --depth=1 https://github.com/danielmiessler/SecLists.git seclists && \
    git clone --depth=1 https://github.com/swisskyrepo/PayloadsAllTheThings.git payloads-all-the-things && \
    git clone --depth=1 https://github.com/returntocorp/semgrep-rules.git semgrep-rules && \
    git clone --depth=1 https://gitlab.com/exploit-database/exploitdb.git exploitdb

RUN sudo chmod +x /usr/local/bin/kerbrute
RUN mkdir -p /home/kali/.config/nuclei && \
    echo >> /home/kali/.config/nuclei/config.yaml && \
    echo "disable-update-check: true" >> /home/kali/.config/nuclei/config.yaml
RUN nuclei -version && \
    RsaCtfTool --help >/dev/null && \
    zbarimg --version && sox --version && tesseract --version && \
    python3 -c "from Crypto.Cipher import AES; from cysignals import signals; from fpylll import IntegerMatrix; from gmpy2 import mpz; import pytesseract, segno; from py_ecc import bn128; from pyzbar import pyzbar; from scipy import signal; from sympy import factorint; from z3 import Solver; assert AES.block_size == 16 and IntegerMatrix(1, 1).nrows == 1 and mpz(7) == 7 and bn128.curve_order > 0 and factorint(15) == {3: 1, 5: 1} and Solver() is not None and signals is not None and pytesseract is not None and segno.make('RedTrace') and pyzbar is not None and signal is not None"
RUN forge --version && anvil --version && echidna --version && \
    slither --version && solc --version && \
    httpx -version && ffuf -V && feroxbuster --version && \
    sqlmap --version && arjun --help >/dev/null && \
    garak --version && mitmproxy --version && promptfoo --version && \
    python3 -c "import angr, lief, pefile, elftools, capstone, unicorn, keystone, ropper, web3, eth_abi, slither, crytic_compile; print('supplemental python imports ok')"
RUN sudo rm -rf /usr/lib/llvm-*/build && \
    if [ -d /usr/lib/mysql/plugin/auth_pam_tool_dir ]; then \
      sudo chmod o+rx /usr/lib/mysql/plugin/auth_pam_tool_dir; \
    fi && \
    sudo chmod o+rx /etc/ssl/private
RUN printf '%s\n' 'PS1="${PS1%\\n*} \[\033[0;36m\]\D{%y-%m-%d} - \t\[\033[;32m\]\n${PS1##*\\n}"' >> /home/kali/.bashrc && \
    mkdir -p /home/kali/workspace && cd /home/kali/workspace && git init
ENV TZ=Asia/Shanghai
ENV PATH="/home/kali/.solc-select:${PATH}"
ENV PLAYWRIGHT_MCP_BROWSER=chromium
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV PYTHONUNBUFFERED=1

COPY ./.agents /home/kali/workspace/.agents
COPY ./.agents /home/kali/workspace/.claude
COPY ./AGENTS.md /home/kali/workspace/AGENTS.md
COPY ./AGENTS.md /home/kali/workspace/CLAUDE.md

WORKDIR /home/kali/workspace
