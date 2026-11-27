# Rust 渐进式重构与运行时性能

2026-11-27，本机 Darwin arm64、Node 26.13.1、Rust/Cargo 1.100。基线为 `42d6b795`，修改保留在工作区，未提交。以下是六组交替顺序运行的中位数；数据为可重复的本地负载，不代表远端模型延迟或真实渗透成功率。

## 已接入的 Rust 模块

`packages/redtrace-engine/src/native` 使用 napi-rs 实现整页 Audit JSON 摘要投影。SQLite 通过 `CAST(data AS BLOB)` 返回字节缓冲，Rust 借用正文和参数的原始 JSON，只返回 Trace 所需字段与 180 个 UTF-16 code unit 的正文前缀。每页一次跨语言调用，避免把完整输出转为 JS 字符串再解析。

完整 Audit、原生 Session、Run 历史、详情读取、查询和 Graph 归属检查保持原有格式及职责。差分测试覆盖 null、缺失字段、转义、中文、emoji、孤立 surrogate 及摘要之后的损坏 JSON。macOS arm64 release 库约 492 KiB；源码、Cargo.lock 和构建脚本入库，原生二进制及 Cargo 缓存不入库。

启动、npm start/test、适配器构建、WSL 同步、CI 与 Docker 已接入构建。Docker 用独立 Rust 阶段编译；运行时首次读取 Trace 摘要或压缩工具文本时加载原生库。源码启动新增 Rust 1.88+ 与 C 链接器要求，编译错误直接中止，没有 JS 静默降级。

## Run 事件与 Trace：实测

真实文件 SQLite、四个 Run、160 对工具调用、每次结果为 340,000 bytes（UTF-8）的字符串、120 页 Trace。事件通过生产 `recordRunEvent` 进入 Store；包含用量累计、工具待确认状态、原始事件与 Audit。断言验证完整结果原文、工具索引、Token 合计和 pendingTools。内存没有强制 GC，JS 堆为采样峰值，RSS 为进程 high-water mark。

| 指标 | 基线 | 修改后 | 变化 |
|---|---:|---:|---:|
| 写入 + Trace + 重开，累计耗时 | 1902.55 ms | 905.19 ms | 快 2.10 倍 |
| Run 事件写入 | 674.57 ms | 500.32 ms | 耗时减少 25.83% |
| 120 页 Trace | 1208.30 ms | 403.33 ms | 快 3.00 倍 |
| 每次 Trace 调用，平均 | 10.07 ms | 3.36 ms | 含真实 SQL 与摘要投影 |
| 重开数据库 | 19.13 ms | 0.98 ms | 耗时减少 94.86% |
| CPU 时间 | 1914.22 ms | 910.31 ms | 减少 52.45% |
| JS 堆采样峰值 | 164.80 MiB | 61.42 MiB | 减少 62.73% |
| RSS 峰值 | 301.12 MiB | 248.05 MiB | 减少 17.62% |
| 重开产生的 WAL | 53,592 bytes | 0 bytes | 不再重建正确的索引 |
| 关闭后的数据库大小 | 107.91 MiB | 107.91 MiB | 原始历史完整保留 |

配套的 JS/SQLite 根因修复：

- 用量只在有用量的 assistant/message 上累计和保存，记账事件不再重写未变化 Run。
- 无 Audit 投影的事件不再执行空 Audit 更新；同内容 Audit 元数据不重复写回。
- 生命周期写入直接使用事件数据，由现有 JSON 序列化完成持久快照，移除其前面的重复 stringify/parse；异步 Audit 发布的快照仍保留。
- 通过索引列检查进行必要迁移，不在每次启动时 DROP/CREATE 正确的 Audit 索引。

## 完整原生 DSH Agent Loop：实测

真实 Cordis 启动、Scheduler、四个并发 DSH Agent、80 次原生本地文件读取、Fact 提交、结构化结束和持久化；只有模型服务替换为本地确定性 OpenAI-compatible SSE 协议服务。每组均为 88 次请求、四个成功 Run、80 次成功读取，无未确认工具。没有访问外部目标或付费模型。

| 指标 | 基线 | 修改后 | 变化 |
|---|---:|---:|---:|
| 启动至四个 Run 完成 | 1801.04 ms | 1727.21 ms | 减少 4.10% |
| 第一模型请求至全部 Run 完成 | 1226.35 ms | 1175.88 ms | 减少 4.12% |
| 子进程 CPU 时间 | 1994.31 ms | 1889.19 ms | 减少 5.27% |
| RSS 峰值 | 342.20 MiB | 346.22 MiB | 本组增加 1.18%，没有降低证据 |

CPU profiler 定位到 `domainAction`：每次原始工具名查询都重新遍历完整域目录，在该负载采样中是明显热点。现在从现有静态目录一次构造反向索引，命中及未命中均直接查询；返回对象仍独立，不改变工具 Schema、action、角色权限或禁用规则。

前两次完整 Loop 对照的墙钟收益曾分别约为 +3.4% 和 -1.8%，不足以证明稳定提速；随后按 profile 修复域查询后，上表六组对照才得到最终结果。这也是不能把 Trace 的 3.00 倍当成整个 Agent 提速的原因。请求次数相同；没有据此宣称真实 Token 账单下降。

## 第二轮：批量工具文本压缩

fast-anything 在本地 stdout 混合负载中将原 JS 行折叠识别为 92.8% 的热点。原型通过 248/248 个记录、边界和派生输入，单次调用约 633.0 → 189.6 µs，快 3.34 倍。其自动 ESM 替换的整轮测试没有测出收益（2.39 → 2.40 秒），不作为生产收益证据；实验替换已停用。以下结果由显式调用生产原生库的可复现脚本取得。

生产 `compactToolTexts` 每次接收一个工具结果的全部文本块，保留 JS UTF-16 语义；Rust 直接比较借用的行片段，不再为每行建立 JS 字符串、正则匹配数组和重复组副本。只有出现严格缩短的折叠时才创建结果缓冲；无变化返回 null，JS 保留输入字符串。没有增加 Rust 依赖。

混合文本负载包括真实本地 Node stdout、唯一行、90 万字符无换行文本、短行、CRLF、中文与 emoji。每进程 1,800 次压缩，六组交替顺序、中位数；两实现输出哈希均为 `90b63a763e44d3a4821d2d79089a39ed14349f19eb96b808e056e1e48e3a1cc6`。

| 混合输出压缩 | 原 JS | Rust | 变化 |
|---|---:|---:|---:|
| 1,800 次累计耗时 | 1412.52 ms | 432.25 ms | 快 3.27 倍 |
| 平均单次耗时 | 784.74 µs | 240.14 µs | 包含 N-API 及 UTF-16 转换 |
| CPU 时间 | 1469.45 ms | 432.38 ms | 减少 70.58% |
| JS 堆采样峰值 | 133.45 MiB | 23.91 MiB | 减少 82.08% |
| RSS 峰值 | 260.30 MiB | 108.19 MiB | 减少 58.44% |

整条 Agent 路径另行比较：四个真实 DSH Agent、80 次原生 shell 命令读取本地文件、88 次本地模型请求；断言 80 份工具输出确实被折叠并进入模型上下文。只替换旧行折叠算法，其余运行时代码保持当前版本。终端自身仍按原规则截断并留存完整 stdout，压缩处理的是终端交付给它的文本；因此不能把微基准收益外推给所有命令。

| 完整 Agent 命令输出负载 | 原 JS 折叠 | Rust 折叠 | 变化 |
|---|---:|---:|---:|
| 启动至四个 Run 完成 | 1995.74 ms | 1940.11 ms | 减少 2.79% |
| 首次模型请求至完成 | 1378.66 ms | 1348.81 ms | 减少 2.17% |
| 子进程 CPU 时间 | 1812.02 ms | 1719.24 ms | 减少 5.12% |
| RSS 峰值 | 297.79 MiB | 300.25 MiB | 增加 0.83% |

该轮没有证明完整 Agent 内存下降，也没有改变输出内容或请求次数，不能据此宣称 Token 减少或真实靶场解题加速。原始数据在 `/tmp/redtrace-live-perf.5bvkcp90/{output,agent-output}-results.json`。基准最初因 macOS `/tmp` 与 `/private/tmp` 模块身份不一致而未调度；统一为 realpath 后，才取得上述成功负载结果。

原文仍由 DSH Spill 保存；PTC value、读取工具和非文本结果的既有规则不变，归档失败保留原文。构建发布改为同目录临时文件加原子 rename，避免覆盖运行中映射的原生库 inode。性能测试使用隔离编译目录。

2026-11-27，经用户明确许可，已通过原生 pause 接口暂停真实任务：6 个在途 Run 均为 paused，pendingTools 全部为零；执行 `npm run dsh:build:redtrace` 成功后正常停止旧服务，启动新服务并通过原生 resume 恢复同一个 Commander Session，`unresolved=[]`。新服务已映射原生库，运行 API 返回 200；核验时 5 个原 Run 继续执行，另有 1 个新 Run，共占满现有 Project 的 6 个执行槽，另 1 个原 Run 仍暂停。恢复后已观察到 51 个成功工具结果，未出现新的 undefined flush 错误。

重启验收同时暴露一个实际限制：旧后台 job ID 是进程内资源，恢复后的 `job_output` 返回 `Error: unknown job bash-25323fe57eaa4d8d`。这不属于未确认工具重放，也不能视为旧后台进程已恢复；本轮没有自动重跑该命令或修改 Job 持久化契约。真实任务恢复验证不是速度、Token 或解题成功率 A/B。

## 会话退出竞态修复

真实并发关停复现了 `TypeError: Cannot read properties of undefined (reading 'flush')`：Cordis 的 sessions 服务已退出，适配器 finally 又查询它进行重复 flush。退役 Commander、Worker 和全局会话现在依赖原生 AgentHandle.dispose 的 drain/close 持久化边界；继续常驻的 Commander 仍执行 flush。Worker checkpoint 移到 dispose 成功之后，错误继续传播。

回归在模型请求进行中并发执行宿主 dispose 与 controller close，然后用新 persistence backend 重开 Session，确认原始巡检输入和用户 objective 都已持久化，pendingTools 为零；不是用可选链隐藏错误。

## 大图投影：实测

201 个 Goal、4,000 个活动 Step、8,000 条去重 live edge，直接运行生产 `projectFgs` 与 `liveSteps`。每个进程先预热，再取九轮中位数，六组交替比较。

- 单次投影中位数：**68.05 ms → 3.65 ms，快 18.64 倍**。
- 六组完整投影输出的 SHA-256 全部相同：`b9fb90f1ce3be45599c2d3a60cf59fab8ff9f9422dae3d35cbb4e4580470fae5`。
- Goal 活动数改为单次遍历累计；live edge 去重使用本次投影拥有的 Set，替代每条边线性扫描全部已有边。
- 这是投影函数耗时，未测完整 HTTP 大图响应、浏览器布局和 FPS；不把它表述为整个 UI 快 18.64 倍。该数据集进程 RSS 没有下降。

## 磁盘占用

- Engine 未使用的直接 Playwright 依赖已从 package/lockfile 移除并实际 prune：本机 Engine node_modules 约 **57.91 → 39.66 MiB**，释放约 **18.24 MiB**。根目录 Playwright 及已有浏览器能力保留；计入新增原生库后，这两项净减约 **17.76 MiB**。Rust 开发编译缓存另计，不属于运行包。
- Docker 上下文排除生成的 vendor lib、适配器 lib、tsbuildinfo 和本机 Rust 产物。当前已构建 checkout 的 vendor lib 为 **85.51 MiB 文件内容 / 106.89 MiB 已分配空间**。这是可避免复制的体积；没有 Docker 环境，未实测镜像体积，干净 clone 没有这些旧产物时收益为零。
- DSH 本地更新源复制也排除 lib、node_modules 和 tsbuildinfo；真实文件夹具验证仍保留相对 symlink。没有清理用户会话、历史、工件、现有 vendor 功能或大型可选工具。
- 扫描时去重硬链接后的仓库占用约 **2.409 GiB**，其中 DSH node_modules 约 **1.721 GiB**；CodeGraph 运行包约 **278.77 MiB**。它们对应现有工具或可选功能，未通过删除功能制造空间收益。APFS clone 的共享 extent 不包含在 inode 去重统计中。

## 后续 Rust 化边界与已验证的压缩取舍

1. **Session 规范化、不可变快照与持久化字节链路**：完整 Loop profiler 中 `deepFreeze`、JSON 值遍历/拷贝、`hasIntrinsicConstructor`、`sameSchema` 和请求编码仍有明显 CPU 成本。适合评估让规范日志和字节索引在 Rust 侧驻留，按页/增量交付，避免把 JS 对象逐个送进 Rust。需要保留 DSH 原生所有权、Session surface、事件连续性、取消和错误传播契约。
2. **会话压缩迁移**：真实 Cordis JSONL append/fsync/open/read 对照中，zstd 对 3,000 条短文本节省 93.79% 文件字节，对 2,000 条重复约 4 KB 文本节省 99.49%；随机 Base64 只节省 27.01%，并使追加 CPU 增加约 53.5%、读取耗时增加约 25.2%。现有 none 根目录直接切为 zstd 会实际报编码不匹配，因此未改配置；后续需使用原生租约和逐会话内容验证完成显式离线迁移。
3. **知识库 generation**：当前本地没有 corpus，不能报实际节省。源码为每代复制全部语料，后续可评估不可变内容存储或 CoW；不能直接 hardlink 会被覆盖更新的源文件，否则会破坏旧代隔离。
4. **大图 Rust 化**：先消除已确认的二次遍历后再重测。当前整图搬运 JS 对象的成本可能超过计算；更合理的边界是与数据库行/紧凑关系列一起投影，不能假定换语言就更快。

上一轮已验证的单条及批量 Rust 脱敏原型分别比 JavaScript 慢 1.9 倍和 1.7 倍，保持停用。当前保留的 Rust 模块处理整页原始字节，避免该类转换成本。

## 验证与复现

```bash
npm run native:build
npm run dsh:build:redtrace
npm run bench:runtime
npm run bench:runtime -- --baseline 42d6b795
npm run bench:agent
npm run bench:agent -- --baseline 42d6b795
npm run bench:output
npm run bench:output -- --original-output
npm run bench:agent -- --tool-output
npm run bench:agent -- --tool-output --original-output
npm run bench:graph
npm run bench:graph -- --baseline 42d6b795
```

`--baseline` 不指定 revision 时使用 HEAD。基准通过 Node load hook 读取 Git 中的旧源码，不覆盖工作区或创建源码备份；Run 事件旧版基准对应本报告的原始 inline listener。生成数据位于系统临时目录并清理，不访问现有项目数据。最终六组 JSON 在本 Session 的 `/tmp/redtrace-runtime-perf.JvYHTDNI/{runtime,agent,graph}-results.json`，临时目录不是长期归档。

`--original-output` 固定读取 Git `42d6b795` 中的行折叠实现，不会随未来 HEAD 改变而误用新实现。纯压缩基准同时校验两实现输出，完整 Loop 检查成功 Run、工具数、模型请求数和模型可见的折叠文本。

已运行：

- Rust release 构建和两项 Rust 测试通过；原生 JSON 差分与损坏输入回归通过。
- 第二轮 Engine 全套：529 项，527 通过、1 跳过（本地 Chisel 集成）、1 项更新器夹具因测试命令外部设置源码/运行时根目录而失败（版本实际 0.2.2-rc.3，夹具预期 0.1.0）。清除外部根目录和隔离 loader 后，仅重跑更新器文件，4/4 通过；未改产品逻辑或放宽断言。包含真实并发关停持久化回归。
- 第二轮 DSH 全套在隔离的新编译模块上运行：93 项，92 通过、0 失败、1 跳过（可选插件浏览器回归）；包含 975 组行折叠差分输入及真实多文本块原文留存。
- Engine TypeScript check、适配器编译、原生 prebuilt 自检、源码指纹复用、git diff --check 通过。
- 原生 Soldier 同 Session 暂停恢复、Benchmark resident/compaction、并发、Unknown 保留、Thinking、原始输出与 Trace 搜索/详情回归通过。

未运行 Docker 镜像构建、Linux/Windows 原生编译和真实远端模型/靶场 Benchmark；三平台 Rust 工具链已加入 CI。没有新增限流、全局锁、串行队列、重试或权限机制；规划、角色、并发额度、工具 Schema 与错误传播职责保持不变。


## 第三轮：根据运行中任务继续优化（2026-11-27）

本轮从当前未提交工作区继续，基线包含本文前两轮全部改动；下面的增益不能与前文直接相加。服务 PID 69355 始终保留，运行数据库通过 SQLite 在线 backup 获取一致性快照，没有操作任务平台、暂停、恢复或重启服务。

fast-anything 实际安装 CLI 为 0.8.6，技能包为 0.8.9。`fast-anything scan -- node scripts/bench-runtime.mjs` 报告 `recordRunEvent` 累计 48.4%、`readRunTrace` 40.4%、`auditSummaries` 30.7%（嵌套累计时间不能相加）。前两者接收带 SQLite/运行状态的对象，自动标记 `port it` 不能证明它们是可录制纯函数；本轮保留其状态所有权，将优化落在实际数据处理边界。

### 保留的改动

1. Rust `fold_lines` 不再为了比较重复行扫描下一行的换行位置；用当前已知的完整行切片直接比较后续前缀，再按行长推进。带换行的行只有字节/UTF-16 单元完全匹配才命中；无换行末行不会被当成前面完整行。保留批量 N-API、孤立 surrogate、CRLF、精确次数和严格缩短规则。没有新增依赖或跨语言调用。
2. `recordRunEvent` 移除进入 Store 前的整批 `stringify/parse`。`Store.audit` 用已写入 SQLite 的同一份 JSON 生成异步通知快照，并补回插入行 ID；原调用参数、异步发布事件与持久化数据仍彼此独立。事务回滚不发布事件，`persist_only` 不额外生成通知副本。新增回归真实验证事务内修改参数、发布内容与数据库一致、监听器修改不污染调用者、回滚事件不泄露。

六组交替顺序，取各指标中位数；两实现输出哈希和成功行为均已断言：

| 当前版本 → 第三轮 | 当前基线 | 第三轮 | 观察结果 |
|---|---:|---:|---|
| 1,800 次混合输出压缩 | 424.04 ms | 186.85 ms | 快 2.27 倍，CPU 减少 55.92% |
| 真实任务文本回放，40 轮 | 197.83 ms | 142.35 ms | 耗时减少 28.04%，CPU 减少 27.71% |
| 160 对 Run 工具事件写入 | 512.10 ms | 482.93 ms | 耗时减少 5.70% |
| 写入 + 120 页 Trace 的 CPU | 959.19 ms | 916.65 ms | 减少 4.44% |
| 写入/Trace JS 堆采样峰值 | 57.96 MiB | 49.90 MiB | 减少 13.91%，不是进程内存结论 |
| 完整 Agent Loop，启动至完成 | 1980.15 ms | 1963.96 ms | 差异 0.82%，不足以认定稳定收益 |
| 完整 Agent Loop，首次请求至完成 | 1343.52 ms | 1346.46 ms | 增加 0.22%，不足以认定回退 |

完整 Loop 每组均为 4 个成功 Run、80 次真实本地 shell 工具执行、88 次确定性本地模型请求；没有未确认工具。真实数据快照包含 8,035 个 Audit 事件、5,155 段正文、7,248,558 UTF-8 bytes，全部正文逐项对照，Audit 摘要也逐项对照。真实文本折叠输出 SHA-256 为 `a423db8dc0624d70703f0a0c722b518b57ee4c867fc08479e504cef825d76687`。混合负载输出哈希仍为前文 `90b63a...a1cc6`。

fast-anything 原型复用原有 24 条真实录制，没有改录制数据；本轮通过 248/248 组（24 真实 + 24 边界 + 200 派生），单调用原 JS 652.0 µs → Rust 82.8 µs，快 7.9 倍。`enable/bench --runs 3/report/disable` 已执行；自动 ESM 替换的整轮 2.54 → 2.51 秒在 ±51 ms 波动内，原型最终停用。生产收益来自上表显式调用已构建 N-API 库的负载，不能用原型自动替换结果冒充生产收益。bench 提示 stdout 不同，对应输出中的耗时/CPU/内存字段，实际内容用独立哈希与 verify 验证。

### 资源占用与剩余 Rust 边界

本轮没有证明完整 Agent RSS 下降；真实回放进程 RSS 中位数反而从 160.79 → 173.34 MiB（增加约 7.81%，包含等价性检查及分配器历史），不作内存优化宣传。原生库前后均为 504,032 bytes，没有扩大运行包，也没有新增磁盘节省证据。数据库保留完整历史；基准约 107.91 MiB，差异仅页分配波动。

运行中服务三秒采样显示主线程 2,436 个采样中 2,206 个落在 `kevent` 等待，约 90.6%；physical footprint 285.0 MiB，历史峰值 465.2 MiB。这只说明该时间窗口主要在等 I/O，不能证明整个任务周期的瓶颈分布。没有实测远端模型/靶场解题速度改善。

本轮完整 Loop CPU profile 仍看到 Session `sameSchema` 重复 JSON 编码、`deepFreeze`、不可变快照遍历，以及 shell 的 open/close/write。下一阶段优先把 Session 字节日志、偏移索引、压缩和增量投影作为一个完整 Rust 边界评估；直接把有 JS 原型、getter、Proxy、AbortSignal 语义的校验/冻结换成 JSON 往返会改变契约。Schema 应先消除重复编码；逐个搬进 Rust 会增加转换成本。SQLite 状态和事务不因 profiler 的函数标签迁移所有权。

当前 `.redtrace/runtime/npm` 约 279 MiB，主要是现有 CodeGraph 工具安装；Session JSONL 约 43 MiB 并持续增长。没有通过删除工具、日志和证据降低磁盘占用。会话 zstd 迁移仍须保持原生租约与编码契约；活动会话不做在线改写。

### 本轮验证与运行中服务

- 生产原生 release 构建、Engine 类型检查通过。
- 相关 Engine/DSH 测试 48/48 通过；包含 Trace 搜索/详情、图隔离、并发调度、真实 DSH 会话持久化和暂停恢复路径、975 组 UTF-16 行折叠差分。
- Rust 测试 2/2 通过；fast-anything 248/248 通过。
- 相同输入分别执行 BASELINE、MODIFIED、ROLLBACK，均 160 对工具事件、120 页 Trace、完整原文/Token/索引断言通过，退出码均为 0；回滚副本所有源码 SHA-256 等于本轮原始工作区，补丁可逐字节重建候选。
- `git diff --check`、原生 prebuilt 自检通过。没有改动角色、工具 Schema、并发数、规划与攻击执行策略；没有新增锁、队列、重试、超时、权限或降级机制。
- 原生二进制通过现有原子 rename 发布，运行中进程继续映射旧 inode。第三轮源码和二进制已就位，新进程使用第三轮；PID 69355 已加载的 JS 和原生库不会自动更新。本轮没有为了部署而打断在途工具，也没有声称它已使用第三轮代码。

原始六组结果、CPU profile、实际数据库快照与四角色验收工件位于 `/var/folders/d3/j_ndtywx6bxclc1b36rjvbfw0000gp/T/redtrace-perf-round3._q3ldf5y`；快照包含真实任务正文，仅留本机权限受限目录。`MODIFIED_FILE/` 为候选源码树，`DIFF_FILE.patch` 重建候选，`VERIFICATION.txt` 保存命令/输入/逐字输出/退出码，`ROLLBACK.sh TARGET_COPY_ROOT` 仅用于显式目标副本。项目中没有创建备份或回滚脚本，没有暂存、提交或推送。

未运行全量 Engine/DSH、全量上游构建、Docker/跨平台构建或远端付费模型/靶场速度 A/B；本轮仅修改 Engine 源码和既有 Rust 模块，未改 DSH TypeScript 适配器，因此采用相关行为回归、类型检查与原生构建。
