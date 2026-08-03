FROM kalilinux/kali-rolling:latest

ARG TARGETARCH
ARG CODEX_VERSION=0.146.0
ARG CLAUDE_CODE_VERSION=2.1.220
ARG PI_CODING_AGENT_VERSION=0.83.0
ARG PLAYWRIGHT_CLI_VERSION=0.1.17

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
    build-essential pkg-config cmake ninja-build swig \
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

RUN sudo chmod +x /usr/local/bin/kerbrute
RUN mkdir -p /home/kali/.config/nuclei && \
    echo >> /home/kali/.config/nuclei/config.yaml && \
    echo "disable-update-check: true" >> /home/kali/.config/nuclei/config.yaml
RUN nuclei -version && \
    RsaCtfTool --help >/dev/null && \
    zbarimg --version && sox --version && tesseract --version && \
    python3 -c "from Crypto.Cipher import AES; from cysignals import signals; from fpylll import IntegerMatrix; from gmpy2 import mpz; import pytesseract, segno; from py_ecc import bn128; from pyzbar import pyzbar; from scipy import signal; from sympy import factorint; from z3 import Solver; assert AES.block_size == 16 and IntegerMatrix(1, 1).nrows == 1 and mpz(7) == 7 and bn128.curve_order > 0 and factorint(15) == {3: 1, 5: 1} and Solver() is not None and signals is not None and pytesseract is not None and segno.make('RedTrace') and pyzbar is not None and signal is not None"
RUN sudo rm -rf /usr/lib/llvm-*/build && \
    if [ -d /usr/lib/mysql/plugin/auth_pam_tool_dir ]; then \
      sudo chmod o+rx /usr/lib/mysql/plugin/auth_pam_tool_dir; \
    fi && \
    sudo chmod o+rx /etc/ssl/private
RUN printf '%s\n' 'PS1="${PS1%\\n*} \[\033[0;36m\]\D{%y-%m-%d} - \t\[\033[;32m\]\n${PS1##*\\n}"' >> /home/kali/.bashrc && \
    mkdir -p /home/kali/workspace && cd /home/kali/workspace && git init
ENV TZ=Asia/Shanghai
ENV PLAYWRIGHT_MCP_BROWSER=chromium
ENV CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1
ENV PYTHONUNBUFFERED=1

COPY ./.agents /home/kali/workspace/.agents
COPY ./.agents /home/kali/workspace/.claude
COPY ./AGENTS.md /home/kali/workspace/AGENTS.md
COPY ./AGENTS.md /home/kali/workspace/CLAUDE.md

WORKDIR /home/kali/workspace
