---
name: redtrace-webshell
description: WebShell registration, operation, and lifecycle management via RedTrace Resource tooling when obtaining or operating webshells.
---

# RedTrace WebShell

WebShell 操作方法。仅在获取或操作 WebShell 时加载。

## 注册

- 用 `redtrace-resource webshell-create` 注册 WebShell
- 注册失败：查看该子命令 `--help`，修正参数重试一次
- 注册成功后必须改用 `redtrace-resource run --wait` 执行
- 不得继续手写 `curl ...?c=...` 绕过管理层

## 协议约束

- `protocol` 只能填写实际 WebShell 协议
- `method` 只能是 GET/POST

## 复用

- 先运行 `redtrace-resource snapshot --kind webshell` 检查已有 WebShell
- 跨任务复用匹配资源并按 ID 检查

## Resource ID

- 最终结论提到已获得 WebShell/RCE 时，必须包含对应 Resource ID
- 没有 ID 就继续注册而不是结束
