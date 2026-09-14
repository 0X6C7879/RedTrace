# RedTrace 完整工具清单

## 1. 基础系统与 Shell 工具

### 必备

- `bash`
- `coreutils`
  - `cat`
  - `cp`
  - `mv`
  - `rm`
  - `mkdir`
  - `head`
  - `tail`
  - `tee`
  - `wc`
  - `date`
  - `timeout`
- `findutils`
  - `find`
  - `xargs`
- `grep`
- `sed`
- `gawk` / `awk`
- `sort`
- `uniq`
- `cut`
- `tr`
- `diff`
- `less`
- `which`
- `whereis`
- `file`
- `xxd`
- `od`
- `strings`
- `base64`
- `jq`
- `bc`
- `parallel`
- `procps`
  - `ps`
  - `top`
  - `pgrep`
  - `pkill`
- `psmisc`
  - `killall`
  - `fuser`
- `lsof`
- `tmux`
- `screen`
- `expect`

### 压缩与归档

- `tar`
- `gzip`
- `gunzip`
- `bzip2`
- `xz-utils`
- `zip`
- `unzip`
- `p7zip-full` / `7z`

---

## 2. 下载、源码与构建工具

- `curl`
- `wget`
- `git`
- `ca-certificates`
- `build-essential`
- `gcc`
- `g++`
- `make`
- `cmake`
- `pkg-config`
- `autoconf`
- `automake`
- `libtool`
- `patch`

> 如果最终镜像只运行预编译安全工具，可在多阶段构建后删除部分编译环境。

---

## 3. 网络基础工具

### 地址、路由、连通性

- `iproute2`
  - `ip`
  - `ss`
- `iputils-ping`
  - `ping`
- `net-tools`
  - `ifconfig`
  - `netstat`
  - `route`
- `traceroute`
- `mtr-tiny`
- `arping`

### DNS

- `dnsutils`
  - `dig`
  - `nslookup`
  - `host`

### TCP/UDP / 原始协议

- `netcat-openbsd` / `nc`
- `ncat`
- `socat`
- `telnet`
- `tcpdump`

### TLS / 加密连接

- `openssl`

---

## 4. 端口扫描与服务发现

### 主要工具

- `nmap`
- `nmap` NSE scripts
- `naabu`
- `fping`

### 完整覆盖建议保留

- `masscan`
- `rustscan`

> `masscan` / `rustscan` 在本批任务中并非核心依赖，但若目标是通用 Benchmark 镜像，可保留。

---

## 5. Web / HTTP / API 测试

### HTTP 客户端与探测

- `curl`
- `wget`
- `httpx`
- `whatweb`
- `nikto`

### 目录、路由、参数 Fuzz

- `dirsearch`
- `ffuf`
- `gobuster`
- `feroxbuster`
- `wfuzz`
- `dirb`

> 实际核心优先级：`dirsearch + ffuf`。  
> 其余工具功能有重叠，但本清单按“完整覆盖”保留。

### Web 漏洞扫描与利用

- `nuclei`
- `sqlmap`

### 浏览器自动化

- `playwright`
- `playwright-cli`
- Chromium / Playwright Chromium runtime
- Playwright 所需系统动态库

---

## 6. 认证、爆破、口令测试

- `hydra`
- `medusa`
- `patator`
- `john`
- `hashcat`

### 常用辅助

- `sshpass`
- `expect`

---

## 7. SSH / FTP / 远程访问

- `openssh-client`
  - `ssh`
  - `scp`
  - `sftp`
- `sshpass`
- `ftp`
- `lftp`
- `telnet`

---

## 8. 内网穿透、代理与 Pivot

### 必备

- `chisel`
- `proxychains4`
- `socat`

### 建议补充

- `ssh` 动态/本地/远程转发
- `ncat`
- `curl` SOCKS 支持
- Python `PySocks`

### Chisel 二进制

至少保留：

- `chisel_linux_amd64`

如需要多架构目标，再加入：

- `chisel_linux_arm64`
- `chisel_linux_386`
- `chisel_windows_amd64.exe`

---

## 9. 抓包与流量分析

- `tcpdump`
- `tshark`
- `wireshark-common`
- `capinfos`
- `editcap`
- `mergecap`

> 无 GUI 环境不需要完整 Wireshark Desktop。

---

## 10. Reverse Engineering / Binary Analysis

### ELF / 二进制基础

- `file`
- `strings`
- `xxd`
- `od`

### Binutils

安装 `binutils`，至少包含：

- `objdump`
- `readelf`
- `nm`
- `objcopy`
- `strip`
- `strings`
- `addr2line`

### 动态分析

- `gdb`
- `gdb-multiarch`
- `strace`
- `ltrace`

### 安全属性检查

- `checksec`

### ROP

- `ROPgadget`
- `ropper`

### 编译/验证 PoC

- `gcc`
- `g++`
- `make`

### 完整覆盖可选 RE 工具

- `radare2`
- `rizin`
- `binwalk`
- `lldb`

### 大型工具（建议按需插件化，不默认放最小镜像）

- Ghidra
- angr
- QEMU user/system emulation

---

## 11. Pwn / Exploit 开发

系统工具：

- `gdb`
- `gdb-multiarch`
- `checksec`
- `ROPgadget`
- `ropper`
- `objdump`
- `readelf`
- `nm`
- `gcc`
- `strace`
- `ltrace`
- `socat`
- `nc` / `ncat`

Python 包：

- `pwntools`
- `capstone`
- `unicorn`
- `pyelftools`
- `z3-solver`

---

## 12. Java / JDWP

为了完整覆盖 Java Debug Wire Protocol 和 Java 类分析任务：

### JDK

- OpenJDK JDK
- `java`
- `javac`
- `jdb`
- `javap`
- `jar`
- `keytool`

推荐：

- `openjdk-17-jdk-headless`

如果目标程序需要其他版本兼容，可追加相应 JDK。

---

## 13. PHP

- `php-cli`

建议模块：

- `php-curl`
- `php-json`（新版本通常内置）
- `php-mbstring`
- `php-xml`
- `php-zip`
- `php-sqlite3`

用途包括：

- PHP 序列化/反序列化测试
- Session/Cookie 处理
- PHP 类型/比较行为验证
- Payload 本地验证

---

## 14. Node.js / JavaScript

- `nodejs`
- `npm`
- `npx`

建议同时支持：

- JavaScript Payload 执行
- Web 前端逻辑分析
- Playwright
- Prototype Pollution / Node 生态漏洞 PoC

如果 Playwright 单独管理 Node Runtime，可避免安装两套 Node。

---

## 15. Go Runtime / Go 工具

若使用预编译二进制，运行时无需 Go 编译器。

### 构建阶段可能需要

- `golang-go`

### Go 工具

- `httpx`
- `nuclei`
- `naabu`
- `ffuf`
- `chisel`

建议使用多阶段 Docker 构建：

1. Builder 安装 Go 并编译工具；
2. Runtime 仅复制最终二进制；
3. 最终镜像移除 Go toolchain。

---

## 16. Python Runtime

用于所有安全脚本与 Python PoC。

---

# 17. Python 第三方包完整清单

## 17.1 HTTP / Web / API

- `requests`
- `urllib3`
- `httpx`
- `aiohttp`
- `httpcore`
- `h11`
- `h2`
- `websockets`
- `websocket-client`
- `beautifulsoup4`
- `lxml`
- `html5lib`

## 17.2 SOCKS / 代理 / 网络

- `PySocks`
- `paramiko`
- `scapy`
- `dnspython`

## 17.3 Web Framework / Session / Token

- `Flask`
- `Werkzeug`
- `Jinja2`
- `itsdangerous`
- `flask-unsign`
- `PyJWT`

## 17.4 密码学

- `cryptography`
- `pycryptodome`
- `bcrypt`
- `PyNaCl`

## 17.5 二进制 / RE / Pwn

- `pwntools`
- `capstone`
- `unicorn`
- `pyelftools`
- `z3-solver`

## 17.6 数据、科学计算与图像

- `numpy`
- `scipy`
- `Pillow`

## 17.7 序列化 / 特殊 Payload

- `phpserialize`
- `pydash`

## 17.8 异步 / 服务端兼容

- `sanic`

## 17.9 实用包

- `rich`
- `click`
- `colorama`
- `tqdm`
- `python-dateutil`
- `PyYAML`

## 17.10 浏览器自动化

- `playwright`

安装后执行：

```bash
python -m playwright install chromium
```

---

## 18. 推荐 Python requirements.txt

```text
requests
urllib3
httpx
aiohttp
httpcore
h11
h2
websockets
websocket-client
beautifulsoup4
lxml
html5lib

PySocks
paramiko
scapy
dnspython

Flask
Werkzeug
Jinja2
itsdangerous
flask-unsign
PyJWT

cryptography
pycryptodome
bcrypt
PyNaCl

pwntools
capstone
unicorn
pyelftools
z3-solver

numpy
scipy
Pillow

phpserialize
pydash
sanic

rich
click
colorama
tqdm
python-dateutil
PyYAML

playwright
```

---

## 19. 数据库客户端

### 必备/高价值

- `sqlite3`
- `mariadb-client` / `default-mysql-client`

### 建议完整覆盖

- `postgresql-client`
  - `psql`
- `redis-tools`
  - `redis-cli`

### 可选

- MongoDB Shell
  - `mongosh`

---

## 20. OCR / 验证码

- `tesseract-ocr`
- `imagemagick`

Python：

- `Pillow`
- `numpy`

典型流程：

```text
获取验证码
→ resize
→ grayscale
→ threshold
→ OCR
→ 自动提交
```

---

## 21. CVE / Exploit / PoC 工具

### 建议保留

- `searchsploit`
- ExploitDB

### 大型通用框架

- `metasploit-framework`

> Metasploit 体积很大。  
> 如果目标仍然要求最终镜像 ≤3 GiB，建议改为外部插件/按需镜像，而不是常驻主镜像。

---

# 22. Nuclei

### 二进制

- `nuclei`

### 模板

- `nuclei-templates`

需要包含：

- `http/`
- `network/`
- `cves/`
- `vulnerabilities/`
- `misconfiguration/`
- `technologies/`
- `default-logins/`
- `helpers/wordlists/`

建议固定 Git commit，保证 Benchmark 可复现。

---

# 23. PayloadsAllTheThings

建议保留本地副本：

```text
PayloadsAllTheThings/
```

重点目录：

- Command Injection
- File Inclusion
- File Upload
- Insecure Deserialization
- JWT
- NoSQL Injection
- OAuth
- Open Redirect
- Prototype Pollution
- Request Smuggling
- Server Side Request Forgery
- Server Side Template Injection
- SQL Injection
- XSS Injection
- XXE Injection
- SAML Injection
- LDAP Injection
- GraphQL Injection
- API Key Leaks
- Encoding Transformations
- Web Cache Poisoning

---

# 24. Vulhub / 本地 PoC 知识库

建议保留 Vulhub 的：

- README
- CVE 描述
- PoC
- exploit scripts
- payload examples
- 配置说明

不建议在 Benchmark 主镜像中保存：

- Vulhub Docker images
- 每个漏洞的完整运行环境
- 大体积构建缓存

可以制作：

```text
vulhub-lite/
```

只保存知识与利用脚本。

---

# 25. 字典 / Wordlists

## SecLists

建议至少保留：

```text
SecLists/Discovery/Web-Content/
SecLists/Discovery/DNS/
SecLists/Discovery/Web-Content/api/
SecLists/Fuzzing/
SecLists/Usernames/
SecLists/Passwords/
```

优先小型、常用字典。

## Dirsearch

保留：

```text
dirsearch/db/dicc.txt
```

## Nuclei

保留：

```text
nuclei-templates/helpers/wordlists/
```

## 常用系统字典

- `/usr/share/wordlists/`

如果有 RockYou：

- `rockyou.txt`

但完整大字典可按需挂载，不一定放进基础镜像。

---

# 26. JSON / YAML / XML 数据处理

系统：

- `jq`
- `xmlstarlet`

Python：

- `PyYAML`
- `lxml`
- `beautifulsoup4`

---

# 27. 图像与文件处理

- `imagemagick`
- `file`
- `xxd`
- `binwalk`
- `exiftool`

Python：

- `Pillow`

---

# 28. 编码 / Hash / Crypto 辅助

系统：

- `openssl`
- `base64`
- `xxd`
- `sha256sum`
- `sha1sum`
- `md5sum`

密码恢复：

- `john`
- `hashcat`

Python：

- `hashlib`（标准库）
- `base64`（标准库）
- `hmac`（标准库）
- `cryptography`
- `pycryptodome`

---

# 29. Python 标准库能力

无需 pip 安装，但 Agent PoC 会大量使用：

- `socket`
- `ssl`
- `http.client`
- `urllib`
- `urllib.parse`
- `json`
- `xml`
- `base64`
- `hashlib`
- `hmac`
- `secrets`
- `struct`
- `subprocess`
- `asyncio`
- `threading`
- `multiprocessing`
- `concurrent.futures`
- `re`
- `os`
- `sys`
- `pathlib`
- `tempfile`
- `shutil`
- `sqlite3`
- `pickle`
- `marshal`
- `zlib`
- `gzip`
- `tarfile`
- `zipfile`
- `csv`
- `html`
- `http.server`
- `socketserver`
