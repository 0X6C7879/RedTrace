# RedTrace 优化交付报告

> 2026-11-18 更新：本轮已继续修复原任务恢复中暴露的问题。用户最后要求停止真实任务验收；已通过原生 pause 暂停 `proj_001`，保留执行进度及未决结果。下文原阶段的“未重启/未真实运行”记录为历史记录，以末尾“本轮修复与验证”为准。

## 已完成

- **容量**：`maxSteps` 只限制每张 Graph 已认领且尚未释放的执行 Step。Pending 可无限排队，按优先级和依赖派发；检查与认领在现有 SQLite 事务中完成。Running、保留认领权的 Paused、结果 Unknown 保留名额；明确终态/取消释放。移除了创建容量参数和旧 Pending 计数语义。
- **Planner**：Benchmark General 迁为 Graph 级持久实体（`activity=plan`、`stepId=null`），保留原生 Session、STATE、TodoList、接力、暂停恢复、消息和事件唤醒。General 模式仍由 Project Commander 规划；执行 Worker 的 Step 才计数。保留简单题 Soldier 自主规划路径。实际 Worker、项目、运行项目及路由容量仍独立生效。
- **上下文/事件**：启动交付 Goal、Todo、活跃/排队索引、总数/范围/关系、近期证据及 Trigger；不再默认复制原始 Trace/Thinking/Prompt/工具输出。复用 events 表保存已交付/已处理双游标；仅成功结束规划轮次才提交处理确认。800ms 尾沿合并；失败、重启、接力保留未处理事件。15秒本地监督不触发无变化 LLM；有效证据、终态、消息、停滞会唤醒。
- **Trace**：默认摘要索引，支持关键词、after/before 分页和 eventId 原始详情；完整 Audit 不变。FGS Fact/Finding 只增不减。Todo 由实际任务规划者维护，完成需要真实 Fact；普通执行者不能写规划者 Todo。
- **Schema**：集中定义18个职责域，按角色/插件/具体 action 裁剪注册；原工具体仅内部派发，不同时向模型暴露旧名。WebShell、C2、FGS、Legion、Todo、HTTP、Knowledge、资源、远程文件和隧道等相关操作聚合；证据/报告等独立职责保留。保留批量操作及原始参数校验、安全边界；严格检查 action 所需字段、禁用和角色权限，旧会话也不能越权调用。
- **配置/UI/Audit**：旧启用/禁用与角色配置映射到域 action，读取时规范化、下次保存持久化；UI 显示 action 开关、角色可用性、Schema 大小及真实执行名额。新 Audit 统计保留 action；旧记录按原工具名折叠到域和 action，原始记录不重写。
- **Commander/Worker**：复用常驻 Session、60/90秒巡检、Board、原生 Compaction；Checkpoint 仅携带未处理指令，STATE 保留未完成动作和长期约束、建议150行内，不再复制持久 FGS/Board。Worker 默认对 Planner 仅交付摘要，原生 Spill/Terminal/Jobs/Compaction 保留。没有修改供应商、Reasoning Effort，也没有把 API 故障当作攻击失败 Fact。

## 关键位置与参考

- `packages/redtrace-engine/src/store.ts`：`planningCapacity`、`claim`、`claimPlanner`、`plannerEvents`、`plannerWakeAt`、`completePlanning`、旧 General 迁移。
- `scheduler.ts`、`legion-store.ts`、`legion-todos.ts`：认领/释放、Graph Planner 生命周期、Watchdog、接力和 Todo 所有权。
- `runner.ts`、新增 `run-trace.ts`、`legion-tools.ts`、`legion-missions.ts`：精简启动、分页 Trace、实际规划提示词。
- `packages/redtrace-dsh/src/tool-domains.ts`、`api-utils.ts`、`execution-tools.ts`、WebShell/C2：域 Schema、严格派发及插件注册；Engine `compat/cordis.mjs`、`legion.mjs`、`tool-catalog.mjs` 同步真实角色注册。
- Engine `config.ts`、`console-api.ts`、`tool-stats.ts`、`workbench.ts`；`static/index.html`、`static/console.js`；相关角色提示词及 Skill 文档同步。
- 实际参考 ARTEX `73d5437` 的 `graphOverviewData()`、`get_worker_trace()`、`TriggerEvent/renderTriggers()`；Sapper-v2 `7b75e6f` 的 Commander SKILL/Watchdog。未引入第二套执行器或调度框架，未重写已完成的 Commander Checkpoint。

## 可核验成本

测量是**真实 DSH 原生模型请求经本地 OpenAI-compatible 协议夹具**送出时的完整 `tools`，不是静态工具名猜测；不是付费远端模型攻击评估。每角色选择可比首轮，完整所有轮次 JSON 和静态角色目录保留。Token = `ceil(JS UTF-16 字符数/4)`，只作统一估算，不是实际 tokenizer/账单；字节数为 UTF-8。

| 角色 | Schema 数 前→后 | 完整 Schema 字节 前→后 | 估算 Token 前→后 | 降幅 |
|---|---:|---:|---:|---:|
| Benchmark Commander | 22→10 | 8507→6742 | 2127→1686 | 20.7% |
| Benchmark General | 23→10 | 12023→9875 | 3006→2469 | 17.9% |
| Soldier（有 General） | 72→42 | 42152→31708 | 10536→7925 | 24.8% |
| Scout | 60→39 | 32540→26388 | 8133→6595 | 18.9% |
| General 模式 Planner | 34→22 | 17965→15507 | 4490→3875 | 13.7% |
| General 模式 Worker | 69→40 | 40868→30571 | 10215→7641 | 25.2% |

以上含未改动的 DSH 原生/MCP Schema。RedTrace 自建 Schema 字节分别为：Benchmark Commander 8507→6742; Benchmark General 11553→9405; Soldier（有 General） 31622→21178; Scout 22010→15858; General 模式 Planner 10321→7863; General 模式 Worker 30338→20041。其他角色所有权、插件开关变化的实际 Schema 仍按请求裁剪；完整目录覆盖工具来源与角色。

Benchmark General 最小启动负载 `3349→3090` 字节（估算 `837→772` Token）。同输入的大 Trace 回归探针为 `102222→10525` 字节（估算 `25556→2632` Token，约89.7%下降），Audit 详情仍在。**不是所有角色启动总上下文都下降**：必要权限/执行语义说明使部分角色上下文增加；Schema 表不能替代整轮消耗、攻击成功率或延迟结论。

原始/对比证据：`/var/folders/l0/qt5vh8dd3mj49wyzx0c5xpww0000gp/T/redtrace-optimization-3jdl0y7t/SCHEMA-COMPARISON.json`、`requests-v5-before.json`、`requests-verified-after.json`、`schema-before.json`、`schema-catalog-final.json`。每次请求完整 Schema、名字、字节及估算成本可复算。

## 构建与测试（本 Session）

- 修改前所选基线：31通过、0失败。
- `npm run dsh:build`、Engine TypeScript check、`git diff --check` 均 exit 0。
- Engine 全套：451项，**450通过、0失败、1跳过**；DSH 全套：64项，**63通过、0失败、1跳过**。
- 新增/更新回归：10张 Graph 各10个 Pending、各自3个认领；General 同义；优先级/依赖/释放、Paused/Unknown、maxSteps=1 的 Planner+Worker、持久事件游标、失败重启/接力、尾沿合并、无事件不唤醒、健康活动不重复规划、Watchdog、旧数据库/配置/Audit统计迁移、Todo 权限、Schema 必填/禁用/旧会话拒绝、原始证据分页等。
- 本地原生 DSH Benchmark/General 端到端协议夹具均 exit 0；WebShell/C2 的10个 action、执行工具/资源/Knowledge/HTTP/证据/报告等现有测试均随全套通过。未把协议夹具的成功称为真实目标攻击成功。
- 桌面浏览器 1201×670 实验：3/3名额（Running+Paused+Unknown）、7个 Pending；WebShell action 开关保存后服务端一致；页面无阻挡覆盖层，采集 Console error 为空。`/var/folders/l0/qt5vh8dd3mj49wyzx0c5xpww0000gp/T/redtrace-optimization-3jdl0y7t/UI-VERIFICATION.json`，截图 `ui-actions.png`、`ui-capacity.png`。未做手机适配。

## 同输入前后/回溯

输入固定为1张 Graph、maxSteps=3、创建10个排队 Step：原实现 General 占1名额、只创建2个 Worker Step；修改后 General 占0、10个全部创建、最多3个 Worker 认领。外部副本回溯必须恢复原始哈希及原行为，再用补丁重建修改结果；不对工作目录回滚。

四个外部验收角色（不写入项目目录）：
- MODIFIED_FILE：`/var/folders/l0/qt5vh8dd3mj49wyzx0c5xpww0000gp/T/redtrace-optimization-3jdl0y7t/MODIFIED_FILE.tar.gz`
- DIFF_FILE：`/var/folders/l0/qt5vh8dd3mj49wyzx0c5xpww0000gp/T/redtrace-optimization-3jdl0y7t/DIFF_FILE.patch`
- VERIFICATION：`/var/folders/l0/qt5vh8dd3mj49wyzx0c5xpww0000gp/T/redtrace-optimization-3jdl0y7t/VERIFICATION.txt`
- ROLLBACK：`/var/folders/l0/qt5vh8dd3mj49wyzx0c5xpww0000gp/T/redtrace-optimization-3jdl0y7t/ROLLBACK.sh`

逐命令字面 stdout/stderr/exit、源码哈希、回溯结果与角色哈希分别保存在 VERIFICATION、`CHANGES.json`、`ROLE-HASHES.json`。项目源码/配置/提示词/UI 的实际修改清单可由当前 Git diff 查看；没有暂存、提交或推送，原有 `TOKEN-COST-AUDIT.md` 未改。

## 机制、影响及未验证范围

新增的认领准入、Planner 处理确认、事件合并/停滞唤醒、action 校验均为本次明确需求；复用原事务、事件、角色隔离和原生重试/轮询。**未新增额外控制机制**、全局锁、共享串行队列、依赖、MCP 或并行状态系统。工具聚合不扩大权限，执行并发仍由原独立容量约束；没有人为把并发改串行。预期减少重复规划/Schema，但真实吞吐与攻击成功率未做实测结论。

- 已实现并以隔离真实 SQLite 文件验证迁移；未重启生产 RedTrace、未改运行中数据库。部署后首次打开旧库执行迁移。
- 旧 General 没有可信“已处理”游标，迁移时保守从0交付已有事件，保留 STATE/Todo/原始归属；可能一次性重读旧事件，不自动重放 Worker 执行。此前无法凭空还原的处理确认仍是迁移限制。
- 跳过项：真实本地 Chisel 转发、真实 Ghidra ELF/PE 集成（环境依赖）。其余套件无失败。
- 没有对真实远端模型/目标做成功率、付费 Token、长时吞吐或供应商错误压力 A/B；不能据本地夹具保证这些指标。上线需重启现有服务才加载源码变化。

## 2026-11-18 本轮修复与验证

### 修复内容

1. **旧 Commander STATE 回流**：Benchmark 恢复、巡检折叠及 `legion_state` 读取统一使用调度 STATE 入口。未标记的历史战术 STATE 不再进入新请求，原记录和原生 Audit 保留；新调度 STATE 不再继承旧原生压缩摘要。补齐未处理用户指令的 `human` 来源。
2. **证据发布失败**：`submit_fact` 正确识别带文件路径的 HTTP `ev-*` 引用，校验真实字节哈希后晋升为 Graph 内 `artifact-*`。由 Audit 保留 HTTP 输出时，按生产 Run 的实际 workspaceRoot 查找原始文件，不再错误固定在项目根目录。Graph、路径、凭据文件及哈希边界保留。
3. **Unknown 解决后的所有权卡死**：明确解决最新 Unknown 后，同步取消其遗留 blocked Step，允许后继接续原 Todo；未解决的 Unknown 仍占名额，不自动释放、不重放。
4. **调度增量归属缺失**：保留事件的准确 `runId`、`nodeId` 和任务归属，避免把其他 Run 的 resolved 当作当前 Unknown 已解决；仍不向 Commander 注入 FGS 正文或原始攻击 Trace。
5. **巡检重复消费旧事件**：Benchmark `legion_wait` 必须显式提供已处理 `through`，未交付和倒退确认仍拒绝；首次无事件时可以显式确认 0。真实巡检确认点已从长期停留的 761 推进到后续事件，不再每轮从该旧点重读。夹具及直接调用同步更新。
6. **Planner 休眠时消息被拒**：只允许当前、未退休、等待下一轮的 Graph Planner 接收消息；发送方仍须活跃，同 Graph 与旧 Run/跨项目隔离保持不变。复用现有消息、事件唤醒及原生 Session。
7. **完成后的清理/验收死锁**：现有 General 可在平台完成、内部 Goal 尚未验收时派本题收尾 Worker；Commander 仍不能重派已解题或操作实例。搁置后的恢复仅唤醒现有 Planner，旧搁置攻击 Step 不重新排队，已有执行和 Unknown 必须先确认结束。实例关闭仍由执行 Worker、原适配器及原有检查完成。
8. **实例占用信息陈旧**：原只读平台刷新缓存实例状态、地址及刷新时间；Board 同时显示已完成却仍占实例的题目。状态无变化不制造新事件。未增加平台轮询频率或自动关实例机制。
9. **浏览器批注**：Worker `label` 按 Graph 与角色/自定义名称分别编号，多个从 1 开始，单个不带编号；移除题目标题下方的角色名单。Run ID、FGS 节点 ID、消息路由及历史归属均未改变。

主要源码：`/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-store.ts`、`store.ts`、`runner.ts`、`project-evidence.ts`、`legion-tools.ts`、`benchmark.ts`、`workbench.ts`，以及 `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs`、`prompts/benchmark-commander.md`、`/Users/lxy/Downloads/RedTrace/static/index.html`；对应测试与原生协议夹具同步更新。

### 已执行的验证

- Engine 最终全套：**465 项，464 通过，0 失败，1 跳过**。DSH：**61 项，全部通过**。Engine TypeScript 检查通过。新增 10 个回归，并扩展原有游标、权限、原生请求及 UI 断言；关键失败均先重现后修复。
- 浏览器实际核对 `a-02`：标题下不再显示角色长名单；成员列表与日志使用无后缀 Scout、General、Reporter，Soldier 在本图内从 1 开始；另一题独立编号。没有做手机适配。
- 停止真实验收前已观察到：`a-02`、`e1-05` 新获平台确认，平台确认题目由 10 增至 12；这不是完整任务成功率。
- `a-02` 的原 General 已通过新清理路径派出 Worker `run-57f3a672-554c-4a37-abcd-bc4a8efa7c8a`。首次 close 因并行执行尚未结算而被原检查拒绝，结算后返回 `{"unique_code":"a-02","closed":true}`；随后平台 list 为 stopped、地址为空，原 General 将内部 Goal 验收为 achieved。没有重新解题或重提交。原 `a-04` 已通过原生恢复接口续接既有进度，随后随项目最终暂停。
- 旧 `c-01` 先校验所属 Run 全部终止、无未确认调用，并保留证据，再通过原适配器关闭。平台实查发现旧 STATE 错把 `d-01` 当作实例占用者；实际第三个占用者是未完成的 `e1-05`，未盲目关闭。
- 两个 `flush` 异常 Run 在核对原生 Session 写归属与调用结果账本后，明确确认为取消；`run-a71cf7e5-3c9b-4dd9-82d9-e19e7bccf7f6` 仍缺一个 Bash 调用结果，保留 Unknown。未将不确定输出伪造为成功。
- 已从真实原生 `request/header.tools` 提取 Schema（无凭据），但没有同条件真实旧版 A/B，也没有实际 tokenizer/账单或攻击成功率降幅结论。旧成本表仍仅代表其标明的协议夹具测量。

### 最终状态、机制与限制

- 用户最新要求：**先完成修复，不再做真实任务验收**。已执行原生 pause，`proj_001` 为 stopped，4 个 Run paused、1 个 Unknown 保留；控制台服务仍可使用。不再启动新的真实模型或目标验收请求。
- 新增的旧 STATE 格式标记、必填处理游标及精确归属检查均针对已复现问题；未新增锁、串行队列、限流、重试、依赖、权限扩大或难度路由硬限制。曾尝试的 Soldier 难度硬拦截被既有 CyBench 契约测试否定，已撤销。并发配额、角色隔离和 Unknown 保留规则不变；标签处理只增加两次线性计数遍历。
- 原生后台 Job 的句柄随执行上下文重建可能失效；真实恢复时出现过 `unknown job`。没有因此重放旧未知命令，也没有把原生 Job 改造成另一套持久执行器。长时后台任务跨重启、全部 63 题完成、供应商压力与付费成本 A/B 不在本轮已验收范围。
- 保留全部原有未提交改动；没有暂存、提交、推送，也没有在项目目录添加临时探针、截图或运行日志。
- 本轮离线日志、失败重现、原生恢复/暂停回执、清理验收原文及补充角色验证，均位于既有外部验收目录的 `followup/continuation-*`。四个既有验收角色沿用上文绝对路径，并以补充记录扩展；回溯仅在外部测试副本执行，不回滚工作区或运行数据。
