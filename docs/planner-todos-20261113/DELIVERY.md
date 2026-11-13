# 最新更新：TodoList 已加入工作台项目详情

本轮最终位置、测试和预览见 [UI_DELIVERY.md](./UI_DELIVERY.md)。以下为上轮迁移的历史交付记录；本轮 UI 是用户后续明确要求的新范围。

# ARTEX Planner 任务级 TodoList 迁移交付报告

## 结果

已在当前仓库 /Users/lxy/Downloads/RedTrace 实现并验证；未创建其他 Codex Session、SubAgent 或 Worktree，未提交或推送 Git。既有未跟踪的 project-commander/legion 交付记录未被覆盖。

## 实际架构与适配

- 当前唯一全局规划入口为 /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs 的 runCommander；createCommanderController 按 Project 管理激活和容量。
- Project Commander 通过 legion_spawn 产生 Graph 内 Mission；Scheduler 与 DSH 仍是原来的执行路径。General 可以为自己的 Mission 分派同任务小队，但不能维护规划 TodoList。
- 根 engine.legion 持有内存 Map<ProjectID, CommanderTodos>；每个 CommanderTodos 内部按 GraphID 保存完整 Todo 数组。runCommander 显式复用根运行时对象，而不是每轮新建的 LegionStore 视图或单次 DSH Session。
- 保留现有 DSH resume / 原生 compaction-relay 生命周期，没有强行改变成每轮销毁会话。Store 与 sessionId 无关；测试同时覆盖原生续用会话和实际创建全新 DSH 会话后的清单延续。
- 重建 Commander 运行时或进程重启后清单为空。这是明确要求的内存生命周期，不增加恢复逻辑。

## 功能及职责边界

- Todo 只有 content 和 status；状态只允许 pending、in_progress、completed。
- TodoWrite 接收 projectId、graphId 和完整 todos；每次整表替换，可传空数组清空，返回 {saved:true}。
- 工具仅在 Commander 分支且提供共享规划 Store 时注册。Scout、General、Soldier、普通执行角色的 graphTools 不含 TodoWrite；没有向 DSH 全局工具注册表添加工具。
- 使用现有 TypeBox 参数验证及 Project/Graph 归属校验。没有新增权限体系。
- 每次 runCommander 激活自动通过动态 user message 注入各 Graph 的当前完整 FGS 与 TodoList。变化清单不写入长期 system prompt。
- Commander 提示词要求：强依赖链一次记录完整路线，只将前置 Fact 已存在的当前阶段转换为 Mission；新 Fact 到达后检查真实证据、整表更新并推进下一阶段。失败、Worker 声称成功或 Step 结束不能代替阶段验收；路线失效允许重写。
- 阶段验收和路线选择沿用 ARTEX 的 Planner 推理语义，不引入硬编码的第二套依赖调度器。TodoWrite 本身不把自由文本 Todo 与 Fact 自动匹配，也不会自动创建 Step。
- 不更改 sync_step、read_graph、read_graph_delta、Fact/Finding 提交、Goal 验收、Project.mode 或 TSecBench 托管逻辑。
- 独立方向仍使用现有并行调度；未新增锁、队列、重试、超时、数据库表、文件持久化、UI、API、依赖或配置开关。
- 除需求内工具角色隔离、三状态参数校验及复用既有归属边界外，未新增额外控制机制。

## 修改文件（5 个实现文件、2 个测试文件）

- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-store.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-tools.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-missions.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-todos.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-todos.test.ts
- /Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-todos.fixture.mjs

## 参考核对

- 本地 /Users/lxy/Downloads/ARTEX/agent/planner.go：todos 映射、todoFor、renderPlannerTodos、Plan 中共享 Store 和动态注入。
- 本地 /Users/lxy/Downloads/ARTEX/agent/worker.go：Worker 自有会话内临时 Todo，不是 Planner 的跨唤醒共享清单；按本任务更严格的要求，RedTrace Worker 不注册 TodoWrite。
- ARTEX go.mod 固定 norma v0.4.3；整表替换与两字段模型核对自 [norma v0.4.3 TodoStore](https://raw.githubusercontent.com/Autumn-27/norma/v0.4.3/tool/todo.go)。
- 参考对话的早期 DAG 建议没有采用；以用户最终任务文本指定的简单数组为准。

## 验收覆盖

| 场景 | 已执行验证 |
|---|---|
| 1 同 Graph 多次唤醒保留 | 原生 DSH 五轮唤醒；同时覆盖原会话恢复和新 Session |
| 2 同 Project 两 Graph 隔离 | A/B 分别写入不同清单，互不改变 |
| 3 不同 Project 隔离 | 同一根运行时下两个 Project 分别写入与读取 |
| 4 首次清单为空 | 内存 Store 单测和第一轮原生上下文断言 |
| 5 Commander 整表替换 | 替换为不同清单和空数组；FGS 快照保持不变 |
| 6 新唤醒读取最新清单 | 五轮协议夹具断言实际模型请求中的完整 todos |
| 7 Worker 无修改工具 | Scout/General/Soldier 与普通执行 graphTools 白名单断言 |
| 8 下游不提前派发 | 第一轮只有入口阶段及两个独立方向，凭据阶段未建 Step |
| 9 有效 Fact 后推进 | 新入口 Fact 出现在下一轮 FGS；凭据阶段 sourceIds 引用该真实测试 Fact |
| 10 失败/无必要 Fact 不完成 | 失败且 Worker 口头报成功仍保持原清单；第二阶段 Step 结束但只有 blocker Fact 时仍 in_progress |
| 11 独立方向可并行 | 同时 claim 两个独立 Mission 并断言两个 running Run；原有并行调度回归 |
| 12 既有流程 | 全引擎回归失败集合与基线相同；DSH 全套通过；原有 general/benchmark/FGS/角色/compaction 测试保留 |

新增 6 项测试全部通过。原生 DSH 使用真实本地 DSH 会话、工具调用和 HTTP 模型适配器，模型回复由确定性的本地协议夹具提供；这不等价于真实模型自主规划能力或靶场攻击成功率评测。

## 测试和构建

| 检查 | 结果 |
|---|---|
| 修改前完整引擎测试 | 276 项：268 通过、7 失败、1 跳过；exit 1 |
| 修改后及构建后完整引擎测试 | 282 项：274 通过、7 失败、1 跳过；exit 1 |
| 构建后完整 DSH 测试 | 59 项：58 通过、0 失败、1 跳过；exit 0 |
| 引擎 tsc --noEmit | exit 0 |
| RedTrace DSH tsc 构建 | exit 0 |
| npm run dsh:build（原生系统、上游 host、RedTrace DSH） | exit 0；存在既有构建工具弃用警告 |
| git diff --check | exit 0 |
| patch 重建 | 7 个文件逐字节等于当前工作源码 |
| rollback | 4 个原文件 SHA-256 等于修改前；3 个新增文件被移除；然后重应用补丁并验证最终修改包 |

未新增失败。原有 7 项失败：4 项 knowledge-offline 测试找不到 /Users/lxy/Downloads/RedTrace/.redtrace/runtime/knowledge/bin/python；3 项 project-graph-migration 测试的历史 session / campaign_archive / 失败回滚预期不满足。没有扩大范围修复这些既有问题。REGRESSION_COMPARISON.json 记录精确失败集合；VERIFICATION.txt 保存命令、原样 stdout/stderr 和退出码。

## 并发、性能、权限与流程影响

不改变 Scheduler、并行容量、模型路由或执行隔离。每次唤醒新增清单内存快照及完整 FGS 上下文，开销随项目图谱和清单大小增长，会增加模型输入 token；已通过原有并发和原生 compaction 回归，未做吞吐量或真实模型成本基准。权限唯一新增行为是按需求仅给 Commander 的规划工具集注册 TodoWrite，复用现有边界。

## 三态事务验证（同一探针和 Todo 输入）

- BASELINE（exit 0）：TodoWrite=false; cross_wake_todos=unavailable; FGS_unchanged=true
- MODIFIED（exit 0）：TodoWrite=true; cross_wake_todos=completed,in_progress; whole_list_replacement=true; FGS_unchanged=true
- ROLLBACK（exit 0）：TodoWrite=false; cross_wake_todos=unavailable; FGS_unchanged=true

## 四角色交付物

- MODIFIED_FILE：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/MODIFIED_FILE.tar.gz
- DIFF_FILE：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/DIFF_FILE.patch
- VERIFICATION：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/VERIFICATION.txt
- ROLLBACK：/Users/lxy/Downloads/RedTrace/docs/planner-todos-20261113/ROLLBACK.sh

ROLLBACK.sh 接受目标源码副本目录，用同目录 BASELINE.tar.gz 恢复这四个原文件并移除本次三个新增文件。已在独立临时副本实际执行；当前原仓库保留迁移后的实现。请勿对含后续编辑的工作区直接回滚，否则这七个任务相关路径的后续编辑会被覆盖。

## 尚未完成 / 风险

本次迁移实现、测试、构建和可逆交付均已执行。未启动或重启正在运行的 RedTrace 服务，未做真实模型、真实靶场或在线 TSecBench 评测；旧进程须重新加载源码才能获得新实现。进程重启清空 Todo 为本次要求的设计行为。没有 Git 提交/推送。
