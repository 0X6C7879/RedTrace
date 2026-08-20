---
name: redtrace-blackboard
description: Query RedTrace Blackboard history, source context, graph paths, and cross-worker evidence when the current task needs information beyond the provided graph snapshot.
---

# RedTrace Blackboard

高级 Blackboard 查询方法。仅在需要跨 Worker 溯源或历史查询时加载。

本 Skill 对 Claude Code、Codex 和 Pi 使用同一接口：`redtrace-blackboard` 是注入 `PATH` 的 shell CLI，必须通过当前 Worker 的 shell/terminal tool 执行。它不是 MCP server、MCP tool 或 MCP Resource；不要通过任何 MCP 接口调用，也不要构造 `blackboard://` URI。

## 命令

- `redtrace-blackboard snapshot` — 完整黑板快照
- `redtrace-blackboard changes --since <revision>` — 增量变化
- `redtrace-blackboard node <node_id>` — 单节点详情
- `redtrace-blackboard context <node_id>` — 节点上下文链
- `redtrace-blackboard source <fact_id>` — 提交者的有界对话记录
- `redtrace-blackboard path <from_id> <to_id>` — 两节点间的路径

## 使用原则

- 先看 $REDTRACE_BLACKBOARD_NOTICE 中的增量，判断是否需要深入查询
- 只在当前 Task Graph snapshot 不足以回答问题时才查 source/context/path
- 不重复读取已确认的信息
- 按需查询，不批量预读
