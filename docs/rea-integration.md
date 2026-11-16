# REA / redtrace-reverse

## 安装与启停

在项目根目录部署时执行 `npm ci`（锁定 `rea-agents@6.4.0`）、
`npm run dsh:build`。`build-dsh.sh` / `build-dsh.cmd` 与三平台 CI 已包含
根依赖安装。本次不构建 Docker。运行时不执行 npm/npx 下载或交互式 setup。

插件管理页中的 **Reverse Engineering** 对应 `redtrace-reverse`，默认启用、按需装载。
REA 默认开启，由 Explore 自主按需加载，Reason 不再通过 Step.requires/plugins 控制工具。
管理员明确停止会持久化禁用并撤销活动 Run 的本插件 Skill/MCP/分析能力，但不取消 Step 或阻止 Reason 规划。
历史 Step 声明仅兼容读取，新 Step 不保存这些字段，也不因工具声明触发 Replace。
每个启用插件的 Explore 都能发现官方 Skill 与 CLI；未加载 Skill 时 MCP 不连接、不启动分析引擎。
Explore 调用原生 `skill({name:"reverse-engineer-anything"})`，自动创建
该 Run 私有的 DSH MCP Client，不启动 Ghidra。
加载 Skill 后仅注册固定的上游 MCP-only 集合及六个需要复用同一 Program 的高频原生查询。
其余路径型分析通过 `node "$DSH_REA_CLI" --help` 查询并用原生 Shell 执行；
不再注册 `reverse_tools` 或按目标自动扩展类别。上游 CLI 每次打开/关闭自己的分析会话，
不能等价替换持久 Program、注释和内存 Evidence，因此这些 MCP 操作保留。


本地 `mcp/rea.json` 的服务器名保留给该插件，不再被全局 Domain 重复挂载，
其他 MCP 配置不变。已有 REA 配置不会被删除，其个性化引擎设置请放入
`common_env`（或启动环境中的 `REA_*`、`GHIDRA_INSTALL_DIR`、`JAVA_HOME`）。
CLI 仍由原生 shell 调用 `node "$DSH_REA_CLI" ...`，无需分析代理。
通用 shell 能访问系统安装的 rea，停用不是系统级执行禁止。

## 引擎与边界

遵循 [REA 官方实现](https://github.com/morluto/rea) 和锁定版本 npm 包；
官方 Skill 及其六个 references 原样放在 `plugins/reverse/skills/`，不进入
全局 managed Skill 根，不提前注入 Skill 正文。`plugins/reverse/upstream.json`
记录版本、审阅提交和逐文件 SHA256；测试对照安装包验证全部字节与相对引用。
现有 [DSH 原生 MCP Client](https://github.com/deepseek-ai/deepseek-harness)
负责通信、协议、输入校验、错误处理与连接关闭，没有第二套 MCP 协议。

部署 Ghidra 12.1.x 和 Java 21 后设置 `GHIDRA_INSTALL_DIR`、`JAVA_HOME`；
已有 Homebrew 安装自动检测，兼容已有 `GHIDRA_HOME`。按需要预装 JADX、
APKTool/JEB、ILSpy、Binwalk/Unblob、pwntools、Playwright 浏览器和相关运行环境。
IDA/Hopper 需要各自安装/许可证；设备、GUI 与权限由 REA 原生 Provider 检查。
单个 Provider 不可用不影响其他 Provider；返回上游结构化错误与 remediation，
不能在测评期间要求人安装、点击或批准。EVM、固件等仍受上游 OS/架构边界限制。

Ghidra 真正初始化可能发生在首个函数查询，而不是 open_binary；冷启动和
自动分析使用上游 330 秒启动预算，加 90 秒传输/清理余量，之后普通查询 120 秒。
JS 分析和显式 `analysis_timeout_ms` / `timeout_ms` 同样留出上游工作预算。
不改变 DSH 自动上下文压缩、Worker 并发、模型路由或 FGS 调度。

Run 生命周期拥有私有 REA 服务，底层 Ghidra 私有 project/process group 由
REA 原生监督器管理。DSH 关闭 stdio 后 REA 的 EOF/SIGTERM 流程释放分析
资源；插件还取消自己的活动调用并清理分配的临时目录。不共享 Worker/Step
Session 或缓存。复用同一 Run 的连接与分析 Program，不为查询重复启动引擎。

## Evidence 与零人工执行

默认优先 `detail:summary`、`inspect_analysis_view`、Evidence ID 与局部查询。
大于 8 KiB 的文本结果按 SHA256 保存于 Workspace `.rea/run-*/`，模型只接收
1500 字符预览与真实路径/摘要；相同结果不重复保存。它是**不完整预览**，
不是可当完整 JSON 解析的成功证据。完整原生值保留在工具结果中，图片走原生附件。
显式 `export_evidence_bundle` 保存的 bundle 和结果文件在停用后不删除；
**没有显式导出的 REA 内存证据不承诺跨 Run 持久化**。Fact/Finding 在现有
Store 中保留，必须由 Explore 验证后提交，REA Evidence 不自动升级成事实。

Explore 在 Skill 加载的同一调用内收到连接结果；缺依赖/启动错误返回
`{status:"unavailable", component:"rea_mcp", reason, fallback}`。
遇到 Provider 失败只尝试有意义的可用替代方案，输入/依赖没有变化时不重复
安装或重试。候选解答仍走既有验证、Fact/Finding 和平台提交契约。

## 旧能力处理

REA 是可用时的默认静态分析入口。精简 `ctf-reverse/SKILL.md` 中重复的
安装步骤和基础 Ghidra/radare2/IDA 命令，保留全部按需 CTF 解题 references。
`ctf-pwn`、`ctf-forensics`、`ctf-crypto` 的逆向指引同步到新入口。
不删除旧 `ghidra-headless` 批量导出脚本、Radare2/Rizin、GDB、angr、Z3、
Unicorn、Frida、pwntools。当前小型真实样本不足以证明全部旧批量导出、
平台/架构和解题行为等价，因此按硬约束保留，而非假称已完整替代。

## 可复现验收

```sh
npm run dsh:build
npm run dsh:test
npm --prefix packages/redtrace-engine run check
npm --prefix packages/redtrace-engine test
REDTRACE_REA_REAL_TESTS=1 node --test packages/redtrace-dsh/test/reverse.test.mjs
```

普通套件使用真实 DSH fibers、原生 MCP 和 REA；真实 Ghidra 样本仅在已部署
引擎时显式启用。测试自行生成已知返回 42 的 ELF/PE，不执行目标程序。
覆盖启停/重启/持久化、无关 Run 隔离、工具 Schema 实际消失、同 Run 连接
复用、大输出落盘与去重、保存证据保留、完整类别可访问，以及错误/取消清理。
以 Ajv 对全部上游工具示例和负例比较 compact/full 校验结果。

实际数据和环境限制记录在 `docs/rea-acceptance.md`；Mock/契约、原生引擎、
实际模型测评分别报告，不互相替代。
