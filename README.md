# RedTrace

面向通用状态空间搜索的问题求解引擎。无需预定义角色与工作流——给定起点与目标，在未知状态空间中搜索可达路径。

## 核心概念

| 概念 | 含义 |
|---------|---------|
| **Fact** | 写入黑板的已确认客观发现 |
| **Intent** | 已声明但未执行的探索方向 |
| **Hint** | 人类随时注入的判断，下次读取时被 Agent 吸收 |

图从 `origin` 向 `goal` 生长。每个新 Fact 是一块垫脚石，每个 Intent 是踏入未知的一步。

## 架构

```
          ┌──────────────────────────────────┐
          │         RedTrace Server          │
          │    Facts + Intents + Hints       │
          └─────────────────┬────────────────┘
                            │
                     Read / Write API
                            │
          ┌─────────────────┴────────────────┐
          │           Dispatcher             │
          │   调度任务、管理容器/进程、        │
          │   写入 protocol                   │
          └──────────┬───────────────┬───────┘
                     │               │
     ┌───────────────┴──┐     ┌──────┴──────────────┐
     │  Worker (项目A)  │     │  Worker (项目B)      │
     │  ┌────┐  ┌────┐  │     │  ┌────┐  ┌────┐     │
     │  │ W. │  │ W. │  │     │  │ W. │  │ W. │     │
     │  └────┘  └────┘  │     │  └────┘  └────┘     │
     └──────────────────┘     └─────────────────────┘
```

**Server** 仅维护图一致性。**Dispatcher** 读图、调度任务、管理 Worker 生命周期，是 protocol 的唯一写入者。

支持三种 Worker 后端：**Claude Code**、**Codex**、**Pi**。

## 任务类型

| 任务 | 作用 | 产出 |
|------|------|--------|
| **Bootstrap** | 项目启动时直接尝试求解 | Fact + 可能的 Complete |
| **Reason** | 读取全图：目标是否达成？下一步探索什么？ | Complete / 新 Intent / 空 |
| **Explore** | 认领一个 Intent，执行探索，汇报发现 | 一个 Fact |

## Skills、MCP 与 Plugins

- `./skills/<name>/SKILL.md` — 三者共用的 Skills 源（Claude / Codex / Pi）
- `./mcp/<name>.json` — 共用的 MCP 配置，自动翻译为各 Agent 原生格式
- `./plugins/manifest.json` — 浏览器与 Burp 等外部插件的统一注册表；插件源码均位于
  `./plugins/`，不从构建产物反向读取

RedTrace 内置 `/api/plugins/v1` 外部插件接口，并兼容 CyberStrikeAI 插件使用的旧
`/api/auth/*`、`/api/projects`、`/api/roles`、`/api/*-agent/stream` 与取消接口。
迁移后的浏览器和 Burp Suite 插件默认连接 `http://127.0.0.1:8000`。若服务端不只
绑定回环地址，应设置 `REDTRACE_PLUGIN_TOKEN` 并在插件中填写同一令牌。完整契约见
[`docs/specs/plugin-compatibility.md`](docs/specs/plugin-compatibility.md)。

Web UI 中可直接创建、编辑、启用 / 禁用 Skills 和 MCP，也可在“设置”中新增、
编辑、复制、启停或删除 Worker。Worker 保存前会执行配置校验与连接测试；API Key
仍通过 `dispatch.yaml` 中的随机引用关联到本地加密存储，并在本地管理界面与配置接口
中明文回显，便于人工调试和配置。

## 快速开始

**环境要求**
- Python ≥ 3.12
- Docker（容器模式，本地模式不需要）

### Docker Compose（推荐）

```bash
cp dispatch.example.yaml dispatch.yaml
docker compose up --build
```

启动后可在 Web UI 的“设置”页面维护 Worker，无需手动编辑 `dispatch.yaml`。
Dispatcher 仅在文件原子替换后增量加载新配置；新任务使用新配置，运行中任务继续
使用启动时的配置快照。

### 本地模式（无需 Docker）

Worker 直接调用宿主机安装的 `claude`、`codex`、`pi`，并继续复用各 CLI 的用户登录、
全局设置、Skills、MCP 和扩展。设置页面中某个 Worker 同时配置 Endpoint、API Key
和 Model ID 后，这三个值会覆盖该 Worker 进程，并同步模型到运行 RedTrace 的用户级
CLI 配置：`~/.claude/settings.json`、`~/.codex/config.toml` 和
`~/.pi/agent/{settings,models}.json`。Claude 与 Pi 的原生 JSON 会保存网关密钥；
Codex 的密钥继续由 RedTrace 加密保存并通过 `OPENAI_API_KEY` 按进程注入，避免多个
Worker 共用 TOML 明文密钥。三项全部留空则回退到 CLI 原有登录配置。不同 Worker
仍可使用不同模型并行运行；原生用户级默认值以最近一次保存的同类型 Worker 为准。

Ubuntu/Kali 一键部署（自动切换中国 apt 镜像，并按缺失项安装 CLI、RTK、项目依赖和
安全 Skills 工具）：

```bash
bash deploy-local.sh
```

手动启动：

```bash
cp dispatch.local.example.yaml dispatch.local.yaml
REDTRACE_DISPATCH_CONFIG="$PWD/dispatch.local.yaml" uv run --project redtrace redtrace serve
uv run --project redtrace redtrace dispatch --config dispatch.local.yaml
```

### 测试

```bash
uv run --project redtrace --group dev pytest
```

## 免责声明

RedTrace 是通用问题求解引擎。虽然它支持渗透测试、CTF 解题、安全评估等场景，但仅限在已获明确授权的环境中使用。开发者与贡献者不对任何滥用、损害或法律后果承担负责。

## 许可证

本项目基于 **GNU AGPLv3** 许可。商业使用请联系获取商业授权。
