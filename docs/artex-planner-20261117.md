# 题目级 ARTEX Planner 迁移

## 参考与适配

核对 ARTEX 提交 `6997a4661921395072290becc50380db8dacb04e`：
- [agent/planner.go](https://github.com/RuoJi6/ARTEX/blob/6997a4661921395072290becc50380db8dacb04e/agent/planner.go)：独立规划轮次、概览和触发事件、跨轮 Todo。
- [agent/worker.go](https://github.com/RuoJi6/ARTEX/blob/6997a4661921395072290becc50380db8dacb04e/agent/worker.go)：一次执行一个意图、保留实际执行输出。
- [agent/tools.go](https://github.com/RuoJi6/ARTEX/blob/6997a4661921395072290becc50380db8dacb04e/agent/tools.go)：Worker Output/Trace、规划工具。
- [server/engine.go](https://github.com/RuoJi6/ARTEX/blob/6997a4661921395072290becc50380db8dacb04e/server/engine.go)：Planner/Worker 独立循环、800ms 事件合并、heartbeat 和有限模型故障恢复。

迁移调度设计，不复制其 Planner 默认 Bash/执行工具和进程内 TodoStore。继续复用 RedTrace FGS、数据库、证据保留、冷压缩和 DSH 模型轮询，不新增图、任务队列、依赖或配置。

## 运行与权限

Benchmark Commander 保留项目级调度、升级、换人、Park、平台确认和原巡检节奏。可选 Scout 保留已有侦察/分类行为，不把参考图的四分钟改成新配置或强制门槛。

简单题仍由 Soldier 自主执行。General 在原题 Graph 内成为唯一 Planner；原 Soldier 立即失去题目规划工具，已有执行和证据不丢弃。General 被暂停、故障或停止后，不自动把总体规划权退给 Soldier；Commander 可在同一 Graph 更换 General。

General 复用一条持久 FGS 生命周期 Step。每轮是独立 Run；`legion_plan_done` 保存 STATE 后立即释放执行槽，保留该 Step 等待下一轮。Worker 不等待 Planner，Planner 不等待 Worker。独立 Step 可批量原子派发，调度并行度仍受既有全局、项目和模型容量约束，不额外预留槽。

General 不挂载执行工具栈、MCP、HTTP、资源/能力执行工具，也不能提交 Worker Fact/Finding。保留 FGS/证据读取、原生受现有路径边界约束的只读文件/Spill 回读、Todo、Step 管理、Worker Trace/Output、消息、生命周期和验收工具。Specialist 仍使用 Soldier 执行配置，只执行被分配的一个 Step。

## 事件、验收与恢复

- Fact/Finding、Worker 成功/失败/未知结果、Hint、额度变化触发同题重新规划，合并 800ms 内事件；15 秒 heartbeat 检查停滞。自身规划结束不触发自旋。
- 每轮上下文包含 STATE、Todo、FGS 概览、近期证据和 Worker 原始记录；分页工具读取更早的节点与 Trace。恢复原生 Session 时同样注入最新快照。
- Todo 继续存储在 `commander_todos`，增加可选 `acceptance`、`stepIds`、`factIds`。完成条目必须包含验收条件和同题真实 Fact；旧库缺少验收条件或 Fact ID 的完成标记一次性改为进行中，保留阶段、顺序及已有引用供 Planner 重验，不删除攻击链；证据必须是校验过完整性的保留 Artifact，或真实审计工具结果。Scope、纯文字声称、Step 终止和 Finding 数量不能替代证据。
- Planner 模型判断 Fact 对验收条件的语义充分性；代码只负责所有权、引用、证据来源与完整性，不用关键词假装判定攻击成功。部分进展不应完成 Todo。Goal 单独由证据验收，不能从 Todo 状态推导。
- `dependsOn` 统一适用于两种模式；必须同题、完成且已有 Fact 才可领取。未来阶段留在 Todo，所需 Fact 尚不存在时不创建可执行 Step。
- 模型轮询与原生重试保持原路径；现有 watchdog 最多恢复三次，并增加 1/2/4 秒退避。未知工具结果不自动重放；失败 Trace/Output 和已有 Fact 保留供 Planner 续接。恢复后的 Step 同样不能挤破额度。

## Max Step 的精确定义

保留现有 `tasks.commander.max_intents`，默认值和活跃计数语义不变：`pending/running/paused`，不是历史累计创建数。General 项目按项目计数；Benchmark 按题目 Graph 计数，Soldier 与 General 使用相同规则。

所有创建路径最终进入 `Store.addStep` 的事务准入检查；绑定实时配置后，直接调用、省略参数、工具、批量、替换、自动报告/生命周期入口均不能绕过。批量溢出整体回滚。满额时保留新 Finding，延后自动报告 Step；空出额度后使用既有显式报告入口，不因报告额度失败丢弃发现。已有非活跃 Step 的重新激活也经过存储层检查。下调额度不取消既有工作，但不再准入新工作。

General 生命周期 Step 也计入同一活跃额度，不另行豁免。因此上限为 1 时，Planner 无法再新建 Worker Step，只能审查既有证据或如实停止；不会扩大上限。完成/取消释放额度，达到上限并不等于目标达成。

## 验证与限制

`artex-planner.test.ts` 覆盖持久化、升级继承、唯一规划权、无证据拒绝、证据篡改、跨题隔离、批量原子额度、替换/重激活、热配置、Planner 与三 Worker 同时运行、事件合并、依赖和失败 Trace。`artex-planner-native.fixture.mjs` 直接启动生产 DSH 宿主，验证 General 无攻击工具、Specialist 保留执行工具、并行派发、Trace 读取和真实文件 Fact 的 Todo/Goal 验收。既有 Benchmark/General 原生协议测试继续验证巡检、模型轮询、有限恢复和上下文压缩。

本次是本地代码与协议验证，不是远端模型或真实 CTF 的解题效果验证。服务中的旧 Session 不会自动更换已注册工具；部署需要重启宿主并按既有恢复流程确认未完成工具结果。

## 本次修改文件

- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/scheduler.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/runner.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-tools.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-todos.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-store.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/index.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/legion-missions.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/cordis.mjs`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/prompts/benchmark-commander.md`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/artex-planner.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/benchmark-task-todos.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-todos.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/platform-roles.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/project-graphs.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/benchmark-scheduling.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/planning-concurrency.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/benchmark-resident.test.ts`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/benchmark-autonomy.fixture.mjs`
- `/Users/lxy/Downloads/RedTrace/static/index.html`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/legion-todos.fixture.mjs`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/benchmark-controller.fixture.mjs`
- `/Users/lxy/Downloads/RedTrace/README.md`
- `/Users/lxy/Downloads/RedTrace/docs/artex-planner-20261117.md`
- `/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/test/artex-planner-native.fixture.mjs`

## 最终本地结果

- Engine：429 项，428 通过、1 跳过、0 失败（`node --test --test-reporter=tap --test-concurrency=4 packages/redtrace-engine/test/*.test.ts`）。
- DSH：63 项，62 通过、1 跳过、0 失败（`npm run dsh:test`）。
- Engine TypeScript、两个 Compat 模块语法、`git diff --check` 均通过。
- 原生宿主验证 General 工具隔离、Specialist 执行工具、并行批量派发、Trace 读取、真实保留文件 Fact 的 Todo/Goal 验收。
- 未执行真实远端模型/CTF；未重启既有服务，未暂存、提交或推送。
- 基线无 Fact 完成标记被接受；修改后被拒绝；独立副本回滚后恢复基线行为，所有原文件哈希匹配。项目内未创建源码备份或回滚脚本，验证材料放在项目外。
