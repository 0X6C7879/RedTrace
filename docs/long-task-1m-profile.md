# 1M 上下文长任务配置

RedTrace 的默认部署配置面向 1M 上下文模型和持续数小时的复杂任务。目标不是把所有原始日志直接塞进模型，而是扩大可用上下文预算，同时继续使用 RTK、Artifact 和按需查询控制重复噪声。

## 默认预算

| 配置 | 默认值 | 作用 |
|---|---:|---|
| `tasks.bootstrap.timeout` | 7200 秒 | 初始高能力 Worker 最长可直接推进 2 小时 |
| `tasks.bootstrap.conclude_timeout` | 1800 秒 | 超时或输出异常后保留已确认进展 |
| `tasks.reason.timeout` | 1800 秒 | 全图规划与长历史推理 |
| `tasks.explore.timeout` | 14400 秒 | 单个探索方向最长运行 4 小时 |
| `tasks.explore.conclude_timeout` | 1800 秒 | Explore 结束后的结论恢复 |
| `runtime.healthcheck_timeout` | 60 秒 | 兼容慢网关和冷启动模型 |
| `context_harness.inline_bytes` | 262144 | 256 KiB 以内的普通输出保持直接可见 |
| `context_harness.visible_bytes` | 131072 | 压缩结果最多保留 128 KiB 高信号信息 |
| `context_harness.query_bytes` | 1048576 | 单次 Artifact 查询最多返回 1 MiB |
| `context_harness.parse_bytes` | 67108864 | 最多分析 64 MiB 内容，原始 Artifact 始终完整保存 |
| `context_harness.worker_output_chars` | 33554432 | 每个 stdout/stderr 保留 32 Mi 字符的前缀和尾部窗口 |

这些数值是硬上限而不是目标使用量。Context Harness 仍应优先返回结构化摘要；只有下一步确实需要细节时，Worker 才通过 `redtrace-context query` 读取更大的局部内容。

## 已有配置升级

升级前可先检查：

```bash
uv run --project redtrace python scripts/apply-long-task-profile.py dispatch.local.yaml --check
```

应用配置：

```bash
uv run --project redtrace python scripts/apply-long-task-profile.py dispatch.local.yaml
```

脚本只会提高低于长任务配置的数值，不会降低用户已经配置得更大的预算。首次修改会创建：

```text
dispatch.local.yaml.pre-1m.bak
```

容器模式将路径替换为实际使用的 `dispatch.yaml`。

## Pi 自定义模型

RedTrace 的 Pi Provider 无法仅凭自定义模型 ID 推断上下文长度。使用第三方 API 时，Worker 环境必须包含：

```yaml
env:
  PI_MODEL_CONTEXT_WINDOW: "1048576"
```

迁移脚本会为所有 Pi Worker 自动补齐或提高该值。Claude Code 和 Codex 继续使用各自 CLI/Provider 的模型元数据；第三方网关本身也必须允许 1M 输入，否则仅修改 RedTrace 无法突破上游限制。

## 压缩原则

1. RTK 先减少扫描器、HTTP 和命令输出中的重复噪声。
2. Context Harness 将超大结果保存为完整 Artifact，并返回较大的结构化摘要。
3. Worker 根据下一步需求，通过关键词、行范围或字节范围查询 Artifact。
4. 上下文整理只移除重复过程，不删除已确认事实、认证状态、失败边界、证据路径和下一步动作。

1M 上下文用于扩大有效工作集，而不是无边界重复注入原始日志。这样既能支持长任务，也能降低上下文腐败和模型在大量低价值输出中丢失关键事实的概率。
