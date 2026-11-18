# RedTrace Token 消耗专项审计

审计日期：2026-11-17（北京时间）。对象：`/Users/lxy/Downloads/RedTrace`，HEAD `36a6ba2410bc7e04448b896cd338c0d73611561d`。**本次仅生成本报告；未修改业务代码、模型配置或运行数据库，未重启服务/Benchmark，未对真实目标发起请求。**

## 1. 总体结论

### 1.1 直接回答：General 每次醒来在做什么？

**不是严格地只处理新增 Fact 和 Worker 执行结果。当前实现每轮创建新的规划 Run/Session，重新装入任务快照和一段原始 Worker 历史，再由模型重新判断下一步；真实日志中已经发生重复读取。** 但也不能说“每轮把整库全部历史都读一遍”：代码存在行数窗口、FGS 标题折叠、STATE 和分页工具。

具体是：

```text
同一 General 生命周期 Step
  → 事件或 15 秒 heartbeat 到期
  → 新 Run / 原生 Session（正常结束后的下一轮）
  → STATE + 完整 TodoList + 最多 100 Goal / 100 Step
     + 最近 24 Fact/Finding 的 summary
     + 最近 12 Worker Run 元数据和各自最后 8 条原始 Audit 事件
  → 模型按需 read_graph / read_graph_delta / legion_read_run
  → legion_plan_done 保存文字 STATE，Step 回 pending
  → 下一轮重新执行上述装载；没有已处理 Trace 的跨轮高水位
```

调用链：[Scheduler.dispatch](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/scheduler.ts#L65) → [Store.plannerWakeAt / claim](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts#L898) → [executeDsh 启动/恢复](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/cordis.mjs#L357) → [launchContext](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts#L184) → [legion_plan_done](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-tools.ts#L135) → [finishRun](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts#L937)。

三轮真实 Planner 均属 f2-01、同一 Step `i021`，并未并发争抢规划权。第 2、3 轮启动间隔分别恰为前一轮结束后的约 15 秒；两轮间没有新增 Fact/Finding/Worker 完成事件，但 Worker 有新的工具活动。它们既读到新增执行过程，也再次读到已看过的旧事件。因此真正缺口是**“保留完整态势”没有与“增量处理执行记录”分离**，不是应该取消 General、FGS 或 TodoList。

### 1.2 总体成本判断

- 当前 Campaign 可核验的用量下界为 **89,882,953 Token**，含普通输入、缓存读取/写入和输出，**不是账单费用**。Commander 占 60.165%，Soldier 占 36.728%，General 占 2.931%，Reporter 占 0.176%。
- 这批历史的最大根因仍是旧 Commander 的历史重放：完整输入从 **4,246 增至 479,545 Token/请求**，累计完整输入 53,970,829；旧工具结果持续留在后续请求里。**该根因在仓库已有 `checkpointCommanderPatrol` 修复，本次没有重复实现。** 新代码的本地原生协议复核通过，但没有修复后真实模型数据。
- **下一项优先处理 General 的输入构造与读取协议。** 迁移后的三个规划轮次合计已计量 275,907 Token，10 个有 usage 的响应；另有 1 个无 usage 的响应。启动快照 19,181 → 50,732 → 44,020 字节，Trace 占其中 36.03% → 59.23% → 51.81%。
- 不能把 General 累计 2,634,185 全叫作“ARTEX Planner 浪费”：其中 **2,358,278** 来自迁移前允许 Bash 的旧 General 执行 Run。它与后续只规划的 3 个 Run 必须分开。
- Worker 的 919 个已计量响应也是重要成本面，但攻击链中的必要多步执行不能一律算浪费。已证实的是 Schema 基础负担、历史重放和部分重复回读；尚无证据给每次扫描/验证标出“无效”的 Token 数。

### 1.3 证据范围与版本界线

读取原生 JSONL、SQLite 只读事务、Campaign Usage、Audit、[2026-11-17 runtime-review](/Users/lxy/Downloads/RedTrace/docs/runtime-review-20261117.md#L1)，并读取本机两个参考仓库：

- Sapper-v2：`7b75e6f1f5d5b4ae0c55878b0dd0994d9b08f1fb`。
- ARTEX：`73d5437c5a64559ed803bcd096d2a0a0014a1214`。迁移文档另引用早期 `6997a466…`；本报告对成熟实现的比较以本机当前提交为准，不将旧版参数当作当前参数。
- 当前数据库：1 个项目，29 条执行 Run、30 条 Audit Run、3,460 条 Audit 事件；29 个有对应 Audit 的原生 Session 文件。另一个 Soldier Run 无 Session 文件、Audit 用量四项均 0，不虚构它的请求次数。
- 当前 `proj_001=stopped`、running Run=0；检查时 8000 端口无监听，runtime-review 所记 PID 1774 已不存在。没有进行启动或恢复操作。
- 原生记录覆盖约 **09:57–14:40**，不只是 runtime-review 的 14:33–14:42 采样段。因此终点、请求数和巡检次数比旧报告抽样更完整，并非新增运行。
- 扫描历史未找到 `redtracePatrolCheckpoint` 或 `compaction/*` 事件。不能用这批旧请求给新版 checkpoint 宣称真实 Token 降幅。磁盘遗留的 [生成宿主配置](/Users/lxy/Downloads/RedTrace/.redtrace/node.cordis.yml#L8) 仍引用旧 `candidate-test` 路径；因进程已退出，它只是部署溯源线索，不能证明今后会启动哪个代码版本。

## 2. 角色成本分布与统计口径

### 2.1 先核实 Provider 口径，避免重复相加

实际声明使用 `magpie` 的 `anthropic-messages` 协议。底层 pi-ai `api/anthropic-messages.js:495–504,655–668` 将 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens` 分别保留为互斥桶；[mapUsage](/Users/lxy/Downloads/RedTrace/vendor/deepseek-harness/packages/llm/llm-pi-ai/src/stream.ts#L24) 不再重复计算缓存。协议的完整输入公式与 [Anthropic 官方 Prompt Caching 文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 一致：

```text
完整输入 I = inputTokens + cacheReadTokens + cacheWriteTokens
已记录总量 T = I + outputTokens
```

`inputTokens` 在本报告专指**非缓存输入**；增长趋势/P50/P95 默认使用完整输入 I。`reasoning` 不另加一遍，已包含在供应商输出桶。`totalTokens` 是校验项，不再加进四桶之和。统计采用每条 `assistant/message.data.usage` 一次，而不是把 `stream` 中同一次响应的累计 usage 再加一次。

**核实边界：** 已核对客户端协议与映射、原生持久化计数和数据库的一致性；没有供应商原始 HTTP usage/账单，也没有 Magpie 网关的上游换算规则。因此只能确认“网关通过该协议报告的数值”，不能证明其缓存来自哪个上游、别名背后的物理模型、实际价格或计费折扣。缓存写入全为 0 不等于上游绝无缓存创建。

### 2.2 累计用量

| 角色 | 非缓存 Input | Output | Cache Read | Cache Write | 四桶合计 | 占已记录总量 |
|---|---:|---:|---:|---:|---:|---:|
| Commander | 18,994,189 | 107,239 | 34,976,640 | 0 | 54,078,068 | 60.165% |
| General（含旧执行 Run） | 278,566 | 69,283 | 2,286,336 | 0 | 2,634,185 | 2.931% |
| Soldier / Specialist | 1,072,660 | 251,877 | 31,687,552 | 0 | 33,012,089 | 36.728% |
| Reporter | 148,131 | 3,696 | 6,784 | 0 | 158,611 | 0.176% |
| Scout | 0（无记录） | 0 | 0 | 0 | 0 | 0% |
| 自定义角色 | 无运行样本 | — | — | — | 无法评估 | — |
| **总计** | **20,493,546** | **432,095** | **68,957,312** | **0** | **89,882,953** | **100%** |

Scout 的 0 是本样本中没有其运行记录，不是角色天然免费；Specialist 复用 Soldier 角色，没有单独 usage 桶。不把全局聊天或本地测试夹具计入 Campaign。

### 2.3 请求次数、均值与分位数

“计量响应”是能够还原四桶的响应，不等于供应商 HTTP 尝试总数。模型 Step 起点、带/不带 usage 的响应、失败 attempt 分别保留，不能拿 Audit Run 条数当模型请求数。分位数使用 nearest-rank，不插值。

| 角色 | Run 数（Audit） | 原生 model Step 起点 | 有 usage 响应数 | 平均完整输入 I | I P50 | I P95 | I 最大 | 平均四桶总量 T |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| Commander | 1 | 212 | 210 | 257,004 | 242,959 | 462,397 | 479,545 | 257,515 |
| General 合计 | 4 | 51 | 49 | 52,345 | 49,811 | 91,764 | 93,303 | 53,759 |
| Soldier | 23 | 932 | 919 | 35,648 | 33,170 | 63,085 | 93,568 | 35,922 |
| Reporter | 2 | 7 | 7 | 22,131 | 4,176 | 82,989 | 82,989 | 22,659 |
| Scout | 0 | 0 | 0 | — | — | — | — | — |

共 **1,202 个 Step 起点、1,192 条 assistant/message，其中 1,185 条带 usage，7 条无 usage；另有 6 条 assistant/attempt**。这些不是可以相加的独立请求计数：attempt 与 Step 属同一调用生命周期。尚有开始后无最终响应的 Step，不能断言“只有 1,185 次 API 请求”。

非缓存 Input 的 P50/P95/最大值分别为：Commander 4,716 / 372,283 / 463,798；General 1,566 / 18,722 / 62,349；Soldier 403 / 3,415 / 38,262；Reporter 3,614 / 82,989 / 82,989。Commander 非缓存输入波动很大，但完整输入始终累积；看低 P50 或缓存命中会漏掉问题。

增长趋势：Commander 第一/最后一个已计量响应 I 为 **4,246 / 479,545（约 112.9 倍）**；按时间排列前后各四分之一响应的均值为 **93,364 / 433,452**。Soldier 对应分组均值为 30,705 / 35,851，但它混合多个题、不同 Session，不解释为同一会话增长曲线。逐请求明细保留 session、seq、turn、step、时间、路由和四桶，不以聚合曲线替代单会话检查。

### 2.4 Commander 每轮巡检

原生 `patrol:true` 输入 **46 次**，其中 **44 次执行 legion_wait 完成巡检**；首轮和最终停止轮未正常 wait。不要把 44 次完成、46 次注入与 runtime-review 的抽样计数互相覆盖。分组以原生 patrol 输入边界划分，恢复沿用原 Session。

46 组的已计量消耗：总计 54,078,068，均值 1,175,610，P50 1,044,070，P95 2,225,126，最大 3,662,498 Token；每组平均 4.565 个带 usage 响应，最大 9 个。包含两组未完成巡检，因此均值不是仅成功巡检均值。每轮四桶见本报告附表 A；原始 CSV 可重新过滤完成轮次。

### 2.5 General 每轮规划：不能混入迁移前执行成本

| 阶段 / Run（前缀唯一） | 北京时间 | 模型 Step / 有 usage | 非缓存 Input | Cache Read | Output | 四桶合计 |
|---|---|---:|---:|---:|---:|---:|
| 旧 General 执行 `run-f7613d40…` | 11:00:13–11:14:31 | 40 / 39 | 187,736 | 2,123,264 | 47,278 | 2,358,278 |
| Planner `run-3d37e637…` | 14:21:50–14:23:24 | 6 / 6 | 32,767 | 106,496 | 13,908 | 153,171 |
| Planner `run-2202e118…` | 14:23:39–14:24:01 | 2 / 2 | 31,923 | 27,904 | 3,240 | 63,067 |
| Planner `run-98990031…` | 14:24:16–14:26:45 | 3 / 2 | 26,140 | 28,672 | 4,857 | 59,669 |

迁移后小计：Input **90,830**、Cache Read **163,072**、Output **22,005**、Cache Write **0**，合计 **275,907**；平均每轮 **91,969**。10 个计量响应的平均完整输入 **25,390**，P50 **22,756**，P95/最大 **37,071**。后两轮合计 **122,736** 是心跳触发轮次的已计量成本，**不是已经证明可全额删除的浪费**：其中确有新的 Worker 工具进度、必要监督与决策。

### 2.6 Worker 每个 Step

同一 Step 的多次 Run 合并一次；没有再加 `runs` 表累计值。Scout 无样本，Reporter 单列。完整四桶表见附表 B。

最重的 Soldier Step 为 c-01 `i003` **5,201,060**、c-09 `i019` **4,973,536**、b-01 `i002` **3,483,470**。这里给出成本定位，不据“花得多”判定攻击无效。

### 2.7 对账：token-usage.ts 是否重复加了历史？

[tokenUsage](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/token-usage.ts#L5) 的当前逻辑：

1. 按 Project / Graph / Run 过滤 Audit Run，四桶各加一次。
2. 项目级总览如有 Campaign Usage，**先减去该项目 coordinator 的 Audit 小计，再用 Campaign 生命周期账替换**；不是二者相加。
3. 题目或 Run 范围不再附加整个 Campaign。自定义 `task_type` 独立建桶；固定角色含 Reporter。

实测：28 个有 Session 的执行 Run，原生 `assistant/message` 合计与 Run 及 Audit **全部一致**；1 个无文件 Run 四桶为 0。Commander Audit 四桶为 **0**，Campaign 四桶与原生求和 **完全一致**。所以这次 **54.08M 不是 Campaign + Audit 双算**；累计总量 89.88M 也没有再叠加当前 Session 的同一笔用量。

本次重跑只针对去重口径的内存数据库测试，1 项通过、退出 0：

```sh
node --test --test-name-pattern='coordinator campaign usage' packages/redtrace-engine/test/runtime-review.test.ts
```

剩余计量盲区不是“重复加太多”，而可能**漏记**：[accumulateUsage](/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/audit.ts#L16) 仅计 assistant/message；原生压缩的额外模型 usage 位于 compaction/summary，不进入这条累计路径。失败/中断时缺 usage 也无法补齐。当前样本压缩事件为 0，不把潜在漏记算作已发生高消耗。

### 2.8 全盘 Session 清点：另有未关联当前 Campaign 的旧记录

本次共清点 `.redtrace/sessions/*/*/session.v4.jsonl` **33 个文件**，不是只挑当前 29 个。除当前 Audit 能关联的 29 个，另有 **3 个旧 Commander 命名 Session、1 个全局聊天 Session**。旧 Commander 日志在 11月13–14日，不在 11月17日当前 Campaign 的 sessionHistory/Audit 中；仅凭复用的目录名 proj_001 不能认定为同一 Campaign。

| 未关联 Session 前缀 | 北京时间范围 | 有usage响应 | 非缓存Input | Cache Read | Output | 四桶合计 |
|---|---|---:|---:|---:|---:|---:|
| `command-837ff853…` | 11-13 20:44–11-14 08:32 | 120 | 8,639,870 | 21,866,752 | 64,635 | 30,571,257 |
| `command-1ba9591c…` | 11-14 08:39–08:41 | 4 | 70,226 | 166,144 | 6,288 | 242,658 |
| `command-f6f4666a…` | 11-14 08:43–09:08 | 122 | 3,903,791 | 18,538,496 | 93,742 | 22,536,029 |
| 旧Commander日志小计 | **不并入当前Campaign** | **246** | **12,613,887** | **40,571,392** | **164,665** | **53,349,944** |

以上 Cache Write 均0，header 路由均 `magpie / auto/deepseek-flash`，未记录 reasoningEffort，不能补填 high。额外全局聊天为 1 个计量响应、Input 1,151 / Output 156 / Cache 0，总量1,307，也不混入角色 Campaign 分布。

因此 **89,882,953 是当前Campaign账本范围，不是整台机器历来总量**。磁盘中不同Session记录的历史usage另列53,349,944，未强行归入当前账；它说明历史Commander高消耗并非只出现一次，但缺当前权威Campaign归属，不能拿它计算本次每题成本、重放比例或优化收益。完整路径、哈希、时间和逐请求四桶保留在 [unlinked-sessions.json](/tmp/redtrace-token-audit-20261117/unlinked-sessions.json)、[unlinked-requests.csv](/tmp/redtrace-token-audit-20261117/unlinked-requests.csv)；未对这些历史记录或全局聊天做任何恢复操作。

## 3. 根因排名：已证实的重复与尚不能精确归因的成本

**排序限制：没有供应商 Tokenizer 的分段账单，不能把任意字节乘一个常数伪装“实际浪费 Token”。** 下表按实测受影响成本与冗余证据分层排序；“影响量”是归因范围/上界，不表示可全额节省。无法精排者明确标记。

| 排位 | 根因 | 实测影响与证据 | 当前状态 / 修复优先级 |
|---|---|---|---|
| 1 | 旧 Commander 每轮重放工具历史，并大量做题目级调查 | 53,970,829 完整输入；首尾输入放大 112.9 倍；最后已计量响应前仍保留 440,777 B Worker Trace、208,169 B 平台列表、174,229 B Roster 文本 | **仓库已修；只需部署后验收，不重复开发** |
| 2 | General 每轮重新装载原始 Worker Audit、无已处理 Trace 高水位 | 3 轮启动共 113,933 B；跨轮重复 Trace 事件体至少 15,886 B；第二次完整 read_run 中 9 条旧事件再次出现，占该结果约 30,408 / 63,340 B | **P1，先做增量输入/读取**；275,907 是三轮已计量成本，不等于全可省 |
| 3 | General 无具体结果通知包，15 秒心跳直接进入模型规划 | 两个新 Run 均在前轮结束约 15 秒后启动；期间只有 General 自身完成事件，没有 Fact/Finding/Worker 终态；后两轮已计量 122,736 | **P1，和排位 2 联合处理**，两项影响重叠，不能相加 |
| 待量化 A | Worker 工具 Schema 及长期原生会话内旧输出反复成为输入 | 919 个计量响应、完整输入 32,760,212；每请求工具表约 40–43 KB，累计逻辑暴露约 39,126,379 B | **P2**；有基础开销，但未证明 32.76M 中多少不必要，不能在实际浪费量上硬排第 2 |
| 待量化 B | 无变化/已覆盖内容的工具回读与输入套娃 | Commander read_run 33 次、Roster 39、平台列表 21、STATE 29；General Trace 含 Worker 自己收到的提示/上下文，而非仅执行结果 | 旧 Commander 部分已隔离；**P1 优化 General Trace 投影，P2 其他按需读取** |
| 待量化 C | 新 Commander checkpoint 保留的 instructions/notes 没有体积边界 | 所有历史 user/chief/global-assistant 不分处理状态进入 instructions；本样本该接收箱没有此类消息，已观测浪费为 **无样本可量化** | **P2**；代码风险真实，不能冒充本次 54M 成因 |
| 计量缺口 | 失败请求、压缩摘要未纳入统一 overhead 账 | 6 attempt、7 无 usage 响应，0 compaction；只有一条错误 attempt 报 0 usage | **P2 只完善计量**，不根据未知量删重试/压缩 |

### 3.1 旧 Commander：已定位、已修复，仍需区分剩余边界

源码：[checkpointCommanderPatrol](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs#L72)，[runCommander 巡检入口](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs#L161)，[Benchmark 工具挂载分支](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs#L124)。

函数仅在 idle 且 `pendingCalls.size=0` 时，以原生 `surfaceOp.replace` 替换受保护 system 首节点以外的巡检 surface；保留 Session ID 和原始审计。它**确实折叠模型可见历史**，不是仅把摘要存到数据库。若仍运行/有未确认工具结果则不替换，这个安全边界不能为省 Token 删除。

本次再次运行仓库已有纯本机原生夹具，退出 0：16 请求、16 tool/call、7 次 checkpoint，首请求字节 `13,218 → 13,514 → 13,514…`，最大请求 24,683 B。只用回环地址 SSE 模拟模型和隔离临时数据库，不访问真实 Provider/目标，也没有恢复用户项目。证据：[patrol-test.stdout](/tmp/redtrace-token-audit-20261117/patrol-test.stdout)、[patrol-test.stderr](/tmp/redtrace-token-audit-20261117/patrol-test.stderr)。

**但“每轮丢弃旧巡检”不等于整个输入硬有界：** notes 不限字节；instructions 无游标/总量限制；Board 只限行数。任务数量、人工指令、单条长消息仍可能使 checkpoint 变大。runtime-review 已说明不是固定字节硬上限，本报告不重复把该已知限制包装成新修复。

### 3.2 General：行数有界，却不是增量，也不是字节有界

源码：[taskPlanningContext](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts#L150)、[launchContext](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts#L184)、[General legion_read_run](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-tools.ts#L130)、[General 角色要求](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-missions.ts#L20)。

- `recentEvidence` 按 rowid 最近 24 条取值，**没有 `after` / 已处理版本过滤**，且包括 Scope origin。不是读全部 FGS，但每轮仍重复窗口。
- `workers` 按最近 12 Run，各取最后 8 条 Audit；**没有 event kind 过滤或已读事件游标**。8 条里可以包含很长的 `user.message`、thinking、工具调用参数和结果。
- `legion_read_run` 只有 `before` 向过去翻页，默认最后 100 条原文；**分页 ≠ 增量**。未传 before 的每次调用会重新覆盖最近窗口。它没有 `after` / 特定事件详情选择，也不保存跨规划轮次的阅读进度。
- STATE 是文字，Todo 是持久化列表，但没有结构化记录“哪些 Run 的哪些审计事件已经处理”。新 Session 不会继承前一轮模型未写入 STATE 的推理。
- `read_graph_delta` 的 deliveredGraphCursor 是 FGS 交付边界，不是 Worker Audit 的已处理边界；claim 又以当前事件最大 ID 初始化新 Run。它不能代替 Planner 对历史结果的处理确认，也不能解决 8 条窗口外未读结果的完整性问题。

**影响：** 随 Run/Trace 增多，重复输入、对旧结论重新归纳和定位游标的模型工具轮次增加。最小方向不是删历史，而是默认发当前态势索引+实际变动+未读执行片段，保留旧证据按 ID 取详情。

### 3.3 General：800ms 合并与 15 秒心跳

源码：[plannerWakeAt](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts#L898)、[Scheduler.wake / dispatch](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/scheduler.ts#L35)、[finishRun](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts#L937)。

800ms 是从第一条符合条件的事件时间计算的窗口，不是每来一条事件就重置的 trailing debounce。Fact/Finding、Hint、执行成功/失败/取消/未知、容量变更可促发；**并非任意 Step 状态变化都触发**。自身 General Step 的完成事件被排除，不会直接自旋；同一 pending Step 被 claim 成 running，也未发现多个同时规划的 Run。

但没有符合事件时，到 `lastRun.endedAt + 15s` 仍会启动完整模型轮次。两次实测分别为：

- `14:23:24.721 → 14:23:39.730`（15.009 秒）；
- `14:24:01.337 → 14:24:16.343`（15.006 秒）。

期间事件表只有 `i021` 自身 `execute.succeeded`，没有同题新的 Fact/Finding/Worker 终态；底层 Worker 工具活动并未作为明确的触发包提供。**这是无决策级变更时仍反复支付规划启动成本的证据，不是“800ms 导致每秒调用一次”的证据。** 样本不足以量化事件风暴时 debounce 的额外费用。

## 4. 重复上下文分析

### 4.1 General 启动快照逐轮拆解

所有字节均为 UTF-8；字段值长度按紧凑 JSON 序列化计量。字段内部事件体与外层转义长度不完全可加，百分比只作上下文构成参考，**不当作 Token 占比**。

| Planner Run 前缀 | 启动输入 B | Worker 包 B / 占比 | 内嵌 Trace B / 占比 | 旧 Trace 事件体 B | Todo B / 项数 | 本轮新 Fact/Finding |
|---|---:|---:|---:|---:|---:|---|
| `run-3d37e637…` | 19,181 | 8,865 / 46.22% | 6,911 / 36.03% | 0 | 62 / 1 | 仅既有 Scope；不是新攻击 Fact |
| `run-2202e118…` | 50,732 | 32,817 / 64.69% | 30,051 / 59.23% | 6,902 | 827 / 3 | 0 |
| `run-98990031…` | 44,020 | 25,575 / 58.10% | 22,808 / 51.81% | 8,984 | 827 / 3 | 0 |

可复现的重复点：

1. 第二轮沿用旧 Worker `run-8b7815ea-e6ae-4252-9be0-b0a4ec75c45f` 最后 **8 条**；第三轮这 8 条仍在。第三轮另重复了活跃 Worker 的 2 条，共 **10 / 16 条** Trace 事件已在前轮出现。按事件体字节，后两轮 Trace 重复比例分别 **22.98% / 39.42%**。
2. 三轮启动仅有一个 Fact/Finding 项，都是 Scope origin；第二、三轮并无新 Fact。当前 Scope 在顶层 `scope`，又在 recentEvidence summary 中出现；应保留授权 Scope 的权威表达，但不需要作为“新证据”反复包装。
3. 三轮中 `handoff.confirmedState === plannerRound.state` 均为 true，STATE 各重复两处；原始状态正文大小分别 **221 / 1,443 / 1,696 B**。这是直接可删的输入冗余，不涉及删攻击证据。
4. 第二轮新 Worker 的最后 8 条 Trace 中，**17,422 B 是 Worker 收到的三个 user.message 正文**，并非执行结果；其中一个运行上下文提醒就有 12,490 B。把 Audit 不加区分地当“执行结果”注入，导致提示词套娃。
5. Audit 的 `tool.completed` 为 UI 回显再次携带参数（[eventProjection 工具结果](/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/audit.ts#L127)）；活跃 Worker 的 started/completed 中，参数累计 32,052 B，其中 16,026 B 为对应调用参数的第二份。保留完整 Audit 是必要的，**问题是默认喂给 Planner 的投影**，不是应破坏原始记录。

TodoList 确实整表注入：[taskPlanningContext](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts#L154)，另在 [redtrace:task-planning runtime context](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/cordis.mjs#L278) 注册同一列表。后两轮 3 项 Todo 完全相同，各 827 B；第一轮另调用 `legion_todos` 读已提供的 62 B 列表。**Todo 占启动输入不到 2%，不是本样本 General 膨胀的主体**。当前源码存在 launch/runtime context 双入口，应复用一个权威最新快照；但 runtime-context 层会比较快照后才发提醒，不能说它每个模型请求都再 append 全表。参见 [RuntimeContextProjection](/Users/lxy/Downloads/RedTrace/vendor/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts#L124)。这里不假造每请求双份 Todo 的实测 Token。

### 4.2 `legion_read_run` 的跨轮重读与错误分页

| 规划轮 | 调用参数（省略固定 runId） | 返回 B | 返回 Audit 条数 | 与前轮同次读取重叠 |
|---|---|---:|---:|---|
| 第 2 轮 | `limit:60` | 31,247 | 9 | 首次读取 |
| 第 3 轮 | `before:1000, limit:40` | 833 | 0 | 空页，随后重调 |
| 第 3 轮 | `limit:60` | 63,340 | 23 | **9 条旧事件，事件体 30,408 B** |

三个调用都读 `run-04399cb8-1211-45cb-b21a-d086971a23d7`。真实 Audit ID 起于 **7560**；`before:1000` 混淆了游标空间，不能取得这些记录。之后不带游标重读最新页，旧事件随新增事件再次返回。参数/结果见原生 Run `run-2202…` seq10–11 和 `run-9899…` seq12–18；数据库 Audit IDs `7560,7561,7562,7563,7578,7579,7580,7583,7584` 重叠。

**重要计量限制：** 最后这个 63,340 B 结果在第 3 轮的最后一次模型 Step 前进入 Session，随后响应 seq21 没有 usage；不能声称这 63 KB 已全部计入该轮已知 59,669 Token，更不能给它编一个精确 Token 节省数。读取重复、默认投影重复已被实证，最后一次调用的计费输入仍未知。

### 4.3 Commander 剩余重复面

- **instructions：** [checkpoint 参数](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs#L161) 筛 sender 为 user/chief/global-assistant，随后 `.map` 全部历史内容与附件；无 processed/status/时间游标。已 admitted 的人类指令也会在每轮 checkpoint 重入，有 pending 时还可能同时出现在 followup inbox。**本样本 Commander 接收箱没有这类消息，故实际浪费量不可得，不能归因本次 54M。**
- **STATE：** [saveState](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-store.ts#L322)、[checkpointState](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-store.ts#L116) 不限实际字节数。当前 STATE **47,205 B**；其中 notes 3,267 B，board 9,909 B、allocation 10,597 B、tasks 11,205 B、graphs 12,061 B（字段序列化值，非互斥账单项）。它是覆盖写，且已有 wrapper 解包，**不是每次再嵌一层的无限递归**；但保留所有 Step/Graph 元数据会随任务历史增长。
- **新版正常巡检 checkpoint：** 已从 wrapper 中只取 notes，再加当前 Board，避免把整个 47 KB wrapper 每轮重放。fresh activation 的 followup 仍带原 STATE，第一轮/恢复轮存在额外重复。不能直接按 `47KB × 轮数` 算新版浪费。
- **Board / Inbox / Delta：** `boardSummary` 限 100 行，非字节硬上限；checkpoint 已带 Board，再调 legion_board 会重复当前概览。未处理消息也在 Board 的前 8 条摘要、inbox、followup 中有重叠。`readCommandChanges` 是调度元数据且有 delivered/acknowledged；只有在 `legion_wait(through)` 确认后才推进处理边界。**游标机制已存在，不需重造。**
- **旧运行频次：** STATE 29、Board 5、Inbox 19、Delta 1、Roster 39、read_run 33、平台列表 21。很多巡检在反复用 Roster/平台列表重建全局情况，而非直接复用轻量 Board。新提示词/工具隔离已改善条件，但没有真实上线数据可宣称所有这些调用已经消失。

最后一个带 usage 的 Commander 响应 seq1499，对应原生 surface 保留文本约 **1,246,356 B**：read_run 35.37%、平台列表 16.70%、Roster 13.98%、assistant 文本 8.18%、user 文本 7.34%、Board 0.96%、system 文本 0.42%。这是**保留文本 UTF-8 份额**，不含 Schema、JSON 外壳和隐藏 replay state，不是供应商 Token 占比；足以证明主要大块不是 STATE/Board 本身。

### 4.4 Worker、Skill、Schema 与外部 Evidence

源码：[executeDsh 工具挂载](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/cordis.mjs#L256)、[mountExecutionTools](/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/execution-tools.ts#L141)、[Spill 挂载/折叠](/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/spill.ts#L23)、[nodeContent](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/graph-content.ts#L12)。

- 实测 Soldier 每请求工具表 **73 或 79 项，40,508–43,035 B**；旧 General 80 项/44,402 B，迁移后 General **23 项/11,310 B**；旧 Commander 28 项/11,179 B；Reporter 6 项/3,299 B。**全局 Schema 注册总数不是每个角色实际提交数**，不能拿“约 156/157 个 Schema”直接乘所有请求。
- Soldier 工具 Schema 在 919 个计量响应中的逻辑字节暴露合计约 **39.13 MB**。没有精确 Tokenizer 拆分，无法声明其占输入多少 Token；缓存命中不表示这些上下文不存在。实际使用 28 个不同工具名，未使用不自动等于可删除权限，需按角色/能力配置评估。
- System Prompt 是角色/安全边界、工作区、资产、Skill 索引等组合，并非每一步都新 append 一份相同 system。DSH 的 system projection 有更新/替换逻辑（[SystemPromptProjection](/Users/lxy/Downloads/RedTrace/vendor/deepseek-harness/packages/core/agent-loop/src/runtime-context.ts#L74)）。反复参与请求的同一 system 是基础成本，不能把 UI 的 prompt 去重当模型输入去重。
- Worker 并未每次启动自动装完整 FGS：Benchmark 启动一般是 Scope、规划所有者/Todo、容量、handoff 等；单 Step 执行者按前置 Fact 读。`read_graph` 默认是 title 投影，Fact doc/evidence 外置，已有有效分层，不应倒退成全图正文。
- Skill 正文按 `skill` 工具加载，不是所有 Skill 全文预注入。实测 Soldier 11 次加载、合计 71,261 B；跨调用字节完全相同部分 46,998 B，但多为不同 Run 的合法加载，不可全额算浪费。
- Bash 792 次、结果正文合计 767,060 B、最大 27,850 B；工具调用参数和后续重放也有成本。发现 11 次同字节 Bash 命令重复、37 次命令包含 `sleep`，6 次 job_output 中 3 次 `wait:true`。**这只是候选定位**：扫描后验证、异步任务等待、环境状态变化可以合理重复；本次不把它们擅自删除、不把不同 Payload 当同一失败方向。
- 本来已有 Evidence / ProjectEvidence 分页（每次最多 7,600 B）和原生 Spill（maxInlineTokens=12,500）。General 不挂载执行栈/Spill 写入服务，其自动 launch 注入也不经过工具结果 Spill；Commander 新版同样不挂完整执行栈。**不是“项目没有输出折叠”，而是原始 Audit 注入绕过了已有轻量读取设计**。Reporter 的 read_execution 2 次结果为 120,780 / 229,153 B，说明按条数分页仍可能很大；其四桶累计仅 158,611，应排在 General 之后。
- 当前没有 Scout、自定义角色的真实样本；只能检查共用执行挂载路径、角色过滤和配置，不能宣称它们也有相同实测占比。未观察到可独立归因的 MCP 大块输出；MCP、Skill、能力工具应按需路由，不能为了省 Schema 直接砍必要工具。

## 5. 调度、路由、重试与 Harness

### 5.1 真实模型路由

| 角色 | 原生 request/header 的 Provider / Model | Reasoning Effort | 证据边界 |
|---|---|---|---|
| Commander | `magpie / auto/deepseek-flash` | `high` | 9 个持久 header 版本，后续同配置沿用 |
| General | `magpie / auto/deepseek-flash` | `high` | 旧执行 2 个 header，新 Planner 各 1 个 |
| Soldier / Specialist | `magpie / auto/glm-5.3-flash` | `high` | 28 个 header 版本 |
| Reporter | `magpie / auto/glm-5.3-flash` | `high` | 2 个 header |
| Scout | 配置为 `magpie / auto/glm-5.3-flash` | 配置 `auto_max` 可解析为 high；**无实际请求** | 不冒充实测 |
| 自定义角色 | 无运行样本 | 未知 | 无法给实际路由 |

当前配置和 [resolveReasoningEffort](/Users/lxy/Downloads/RedTrace/packages/redtrace-dsh/src/agent.ts#L35) 会从元数据取支持的最高 effort；请求 header 证实发出 high，**不证明网关实际执行了相应预算**。已经存在角色模型分层，不是全部用了同一高级模型。没有供应商价格/账单和质量对照，不能仅凭 `high` 或模型名称断言“所有角色都在用高价模型”。建议在消除重复输入之后再做轻量调度/简单任务路由质量评估，本次未改配置。

### 5.2 重试和 Session 接力的实际证据

- 原生 Session 中 `llm/retry`、`llm/polling`、`llm/polling-failed` 均为 **0 条**。6 个 assistant/attempt 中，Commander seq26 有 `INVALID_REQUEST`、usage 四桶归一化后为 0；其余 5 个无 usage。另有 7 个无 usage 的 assistant/message。**0 已记录额外 usage 不等于真实失败费用为 0**。
- 事件表有 **2 次 `legion.worker_restarted`**，分别关联 `i016`、`i019`；不把这些 Run 的全部累计都说成重试额外成本，因同 Run 可能含正常执行、暂停恢复，缺少逐尝试的供应商账。
- 原生 `compaction/*` 为 **0**，所以本样本可观测的压缩摘要额外消耗为 **未发生**，不是“压缩后没变小”。4 次 step.handoff_ready 也不能直接当 4 次模型压缩。
- 源码确有有限恢复：[watchdog](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/scheduler.ts#L115) / [recoverLegion](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs#L188) 保留未知工具结果，不自动重放；不能为省 Token 去掉这些必要生命周期保障。

当前实现的重试层次已核对：[providerProfiles](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/models.ts#L17) 设 normal 策略；原生 retry-policy 默认最多 5 次，[pi-ai adapter](/Users/lxy/Downloads/RedTrace/vendor/deepseek-harness/packages/llm/llm-pi-ai/src/adapter.ts#L164) 的 SDK 重试为 0，避免与 Harness 的可见重试重复。现有 [installModelPolling](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/llm.mjs#L43) 按**相同 Model ID** 轮询 Provider，失败前已有 usage 时将其合并进终态 usage；以后审计不能再把 polling-failed usage 与最终累计再加一遍。当前 magpie 的 `auto/…` 与 venus 的无前缀模型 ID 不相同，不能仅凭“配置了两个 Provider”就推断正在双重请求。

### 5.3 原生 Compaction 真的替换输入吗？

**代码上会替换，不是只保存摘要。** [commitCompactionBody](/Users/lxy/Downloads/RedTrace/vendor/deepseek-harness/packages/compaction/compaction-basic/src/region.ts#L470) 先记录带 usage 的 compaction/summary，再原生 replace 旧 surface；[RedTrace compaction hook](/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion-context.mjs#L18) 保存 handoff 并走已确认的接力路径。工具 pruner 也原生 replace 单个大结果，不删除原始 Audit。

当前 [Compaction 配置](/Users/lxy/Downloads/RedTrace/profiles/redtrace/node.cordis.yml#L14) 阈值 90%，maxTokens 4,096；RedTrace 在约 80% 压力时提示保存 STATE。原生 header 声明 contextWindow=1,000,000、输出上限=128,000。即使取已观测最大完整输入 479,545，加输出预留也约 607,545；**累计 54M 从来不等于单次窗口已到 90%**。没有压缩事件与这个量级一致，但 TokenMeter 是估计器，不用简单公式代替其完整模型路由测量。

若未来实际 compaction 后输入不降，首先核对 replace 是否落盘、是否仍注入大 STATE/启动历史/原始 Audit，再看 tokenizer 和 replay state；不是新增第二层模型摘要。当前证据不足以把“原生 compaction 无效”列为已发生根因。

### 5.4 并发与必要成本

General 的唯一生命周期 Step、Planner/Worker 独立 Run、FGS 依赖校验、真实 Fact 验收、题目隔离和 Max Step 是 RedTrace 的实际架构需要。每题一层 Planner 本来就比 Sapper 的单层全局调度多启动、Schema 和计划维护成本；不能为了追数字取消它。已有同 Step claim 与 pending/running 状态避免同时认领，不需加全局锁或第二调度队列。

本样本只能证明 3 个新 Planner Run 串行、Worker 可独立推进；没有在真实 Provider 上做吞吐/并发效果实验。优化应只改变“何时把哪些已存在信息喂给 Planner”，不把 Worker 等待 Planner、不延后关键 Fact 通知、不降低可用执行槽。

## 6. Sapper-v2 / ARTEX 对比

### 6.1 Sapper 为什么可以更克制？哪些已正确迁移？

参考 [常驻循环 §2](/Users/lxy/Downloads/sapper-v2/docker/commander/SKILL.md#L42)、[STATE / 85–90 协议 §5](/Users/lxy/Downloads/sapper-v2/docker/commander/SKILL.md#L260)、[cmd_peek](/Users/lxy/Downloads/sapper-v2/docker/commander/worker.sh#L514)。

| 机制 | Sapper-v2 当前实现 | RedTrace 状态 |
|---|---|---|
| 常驻 Session、固定巡检 | 不因每轮新建 Session；Board → 思考 → 最多两次决定性行动 → sleep60 | 常驻原生 Session、60/90 秒；新版边界 replace 已通过本机原生夹具 |
| STATE | fresh start 读一次；重大决定/上下文压力重写，建议小于 150 行 | 有持久 STATE、wrapper 解包、handoff、游标；没有行数/实际字节预算，notes/instructions 是剩余增长面 |
| Board 优先 | 同一轮复用已读 Board，HELP、预算、任务状态聚合，避免无目的全图调查 | 轻量 Board、100 行上限、调度 Delta 已迁移；旧运行更常调 Roster/平台列表/Worker Trace |
| peek 按需 | 默认窗口 40 行；异常调查才看细节，不是全员日志归档 | read_run 用 Audit 条数页，默认100且含原文/思考/提示；不像 peek 的窄摘要窗口 |
| 85/90 | 约85%重写 STATE，约90% Harness 自动压缩，禁止手动 compact | 80%保存提醒、90%原生压缩+接力；触发点并非逐字一致，生命周期设计一致 |
| 模型层级 | flash 大量执行、smart General 选择性升级、家庭/网关路由 | 已有 Commander/General 与 Soldier 两个模型别名；实际经济性未知，不能机械复制名称 |

**不要过度神化 Sapper：** 常驻 Session 同样可能重放两次压缩间的历史；`peek` 也不是持久已读游标，150 行是提示词纪律而非普适硬限制。本次未获得同任务、同 Provider、同预算的 Sapper 真实 usage，不声称已证明其每题比 RedTrace 便宜多少。其优势来自职责克制、Board 复用、窄回读和 STATE 接力组合，不是无限上下文免费。

### 6.2 ARTEX 如何减少历史重复？也有哪些重复？

参考 [NotifyDone / NotifyFinding](/Users/lxy/Downloads/ARTEX/server/manager.go#L2380)、[drainTriggers](/Users/lxy/Downloads/ARTEX/server/manager.go#L2475)、[renderTriggers](/Users/lxy/Downloads/ARTEX/agent/planner.go#L175)、[Plan](/Users/lxy/Downloads/ARTEX/agent/planner.go#L350)、[graphOverviewData](/Users/lxy/Downloads/ARTEX/agent/tools.go#L358)、[getWorkerTrace](/Users/lxy/Downloads/ARTEX/agent/tools.go#L1860)。

1. Worker 完成/发现时记录**具体触发项**，每轮 `drainTriggers` 取出并清空，Planner 先看到谁完成、输出与新 Fact ID，不用自己在历史 Run 中猜变动。
2. 每轮新 Agent，上下文不沿用无限聊天历史；TodoStore 跨轮复用。**它也会重新注入完整 Todo 与有界图概览，不是完全不重读任务状态。**
3. 触发项中的 Worker 输出限 800 个 Unicode 字符；图概览是 distill：open≤30、recent_done≤12、recent_facts≤20、finding_list≤10，加真实总数、父子/产出关系与 cold digests，而非最近 N 条原始审计。
4. Trace 默认列≤100字的步骤摘要/搜索定位，详情按 step_ids 获取且一次最多5个，**默认不含 thinking**；完整技术证据仍可按需回读。没有证明它存在永久“绝不重读”游标，它是通过触发包、摘要索引、按需取详情降低重读概率。
5. 当前 [plannerHeartbeatInterval](/Users/lxy/Downloads/ARTEX/server/engine.go#L859) / [MinPlanHeartbeatSeconds](/Users/lxy/Downloads/ARTEX/db/tasks.go#L98) 的 Planner 心跳**下限与默认均为 600 秒**；800ms 只合并事件。RedTrace 固定15秒并不等于当前 ARTEX 的成熟参数。

### 6.3 RedTrace 哪些差异必要，哪些是额外工程开销？

**保留：** 项目级 Commander + 题目级 General；统一 FGS 权威；数据库 Todo 与证据验收；跨题隔离；Worker 原始 Trace / Output；必要故障恢复；独立 Worker 并行与平台确认。ARTEX Planner 本机代码还挂默认执行工具，不能为了“对齐”恢复 RedTrace General 攻击权限。

**优先去掉：** General 新轮次无差别注入旧 Trace（尤其 user/system/thinking 包装）、同 STATE 两处、重复获取已分析的 Audit 页、没有变动说明的短周期全模型规划、已供给 Board 后再读等价 Roster。**保留完整态势索引，不等于默认重放全部证据正文。**

**先观察再定：** 完整 Todo 每轮的必要维护成本；79项 Worker Schema 的能力需求；攻击验证/失败方向的合法重试；高 effort 与模型别名的真实性能。没有实测因果，不作为删减攻击深度的理由。

## 7. 优化方案与修复优先级（本次不实施）

| 顺序 | 最小方案 / 代码落点 | 收益证据 | 难度 | 攻击成功率、速度与并发影响 |
|---|---|---|---|---|
| 已有修复验收 | 在用户确认的安全部署窗口加载现有 Commander checkpoint；核对首轮继承与下一轮完整输入，不重写该机制 | 原生16请求夹具不增长；旧53.97M完整输入 | 低，部署不是本次操作 | 保留 Session/Audit/未知工具保护；本次不启动 |
| **P1-1** | `launchContext` 默认只给全任务轻量索引+变动来源+未读 Worker 事件；复用 STATE 记已处理 FGS/Audit 高水位与 Run ID；保留旧节点/全部 Trace 按需读取。移除重复 handoff/state 之一 | 快照 Trace 占36–59%；重复事件体15,886B；STATE 两份完全相同 | 中 | 不减少已确认事实覆盖；必须对窗口外未读项给计数/分页、不能只留最后8条而漏结果；不新建队列/缓存层 |
| **P1-2** | 复用 Audit ID 给 read_run 增量范围/摘要索引/选定事件详情；标明游标空间。默认不把 Worker 输入包装、thinking、重复调用参数当执行结果；全文仍可读取 | 错误before1000空页；后续9条旧事件重读；ARTEX已采用摘要→详情 | 中 | 必要失败分析/验收仍读取完整真实输出，不能只信摘要；原始Audit字节不动 |
| **P1-3** | 在现有 `plannerWakeAt` / `legion_plan_done` 路径携带本轮触发种类与事件IDs；heartbeat 先做已有状态的轻量停滞检查，再决定是否进入模型。评估更长静默周期，而非盲调800ms | 连续两次15秒启动、122,736已计量；ARTEX当前600秒对照 | 低–中 | Fact/Worker终态/Hint保持立即事件驱动；长时间无进展仍可监督。不可一刀切延迟所有事件或把并行执行改串行 |
| **P2-1** | Commander checkpoint 使用现有消息状态/确认边界提供“当前有效约束+未处理指令”，保留历史查阅；notes 只存决策索引，完整STATE查询按需。Board已供给时不默认再读等价全局状态 | instructions代码无cursor；STATE47KB但正常轮已解包notes；实测此类人工消息0 | 低–中 | 不能简单丢弃已admitted但仍有效的人工约束；无硬截断证据/命令语义；不新增消息队列 |
| **P2-2** | 复用现有角色/能力工具设置减少确定不适用的 Schema 暴露；保持静态前缀稳定，按任务能力需要启用 | Soldier工具表40–43KB/请求；General权限隔离已从80降至23项 | 中 | 仅在调用者/Skill依赖核对后做，不以“历史没用过”砍能力；不新增框架/工具发现中间层 |
| **P2-3** | 统一 overhead 计量：区分正常响应、失败attempt、compaction summary、provider polling；沿现有Run/Session事件记录，不重复加最终合并usage | 当前7响应缺usage、压缩usage独立事件；既有汇总去重正确 | 低 | 不增加模型请求/同步阻塞；缺供应商usage继续标unknown，不估假账 |
| **P3** | 基于已记录错误和Fact依赖复盘Worker重复尝试；仅对确定同目标/同条件/同机制且无新增信息的重试调整任务提示；最后才做轻任务模型/effort质量对照 | Bash字节相同11次、sleep37次只是定位候选；非证明失败方向重复 | 中–高，需要用户批准的后续评估 | 攻击成功率优先；不删必要验证、证据读取或高级模型推理，不新增全局失败方向拦截器 |

首批建议范围：**只做 P1-1/P1-2，再评估 P1-3**；先让每次醒来处理增量、把完整历史留在按需证据层，再决定是否需要改心跳。三者影响相互重叠，禁止将收益百分比相加。

后续验收（仅列标准，本次没有执行优化）：

- 同一冻结任务、同一事件流与同一模拟模型下比较输入、输出、工具次数；保留完整Todo/Goal/已知Fact集合、失败/未知结果和并行派发结果。
- 两个新执行事件只处理新事件；无新结果/无监督动作时不重新读旧完整页；已分析事件可以显式回查，但默认不重复注入。
- 决策验收仍读取实际保留证据；不根据完成状态、摘要或Finding数量接受Goal。
- 对历史超过窗口、Worker运行中推进、事件落在Planner执行期间、暂停/恢复/接力、同一批Fact+完成事件合并分别验证，不能把“游标推进”错误当成“处理完成”。
- 部署后只有经用户确认，才通过自然运行观察真实Provider Token/延迟/成功率；本次不为验收重开Benchmark或请求目标。

## 8. 预期效果、量化边界与交付核验

### 8.1 可以给的数据依据

| 项目 | 可支持的估计 | 不能承诺的部分 |
|---|---|---|
| 已有Commander修复 | runtime-review同输入A/B第8轮首请求95,409→13,514B，**85.8%字节下降**；本次重跑新版仍13,514B稳定，16请求/16工具原始事件不变 | 不是实际Tokenizer或账单下降85.8%，不能把历史54.08M全部视为可退还 |
| General仅去跨轮重复Trace事件体 | 三个启动包共113,933B，重复事件体至少15,886B，约**13.94%启动正文的可避免重复量级**；两个后续窗口分别约22.98%/39.42%为旧Trace事件体 | 结构外层转义、Schema和每轮后续请求不同，不能直接说General Token下降13.94%；重复数据若确需复核也不应机械删 |
| General read_run增量/索引 | 第三轮63,340B返回中，9条旧事件体30,408B，约**48.01%该工具结果体**；可避免无差别完整重读，空页833B也可避免 | 该结果后请求无usage，**Token节省不可量化**；不能把必要新增14条事件一并删掉 |
| General静默心跳频次 | 当前静默极限约240轮/小时（忽略规划时长/容量）；600秒约6轮/小时，**定时触发频次理论少97.5%**。真实样本两次15秒轮已计量122,736 | 是频次上限对照，不是总体Token降97.5%；这两轮有工具进度，是否全可省需监督语义检查；不建议直接全改600秒 |
| Worker Schema/输入分层 | 已定位40–43KB/请求、919响应约39.13MB逻辑Schema暴露，适合能力级核减评估 | 无模型Tokenizer分段数据和质量对照，**不能给可靠Token/成功率降幅** |
| 模型路由、API重试、压缩费用 | 本次只可报告实际别名/effort和usage缺口 | 无价格、供应商账单、失败usage、修复后真实样本，不计算人民币费用、全项目节省比例或达到Sapper的精确差距 |

**总体预期：能确定消除重复上下文和读取轮次，不能据本批数据诚实给出“全项目降 X% Token/费用”的单一数字。** 最大历史异常已有修复；General 是当前明确可复现、应优先处理的下一处根因，但现有真实迁移后样本只有一题三轮。不得把旧Commander收益、General快照收益、心跳收益、Schema收益加总成虚高承诺。

### 8.2 可复核材料

报告主体包含全部聚合、逐规划轮、逐巡检和逐Step数据，原始攻击日志不复制进报告。脱敏派生材料位于项目外：

- [analyze.py](/tmp/redtrace-token-audit-20261117/analyze.py)、[deepen.py](/tmp/redtrace-token-audit-20261117/deepen.py)：只读SQLite及原生日志分析，未导入运行中的Engine或调用执行API；统计脚本自检通过。
- [requests.csv](/tmp/redtrace-token-audit-20261117/requests.csv)：**1,185** 条带usage响应，含Session、seq、turn、modelStep、时间、角色/路由、四桶；不是所有HTTP请求明细。
- [incomplete-requests.json](/tmp/redtrace-token-audit-20261117/incomplete-requests.json)：6 attempt及7无usage响应的定位与可恢复状态；唯一可恢复attempt usage为0，其余unknown。
- [patrols.csv](/tmp/redtrace-token-audit-20261117/patrols.csv)、[runs.csv](/tmp/redtrace-token-audit-20261117/runs.csv)、[audit-data.json](/tmp/redtrace-token-audit-20261117/audit-data.json)、[deep-data.json](/tmp/redtrace-token-audit-20261117/deep-data.json)、[tool-patterns.json](/tmp/redtrace-token-audit-20261117/tool-patterns.json)：巡检、Run、启动结构、Trace重叠和工具统计。
- [input-manifest.json](/tmp/redtrace-token-audit-20261117/input-manifest.json)：当前Campaign原生日志/数据库/runtime-review绝对路径、SHA256和字节数。数据库SHA256：`71bd8e606f5362f843950775035cedc360cad143d7ddb3a26c28ffd372f06a5c`；runtime-review SHA256：`52db3d8511466f95b132e5f7d56027fea59c4c92954534cc520d6c2d329e6835`。
- [token-test.stdout](/tmp/redtrace-token-audit-20261117/token-test.stdout) / [token-test.stderr](/tmp/redtrace-token-audit-20261117/token-test.stderr)：1项内存去重回归通过；[patrol-test.stdout](/tmp/redtrace-token-audit-20261117/patrol-test.stdout) / [patrol-test.stderr](/tmp/redtrace-token-audit-20261117/patrol-test.stderr)：本机原生checkpoint验证通过。没有把旧报告437通过当本次重跑全套。
- 分析脚本首轮曾因原生工具参数为JSON字符串而发生 `AttributeError`、退出1，已将参数正确解析后重跑退出0；错误保留在 [analysis-first-error.stderr](/tmp/redtrace-token-audit-20261117/analysis-first-error.stderr)。一次结构探针因session头无data发生KeyError；随后改用`get`重跑成功。探索时若干猜测路径不存在，已改为实际模块路径，不将空结果当检查通过。

上述 `/tmp` 是辅助证据，可能被系统清理；**本报告是仓库内的长期交付**，关键数字和原始Session定位已保留。报告不包含凭据、目标地址、攻击Payload或Flag，也没有复制源码备份、归档或回滚脚本。

### 8.3 本次变更与未验证事项

实际新增文件仅 `/Users/lxy/Downloads/RedTrace/TOKEN-COST-AUDIT.md`。**未新增额外控制机制。** 未修改权限、并发、角色边界、任务执行流程、模型路由、Prompt或业务代码；未暂存、提交、推送。原项目保持停止，运行数据只读；原始日志保留原处。

未进行：真实模型修复后Benchmark、目标重测、供应商费用校验、Sapper/ARTEX同任务A/B、全套测试与桌面/移动UI验收。主要风险：样本仅一Campaign、General迁移后仅一题三轮；缺usage使89.88M只是可核验下界；缺网关计费规则使账单和分段Token占比未知。

---

### 附表 A：Commander 逐次巡检输入边界与实际已记录用量

`完成`指本组执行了legion_wait；未完成组仍计入实际观察到的usage，缺失部分不补0。Cache Write全为0。所有时间为北京时间。

| 次序 | 输入时间 | 完成 | 有usage响应数 | 非缓存Input | Cache Read | Output | 四桶合计 |
|---|---|---|---:|---:|---:|---:|---:|
| 1 | 09:57:26 | 否 | 2 | 324 | 8,448 | 171 | 8,943 |
| 2 | 10:12:39 | 是 | 3 | 10,729 | 14,720 | 2,269 | 27,718 |
| 3 | 10:15:51 | 是 | 6 | 108,405 | 144,256 | 5,099 | 257,760 |
| 4 | 10:20:51 | 是 | 6 | 115,362 | 271,744 | 2,684 | 389,790 |
| 5 | 10:24:51 | 是 | 4 | 228,265 | 82,944 | 2,960 | 314,169 |
| 6 | 10:28:51 | 是 | 8 | 350,315 | 463,616 | 5,707 | 819,638 |
| 7 | 10:30:43 | 是 | 9 | 74,074 | 1,058,560 | 4,406 | 1,137,040 |
| 8 | 10:32:37 | 是 | 6 | 229,533 | 562,688 | 2,596 | 794,817 |
| 9 | 10:34:18 | 是 | 7 | 72,866 | 911,488 | 2,782 | 987,136 |
| 10 | 10:35:48 | 是 | 3 | 142,449 | 309,888 | 1,857 | 454,194 |
| 11 | 10:37:05 | 是 | 5 | 225,086 | 562,816 | 2,099 | 790,001 |
| 12 | 10:38:43 | 是 | 7 | 508,760 | 646,528 | 2,999 | 1,158,287 |
| 13 | 10:40:54 | 是 | 3 | 10,642 | 505,088 | 2,203 | 517,933 |
| 14 | 10:42:11 | 是 | 4 | 47,926 | 662,528 | 2,928 | 713,382 |
| 15 | 10:43:49 | 是 | 3 | 202,991 | 347,520 | 829 | 551,340 |
| 16 | 10:45:00 | 是 | 4 | 122,885 | 645,504 | 3,115 | 771,504 |
| 17 | 10:46:28 | 是 | 7 | 133,526 | 1,273,216 | 3,902 | 1,410,644 |
| 18 | 10:48:02 | 是 | 4 | 116,462 | 743,936 | 4,235 | 864,633 |
| 19 | 10:49:35 | 是 | 5 | 172,760 | 957,056 | 2,446 | 1,132,262 |
| 20 | 10:51:00 | 是 | 5 | 87,913 | 1,087,744 | 2,462 | 1,178,119 |
| 21 | 10:52:38 | 是 | 9 | 148,224 | 2,068,992 | 7,910 | 2,225,126 |
| 22 | 10:54:52 | 是 | 4 | 553,761 | 487,680 | 2,629 | 1,044,070 |
| 23 | 10:56:27 | 是 | 7 | 218,360 | 1,670,912 | 2,555 | 1,891,827 |
| 24 | 10:58:13 | 是 | 4 | 226,907 | 890,240 | 3,447 | 1,120,594 |
| 25 | 10:59:53 | 是 | 3 | 427,308 | 435,584 | 2,526 | 865,418 |
| 26 | 11:03:21 | 是 | 3 | 918,418 | 11,776 | 574 | 930,768 |
| 27 | 11:04:43 | 是 | 3 | 761,581 | 184,576 | 252 | 946,409 |
| 28 | 11:06:05 | 是 | 5 | 1,056,766 | 557,696 | 1,001 | 1,615,463 |
| 29 | 11:07:41 | 是 | 5 | 231,628 | 1,431,040 | 1,217 | 1,663,885 |
| 30 | 11:09:16 | 是 | 4 | 1,135,422 | 223,488 | 907 | 1,359,817 |
| 31 | 11:10:51 | 是 | 3 | 337,722 | 694,912 | 975 | 1,033,609 |
| 32 | 11:12:35 | 是 | 3 | 833,860 | 212,864 | 1,143 | 1,047,867 |
| 33 | 14:21:51 | 是 | 4 | 376,433 | 1,113,600 | 4,614 | 1,494,647 |
| 34 | 14:23:27 | 是 | 3 | 379,559 | 768,896 | 2,257 | 1,150,712 |
| 35 | 14:24:49 | 是 | 3 | 320,189 | 853,760 | 928 | 1,174,877 |
| 36 | 14:26:05 | 是 | 9 | 3,105,722 | 554,496 | 2,280 | 3,662,498 |
| 37 | 14:28:44 | 是 | 2 | 619,541 | 209,408 | 1,371 | 830,320 |
| 38 | 14:30:04 | 是 | 5 | 500,502 | 1,599,616 | 2,263 | 2,102,381 |
| 39 | 14:31:36 | 是 | 4 | 425,504 | 1,292,160 | 1,013 | 1,718,677 |
| 40 | 14:33:00 | 是 | 5 | 371,260 | 1,830,144 | 1,673 | 2,203,077 |
| 41 | 14:34:30 | 是 | 4 | 1,257,192 | 537,216 | 1,252 | 1,795,660 |
| 42 | 14:36:06 | 是 | 4 | 386,241 | 1,438,208 | 882 | 1,825,331 |
| 43 | 14:37:28 | 是 | 4 | 462,884 | 1,382,784 | 1,200 | 1,846,868 |
| 44 | 14:38:51 | 是 | 2 | 466,223 | 465,152 | 1,396 | 932,771 |
| 45 | 14:39:07 | 是 | 6 | 433,316 | 2,400,000 | 3,127 | 2,836,443 |
| 46 | 14:40:41 | 否 | 1 | 78,393 | 401,152 | 98 | 479,643 |

### 附表 B：每个执行 Step 的累计用量

含恢复/多Run，不含Commander；Cache Write全为0。`i021`含迁移前General，规划分拆已列于2.5；角色按Audit记录，不把Specialist另外重复加一次。

| Step | 题目 | 角色 | Run数 | 有usage响应 | 非缓存Input | Cache Read | Output | 四桶合计 |
|---|---|---|---:|---:|---:|---:|---:|---:|
| `i001` | a-01 | soldier | 1 | 20 | 29,044 | 457,472 | 3,644 | 490,160 |
| `i002` | b-01 | soldier | 1 | 88 | 63,907 | 3,397,248 | 22,315 | 3,483,470 |
| `i003` | c-01 | soldier | 1 | 98 | 95,502 | 5,089,408 | 16,150 | 5,201,060 |
| `i004` | d-01 | soldier | 1 | 29 | 59,718 | 695,936 | 4,110 | 759,764 |
| `i005` | e1-01 | soldier | 1 | 21 | 31,866 | 522,368 | 4,085 | 558,319 |
| `i006` | f1-01 | soldier | 1 | 43 | 43,011 | 1,392,896 | 9,471 | 1,445,378 |
| `i007` | e1-02 | soldier | 1 | 29 | 34,868 | 741,440 | 5,414 | 781,722 |
| `i008` | f1-02 | soldier | 1 | 17 | 24,481 | 325,632 | 4,041 | 354,154 |
| `i009` | f1-03 | soldier | 1 | 20 | 31,075 | 385,664 | 3,137 | 419,876 |
| `i010` | c-01 | reporter | 1 | 4 | 94,229 | 0 | 2,051 | 96,280 |
| `i011` | d-01 | soldier | 1 | 15 | 23,328 | 265,088 | 3,207 | 291,623 |
| `i012` | b-01 | soldier | 1 | 76 | 88,259 | 2,798,976 | 17,851 | 2,905,086 |
| `i013` | f1-04 | soldier | 1 | 8 | 22,175 | 132,672 | 2,484 | 157,331 |
| `i014` | f1-05 | soldier | 1 | 9 | 22,516 | 153,024 | 2,544 | 178,084 |
| `i015` | f1-05 | reporter | 1 | 3 | 53,902 | 6,784 | 1,645 | 62,331 |
| `i016` | f2-01 | soldier | 2 | 40 | 80,645 | 1,188,800 | 41,593 | 1,311,038 |
| `i017` | c-06 | soldier | 1 | 93 | 57,268 | 3,193,856 | 20,926 | 3,272,050 |
| `i018` | b-01 | soldier | 1 | 75 | 106,789 | 3,088,896 | 17,445 | 3,213,130 |
| `i019` | c-09 | soldier | 2 | 133 | 115,237 | 4,819,136 | 39,163 | 4,973,536 |
| `i020` | b-01 | soldier | 2 | 82 | 91,950 | 2,567,936 | 26,861 | 2,686,747 |
| `i021` | f2-01 | general | 4 | 49 | 278,566 | 2,286,336 | 69,283 | 2,634,185 |
| `i022` | f2-01 | soldier | 1 | 16 | 30,477 | 355,840 | 6,189 | 392,506 |
| `i023` | b-01 | soldier | 1 | 7 | 20,544 | 115,264 | 1,247 | 137,055 |

### 附表 C：General 真实 Session 原始定位

- `run-f7613d40-a9af-40fc-a2b9-a950e29b94aa`：[迁移前执行](/Users/lxy/Downloads/RedTrace/.redtrace/sessions/--Users-lxy-Downloads-RedTrace-workspaces-proj_001-agents-f2-01-run-f7613d40-a9af-40fc-a2b9-a950e29b94aa--/run-f7613d40-a9af-40fc-a2b9-a950e29b94aa/session.v4.jsonl)；SHA256 `1e7236bcf61212da94f6692c077ebeeef03a3499078256cdd222dd7a58ede62f`。
- `run-3d37e637-c5ef-4ce0-816d-d11b82e5ee61`：[Planner 原生 Session](/Users/lxy/Downloads/RedTrace/.redtrace/sessions/--Users-lxy-Downloads-RedTrace-workspaces-proj_001-agents-f2-01-run-3d37e637-c5ef-4ce0-816d-d11b82e5ee61--/run-3d37e637-c5ef-4ce0-816d-d11b82e5ee61/session.v4.jsonl)；SHA256 `ef00e3d3bdb5a78e4d68b03f5a6abe4fb06f9ee0f4cf5602fa0eba53ecaadfaf`。
- `run-2202e118-803e-4aa8-886a-ad54b38bc603`：[Planner 原生 Session](/Users/lxy/Downloads/RedTrace/.redtrace/sessions/--Users-lxy-Downloads-RedTrace-workspaces-proj_001-agents-f2-01-run-2202e118-803e-4aa8-886a-ad54b38bc603--/run-2202e118-803e-4aa8-886a-ad54b38bc603/session.v4.jsonl)；SHA256 `dca6133e9d9ca88e1483b03fc87d2a4575ceeecc8ac19fa4152436b33aa9b1ec`。
- `run-98990031-96a0-41c1-bfda-8f2d08296263`：[Planner 原生 Session](/Users/lxy/Downloads/RedTrace/.redtrace/sessions/--Users-lxy-Downloads-RedTrace-workspaces-proj_001-agents-f2-01-run-98990031-96a0-41c1-bfda-8f2d08296263--/run-98990031-96a0-41c1-bfda-8f2d08296263/session.v4.jsonl)；SHA256 `e54ff1c164663c34c4068db2364789498b2cd5519710c37d2049d96aedda351d`。
- Commander `command-8907b696-1c3a-426a-b9a8-b646b33d5373`：[原生 Session](/Users/lxy/Downloads/RedTrace/.redtrace/sessions/--Users-lxy-Downloads-RedTrace-workspaces-proj_001--/command-8907b696-1c3a-426a-b9a8-b646b33d5373/session.v4.jsonl)；SHA256 `c1954efb7d54214ea791800d7674ef283ed817e9b7233f0b7156b5d52dc4549e`。
