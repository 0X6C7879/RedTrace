---
name: redtrace-workspace
description: Multi-worker shared file collaboration rules, file Resources, lock/unlock, and conflict handling when sharing workspace files.
---

# RedTrace Workspace

多 Worker 共享文件协作规则。仅在发生共享文件写冲突时加载。

**加载后首先执行：** `redtrace-skill recall redtrace-workspace`

## 约定

- 工作目录 = `$REDTRACE_WORKSPACE`（Runtime 自动设置）
- 所有脚本、PoC/EXP、日志、中间文件和证据都必须写在 Workspace 内
- 不得写入 `/tmp`、用户主目录或仓库外路径

## 文件协作

- 修改其他 Worker 可能同时使用的文件前，先 `redtrace-resource list` 查看对应 Resource
- 必要时 `redtrace-resource register --kind file --name <name> --target <workspace-path>`
- 然后 `redtrace-resource lock <id>`
- HTTP 423 时：改读、等待或写独立文件，不得覆盖
- 完成或放弃修改后 `redtrace-resource unlock <id>`
- 只读分析无需锁
- 每道已处理题目都要创建或更新可复用的通用解题脚本
