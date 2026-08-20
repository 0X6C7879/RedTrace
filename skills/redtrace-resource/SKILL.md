---
name: redtrace-resource
description: RedTrace shared Resource registry. Hit this the moment you establish a reusable access channel — write/upload a WebShell, catch a reverse/bind shell, start a listener, bring a C2 session/beacon online — and register it so other Workers can discover it; also for reusing an existing WebShell/C2 session/credential/proxy/file instead of rebuilding, and for on-demand queries of shared assets. 触发词：WebShell、反弹 shell、reverse shell、bind shell、监听器、listener、C2 上线、session、beacon、复用通道、共享资产、注册 Resource。
---

# RedTrace Resource

Resource 是系统当前拥有的运行资产（WebShell、C2 Listener/Session/Payload、Credential、File、Proxy）。
Blackboard 上的 Fact 是结论；Resource 记录本身不进入 Blackboard，其他 Worker 通过本 registry 发现和复用资产。

`redtrace-resource` 是注入 `PATH` 的 shell CLI，不是 MCP server。通过终端执行下列命令（Codex 中使用 `exec_command`）；不要把命令名当作 MCP server，也不要为它构造 URI。

## 建立通道后立即注册

新建立的可复用通道默认注册——不注册，其他 Worker 无法发现它：

| 你刚建立的东西 | 注册命令 |
|---|---|
| WebShell（上传/写入成功） | `redtrace-resource webshell-create` |
| 反弹 shell / bind shell session | `redtrace-resource session-register` |
| C2 监听器 | `redtrace-resource listener-create` |
| 凭证 | `redtrace-resource credential-create --secret-stdin` |

- 趁通道在线、访问还在手时就注册，不要留到任务收尾
- 参数不确定看子命令 `--help`；失败后修正参数重试，是否继续、如何降级由你判断
- 注册失败不代表通道失效；如实记录已建立的内容和注册结果即可
- 注册成功后可在结论（Fact description）中引用 Resource ID，其他 Worker 会通过 `changes` / `list` 发现它

## 复用优先

建立新通道之前先查有没有现成的：

    redtrace-resource changes --since <cursor>   # 有信号时查看增量
    redtrace-resource list --kind <kind>         # 按类型过滤
    redtrace-resource get <id>                   # 读取单个 Resource

不要默认执行 `snapshot`；它会把大量 Resource 拉进上下文。
复用已有通道，不要重复利用漏洞重建。

## 共享文件与锁

- 共享文件协作用 `register --kind file` + `lock` / `unlock`，HTTP 423 表示他人持有锁
- 详细参数看对应子命令的 `--help`

## Credential

- 发现凭证时用 `credential-create --secret-stdin` 登记，secret 只走 stdin
- 不要把 secret 放在命令行、Fact 或任务描述里

更多细节见 [references/webshell.md](references/webshell.md) 和 [references/c2.md](references/c2.md)。
