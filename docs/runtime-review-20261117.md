# RedTrace 运行复盘与改进验证（2026-11-17）

## 结论与交付状态

本次在 `/Users/lxy/Downloads/RedTrace` 原目录继续修复，没有提交、暂存或推送，也没有恢复用户停止的 Benchmark。先对照本机 ARTEX 与 sapper-v2，再用原生会话日志、只读运行数据库和本地可重复测试定位问题。没有对目标系统新增攻击请求。

最严重的问题不是单纯“统计显示太大”：Commander 每轮巡检重放不断增长的历史上下文，并参与了本应由题目规划者处理的战术分析。另有两条不同的停题路径：自主 Soldier 提前结束根 Step，以及 Commander 主动 Park；后者受到把停服时间算作执行停滞的错误指标影响。

修复已落到源码，并完成隔离预览、原生 DSH 模拟模型回归与全套相关测试。**原 8000 服务未重启，项目仍停止；新后端尚未部署到该原进程。** 不能把隔离测试结果当作真实模型上线后的费用结果。

## 1. 参考实现与取舍

| 参考 | 实际读取的实现 | 采用 / 未照搬 |
| --- | --- | --- |
| ARTEX `73d5437c5a64559ed803bcd096d2a0a0014a1214` | [agent/planner.go](/Users/lxy/Downloads/ARTEX/agent/planner.go) 的 `Plan`、每轮上下文与 Todo 注入；[server/engine.go](/Users/lxy/Downloads/ARTEX/server/engine.go) 的 Planner / Worker 独立循环、800ms debounce、NotifyDone、heartbeat | 采用每轮根据当前真实状态重建规划输入、持久计划与执行分离；没有复制其默认执行工具进入 RedTrace 规划角色，也没有把其内存 TodoStore 当成数据库持久化实现。 |
| sapper-v2 `7b75e6f1f5d5b4ae0c55878b0dd0994d9b08f1fb` | [docker/commander/SKILL.md](/Users/lxy/Downloads/sapper-v2/docker/commander/SKILL.md) §1、§2、§4.6、§5 | 采用全局 Commander 只调度、Board 驱动、STATE 保存决策、给 General 实际执行时间的边界。sapper 本身是长期会话加 85/90 压缩协议，**不是每次巡检都新建会话**。 |

RedTrace 的适配继续使用原有 Store、Scheduler、FGS、Todo 数据表、模型轮询和原生 DSH Session。没有引入第二套图、队列、调度服务或模型摘要调用。

## 2. 观测方法与真实运行证据

- 运行前段观测约 14:33–14:42（北京时间），使用只读 SQLite 连接与已有原生日志。最终再次确认项目 `proj_001` 为 `stopped`，运行中的 Run 数为 0。
- 原服务 PID 1774、端口 8000；本次没有重启、恢复、自动解除 Park 或修改原运行数据库中的 Todo / Goal / Step。
- 原生 Commander Session 的 JSONL 约 3.7MB。抽样包含约 42 轮巡检、192 条以上 assistant 消息、288 次工具调用及结果。随后用户停止时巡检计数到 44。
- 原生模型响应记录中的输入量从约 4,246 增到 452,100 Token。大块历史结果包括 Worker Run 阅读约 429KB、平台题目列表约 219KB、Roster 约 198KB、grep 约 99KB。这些字节是保留结果体积，不是费用。
- 停止时 Commander 累计：非缓存输入 **18,994,189**、输出 **107,239**、缓存读取 **34,976,640**、缓存写入 **0**，合计 **54,078,068 Token**。
- 同项目 Commander audit Run 的四个计数为零；实际累计来自 campaign。因此“同一笔 campaign 和 audit 被重复累加”**不是这次 54.08M 的实测根因**。仍统一了聚合口径，避免将来两个来源同时有值时重复计数。
- 只保留必要元数据到外部证据目录；本报告不复制原始攻击命令、目标凭据或 Flag。

观测脚本与脱敏计数：[observe.py](/tmp/redtrace-runtime-review/observe.py)、[samples.jsonl](/tmp/redtrace-runtime-review/samples.jsonl)。真实日志仍由原来的原生 Session 留存。

## 3. 根因、修复与行为变化

### 3.1 Commander Token 高：上下文随巡检次数线性膨胀

**根因。** 驻留 Commander 每轮只追加新 patrol 消息，旧 Board、Roster、工具输出、战术讨论全部继续成为下一轮模型输入。Commander 又能挂载文件与执行侧工具栈，提示词让其阅读工作区和进入攻击细节。全局状态维护者逐渐变成第二个题目级规划者，既重复输入，也重复思考。

**修复。** 在 Commander 空闲且没有待确认工具结果的巡检边界，使用 DSH 原生、写入日志的 `surfaceOp.replace` 折叠此前模型可见的巡检内容。保留受保护 system 首节点，以已有 STATE 中的决策 notes、当前简版 Board、未处理游标及人类指令作为新输入。原生原始事件不删除，Session ID 不变，不通过改写网络请求绕过 Session 权威。

Benchmark Commander 不再挂载执行侧工具栈；只注册现有全局调度、状态、通信、必要审计工具。提示词明确正常巡检不读整段 Worker Trace、不处理具体攻击链；异常调查仍可按需读取审计。General 项目模式和题目 Specialist 的执行工具不因此被削减，也没有修改 DSH 默认工具注册机制。

**影响。** 下一轮不再重放所有旧巡检结果；没有额外模型调用。STATE / 人类指令本身仍可能变大，这不是固定字节硬上限；异常时主动读取很长 Trace 也仍有成本。

### 3.2 b-01：自主 Soldier 提前把根 Step 当成完成

| 北京时间 | 真实状态 |
| --- | --- |
| 14:37:28 | 自主 Soldier 根 Step `i020` 经 `finish_step` 成功结束，但题目 Goal 仍 open。 |
| 14:39:28 | Commander 新建 `i023` 继续同题，说明此前结束不是目标验收。 |
| 14:40:44 | 用户停止项目。 |

**根因。** 原 `finish_step` 允许有部分 Fact 的题目级自主 Soldier 结束根执行，不要求 Goal 已验收，也不要求明确报告方向穷尽。调度要等下一轮 Commander 补人，造成“莫名停止”的空档。

**修复。** Benchmark 题目 Todo 的自主 Soldier 所有者，在 Goal 仍 open 时不能用 `finish_step` 安静退休。其应继续当前计划，以真实证据 `legion_accept`，或显式 `legion_task_stop` 如实结束未达成任务。后一个工具复用现有 Goal 取消与 STATE 路径，向自主 Soldier 开放，不虚构成功。执行单个 Step 的 Specialist 不受这个根任务结束条件影响。

### 3.3 f2-01：Commander 主动 Park，而不是未知崩溃

| 北京时间 | 真实状态 |
| --- | --- |
| 14:23–14:24 | 同一 General 根 Step `i021` 多次完成规划轮次；这些 Run 不等于多个独立 Planner。 |
| 14:26:45 | Commander 明确 Park `i016`、`i021`、`i022`，随后相应执行取消；Goal 仍 open。 |

Park 理由引用了长时间无 Fact 的判断。该题当时只有 Scope Fact，没有执行者产生的新 Fact，这部分确实没有进展；但停滞时长混入约 11:15 到 14:21 的暂停 / 离线间隔，不能作为近期有效攻击时间。

**修复。** `tactics` 从现有 `execute.started / paused / succeeded / failed / unknown / cancelled` 事件重建执行区间，合并并发时间，扣掉暂停与离线间隔。对于启动后发现的 `Process stopped…`，未确认区间最多计到最后一条真实模型 / 工具审计活动，不把下一次启动发现错误的时间作为真实执行终点。暂停区间仍按原终点截断，不被之后活动重新拉长。

这是调度建议的计时根因修复，不是新增自动恢复控制。没有强制推翻既有 Park；原始原因和恢复条件保留。界面直接展示“Commander 已暂停该题”，展开可看原原因，而不再只显示无活动。

### 3.4 Soldier Todo：有工具权限，但只留下初始化目标

原运行 Soldier 确有 `TodoWrite` / `legion_todos` 工具；问题不是 UI 隐藏完整计划，而是数据库没有实际拆出的多阶段计划，只有初始化目标，旧数据还可能被错误勾选。

复用现有 PlanGuard：题目级自主 Soldier 在首次攻击执行前必须写真实 Todo；初始化 Goal 单行、不带验收条件，无论旧状态是 pending 还是 completed，都不算已制定计划。读取图、证据、提交 Fact/Finding、规划与生命周期工具仍可使用，不阻塞必要的观察与交接。子 Specialist 不承担题目级 Todo 维护。

UI 显示所有者是自主 Soldier 还是 General；初始化目标明确标注为尚未拆解的规划，而非伪造已有阶段。Todo 完成仍走 Planner + 实际 Fact / 证据的已有验证，不从 Worker 完成状态、文字总结或 Finding 数量推导完成。

### 3.5 设置比例、待执行卡片、用量与停止状态

- 容量设置调整为桌面三列网格；短标题、独立说明、等高数字输入框，五项按 3+2 排列，不再让一个长标签撑低相邻输入。保留设置名、默认值、热加载及现有 **活跃 Step** 配置语义；不是新增累计 Step 配额。
- Benchmark 左侧按题目展示等待角色与原因；移除与会话并列、长任务描述撑开的孤立 pending-General 卡片。General 项目待调度项折叠展示。
- Commander 会话标题展示该项目 Commander 累计；题目会话展示该题 General / Soldier / Scout 等角色累计，排除其他题和 Commander。
- 区分输入、输出、缓存读取/写入。总览显示角色名并包含 Reporter，不让总数包含一个不可见角色。所有用量均标明“含缓存，非费用”，不据此估算账单。
- 用户正常停止项目不再展示成意外 Commander 调度错误；实际活跃项目上的 Commander 错误继续显示。停题状态明确区分 Goal 验收、未达成结束、Park、项目停止和等待规划。

## 4. 同输入 A/B：原生 DSH，而非字符串模拟

运行 [commander-patrol-boundary.fixture.mjs](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/commander-patrol-boundary.fixture.mjs)。本地 SSE 模型固定产生同样的两次工具交互，8 轮巡检 / 16 个模型请求；模型和工具均在本机测试夹具内，不访问真实供应商。

基线来自本轮修复前已记录的 compat 源码，不是人为制作的坏版本。两侧使用相同夹具、相同轮数、相同调度输出。测量完整 HTTP JSON 请求的 UTF-8 字节数，**不是 Tokenizer 测量，更不是收费测量**。

| 指标 | 修改前 | 修改后 |
| --- | ---: | ---: |
| 每轮首请求字节 | 15,347 → 26,783 → 38,219 → 49,655 → 61,091 → 72,529 → 83,969 → 95,409 | 13,218 → 13,514 → 后续稳定 13,514 |
| 第 8 轮首请求 | 95,409 | 13,514（减少约 85.8%） |
| 整个夹具最大请求 | 106,578 | 24,683 |
| 原生已记录上下文替换 | 0 | 7 |
| 原始 tool/call 事件 | 16 | 16 |
| 模型请求数 | 16 | 16 |

**没有靠删除审计或增加总结调用换取结果。** 真实模型的后续 Token / 延迟 / 费用仍需安全部署后再次观察，不能承诺同样的费用降幅。

## 5. 测试与验证

最终命令均在原项目目录运行，完整 stdout / stderr / 退出码保存到 [verified-results.json](/tmp/redtrace-runtime-review/verified-results.json)。

| 检查 | 结果 |
| --- | --- |
| `npm --prefix packages/redtrace-engine test` | 438 项：437 通过，1 跳过，0 失败 |
| `npm --prefix packages/redtrace-engine run check` | TypeScript 通过，退出 0 |
| `npm run dsh:test` | 63 项：62 通过，1 跳过，0 失败 |
| `git diff --check` | 退出 0 |
| 原生 Commander A/B | 两侧退出 0，修改后不再随巡检线性增长 |
| 本轮运行问题回归 | 9 项通过：计时并集、同 Run 暂停恢复和崩溃、Token 去重及题目范围、真实计划要求、根 Soldier 提前结束拦截、诚实终止、原生会话边界、正常停止展示 |

既有迁移测试一并覆盖：唯一 Planner、升级继承、Todo 数据库重开、Fact 验收与伪造/跨题证据拒绝、Specialist 权限、Planner 与三个 Worker 重叠运行、事件 debounce、heartbeat、前置 Fact、Worker Trace/Output 保留、Max Step 所有创建入口与批量原子回滚、满额时真实 Finding 不丢失。

本轮调试中出现过两个原生 Session 契约错误：替换范围包含 system 首节点、source.kind 使用保留的 plugin 值；均已按原生契约修正并回归。旧计时测试只改 Run.startedAt、未改实际开始事件，已同步修正夹具，不以放宽断言掩盖问题。一次误用 npm workspace 命令退出 1，已改为本项目正确的 `npm --prefix` 并重跑；失败日志留在外部证据目录。

跳过项为需要真实 Chisel 工具链的本地转发测试、真实 Ghidra ELF/PE 测试；并非本次修改后失败。

### 桌面界面验证

隔离预览使用停止时运行数据库的 SQLite 一致性副本、`autoStart:false`，端口 8001，仅展示新代码；原生会话历史只读来自原服务。验证后关闭临时页面和预览服务。没有将调试产物写入源码目录。

- [设置网格截图](/tmp/redtrace-runtime-review/settings-after.png)
- [Commander 用量截图](/tmp/redtrace-runtime-review/commander-usage-after.png)
- [b-01 题目用量与停止状态](/tmp/redtrace-runtime-review/b01-usage-after.png)
- [f2-01 Park 状态与角色用量](/tmp/redtrace-runtime-review/f2-usage-after.png)
- [Todo 所有者截图](/tmp/redtrace-runtime-review/todo-owner-after.png)（旧列表内容；之后补充的 legacy completed 占位识别由回归测试验证）

## 6. 本轮主要修改文件

下列路径均在原项目中；此次 diff 叠加在之前的 Planner 迁移和用户已有未提交内容之上，没有还原或覆盖无关修改。

- [compat/legion.mjs](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs)：巡检边界、上下文投影、Benchmark Commander 工具挂载。
- [benchmark-commander.md](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/benchmark-commander.md)：调度职责和轻量巡检。
- [legion-store.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-store.ts)：真实活动区间和停滞指标。
- [legion-todos.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-todos.ts)、[plan-guard.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/plan-guard.ts)：真实题目计划判定和执行前要求。
- [runner.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts)、[legion-tools.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-tools.ts)、[legion-missions.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-missions.ts)：根 Soldier 结束语义、显式未达成结束、任务提示。
- [token-usage.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/token-usage.ts)、[audit-api.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/audit-api.ts)、[workbench.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/workbench.ts)：统一用量来源、范围、所有者与等待原因。
- [index.html](/Users/lxy/Downloads/RedTrace/static/index.html)、[console.css](/Users/lxy/Downloads/RedTrace/static/console.css)、[workbench.css](/Users/lxy/Downloads/RedTrace/static/workbench.css)、[workbench.js](/Users/lxy/Downloads/RedTrace/static/workbench.js)：桌面布局、状态和会话用量。
- [runtime-review.test.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/runtime-review.test.ts)、[commander-patrol-boundary.fixture.mjs](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/commander-patrol-boundary.fixture.mjs)：本轮新增回归。
- [benchmark-scheduling.test.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/benchmark-scheduling.test.ts)、[cybench-dispatch.test.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/cybench-dispatch.test.ts)、[planning-concurrency.test.ts](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/planning-concurrency.test.ts)：真实事件计时与设置文案夹具同步。

## 7. 新增限制、性能影响与未验证事项

**明确新增的业务约束：** 题目所有者先写真实 Todo 再执行；自主根 Soldier 不能在 open Goal 上通过 finish_step 静默退休；Benchmark Commander 不再挂载执行侧工具。这些均对应已复现问题和用户要求，不是通用的防御层。Worker 单 Step 完成、已有安全校验和任务隔离保持不变。

其余复用原有模型重试、调度并发、Step 配额和状态机。**未新增额外队列、全局锁、重试层、限流器、超时器、Fallback 或配置项。** 计时从事件与审计派生，增加相应本地读取，不新增持久状态；Token 聚合共享单一实现并一次解析审计记录。Planner / Worker 不被改成串行；并行测试通过，但未做真实供应商吞吐基准。

尚未执行真实模型修复后 Benchmark，也未自动解除 f2-01 历史 Park、补写运行中 Todo 或伪造 Goal 达成。原服务必须在安全时机加载新后端；部署后首轮应核对请求输入量、状态继承和实际供应商账单口径，再决定是否人工恢复任务。已有巨额历史累计不会被清零，不能靠清计数掩盖成本。

本次已处理所观测路径，不声称穷尽所有运行隐患；未做手机适配、真实攻击重跑、真实 Ghidra/Chisel 硬件工具链验证。外部证据和截图位于临时目录，后续系统清理会使链接失效。
