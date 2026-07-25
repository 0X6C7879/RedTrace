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

## Skills 与 MCP

- `./skills/<name>/SKILL.md` — 三者共用的 Skills 源（Claude / Codex / Pi）
- `./mcp/<name>.json` — 共用的 MCP 配置，自动翻译为各 Agent 原生格式

Web UI 中可直接创建、编辑、启用 / 禁用 Skills 和 MCP。

## 快速开始

**环境要求**
- Python ≥ 3.12
- Docker（容器模式，本地模式不需要）

### Docker Compose（推荐）

```bash
cp dispatch.example.yaml dispatch.yaml  # 填入 LLM 端点与 API key
docker compose up --build
```

### 本地模式（无需 Docker）

Worker 直接在宿主机上作为进程运行，复用已配置好的 `claude`/`codex`/`pi` CLI：

```bash
cp dispatch.local.example.yaml dispatch.yaml
uv run --project redtrace redtrace serve
uv run --project redtrace redtrace dispatch --config dispatch.yaml
```

### 测试

```bash
uv run --project redtrace --group dev pytest
```

## 免责声明

RedTrace 是通用问题求解引擎。虽然它支持渗透测试、CTF 解题、安全评估等场景，但仅限在已获明确授权的环境中使用。开发者与贡献者不对任何滥用、损害或法律后果承担负责。

## 许可证

本项目基于 **GNU AGPLv3** 许可。商业使用请联系获取商业授权。
