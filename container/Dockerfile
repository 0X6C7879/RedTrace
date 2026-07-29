FROM --platform=amd64 kalilinux/kali-rolling:latest

RUN apt update && \
    apt -y install kali-linux-headless && \
    apt clean && \
    rm -rf /var/lib/apt/lists/*

RUN useradd -m -s /bin/bash kali && \
    echo "kali ALL=(ALL) NOPASSWD:ALL" >> /etc/sudoers
USER kali

RUN sudo apt update && \
    sudo apt install -y bsdextrautils npm jq iputils-ping sshpass ncat rlwrap \
    python3-venv hashcat ffmpeg qrencode zbar-tools sox tesseract-ocr \
    bloodyad coercer enum4linux-ng pwncat chisel-common-binaries \
    dirsearch yq krb5-user gitleaks naabu nikto netexec adb && \
    sudo apt clean && \
    sudo rm -rf /var/lib/apt/lists/* && \
    pip3 install pwntools pymongo pycryptodome z3-solver sympy gmpy2 \
    cysignals fpylll py_ecc pycparser==2.23 Pillow numpy scipy requests dnslib \
    pyzbar pytesseract segno \
    --break-system-packages && \
    sudo npm install -g @playwright/cli@latest && \
    cd /tmp && playwright-cli install-browser chromium --with-deps

RUN cd /tmp && \
    wget -q "https://github.com/projectdiscovery/katana/releases/download/v1.5.0/katana_1.5.0_linux_amd64.zip" -O katana.zip && \
    wget -q "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.0/nuclei_3.11.0_linux_amd64.zip" -O nuclei.zip && \
    wget -q "https://github.com/projectdiscovery/nuclei/releases/download/v3.11.0/nuclei_3.11.0_checksums.txt" -O nuclei-checksums.txt && \
    wget -q "https://github.com/hahwul/dalfox/releases/download/v2.12.0/dalfox-linux-amd64.tar.gz" -O dalfox.tar.gz && \
    wget -q "https://github.com/BishopFox/cloudfox/releases/download/v2.0.1/cloudfox-linux-amd64.zip" -O cloudfox.zip && \
    wget -q "https://github.com/ropnop/kerbrute/releases/download/v1.0.3/kerbrute_linux_amd64" -O kerbrute && \
    grep "nuclei_3.11.0_linux_amd64.zip" nuclei-checksums.txt | sha256sum -c - && \
    unzip -q katana.zip katana && sudo mv katana /usr/local/bin/ && \
    unzip -q nuclei.zip nuclei && sudo mv nuclei /usr/local/bin/ && \
    tar -xzf dalfox.tar.gz && sudo mv dalfox-linux-amd64 /usr/local/bin/dalfox && \
    unzip -q cloudfox.zip cloudfox/cloudfox && sudo mv cloudfox/cloudfox /usr/local/bin/ && \
    sudo cp kerbrute /usr/local/bin/ && \
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

RUN cd /tmp && \
    wget -q "https://github.com/BurntSushi/ripgrep/releases/download/15.1.0/ripgrep_15.1.0-1_amd64.deb" -O ripgrep.deb && \
    wget -q "https://github.com/sharkdp/fd/releases/download/v10.4.2/fd_10.4.2_amd64.deb" -O fd.deb && \
    sudo apt install ./ripgrep.deb ./fd.deb && \
    sudo rm -rf /tmp/* && \
    sudo apt clean && \
    sudo rm -rf /var/lib/apt/lists/*
    
RUN pip3 install tccli awscli --break-system-packages && \
    sudo bash -c "$(curl -fsSL https://aliyuncli.alicdn.com/install.sh)"

RUN sudo npm install -g @openai/codex@0.118.0
RUN sudo npm install -g @anthropic-ai/claude-code@2.1.98
RUN sudo npm install -g @mariozechner/pi-coding-agent@0.73.0 && \
    pi install npm:pi-mcp-extension@1.5.0

RUN sudo chmod +x /usr/local/bin/kerbrute
RUN mkdir -p /home/kali/.config/nuclei && \
    echo >> /home/kali/.config/nuclei/config.yaml && \
    echo "disable-update-check: true" >> /home/kali/.config/nuclei/config.yaml
RUN nuclei -version && \
    RsaCtfTool --help >/dev/null && \
    zbarimg --version && sox --version && tesseract --version && \
    python3 -c "from Crypto.Cipher import AES; from cysignals import signals; from fpylll import IntegerMatrix; from gmpy2 import mpz; import pytesseract, segno; from py_ecc import bn128; from pyzbar import pyzbar; from scipy import signal; from sympy import factorint; from z3 import Solver; assert AES.block_size == 16 and IntegerMatrix(1, 1).nrows == 1 and mpz(7) == 7 and bn128.curve_order > 0 and factorint(15) == {3: 1, 5: 1} and Solver() is not None and signals is not None and pytesseract is not None and segno.make('RedTrace') and pyzbar is not None and signal is not None"
RUN sudo rm -rf /usr/lib/llvm-*/build && \
    sudo chmod o+rx /usr/lib/mysql/plugin/auth_pam_tool_dir /etc/ssl/private
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
