# RedTrace_X — 独立 RedTrace + TSecBench 评测接入

RedTrace 项目的独立副本，以**本地模式**运行，接入 [TSec Benchmark 平台](https://tsecbench.zc.tencent.com) 的
`Challenges API`（见 `CHALLENGES_API.md`）。跑分时由 RedTrace 的多 Agent worker（Claude Code / Pi，模型网关延用
`redtrace.yaml` 的 deepseek-v4-pro 配置）作为解题大脑，`benchctl` 驱动标准流程：

```
VPN 预检 → 列出题目 → 逐题：启动容器 → 建 RedTrace 项目(worker 解题) → 提交 flag → 关闭容器 → 汇总得分
```

## 使用

```bash
cd RedTrace_X
# 1. 只需填 BENCHMARK_TOKEN（其余模型/网关配置已按当前 redtrace.yaml 预置在 .env）
vim .env
# 2. 启动：加载 .env → 渲染 redtrace.yaml → 起 RedTrace(本地模式) → 自动开始评测
./start.sh
```

`BENCHMARK_BASE_URL` 默认 `https://tsecbench.zc.tencent.com`，`BENCHMARK_TOKEN` 在平台创建跑分任务后下发。
启动后会先做 VPN 联通预检（`http://10.0.100.58`），不通则中断。

> 依赖：`python3`、`uv`、`curl`，以及至少一个已安装的 Agent CLI（`claude` / `pi`）。
> 首次运行 `uv` 会自动构建 `redtrace/` 的 `.venv`（需联网安装依赖），之后可离线运行。

## 敏感配置

所有密钥/凭证只经环境变量读取，不写入代码包：

- `BENCHMARK_TOKEN`、`BENCHMARK_BASE_URL`、`VPN_CHECK_URL` —— 跑分平台
- `ANTHROPIC_BASE_URL/AUTH_TOKEN/MODEL`、`PI_BASE_URL/API_KEY/MODEL/PROVIDER_API` —— 解题模型网关

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

## 说明

- **整个评测 = 一个 RedTrace 项目**：`benchctl run` 只创建单个项目，把 scope（压缩后的测评上下文 + 题目列表）、
  goal、hint 注入；**任务编排交给 reason**——由模型按「分数随时间衰减、越早解出越高」自行规划每批解哪 3 道、
  最优顺序（`reason.max_intents: 3`），每题一个 Intent 交给 explore 并行解。
- **解题走 skill**：`skills/tsec-benchmark/SKILL.md` 是评测专用 skill，教 worker 用 `benchctl task start/context/submit/hint/close`
  驱动平台；scope 与每个 Intent 都指向该 skill，worker 再按题型加载对应 CTF skill 攻击 `container_addr`。
- `benchctl run` 只做平台侧的生命周期：VPN 预检、创建项目、轮询进度直至全部通关/超时/项目结束，最后统一 `close` 释放未关闭容器。
- 提示（hint）会扣分，skill 已要求 worker 仅在卡住且权衡后值得时使用。
