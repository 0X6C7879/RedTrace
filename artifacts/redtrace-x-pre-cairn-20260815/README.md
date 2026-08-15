# RedTrace_X — 独立 RedTrace + TSecBench 评测接入

RedTrace 项目的独立副本，以**本地模式**运行，接入 [TSec Benchmark 平台](https://tsecbench.zc.tencent.com) 的
`Challenges API`（见 `CHALLENGES_API.md`）。跑分时由 RedTrace 的多 Agent worker（**Pi 专职 reason，Claude Code / Codex 并行 explore**，
统一走 `agent-awd.baidu.com` 网关的 `glm-5.2-agent-chanllenge` 模型）作为解题大脑，`benchctl` 驱动标准流程：

```
VPN 预检 → 列出题目 → 逐题：启动容器 → 建 RedTrace 项目(worker 解题) → 提交 flag → 关闭容器 → 汇总得分
```

## 使用

```bash
cd RedTrace_X
# 1. 填模型网关 API_KEY 与 BENCHMARK_TOKEN（其余网关/模型/平台配置已在 .env 预置）
vim .env
# 2. 启动：加载 .env → 渲染 redtrace.yaml → 起 RedTrace(本地模式) → 自动开始评测
./start.sh
```

`BENCHMARK_BASE_URL` 默认 `https://tsecbench.zc.tencent.com`，`BENCHMARK_TOKEN` 在平台创建跑分任务后下发。
启动后会先做 VPN 联通预检（`http://10.0.100.58`），不通则中断。

> 依赖：`python3`、`uv`、`curl`，以及 Agent CLI `claude` / `codex` / `pi`。
> 首次运行 `uv` 会自动构建 `redtrace/` 的 `.venv`（需联网安装依赖），之后可离线运行。

## 敏感配置

所有密钥/凭证只经环境变量读取，不写入代码包：

- `BENCHMARK_TOKEN`、`BENCHMARK_BASE_URL`、`VPN_CHECK_URL` —— 跑分平台
- `API_KEY`、`MODEL`、`AGENT_BASE_URL` —— 解题模型网关（Claude/Codex/Pi 三 CLI 共用）

`.env`（含真实密钥，已 gitignore）由 `start.sh` 加载；`start.sh` 用 `bench/render_config.py` 把
`redtrace.yaml.template` 渲染成 `redtrace.yaml`（已 gitignore）。`.env.example` 为占位模板。

## 结构

```
RedTrace_X/               # 独立 RedTrace 项目（本地模式）
  redtrace/               # RedTrace Python 包
  skills/                # 共享能力（含 skills/tsec-benchmark/SKILL.md 评测 skill）
  mcp/ plugins/
  start-redtrace.sh       # RedTrace 原生启动脚本（被 start.sh 后台调用）
  redtrace.yaml.template  # 本地模式配置模板（密钥用环境变量占位）
  redtrace.yaml           # 渲染产物（gitignore）
  start.sh                # 一键启动：加载 .env → 渲染配置 → 起 RedTrace → 跑分
  bench/
    benchmark.py          # Challenges API 客户端（list/start/hint/submit/close + VPN 预检 + 错误映射）
    benchctl.py           # 跑分驱动器（单项目 + 每道题一个 Intent）+ worker 调用的平台命令
    render_config.py      # 环境变量 → redtrace.yaml 渲染
    prompts/scope.md      # scope（origin）模板：测评上下文 + 题目列表 + reason 规划规则
    selfcheck.py          # 离线自检
```

## 验证

```bash
python3 bench/selfcheck.py                 # 离线自检（不联网）
python3 bench/render_config.py --help      # 或直接由 start.sh 调用
```

## Docker 镜像（Headless Benchmark Runtime）

`Dockerfile.benchmark` 构建完全离线的评测运行时：RedTrace Headless Runtime + Claude/Codex/Pi Agent CLI +
四方向离线安全工具链（Web / Binary / AI / Blockchain）+ 离线数据语料 + 4 方向 Skill。运行期只允许访问
模型网关、TSecBench API 与目标地址，禁止 `pip/npm/cargo/go install`、`git clone`、`nuclei -update-templates`、
`solc-select install`。

```bash
# 数据语料必须固定版本（--build-arg 传 commit sha）
docker build -f Dockerfile.benchmark -t redtrace-x-benchmark:latest \
  --build-arg NUCLEI_TEMPLATES_COMMIT=<sha> \
  --build-arg SECLISTS_COMMIT=<sha> \
  --build-arg PAYLOADS_COMMIT=<sha> \
  --build-arg SEMGREP_RULES_COMMIT=<sha> \
  --build-arg JWT_TOOL_COMMIT=<sha> \
  .

# 断网离线验证（spec §27）
docker run --rm --network none redtrace-x-benchmark:latest bash container/verify-offline.sh
```

### TSecBench hosted upload image

`container/install-benchmark-extras.sh` is the shared installer for Semgrep,
Gitleaks, the Grype database, binary decompilers/debuggers, AI security suites,
the Solana/Move/Cairo/TON/Cosmos/Substrate toolchains, and curated offline
package caches. Linux deployment installs the same profile by default; set
`REDTRACE_INSTALL_BENCHMARK_EXTRAS=0` to skip it for a lightweight local setup.

On Windows, the following command resolves corpus commits, builds the image,
flattens it, runs the network-disabled smoke test, and creates a gzip-compressed
Docker archive under the hosted 3 GiB upload limit:

```powershell
./build-benchmark-image.ps1
```

The resulting `artifacts/redtrace-x-benchmark-upload.tar.gz` can be uploaded
directly. The platform can load it with `docker load` and the image starts the
benchmark automatically through its `CMD ["bash", "start.sh"]`; tokens and API
base URLs remain runtime environment variables.

镜像内目录（spec §23）：`/opt/redtrace`（只读能力：`app/`〔redtrace+bench+skills〕、`venvs/`、`data/`）与
`/data/redtrace`（运行时增长：workspaces/artifacts/sessions/audit/logs/output/tmp/redtrace.db）。构建时生成
`/opt/redtrace/toolchain-manifest.json`，并通过 `container/skill-tool-check.py` 做 Skill→Tool 一致性校验。

## 说明

- **整个评测 = 一个 RedTrace 项目**：`benchctl run` 只创建单个项目，把 scope（压缩后的测评上下文 + 题目列表）、
  goal、hint 注入；**任务编排交给 reason**——由模型按「分数随时间衰减、越早解出越高」自行规划每批解哪 3 道、
  最优顺序（`reason.max_intents: 3`），每题一个 Intent 交给 explore 并行解。
- **解题走 skill**：`skills/tsec-benchmark/SKILL.md` 是评测专用 skill，教 worker 用 `benchctl task start/context/submit/hint/close`
  驱动平台；scope 与每个 Intent 都指向该 skill，worker 再按题型加载对应 CTF skill 攻击 `container_addr`。
- `benchctl run` 只做平台侧的生命周期：VPN 预检、创建项目、轮询进度直至全部通关/超时/项目结束，最后统一 `close` 释放未关闭容器。
- 提示（hint）会扣分，skill 已要求 worker 仅在卡住且权衡后值得时使用。
