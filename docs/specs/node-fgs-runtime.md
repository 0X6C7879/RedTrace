# RedTrace Node FGS Runtime

RedTrace 的默认运行时是 TypeScript、Node 24.15+ 与内置 `node:sqlite`。一个 Node 进程同时承载 FGS 存储、事件调度、旧版 HTTP 兼容层、Cordis Web 宿主和按需外围能力；启动不需要 Python。

## 状态模型

- `Fact`：有来源、可引用的事实。提交后保留历史并唤醒 Decide。
- `Goal`：根目标或子目标，保存完成状态和证据引用。
- `Step`：唯一可领取的行动单元，关联来源 Scope / Fact / Finding、目标、优先级、Worker、执行适配器与检查点。保留全部产出引用，展示在执行面板。
- `Finding`：面向交付的成果，引用支撑它的 Fact；可作为后续 Step 的来源或 Goal 的验收证据，提交本身不唤醒 Decide。
- `Hint` 与 `Observation`：人工输入和中间记录，不自动提升为 Fact。

SQLite 短事务原子更新图、租约、运行归属、审计和事件序号。Decide 每个项目最多一个；它只读写任务图且不因自己创建 Step 再次触发。Execute 可并行运行，任一 Execute 提交 Fact 后即可启动新的 Decide。规划器不可用时，已经存在的 Step 继续派发。

Decide 的触发白名单只有：任务创建、Fact 增加、Execute 成功完成或失败、任务重新激活（含重开）。Finding、Hint、Observation、Goal/Step 编辑、取消、暂停、未知结果及 Decide 自身结束均不产生新的规划修订。未完成 Step 的容量限制只阻止继续创建 Step，不阻止 Decide 验收已有证据。

## FGS 图投影

画布永久节点只有 `scope / fact / finding / subgoal / goal`；内部保留 `origin` 标识并显示为 Scope。Goal 在创建时即以 open 状态出现，完成由引用证据的状态更新表达。Decide 和 Execute 属于活动；Step 是持久化的执行记录，不占据画布节点。

`src/fgs.ts` 在读取时投影原始记录，不建立第二份图数据库：Scope 关联目标范围；Step 的每个来源连接其全部 Fact 产出；Fact 支撑 Finding；产出关联推进的 Goal；验收证据连接 Goal；Subgoal 指向父 Goal。目标归属与验收证据分开标记，Step 结束不会自动证明 Goal 达成。取消或失败的 Step 仍保留已提交产出的来源关系。边保留 Step ID，可进入执行面板查看来源、全部产出和各次运行日志。

`GET /v2/projects/:id/graph?revision=N` 按事件重建历史状态。新事件保存初始节点及状态快照；旧历史缺失创建描述等信息时返回 `historyIncomplete`，不拿最终状态填补过去。YAML Snapshot 包含完整 `fgs` 节点、关系与原始执行记录。画布支持按目标聚焦，轮询状态变化保留视口，窄窗口使用详情抽屉。

## 执行与恢复

默认 Agent 使用锁定版本的 `@earendil-works/pi-ai` 与 `@earendil-works/pi-agent-core`。需要旧 Agent 钩子的 Worker 使用 DSH 适配器；两者共享同一个 Store 与 Scheduler。Step 会话彼此隔离，Stop 保存当前活动的检查点，Resume 恢复同一 Step。进程重启会保留已提交的 Fact/Finding；没有确认结果的外部操作标记为 `unknown`，不会自动重放。

## 兼容层

`/v2/projects/:id/graph`、Goal、Step 与 Finding API 直接操作 FGS。旧 Project/Fact/Intent/Reason/Explore/Hint、审计、Worker 配置、Skill/MCP、Resource、WebShell/C2、Workspace 与导出 API 投影到同一份状态。旧 conclude 在一个事务中完成 Step 与 Fact 提交。Cordis 插件继续使用真实 `apply(ctx)`、服务注入、Fiber 生命周期和管理 API。

## 数据与启动

新版数据库、会话和 Workspace 位于 `.redtrace/v2` 与 `workspaces/v2`。首次启动从 `redtrace.yaml` 复制配置；后续写入只修改新版副本。旧数据库和工作目录由 `scripts/archive-redtrace-legacy.mjs` 一致性归档，不与新版共写。

```powershell
.\start-redtrace.cmd
```

```bash
./start-redtrace.sh
```

两个入口都检查 Node 24.15+、安装锁定依赖并进入完整 Cordis 兼容模式。精简内核可用 `node scripts/run-redtrace-node.mjs` 单独启动。

## 验证

`packages/redtrace-engine/test` 覆盖事务并发、Decide 不重入、并行事实唤醒、Step 唯一领取、规划不可用时继续执行、暂停恢复、崩溃副作用保护、旧 API、真实 Pi 文件工具、MCP、外围操作、配置和删除。`scripts/verify-node-ui.mjs` 驱动真实 Chromium 验证项目创建、FGS 操作、外围页面与持久化；`scripts/benchmark-node-migration.mjs` 在同一平台和确定性任务上比较旧版、精简内核与完整兼容模式。
