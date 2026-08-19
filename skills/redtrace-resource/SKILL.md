---
name: redtrace-resource
description: RedTrace Resource operations — snapshot, list, register, lock, unlock, credential management, and Resource vs Fact distinction.
---

# RedTrace Resource

Resource 操作方法。仅在需要手工操作 Resource 时加载。

## 核心概念

- Resource = 运行状态（WebShell、C2 Session、Credential、文件等）
- Fact = 黑板结论

## 命令

- `redtrace-resource snapshot` — 全部 Resource 快照
- `redtrace-resource snapshot --kind <kind>` — 按类型过滤
- `redtrace-resource list` — 当前 Resource 列表
- `redtrace-resource changes --since <cursor>` — 增量变化
- `redtrace-resource register --kind <kind> --name <name> --target <target>` — 注册
- `redtrace-resource lock <id>` — 加锁
- `redtrace-resource unlock <id>` — 解锁

## Credential

- 发现凭证时用 `credential-create --secret-stdin` 登记
- 禁止把 secret 放在命令行、Fact 或最终描述里
- 复用时从 credential_ref 资源的 secret 字段读取
