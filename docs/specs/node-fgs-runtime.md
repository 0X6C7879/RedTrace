# RedTrace Node FGS Runtime

RedTrace 的默认运行时是 TypeScript、Node 24.15+ 与内置 `node:sqlite`。一个 Node 进程同时承载 FGS 存储、事件调度、旧版 HTTP 兼容层、Cordis Web 宿主和按需外围能力；启动不需要 Python。

> **退役记录（2026-09-16）**：独立的 DSH 运行时组合（`profiles/redtrace/runtime.cordis.yml`、direct/isolated/reason worker profiles、`packages/redtrace-dsh` 内的轮询 Scheduler、persona/context/contracts 预设与 Web 反代插件）已删除。`packages/redtrace-dsh` 现在只保留引擎宿主（`compat/cordis.mjs`）挂载的适配插件与共享模块；唯一入口是 `profiles/redtrace/node.cordis.yml`，由 `start-redtrace.sh` / `start-redtrace.cmd` 启动。旧 Python dispatcher 设计见 git 历史中的 `docs/specs/dispatcher-design.md`。

## 状态模型

- `Fact`：有来源、可引用的事实。提交后保留历史并唤醒 Decide。
- `Goal`：根目标或子目标，保存完成状态和证据引用。
- `Step`：唯一可领取的行动单元，关联来源 Scope / Fact / Finding、目标、优先级、Worker、执行适配器与检查点。保留全部产出引用，展示在执行面板。
- `Finding`：面向交付的成果，引用支撑它的 Fact；可作为后续 Step 的来源或 Goal 的验收证据，新增后独立唤醒 Decide，不等待 Step 结束。
- `Hint` 与 `Observation`：人工输入和中间记录，不自动提升为 Fact。

SQLite 短事务原子更新图、租约、运行归属、审计和事件序号。Decide 每个项目最多一个；它只读写任务图且不因自己创建 Step 再次触发。Execute 可并行运行，任一 Execute 提交 Fact 后即可启动新的 Decide。规划器不可用时，已经存在的 Step 继续派发。

Decide 首次启动后，由任一新增 Fact 或 Finding、既有运行时关键事件或失败重试驱动，不再要求证据与 Step 结束配对。Hint、Observation、普通 Goal/Step 编辑及 Reason 自身维护不递归触发。未完成 Step 的容量限制只阻止创建更多 Step，不阻止规划；总并发、项目并发和 Worker 上限不变，不预留 Reason 槽位，空位出现时先派发可运行的 Reason。持久化 evidenceSeq/acknowledgedEvidenceSeq 记录待办；成功默认只确认启动边界，finish_decide({throughEvidenceSeq}) 可明确确认连续增量中已实际处理的边界，失败不确认。

## 实时维护接口

Reason 独占 `manage_evidence`：同类 Fact/Finding 可合并、归档、恢复；原始记录与来源均保留。合并修复 Step.sourceIds/factIds、Goal.evidenceIds、Finding.factIds，并汇总证据与产生它们的 Step。归档被活跃 Step、有效 Finding 或已达成 Goal 引用的节点返回 409 与阻塞引用清单，Reason 须先修复引用；历史引用不阻止归档。节点变更使用 expectedVersion；冲突返回当前节点，整个事务不产生部分修改。Scope 与 Root Goal 原始描述不可改写。不自动执行语义去重；Reason 必须确认目标、题目、环境和结论一致后才能合并。

`read_graph` 默认只读活跃证据，按 ID 可以回读历史；`includeInactive:true` 显式包含归档与合并节点。`read_graph_delta({after,limit})` 最多返回 100 个事件及相关节点，按 cursor 连续翻页。读取不代表已处理，跳过的增量不能用高水位确认。HTTP 同步提供 `POST /v2/projects/:id/evidence/manage`、`GET /v2/projects/:id/graph/delta` 和各节点列表的 includeInactive/limit/offset 参数。原 schema 2 数据默认兼容，不清库。

`update_step` 支持描述、来源、目标及执行设置。未领取 Step 可直接改；运行中同目标同权限边界用 amend，变更目标、权限或环境必须 replace。Subgoal 描述变更传播到未结束的后代 Step。替代 Step 保存 replaces/replacedBy，等待旧 Run 确认停止后才变为 pending；旧结果保留、迟到写入被拒绝。unknown 结果保持阻塞；核实后可通过 `POST /v2/projects/:id/runs/:run/resolve` 提交具体 resolution。该接口是确认记录，不替操作者核实远端副作用。

Explore 用 `sync_step({planVersion})` 接收当前 Step、祖先 Goal 和有效依赖。DSH 执行前 guard 同时检查 Run 与模型回合版本；rootCallId 调用树及 PTC 后代继承原版本，旧批次即使执行了 sync_step 也不能继续外部动作，须下一回合生成新动作。已发出的命令不承诺追溯取消。纯证据提交和状态读取可保留已验证结果。

## FGS 图投影

画布永久节点只有 `scope / fact / finding / subgoal / goal`；内部保留 `origin` 标识并显示为 Scope。Goal 在创建时即以 open 状态出现，完成由引用证据的状态更新表达。Step 是持久化的执行记录，不占据永久画布节点；但未完成（pending / running / paused / blocked）的 Step 会作为仅供人工审核的虚拟临时节点叠加在画布端点上：黄色圆形、来源连虚线 `executes` 边、指向目标的 `pursues` 边，完成产出 Fact 后虚拟节点消失、由产出边接管，与旧版开放 Intent 的画布行为一致。该虚拟层由 `liveSteps` 在读取时计算，仅存在于 `/v2/projects/:id/graph` 响应中，不进入导出/快照文件，也不被 `read_graph` 等读图工具读到。

`src/fgs.ts` 在读取时投影原始记录，不建立第二份图数据库：Scope 关联目标范围；Step 的每个来源连接其全部 Fact 产出；Fact 支撑 Finding；产出关联推进的 Goal；验收证据连接 Goal；Subgoal 指向父 Goal。目标归属与验收证据分开标记，Step 结束不会自动证明 Goal 达成。取消或失败的 Step 仍保留已提交产出的来源关系。边保留 Step ID，可进入执行面板查看来源、全部产出和各次运行日志。

`GET /v2/projects/:id/graph?revision=N` 按事件重建历史状态。新事件保存初始节点及状态快照；旧历史缺失创建描述等信息时返回 `historyIncomplete`，不拿最终状态填补过去。YAML Snapshot 包含完整 `fgs` 节点、关系与原始执行记录。画布支持按目标聚焦，轮询状态变化保留视口，窄窗口使用详情抽屉。

## 执行与恢复

所有真实 Worker 使用 DSH 原生 Agent Loop（当前 vendored 版本 `0.2.1-alpha.2`）；`dsh-llm-pi-ai` 仅负责 OpenAI Completions/Responses 与 Anthropic 协议适配。引擎不再依赖或运行 Pi Agent，旧 `backend: pi` 配置统一解析为 `dsh`。只有测试用 `provider: mock` 保留 mock 执行。Step 会话彼此隔离，Stop 保存当前活动的检查点，Resume 恢复同一 Step。进程重启会保留已提交的 Fact/Finding；没有确认结果的外部操作标记为 `unknown`，不会自动重放。

## DSH 原生能力插件

凡是 DSH 原生提供的通用 Agent 能力,不再自研 Skill/MCP;RedTrace 只保留安全任务编排(FGS、Bootstrap/Reason/Explore、Intent 调度、Worker/Provider 路由、Fact/Finding/Step、共享 Resource、审计)。通用能力分两类进入插件管理页(`/__redtrace/plugins`,manifest 位于 `.redtrace/plugins.json`):

**会话级能力栈**——`packages/redtrace-dsh/src/execution-tools.ts` 在每个 Execute 会话的 scoped 上下文里挂载,插件运行才挂载、停止只影响新会话。每个会话先 `isolate` 再挂载服务,并发 Execute 互不冲突,会话结束自动清理(后台任务、PTY、spill 文件句柄随会话销毁):

| 插件 | 挂载的 DSH 包 | 模型得到的工具 |
|---|---|---|
| `redtrace-web` | `web` + `web-search-deepseek` + `web-fetch-http` + `tool-web` | `web_search`(密钥 `DEEPSEEK_API_KEY`)/ `web_fetch` |
| `redtrace-jobs` | `jobs-local` + `tool-jobs` | `job_output` / `job_list` / `job_kill`,bash `run_in_background` |
| `redtrace-terminal` | `terminal` + `terminal-bash` + `tool-terminal` | `terminal_open/send/read/signal/close/list` |
| `redtrace-fs-search` | `tool-fs-search` | `glob` / `grep` |
| `redtrace-spill` | `spill-local` + `spill-policy`(50 KB) | 大结果落盘 + 预览与取回指引 |
| `redtrace-tool-timeout` | `tool-call-timeout-policy` | 声明超时预算的工具统一截止 |
| `redtrace-repeat-reminder` | `repeat-tool-reminder` | 3/5/8 次连续同参调用注入提醒 |
| `redtrace-lsp` | `lsp` + `lsp-stdio` + `tool-lsp` | `lsp`(goToDefinition 等;只挂载本机已安装的语言服务器,一个都没有则整栈跳过) |
| `redtrace-ptc` | 会话内 `agent-tool-presentation`(ptc 模式) + python PTC sandbox | `run_code` 追加在原生工具旁 |

前六项(加 repeat-reminder)默认开启;LSP 与 PTC 默认关闭,在插件页开启。direct 档案下 terminal 挂非受限 sandbox-policy(danger-full-access),isolated 档案继承 workspace-write。Reason/Decide 会话不挂执行工具链,能力栈同样仅限 Execute。

**宿主层服务插件**——由插件管理器作为子 Fiber 挂载、对全局生效,按服务生命周期管理:

| 插件 | 提供的服务 | 说明 |
|---|---|---|
| `redtrace-credentials` | `ctx.credentials` | DSH 凭据文档(`$DSH_HOME/.credentials.yaml` + `.env` 回退),供 web 搜索等解析 `DEEPSEEK_API_KEY`;与 RedTrace 自管 Provider 密钥互不影响 |
| `redtrace-attachment` | `ctx.attachments` | 原生图像附件存储；工具截图先入库再以 attachment 引用送入模型，必需且不可停止 |
| `redtrace-file-references` | `ctx.fileReferences` | `@` 路径补全服务,为交互前端预留 |
| `redtrace-ptc`(宿主半边) | `ctx.codeRuntime` | Python PTC 运行时；会话内使用上游 ptc 呈现模式 |

manifest 语义:默认开启的插件用 `disabled` 记录停用;默认关闭的用 `enabled` 记录开启,重启后按 manifest 恢复。SSH seam(`fs-ssh` 等)与 `ptc-runtime-node` 在当前 vendor 树中不存在,属 DSH master 的未引入能力,不在此列。

## 兼容层

`/v2/projects/:id/graph`、Goal、Step 与 Finding API 直接操作 FGS。旧 Project/Fact/Intent/Reason/Explore/Hint、审计、Worker 配置、Skill/MCP、Resource、WebShell/C2、Workspace 与导出 API 投影到同一份状态。旧 conclude 在一个事务中完成 Step 与 Fact 提交。Cordis 插件继续使用真实 `apply(ctx)`、服务注入、Fiber 生命周期和管理 API。

## 数据与启动

数据库、会话和 Workspace 位于 `.redtrace` 与 `workspaces`(规范路径,无版本子目录)。首次启动从 `redtrace.yaml` 复制配置;后续写入只修改该副本。

```powershell
.\start-redtrace.cmd
```

```bash
./start-redtrace.sh
```

所有入口（启动脚本、`node scripts/run-redtrace-node.mjs`、引擎 CLI）均启动同一 DSH 原生 Cordis 组合；旧 `--compat` 为无操作兼容参数，不再存在精简 Pi 入口。Provider 测试也走独立 DSH LLM 服务，不修改配置修订或共享适配器。密钥只在适配器私有凭据作用域中解析，不写入进程环境、运行时快照或明文存储。

## 验证

`packages/redtrace-engine/test` 覆盖事务并发、Decide 不重入、并行事实唤醒、Step 唯一领取、规划不可用时继续执行、暂停恢复、崩溃副作用保护、旧 API、真实 DSH Bootstrap/Reason/direct/isolated Loop、暂停恢复、凭据轮换、原生 MCP、外围操作、配置和删除。`scripts/verify-node-ui.mjs` 驱动真实 Chromium 验证项目创建、FGS 操作、外围页面与持久化。
