请基于 RedTrace_X，对托管 Benchmark 镜像进行一次彻底的 Headless/Pi-only 重构。

目标不是保留 RedTrace_X 的通用部署能力，而是制作一个用于 TSecBench 等网络安全 Benchmark 的 Kali Linux 单镜像。

【总原则】

1. RedTrace_X 最终只允许存在一个 Dockerfile，作为唯一 Docker 镜像构建入口。
2. 最终只生成一个镜像。
3. Dockerfile 必须使用 multi-stage build。
4. Final Runtime 基础系统必须为 Kali Linux。
5. 最终 docker save | gzip -9 后必须 <= 3 GiB，建议控制在 <= 2.5 GiB。
6. 平台运行资源为 8 Core / 16 GB，需要针对该资源配置。
7. 运行方式只保留 local mode。
8. 不允许 nested Docker，不保留 RedTrace container mode。
9. 不保留 mock mode。
10. Agent 只允许 Pi。
11. 删除 Claude Code 和 Codex 的安装、Adapter、配置、环境变量、session path 和测试。
12. 默认 1 个 Pi Reason/Bootstrap Worker + 3 个 Pi Explore Worker。
13. 所有 Worker 在同一个最终容器中直接执行。
14. 保持现有 Blackboard、Fact、Intent、Hint、GraphPatch、Reason、Explore、Dispatcher、Context Harness 和实时增量同步能力。
15. Benchmark 仍使用一个 RedTrace Project 管理所有题目。

【Headless】

删除所有人工操作面：

- Web UI
- static/
- WebShell 管理
- C2 Listener/Session/Payload 管理
- Resource 人工操作面
- Plugins
- MCP
- Browser Extension
- Burp Plugin
- Web Worker 配置页面
- 人工审批 UI
- Docker/Mock 管理能力

但不要删除 localhost Control Plane。

RedTrace Dispatcher 与 benchctl 仍然需要一个仅监听 127.0.0.1 的内部 FastAPI API。

保留最小 API：

- projects
- hints
- intents
- graph-patch
- blackboard
- audit
- scheduler 必需 settings/status API

禁止监听 0.0.0.0。

删除 app.py 中：

- StaticFiles
- FileResponse
- plugins router
- operations router
- C2 startup/resume
- WebShell/C2 output 初始化
- shell broker

同时删除所有不再被引用的相关模块。

【Python Runtime】

托管版本只支持 local mode，因此：

- 从 hosted runtime dependencies 中移除 docker Python package。
- 删除 container runtime 代码依赖。
- 不安装 Docker CLI/Daemon。
- 删除 Mock Driver。
- 删除 Claude Driver。
- 删除 Codex Driver。
- 只保留 Pi Driver。

确保 pyproject/uv.lock 与最终 runtime 一致。

【Pi】

使用当前项目 pin 的 @earendil-works/pi-coding-agent。

不得安装：

- pi-mcp-extension
- 任何 MCP
- Claude/Codex compatibility package

进一步去掉 RedTrace Pi Provider Extension。

使用 Pi 原生 ~/.pi/agent/models.json。

start.sh 每次启动时根据：

- API_KEY
- AGENT_BASE_URL
- MODEL
- PI_PROVIDER_API（默认 openai-completions）

动态生成 /root/.pi/agent/models.json。

models.json 中绝对不能写入真实 API KEY，只引用：

"$API_KEY"

Pi 调用改为：

pi --provider redtrace \
   --model "$MODEL" \
   --approve \
   --thinking max \
   --mode rpc

保留 Pi RPC 模式和 steer 在线消息注入。

【Pi Skills】

所有专业 Skills 最终只保存一份：

/root/.pi/agent/skills/

不要再复制到每个 Workspace。

RedTrace paths.skills 直接指向：

/root/.pi/agent/skills

或者建立零拷贝 symlink。

不要将全部 skills/ 打入最终镜像。

改为严格 whitelist。

优先保留以下领域：

- TSecBench
- Web
- API
- Business Logic
- Code Audit
- Supply Chain
- Reverse
- Pwn
- Firmware
- Protocol
- Crypto
- AI/LLM Security
- Blockchain/EVM
- Exploit Chain
- Internal Pentest
- Credential/Pivot
- Cloud
- Container Escape
- Evasion

删除：

- report writing
- docs generation
- diagram
- browser automation
- Playwright
- mobile
- iOS
- Android
- digital forensics
- media/stego
- SDR
- WiFi
- ICS
- unrelated skills

当前 src-pentest-skill 不允许原封不动用于 Benchmark。
移除其中等待人工 scope 确认、询问用户、SRC 安静模式等会阻止无人值守执行的逻辑。
Benchmark scope 视为平台已经授权。

【RTK】

必须安装 Rust Token Killer：

rtk-ai/rtk

使用预编译 Release binary，不允许为了安装 RTK 将 Rust/Cargo 带入 Runtime。

固定版本，不使用 latest。

安装后执行：

rtk --version
rtk gain
rtk init -g --agent pi

验证 Pi 自动 rewrite 生效。

Context Harness 继续作为 post-RTK 第二层上下文治理。

【安全工具范围】

镜像必须覆盖：

1. Web漏洞挖掘
2. 二进制漏洞挖掘
3. AI漏洞挖掘
4. 区块链漏洞挖掘
5. 漏洞利用
6. 多阶段渗透
7. 云攻击
8. 对抗规避

Web 核心：

curl wget git jq yq ripgrep
nmap dnsutils whois
httpx ffuf feroxbuster katana nuclei
dalfox grpcurl websocat
sqlmap commix SSTImap arjun wafw00f jwt_tool
semgrep gitleaks syft

Binary/Pwn：

file binutils checksec patchelf
gdb pwndbg radare2 Ghidra-headless
strace ltrace valgrind
qemu-user qemu-user-static
binwalk squashfs-tools upx
pwntools angr
capstone unicorn keystone lief pefile pyelftools
ROPgadget ropper one_gadget seccomp-tools
RsaCtfTool
pycryptodome z3 sympy fpylll
pycdc uncompyle6 ilspycmd jadx

Exploit/Pentest：

gcc g++ make clang
netcat-openbsd socat
openssh-client sshpass
proxychains4
chisel
ligolo-ng
impacket
smbclient
ldap-utils
krb5-user
netexec

Cloud：

awscli
boto3
azure-identity
azure-storage-blob
azure-mgmt-resource
msal

不要安装完整 Azure CLI。

AI：

promptfoo
promptmap2

不要安装 inspect-ai / inspect-evals / AgentDojo 等 Benchmark Framework。

Blockchain 默认只保留 EVM：

forge
cast
anvil
solc
slither
echidna
mythril
heimdall
web3.py

默认删除：

Solana
Anchor
Sui
Aptos
Move
Cairo
Starknet
TON
Cosmos
CosmWasm
Substrate
Hardhat

除非实际题库证明需要。

Evasion：

mingw-w64
pefile
lief
capstone
keystone
upx
openssl
gcc/clang
Python

禁止安装 Metasploit/Sliver/Mythic 等大型攻击框架。

【Offline Data】

保留：

- nuclei-templates pinned snapshot
- SecLists curated subset
- PayloadsAllTheThings curated subset
- semgrep rules
- ExploitDB

删除：

- Grype DB
- 完整 SecLists
- 完整 PayloadsAllTheThings
- 通用开发缓存

不要保存：

- Python wheelhouse
- npm cache
- pnpm store
- Cargo cache
- Go module cache
- Maven cache
- Gradle cache

Benchmark 运行时本来就不应安装新的依赖。

把空间用于真正的漏洞分析工具，而不是 package-manager cache。

【Builder / Runtime】

Builder 可以安装：

gcc
go
rust
cargo
cmake
python-dev
node/npm
其他构建依赖

Final Runtime 只 COPY 最终产物。

Runtime 不允许残留：

cargo
rustc
go compiler
cmake
ninja
Maven
Gradle
npm cache
pip cache
apt cache
下载压缩包
.git
测试代码
构建源码

gcc/clang/make 是例外，因为 Exploit 开发需要，在 Runtime 明确保留。

Ghidra 只安装 headless 所需 JRE，不安装完整 JDK/GUI。

【Repo/Image 文件裁剪】

最终镜像不要 COPY：

.git
.github
docs
tests
plugins
mcp
artifacts
__pycache__
*.pyc
docker-compose.yaml
Dockerfile.benchmark
container/Dockerfile
deploy.sh
install-security-toolchain.sh
redtrace.mock.example.yaml
redtrace.container.example.yaml
README 等非运行资料

使用 .dockerignore 从构建上下文层面排除。

【Secrets】

镜像中绝对禁止出现：

BENCHMARK_TOKEN 实值
BENCHMARK_BASE_URL 实值
API_KEY 实值
AGENT_BASE_URL 实值
任何模型密钥
任何云密钥

全部通过 Runtime ENV 获取。

平台会提供：

BENCHMARK_TOKEN
BENCHMARK_BASE_URL

模型相关配置从托管页面 Runtime ENV 注入。

【Entrypoint】

容器启动后：

1. 校验环境变量
2. 生成 Pi models.json
3. 创建运行目录
4. 启动 localhost RedTrace Headless API
5. 等待 API ready
6. 启动 Dispatcher
7. 启动 benchctl run
8. benchctl 结束后关闭 Dispatcher/Server
9. 容器退出

不能要求人工输入。

不能启动 Web UI。

不能后台等待用户。

【运行配置】

execution: local

max_workers: 4
max_project_workers: 4
max_running_projects: 1

Worker：

pi-reason:
  reason + bootstrap
  max_running=1

pi-explore-1:
  explore
  max_running=1

pi-explore-2:
  explore
  max_running=1

pi-explore-3:
  explore
  max_running=1

reason.max_intents=3

确保 3 个 Explore 能持续并行。

【构建质量门】

Docker build 必须执行：

- Pi smoke test
- RTK smoke test
- Skill discovery test
- RedTrace import test
- Headless API test
- Dispatcher config test
- 核心 security tool existence test

验证：

pi --version
rtk --version
rtk gain
redtrace --help
nuclei -version
httpx -version
gdb --version
analyzeHeadless
forge --version
slither --version
aws --version

并验证：

- claude 不存在
- codex 不存在
- docker 不存在
- chromium 不存在
- playwright 不存在
- MCP 不存在
- plugin assets 不存在

【体积硬门】

构建完成执行：

docker save redtrace-x:latest | gzip -9 > redtrace-x.tar.gz

如果：

stat -c%s redtrace-x.tar.gz > 3221225472

构建必须失败。

优化目标不是刚好 3 GiB，而是 <= 2.5 GiB。

最后输出：

1. 删除的文件/功能
2. 最终安装的工具清单
3. 最终安装的 Skill 清单
4. 最终 docker image size
5. docker save gzip 后大小
6. smoke test 结果
7. 是否满足平台 3 GiB 限制