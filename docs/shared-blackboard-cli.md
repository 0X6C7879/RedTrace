# Worker 按需访问共享黑板

`redtrace-blackboard` 是 Claude Code、Codex 和 Pi Worker 共用的命令行接口。默认命令只读；`submit-fact` 是唯一写命令，用于在不 conclude 当前 Intent 的情况下持久化增量发现。

## 行为边界

- Worker 自主判断是否调用、何时调用以及查询哪些节点。
- RedTrace 不推送变化、不自动轮询、不强制中断任务，也不把新增节点自动注入模型上下文。
- 初始 Prompt 只介绍用途和原则，不要求固定频率检查。
- CLI 仅发送 HTTP `GET` 请求，不暴露黑板写操作，也不使用 MCP。
- 每次调用只启动一个短生命周期 CLI 进程和一个 HTTP 请求；没有守护进程或后台订阅。
- SQLite 使用现有 WAL 模式，修订事件与黑板写入处于同一事务，可供多个并行 Worker 安全读取。

查询会追加一条审计记录，但不会修改 Fact、Intent、Hint、项目状态或黑板修订号。

## 命令

Worker 运行环境已注入连接和审计上下文，因此通常不需要填写全局参数。

```bash
# 与任务开始时的快照修订比较
redtrace-blackboard status

# 读取任务开始后新增的有限条目，默认最多 20 条
redtrace-blackboard changes

# 从指定修订继续读取；响应中的 next_revision 可作为下一次游标
redtrace-blackboard changes --since 42 --limit 20

# 读取一个 Fact、Intent 或 Hint
redtrace-blackboard node f003

# 读取两个图节点之间的有向最短路径
redtrace-blackboard path origin f003

# 读取节点的有界局部上下文
redtrace-blackboard context i002 --depth 1 --limit 30

# 执行中持久化重要发现，不结束当前 Intent
redtrace-blackboard submit-fact "确认 /admin 存在未授权访问"
```

所有命令默认输出易于模型读取的缩进 JSON。可用 `--compact` 改为单行 JSON。边界如下：

- `changes`: 1–100 条，默认 20；
- `context`: 深度 0–3，节点 1–50 个，默认深度 1、最多 30 个；
- `node` 和 `path`: 只返回指定节点或一条最短路径；
- 没有任何命令默认导出完整黑板、完整时间线、完整日志或原始证据集合。

`status` 返回 `changed` 和当前 `revision`；`changes` 返回 `next_revision` 与 `has_more`。默认 `since` 来自任务启动时的 `REDTRACE_BLACKBOARD_CURSOR`，也可显式传入。

## Worker 上下文

Dispatcher 在每个 Worker 进程中设置：

| 环境变量 | 含义 |
|---|---|
| `REDTRACE_SERVER` | RedTrace Server URL |
| `REDTRACE_PROJECT_ID` | 当前项目 |
| `REDTRACE_WORKER` | Worker 配置名 |
| `REDTRACE_TASK_TYPE` | `bootstrap`、`reason` 或 `explore` |
| `REDTRACE_PHASE` | 更细的执行阶段 |
| `REDTRACE_INTENT_ID` | 当前 Intent；Reason 没有当前 Intent 时省略 |
| `REDTRACE_BLACKBOARD_CURSOR` | 任务初始快照的修订号 |

本地执行通过 Python 包安装的 `redtrace-blackboard` 入口运行；项目 Workspace 同时物化同一份无第三方依赖脚本。容器执行把该脚本同步到 `.redtrace/bin/redtrace-blackboard` 并加入 `PATH`。三种 Worker 使用完全相同的命令和输出格式，已有项目容器会在下一次任务启动前同步，无需新增常驻基础设施。

## 服务端协议

CLI 查询调用以下只读接口；增量提交调用 `POST /projects/{project_id}/intents/{intent_id}/facts`。写接口只允许当前持有 working Intent 的 Worker 使用，并在同一事务中增加 `fact_yield`、更新 `last_progress_at`：

| 方法与路径 | 用途 |
|---|---|
| `GET /projects/{id}/blackboard/status` | 比较修订 |
| `GET /projects/{id}/blackboard/changes` | 读取修订后的新增/移除事件 |
| `GET /projects/{id}/blackboard/nodes/{node_id}` | 读取指定节点 |
| `GET /projects/{id}/blackboard/path` | 查询有向路径 |
| `GET /projects/{id}/blackboard/context/{node_id}` | 查询局部上下文 |

黑板内容变更由 SQLite 触发器记录为单调递增的 `blackboard_events.revision`。新 Fact、Intent、Hint 以及重开项目时移除的完成 Intent 都会产生事件；Worker claim、heartbeat 和审计写入不会产生黑板修订。

## 审计

每个成功查询都写入 `blackboard_query_audit`，包含：

- `request_id`、项目、Worker、任务和当前 Intent；
- 命令与参数；
- 查询时修订号和结果数量；
- 规范化 JSON 输出的 SHA-256 与字节数；
- 时间戳。

响应包含同一个 `query_id`，服务器日志也记录该 ID，便于把 Worker 工具调用、服务端查询和结果摘要关联起来。审计表不保存一份完整黑板副本。

## 验证

`tests/test_blackboard.py` 覆盖：

- 修订比较、增量读取、节点、路径和局部上下文；
- 审计上下文与输出摘要；
- CLI 环境变量、URL、请求头和 JSON 输出；
- 同一 CLI 源文件向 Workspace 分发并在容器归档中保持可执行；
- Claude Code、Codex、Pi 三类 Worker 在任务进程中获得相同的黑板访问上下文；
- 初始 Prompt 明确按需使用且禁止轮询。
