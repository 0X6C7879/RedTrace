# Sapper AI Legion → RedTrace 迁移计划

日期：2026-11-10。状态：待实施；本次仅完成设计与源码核对，不代表功能已迁移或测试通过。

## 1. 目标与基线

依据引用聊天《分析迁移设计》的最终修正：允许独立 Commander，固定采用 General / Soldier / Scout 三种执行角色；优先迁移 Sapper 已有军规、Mission、协作与资源策略，不另造一套组织设计。较早版本中“不引入 Commander / 不固定角色”的建议不再采用。

- 目标仓库：/Users/lxy/Downloads/RedTrace
- 上游仓库：/Users/lxy/Downloads/sapper-v2
- 引用聊天：chatgpt-conversation://6af2cfe6-5818-83ee-8d6e-10f6652258c3
- RedTrace HEAD：a0eb09d87914146dd352c0fcb8d7fec16700df0e，但有大量未提交修改；本计划依据当前工作区内容，不能只用 HEAD 重现。
- Sapper HEAD：d4de0770ae1fba706f00b7e29197ce739adbea94；检查时仅见未跟踪的 .codegraph/。
- 不自动切换到旧聊天引用的 c91881dc，不混用不同版本提示词。若决定采用别的基线，应先整体比较军规、Mission、接口和测试。
- 本地 Sapper LICENSE 为 MIT；正式复制代码和提示词时保留版权及许可文件。

总体路线：Sapper 组织策略 + RedTrace FGS + DSH 原生会话。迁移行为与契约，不搬运 tmux/TUI 操作层，也不创建第二份任务图。

## 2. 源码核对带来的修正

| 已确认现状 | 对迁移的影响 |
|---|---|
| Sapper Scout 是短任务 Mission；worker.sh 没有通用 --role scout 参数，General 使用 --general | 三角色是明确的产品语义；RedTrace 的 role 参数属于适配，不能说成原接口直接复制 |
| Sapper SKILL.md、SPEC.md 与 worker.sh 的模型描述有差异；worker.sh 的默认模型还依赖环境变量 | 复用分层原则，不照搬 GLM/DeepSeek 名称和“免费/无限额度”假设；按实际配置测试路由 |
| Sapper SKILL.md 第 5 节的 85/90 协议针对 Commander，含迭代次数/压力信号等启发式判断 | Commander STATE 可直接迁移；精确 Worker 压力监测及自动换人是 RedTrace 新增适配，不能包装为现成能力 |
| RedTrace Activity 只有 decide/execute，TaskType 为 reason/explore/bootstrap | Worker 角色与执行类型分离；保留 execute/explore 路径，增加角色元数据；Commander 单独作为控制会话 |
| Run 强绑定 projectId，现有 Reason 提示词直接负责题目选择、同题扩编及实例释放 | 不伪造一个普通 Project 承载全局 Commander；明确 Campaign 控制域，并调整 Legion 模式的 Reason 提示词 |
| 一个 RedTrace Project 可以包含多道题，已有提示词明确支持同题多 Step | 不强行迁移成一题一 Project；显式绑定 projectId + 题目/目标标识，同题复用所在 Project 的 FGS |
| Scheduler.dispatch 会自动领取 pending/paused Step | paused 不能直接等同 Park；Park 必须排除自动领取 |
| Store.claim 的暂停恢复要求原 worker/backend，并复用旧 Run；SessionId 当前绑定 run.id | 恢复原会话与换人必须分开；换人创建新 Run/Session，不能修改旧 Run 的模型假装恢复 |
| notifyExplore 只允许特定 Reason→运行中 Explore 通知，agent.inject 不唤醒 idle Agent | 复用注入原语，但不能宣称已有任意 Agent 直接通信；需要补齐角色寻址、持久记录及 idle 交付语义 |
| Profile 已挂载 token-meter、compaction-basic、pruner、session persistence/checkpoint | 不重写压缩器；上下文压力使用 DSH 的有效上下文测量，不用累计 inputTokens 当占用率 |
| compat/llm.mjs 已有同 model ID 的跨 provider 轮询及符合条件的错误切换 | 先复用当前机制，不增加第二套 Key Pool/轮询；跨模型升级降级另走明确的交接路径 |
| knowledge.ts 已有文件型 FTS5 索引及刷新窗口 | 经验可先保存为结构化 Markdown 并复用索引；新增经验必须及时可检索，不能默认等缓存过期 |

现有生命周期实现散布于 Scheduler、Store 和 Cordis 适配层；本次未发现可以直接等同 Sapper Watchdog 全部能力的单一 Runtime Supervisor。计划只在这些现有路径补缺口，不新增独立守护进程。

## 3. 目标架构和决策归属

~~~text
Campaign（限定参与的 Project 集合）
└─ Commander：全局优先级、模型/资源分配、升级、Park、收官、跨题经验
   ├─ 简单任务 → Soldier
   ├─ 未知任务 → Scout → 难度报告 → Soldier / General
   └─ 困难任务 → General（自己执行主线）
                 ├─ Scout 专项侦察
                 └─ Soldier 专项验证

每个 Project：Reason 维护 Goal/验收与 FGS 结构
同题 Worker：共享所属 Project FGS；会话独立、执行结果可追溯
所有模型与工具执行：现有 DSH
所有执行 Run：现有 Scheduler → Store.claim → Cordis
~~~

### 必须先固定的职责

1. Commander 管跨题、跨 Project 的分配、升级和止损；不亲自执行侦察/利用。平台启动/关闭属于其决策，但通过既有平台工具执行，并保留认证和范围约束。
2. General 管被委派题目的具体路线和专项编队；不是第二个 Commander，不决定其他题目的资源与实例关闭。
3. Soldier 自主完成常规任务；Scout 执行短时侦察并给出难度与依据。动态职责通过 Mission 表达，不增加 Signalman 等新的固定角色类。
4. Reason 保留目标验收、FGS 整理和执行契约维护。Legion 模式下不再与 Commander 重复选题、分配全局模型或关闭实例；有 General 的题目由 General 主导局部战术。
5. General 的专项委派直接使用同一 Store 的 Step 创建/校验路径，绑定父 Step 和同题目标；不要求每次等待另一次 Reason 推理。Goal 的正式验收仍由 Reason 完成。
6. 同一题目的战术负责人记录在已有目标关联的组织元数据中，不能只写在提示词。Reason 可因目标取消/范围变化使计划失效，但不能同时另开一条冲突主线；现有 planVersion / plan-guard 契约继续生效。
7. 原有非 Legion 项目保持现有行为。接入以显式 Campaign 关联为界，不将所有现有项目自动纳入军团。

### 最小数据增量（拟新增，不是现有字段）

- Campaign：在现有 SQLite 中保存最小控制记录：id、参与 projectIds、Commander sessionId、状态、STATE/交接引用、可选任务截止时间。无第二个数据库，不复制 FGS。
- Step：可选组织元数据 role、parentStepId、taskKey。Mission 复用 description/sourceIds，不另建 Mission 状态机。taskKey 关联题目或目标，不能靠自然语言标题猜测归属。
- Park：建议 Step 增加明确 parked 状态及原因/恢复条件；同步类型、领取过滤、Store 更新、API schema、UI 和测试。题目级 Park 覆盖关联的全部活跃及待派 Step。
- Run：最小接力关联 predecessorRunId、handoff 引用；角色和模型的启动快照可从 Step/Worker 生成。原始日志、证据、用量留在原 Run。
- 消息：复用 run_events/audit 保存发送者、接收者、HELP/REPORT 类型、关联任务与内容；不另建消息总线。
- Experience：先用可索引的文档，含适用条件、方法、来源引用、失败边界和验证记录。暂不增加独立 Experience 数据库。

上述职责与状态调整会改变 Legion 项目的执行契约，属于本计划的核心设计，不作为普通“健壮性优化”隐蔽加入。

## 4. 上游复用清单

| 上游绝对路径 | 迁移内容 | 适配边界 |
|---|---|---|
| /Users/lxy/Downloads/sapper-v2/docker/commander/SKILL.md | 调度循环、战术纠偏、升级阶梯、Scout 分类、Park、收官、同族经验、STATE | 保留规则与顺序，替换工具名、路径、模型名称；平台特定时间/额度作为该任务策略，不硬编码进通用调度器 |
| /Users/lxy/Downloads/sapper-v2/docker/commander/SPEC.md | spawn/kill/msg/peek/list/board/hint 的行为与结果契约 | 冲突处以当前源码实况和选定策略为准，逐条记录差异 |
| /Users/lxy/Downloads/sapper-v2/docker/commander/worker.sh | default_mission、general_mission；Worker 管理语义 | Mission 主体迁移；Shell/tmux 控制改为 DSH/Store 原生操作，不整段复制不可用脚本 |
| /Users/lxy/Downloads/sapper-v2/docker/commander/watchdog.sh | 恢复同一会话、保留模型选择、截止收官的职责划分 | 不迁移屏幕解析、自动确认权限对话框、明文 rotated.env 或第二套重试循环 |
| /Users/lxy/Downloads/sapper-v2/BATTLE-REPORT.md | 实施阶段用于核对策略出处与测试场景 | 不是 RedTrace 实测成绩；本次未据此宣称效果提升 |
| /Users/lxy/Downloads/sapper-v2/LICENSE | 上游版权与许可声明 | 与移植内容一起保留 |

HELP/REPORT 不能原样都写成 RedTrace Fact：求助和未验证情报用消息/Observation/Hint；已验证结论才由 submit_fact/submit_finding 写入。

建议将移植提示词集中在 /Users/lxy/Downloads/RedTrace/skills/legion/，由薄加载逻辑按角色读取。新增内容标记上游 SHA 与改动理由，不维护一份长期闲置的 tmux 实现。

## 5. 实施顺序与阶段验收

### P0：固定基线与接口契约

交付：上游文件哈希/许可、提示词逐条映射、Campaign/角色/任务归属定义、旧模式与 Legion 模式职责表。

- 保存当前工作区基线，不覆盖或清理现有未提交修改；不自动更新 vendor。
- 建立一套最小离线场景：两道题、一个 General、两个专项 Worker、一次 Park、一次交接。
- 固定 spawn/kill/msg/peek/list/board/hint 的输入、输出、错误和作用域；接口名采用 RedTrace 风格，语义参照 Sapper。
- 明确 kill worker 与 close instance 不等价；close 必须等待同题 Worker 停止并确认提交/平台状态。

验收：每条上游能力可对应到“直接迁移、已有能力复用、必要新增、任务特定不迁移”之一；原有回归基线已记录，现存失败与新增失败可区分。

### P1：跑通一个最小军团闭环

交付：Commander 控制会话；三角色 Mission；Worker 创建、通信、查询、终止；基础模型映射；History 读取。

- Worker 继续走 execute/explore，仅增加角色选择；Bootstrap 不顺手改成 Scout。
- Commander 新建或恢复独立 Session；使用 Campaign 控制记录管理，不把它伪装成某题 Reason Run。
- spawn 创建有关联的 Step，由现有 Scheduler 领取，不绕过 maxWorkers/maxProjectWorkers/Worker.maxRunning。
- General 可派同题 Scout/Soldier，继承原 Mission 的最多两个专项小队和短时任务规则；这是上游要求，不扩展为新的全局限流系统。
- Worker 通过原生工具发送 HELP/REPORT；运行中用 inject，idle/重启时按 DSH 会话生命周期交付，不能误把 inject 当唤醒。
- peek 返回真实 Session/Run 片段；Hint 和消息持久保存，接力可读取已完成结果而非只依赖内存。
- 同题共享 FGS；沿用现有 direct/isolated 执行方式，不自行将全部 Worker 串行或复制工作目录。

验收：Commander 派 Scout → 收到分类 → 派 General → General 创建两个专项 Worker → 双向通信 → 结果写回同一 FGS → Reason 验收；原 Explore 回归仍通过。重启后能定位原 Session、任务和消息。

### P2：组织调度、Park 与基础 Board

交付：Sapper 策略循环、任务升级、战术纠偏、Park/Reactivation、收官；文本/JSON Board 和只读 UI。

- 按原 4.6 军规保留 Scout → 战术消息 → 不同角度第二 Worker → General → Park 的顺序；难题可由 Scout 判定后直接交给 General。
- 4 分钟侦察、10/20/30/45 分钟阶梯先作为对应 benchmark 策略迁移。通用渗透任务不无条件套用竞赛倒计时；策略由 Commander 执行，不另建固定时间调度器。
- Park 先阻止新领取并停止题目相关 Worker；确认停止和未决工具状态后再释放实例。Park 不是失败/完成，也不是 paused。
- Reactivation 必须有新情报、明确策略或收官决策；由 Commander 显式解除 Park，再从保存的图和交接信息继续。
- Board 从 FGS、Run、Campaign 和平台现状聚合，展示真实角色而非按模型名称猜 General；不维护平行任务状态。
- 基础 UI 复用当前页面与事件机制，不换前端框架。

验收：Park 后即使 Scheduler 多次 wake 也不重新启动；关闭一个 Worker 不影响同题其余 Worker；最后一个 Worker 停止后才允许释放实例；新 Hint 可以供 Commander 决策恢复；Reason/Commander 不重复派发；旧模式无行为变化。

### P3：上下文、交接与故障恢复

交付：Commander STATE、Worker Handoff、上下文压力展示、自动压缩复用、新 Run 接力。

- 读取 DSH tokenMeter 的有效上下文压力和模型窗口；缺数据时标记 unknown，不用累计 Token 编造百分比。
- 在约 85% 压力时请求保存 STATE/Handoff，复用原有约 90% 压缩策略的意图；实际触发需结合 DSH 预留输出和 headroom 计算，不能保证字面 90% 等于安全阈值。
- 压缩与换人分开：压缩后能继续就继续；明确轮换或压缩无法满足继续条件时，新建 Session 接力。禁止“每次达到阈值就强制换人”。
- Handoff 保存当前目标、FGS 引用、已证实进展、失败路径、工件位置、有效通道、未决调用及下一动作；不复制整份历史上下文。
- 换人先确认旧执行停止，再创建新 Run/Session 关联同一 Step 与前任；模型升级也可复用此路径。保留原 Run 日志和用量。
- pendingTools 非空或原结果不确定时保留 unknown/核验边界，不能自动重放有副作用的操作。
- Commander 恢复先读 STATE，再读实时 Board；STATE 保存决策记忆，不覆盖实时任务事实。
- Watchdog 职责落到现有生命周期路径：处理已确认可恢复的会话中断、清理资源、执行明确截止任务；不从“模型无输出”推断失败并反复重启。

验收：强制产生压力、压缩、Worker 换人和 Commander 重启；接力后不重复已完成 Step，不出现双活执行，不丢失 Fact/证据；未决调用不重放；旧 Session 断开与新 Session 模型选择可追溯。

### P4：模型分层与资源经济

交付：角色对应模型路由、运行时升级降级、Token 账本、额度处理和 Board 用量展示。

- P1 就提供 Commander/General→强模型、Soldier/Scout→经济模型的基础配置；本阶段完善动态调整，不让军团先全跑强模型再补配置。
- 复用 Worker provider/model/maxRunning、已有 maxWorkers 等并发限制和用量统计；不添加共享阻塞队列或全局锁。
- 同 model ID 的多 provider/Key 选择继续由 installModelPolling 处理；保留部分输出后不盲目切换等现有语义。
- 跨模型切换是组织决策，不混入透明同模型轮询；经明确交接重新启动，保持来源和计费可追溯。
- Token 消耗、当前上下文压力、提供商额度分别展示；无价格或额度数据时显示未知，不推算成真实余额。
- 预算以用户/平台已指定的约束为准，未指定时先记账和提供决策信息，不擅自新增总 Token 硬上限。任务截止时间同理。
- 环境变量由运行平台注入的场景继续支持；不在构建期因 BENCHMARK_* 缺失阻断启动。

验收：各种角色选到预期模型；并发计数与现有调度一致；同模型 provider 故障切换回归通过；跨模型接力不丢任务、不重复操作；用量与记录一致，不输出密钥。

### P5：Family Transfer 与经验库

交付：经验提炼、同族识别、检索、Hint/Mission 注入、目标任务复验和经验更新。

- 先迁移 Commander 的 family 判断与定向提示规则，不先建立自动分类服务或向量数据库。
- 文档记录技术族/版本前提、成功或失败方法、必要证据引用、适用边界；通过现有 FTS5 检索。
- 用当前 knowledge 索引能力接入经验目录；新增/更新经验后显式刷新受影响索引，不让 15 分钟刷新窗口破坏即时跨题复用。
- A 的经验以 Hint/任务输入传给 B，不把 A 的 Fact ID 或原始证据直接变成 B 的已确认事实。
- 跨 Project 只传授权共享且脱敏的知识；保留现有 evidence_read 的 Project 边界，不为经验功能放开任意跨项目文件访问。
- B 复验成功后产生自己的 Fact/Finding，并在经验文档记录复验；失败时更新边界，而不是覆盖 A 的原始结论。
- 已验证的新职责/战术先沉淀 Mission 模板，经复核再纳入军规；不允许 Agent 自动改调度器代码。

验收：A 完成后 B 可即时检索并接收经验；B 在验证前仍将其标记为未确认；不泄露项目凭据；错误经验不会误验收 Goal；来源可追溯且不依赖跨项目读权限放宽。

### P6：完整 UI、端到端对照与逐步启用

交付：军团管理、父子编队、Campaign Board、Park 队列、上下文/用量/接力/经验详情及可控操作。

- 操作型 UI 在相应后端状态转换验证后接入；继续复用现有授权与配置校验。
- 对相同授权测试任务分别运行旧模式与 Legion 模式，固定模型配置、并发和任务预算，记录完成率、耗时、Token、重复工作、停滞和接力情况；随机性用重复样本呈现。
- 性能验收：现有调度热路径不新增同步磁盘全量扫描、每次全图读取或不必要的模型调用；测量 Board 查询和通知的实际开销，不能只凭设计宣称无损。
- 先启用一个 Campaign，再扩展到多 Project；旧模式始终可用。

验收：模拟流程、现有回归、真实 DSH Session 和授权平台端到端分别记录结果。没有完成真实模型/平台运行前，不声称提升得分、降低费用或完成实战验证。

依赖：P0 → P1 → P2 → P3 → P4 → P5 → P6。基础模型映射在 P1，基础 Board 在 P2；避免把必要观测和配置推迟到最后。

## 6. 主要代码落点

| 现有绝对路径 | 计划修改 |
|---|---|
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/types.ts | Campaign/角色元数据、Park、Run 接力类型 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts | 组织关联持久化、创建专项 Step、Park/恢复/交接事务；保留 pendingTools 与验收边界 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/scheduler.ts | 按角色选 Worker、排除 Park、接力后新 Run 派发；复用并发及跨项目公平调度 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts | Legion 模式 Reason 职责、Worker Mission 组装、图工具与委派契约 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-contracts.ts | 同步受影响的 Step/Goal 工具 schema |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-api.ts | 同步 HTTP 状态与组织字段 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/cordis.mjs | Commander 会话挂载、通信、压力/交接、停止清理；接入现有 activateAgent |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/types.ts | 角色与任务运行上下文；不把 Scout/Soldier/General 全部复制成新执行引擎 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/agent.ts | 复用 activateAgent 的 create/resume；仅补实证需要的参数 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/state.ts | Commander 控制会话及角色运行态所需的最小注册调整 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/config.ts | 角色模型映射、Campaign 模式配置；保留现有加密凭据存储 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/config-api.ts | 对应配置读写和热更新 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/index.ts | 控制器与 Board 路由接入 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/llm.mjs | 主要复用，不另实现 Key 轮换；仅修迁移实测暴露的缺口 |
| /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/knowledge.ts | 接入经验文档与即时索引更新 |
| /Users/lxy/Downloads/RedTrace/profiles/redtrace/node.cordis.yml | 复用 token-meter/compaction/session 服务，必要时设置与 Legion 相符的策略 |
| /Users/lxy/Downloads/RedTrace/redtrace.local.example.yaml | 无凭据的角色与 Campaign 配置示例 |
| /Users/lxy/Downloads/RedTrace/static/index.html | 复用页面挂载 Campaign Board 和军团管理 |
| /Users/lxy/Downloads/RedTrace/static/fgs-view.js | Step 角色/Park/接力关联展示，不复制 FGS 状态 |

如需拆文件，建议仅新增 /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion.ts 承载控制操作，及 /Users/lxy/Downloads/RedTrace/static/legion.js 承载界面；是否拆分按实施后的体量决定，不先建立多层 Controller/Manager/Adapter 框架。

调用链必须一起检查：配置解析/输出 → 类型与 schema → Scheduler/Store → Cordis/DSH → 提示词与工具注册 → HTTP/UI → fixtures 与测试；不能只改 Mission 就宣称军团已接入。

## 7. 验证与交付规则

### 现有回归接点

- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/runtime-contract.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/wake-contract.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/reason-notify.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/scheduler-hot-path.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/current-fgs.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/llm-polling.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/knowledge.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/test/session-query.test.mjs
- /Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/test/event-projection.test.mjs

### 拟新增最小测试

- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion.test.ts：角色派发、同题委派、消息、职责冲突。
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-lifecycle.test.ts：Park、实例释放、重启、换人、未决调用。
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-experience.test.ts：经验检索、即时更新、未验证情报边界。
- /Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/test/legion-session.test.mjs：create/resume/new-session、压力与消息交付。

计划执行的命令，尚未在本次运行：

~~~sh
npm --prefix /Users/lxy/Downloads/RedTrace/packages/redtrace-engine run check
npm --prefix /Users/lxy/Downloads/RedTrace/packages/redtrace-engine test
npm --prefix /Users/lxy/Downloads/RedTrace run dsh:build:redtrace
npm --prefix /Users/lxy/Downloads/RedTrace run dsh:test
~~~

运行环境遵循仓库 Node >=24.15 <25 要求。测试 fixture 不依赖真实 Token；真实平台测试单列，不能以 mock 代替。

每阶段独立交付可审查的 diff、测试输入/输出、状态转换记录、配置示例和回退步骤。回退时先停止 Legion 会话，再解除 Campaign 关联，保留已生成 FGS/证据和审计；新增 schema 采用可保留数据的增量方式。涉及旧版本无法理解的 parked 状态，必须在回退步骤显式转为不会误启动的旧版状态；不得直接回退二进制后让旧 Scheduler 猜测。实施前对实际数据库做一致性备份，不能用 git reset 清除用户工作。

## 8. 不做的事与风险

- 不搬 Sapper JSON F-I 存储，不重写 FGS；Fact/Goal/Step/Hint 按真实语义映射，Intent 的行动主要对应 Step，目标才对应 Goal/SubGoal。
- 不引入 tmux、TUI 屏幕识别、自动权限对话框确认、明文 Key 池、第二个 Scheduler、消息总线、向量数据库或全局锁。
- 不把 Sapper 的平台实例上限、固定模型、额度价格和竞赛时长硬编码成所有任务的新限制。
- 不将共享 FGS 等同共享所有可写文件；保留现有执行隔离契约，专项任务明确输出位置，先测试同题并发是否存在实际冲突再决定补丁。
- 不新增未经任务要求的重试、限流、fallback 或权限体系；原有必要安全边界必须保留。
- 主要风险是双重调度、Pause/Park 混淆、旧 Run 重用导致重复副作用、跨项目经验污染，以及当前未提交的 DSH 变更与接口版本漂移。

本次实际变更：仅新增此计划文档；未修改程序、配置、依赖或运行数据，未新增额外控制机制。未运行构建、测试、模型调用或平台操作。命令工具的首次调用被本地 RTK hook 的 codex 子命令兼容错误阻断，未执行 Shell 命令；之后使用 Node 文件读取及只读 git 子进程完成核对。一次 read_thread 参数超过上限，修正为 20000 后成功获取引用聊天。

建议下一步仅实施 P0 + P1，首个验收目标是“一题内 Commander → General → 两个专项 Worker 的真实 DSH 闭环”，而不是同时改完全部策略和 UI。
