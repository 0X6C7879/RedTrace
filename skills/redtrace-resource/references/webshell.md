# WebShell Reference

WebShell 是一种 Resource（`kind: webshell`），由 Resource registry 统一登记、共享和审计。

## 相关命令

- `redtrace-resource webshell-create` — 注册 WebShell（协议填实际协议，method 只能 GET/POST）
- `redtrace-resource run --wait` — 通过注册的 WebShell 执行命令
- `redtrace-resource list --kind webshell` — 查找已有可复用的 WebShell
- `redtrace-resource get <id>` — 查看单个 WebShell 的元数据和支持的操作

## 典型流程

1. 需要执行命令时先 `list --kind webshell` 查看是否已有可用通道
2. 有就 `get <id>` 确认状态后复用；没有再自行利用漏洞建立
3. 建立成功后立即用 `webshell-create` 注册，趁通道在线、访问还在手
4. 注册参数不确定或失败时查看子命令 `--help`，修正参数重试；是否继续由你判断

注册是新通道的默认动作（其他 Worker 依赖它发现通道）；直接用 curl 操作未注册的既有 WebShell 仍然允许。
