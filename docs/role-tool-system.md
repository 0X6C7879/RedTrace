# 模式角色、工具绑定与调用统计

> 当前契约：Scout 已退出固定角色与工具绑定。Benchmark 缺少已有的证据分类时保持未分配，不自动转给其他角色；Commander 仅管理全局状态/资源、只读平台清单，不启停实例、不提交 flag、不读取原始攻击证据。REA 已迁为 CLI-only（0 MCP Schema）。工具目录每工具一行，保留角色 Schema 变体。详见 `OPTIMIZATION-REPORT.md` 和 `docs/rea-integration.md`。


## 身份与执行

`Project.mode` 选择固定身份。共同定义位于 `packages/redtrace-dsh/src/roles.ts`，Engine 配置、Worker 调度、Mission、模板、实际工具注册和调用入口使用这份定义，不用 `角色:模式` 字符串。

| 模式 | 固定角色 |
| --- | --- |
| Benchmark | Commander / General / Soldier |
| General | Planner / Worker |

General 的 Planner 是唯一规划者：独占主 FGS、Goal 验收、Step 创建和任务级 TodoList。Worker 仅领取执行 Step、调用执行工具并写回 Fact / Finding；没有 TodoList、建 Step、Goal 管理或验收工具。不创建动态 Agent、专业小队或 Sapper 式升级角色。Benchmark 专业 Agent 仍继承 Soldier；原有报告、单题规划、首派、巡检和交接保持。

General 新 Finding 只触发 Planner，不自动创建报告 Step。Planner 可用 legion_step(reportFindingId, sourceIds) 显式安排既有报告工作流，执行身份始终是 Worker；报告也可按 Skill 处理。

### TodoList、FGS 和 Frontier

已实际对照本地 ARTEX 的 agent/planner.go（todoFor、renderPlannerTodos、串行链提示词、Plan 的 Todos 注入）、server/engine.go 的 800 ms Debounce 与 Worker 领取流程。沿用其规划契约，而不复制双图、Intent 或 Go 运行时。

TodoWrite 仍以 `{content,status}` 全量替换任务清单，状态为 pending / in_progress / completed。复用 commander_todos SQLite 持久化；跨 Planner 唤醒、Session 交接和进程重启保持连续。阶段顺序、前置阶段和可选 Goal / Step ID 写在 content 中，不新增第二套依赖库；不复制 Fact/Finding 或 Step 详情。TodoWrite 不写 FGS，不创建执行队列。Planner 的每次唤醒带当前清单，Worker 的启动上下文不带清单；Worker 也不能通过原始执行查询读取 Planner 的 TodoWrite 审计。

FGS 的 Step.dependsOn 保存实际前置 Step ID，sourceIds 保存已存在的必要证据。Planner 只生成前置已满足的下一阶段；调度器在扫描 Frontier 和事务领取时均检查前置 Step 已完成。失败、取消、未完成前置不能解锁下游；独立 Step 保持并发，不新增锁或队列。前置关系只在建 Step 时指定，修改路线复用已有取消/替换路径，避免引入依赖编辑状态机。

General 的图状态变化、Worker 完成/失败和 Finding 写入通过现有事件流，按项目 Debounce 800 ms 后唤醒 Planner。Planner 每轮可创建零个或多个 Step，结束时释放容量；无工作变更时不空转。暂停、取消、超时、异常恢复、DSH 压缩与新 Session 交接复用原实现。Worker 默认只注入当前 Step、授权 Scope、必要证据摘要和相关 Hint，完整 FGS 按需查询。

内部 `commander` 收件地址、campaign 字段和 API 路径保持稳定：它们是控制通道，不是 General 模式角色身份。

## 配置迁移

同一个 Worker 可同时具有 Benchmark 和 General 资格；Provider、Model、max_running、priority 不合并或复制。`role_version: 3` 标识当前配置。未版本化配置保留 Benchmark 资格，补上 commander→planner、general/soldier→worker；删除旧 Scout 资格，不补发其他资格。v2 的 leader/operator 及工具绑定合并为 worker；worker 超时优先继承旧 operator，否则 leader。新显式资格不再自动扩展。

旧 Worker 实例工具绑定迁为固定角色集合。旧 General Step 的 general/soldier/reporter/leader/operator 迁为 worker；历史 Scout Step 保持原角色，解除 specialist 和 parentStepId，保留报告 Finding 引用、Run/Session、交接和证据。原始审计不重写，查询按模式映射当前角色。

## 工具注册和权限

- 工具目录按真实工厂与注册表枚举 DSH / RedTrace / MCP。仅同名、同来源、同输入 Schema 合并目录项；不同角色参数变体保留，不借用其他角色参数。
- 角色绑定是原有工厂权限的交集，不能授予该角色未注册的能力。Commander 挂载文件和本地检索工具，不挂载模型可调用的 Shell、REA、C2 或 WebShell。Planner 对齐 ARTEX 的基础文件、Bash、Skill、可用 Web 工具；任务派发与验收仍走 Planner 的既有 FGS 工具。
- RedTrace 和 MCP 的启用/角色条件同时进入 DSH `when` 与原生 dispatch guard，覆盖普通调用和程序子调用；下一模型步骤及新调用生效，不中断已经进行的调用。
- 外部 MCP 使用原生定义与执行函数，仅在执行 scope 增加同一角色条件，不增加代理或发现路由。REA 仍由实际执行 Worker 读取 Skill 后按需连接。
- DSH 原生 Schema、执行函数、原生激活条件和生命周期未改；角色绑定和全局启停现在同样适用于 DSH 工具。RedTrace 在原生 resolve 结果上做单层过滤并保留原始 dispose，调用入口使用同一份最新配置；不代理执行工具。CLI、Skill 文件、历史调用不计入 Schema。原生 `skill` 工具本身仍是 DSH Schema。
- 全局目录数量与活动 Run 经原生条件解析后的当前可见 Schema 数量分开返回。后者受插件、角色、启用状态、Skill 是否加载和当前模型条件影响，不把目录总数当 Run 输入。本轮原生本地 Provider 夹具测得 Planner 34、Worker 69 个可见 Schema（未加载 REA Skill），同时核对实际请求和活动 Run 的可见数量；不同任务/报告工作流和 Skill 加载状态会影响数量，不将全局目录数量注入单次 Run。

## REA：CLI 为主，29 个 MCP 为辅

锁定 rea-agents 6.4.0。部署包 node_modules/.bin 加入 PATH，直接执行 `rea`；不把 CLI 命令注册为 Schema，不在运行中安装依赖。静态分析、函数、字符串、过程搜索、反汇编、伪代码和 xrefs 优先使用 CLI。CLI 的 --snapshot 可保存分析快照，但 one-shot 不是同一内存 Program。

已核对锁定包 CLI_COMMANDS、CLI_COMMAND_TOOL_ALIASES、MCP_TOOLS_WITHOUT_DEDICATED_CLI 及实际命令实现。移除 6 个 CLI 等价的高频查询、其余可由 CLI 或组合读取替代的细粒度查询。保留无等价 CLI、需要当前 Program / Hopper 或同一 Evidence 上下文的操作：

- Program：open_binary、close_binary、binary_session。
- Hopper 导航/注释：list_documents、goto_address、next_address、prev_address、list_bookmarks、set_address_name、set_addresses_names、set_bookmark、unset_bookmark、set_comment、set_inline_comment；组合读取 get_navigation_context、inspect_address_context。
- Evidence：export_evidence_bundle、import_evidence_bundle、get_evidence_bundle、compare_artifacts、compare_functions、find_changed_behavior、build_call_path、correlate_static_and_runtime、verify_reconstruction、list_unknowns、record_unknown、update_unknown、verify_unknown_resolution。

连接、Program、EOF 关闭和 Evidence 保留继续使用原生 REA / DSH 生命周期。Hopper 专用操作在 Ghidra 不支持时仍返回上游 capability_unavailable；不包装成成功。Skill 的 CLI-first 适配单独记录 redtraceOverrides，保留上游哈希与 references 来源。

### 当前机器实测数量

| 来源 | 修改前 | 修改后 |
| --- | ---: | ---: |
| DSH 原生 | 19 | 19 |
| RedTrace 平台 | 114 | 109 |
| MCP（REA） | 59 | 29 |
| 全局目录 | 192 | 157 |

用户所述 193 在本次选定 checkout / 本机能力组合中实际复现为 192。已从 Git 原始源码独立枚举并核对，不按历史工具清单凑数。原目录将 REA 59 项误标为 RedTrace；表中按实际来源归类。环境装有 LSP 或另行配置 MCP、运行中出现原生展示项时，目录数量可随真实注册变化，不硬编码为 157。

最终只读检查中，既有 127.0.0.1:8000 进程（04:06 启动，未由本轮重启）返回 156 个目录项：DSH 20 / RedTrace 107 / MCP 29；上述 157 来自最终源码的隔离原生注册夹具。不能将已加载旧模块的进程或环境条件产生的额外原生项，与源码枚举结果混报。真实 Run 可见数继续以该 Run 原生选择结果为准。

## 调用统计

`GET /console/tools` 只返回目录、固定角色组、绑定、来源计数和活动 Run 的当前可见数量，不查询调用汇总。工具页的累计调用、使用工具数、成功、失败、未完成、最近调用在用户打开「调用统计」后加载；主表同步展示该筛选范围的数据。

`GET /console/tool-stats` 直接查询既有 SQLite audit_events / audit_runs，关联 projects / project_graphs，不创建第二套调用表。协调者原生 Session 的事件也投影进同一审计表。

- 以 run_id + call_id 配对，重复开始、完成及原生程序子调用不重复计数。
- 有完成事件才根据 error 判成功/失败；缺少完成事件单列 unfinished，结束或取消 Run 不等于工具失败。
- 历史角色按所属 Project.mode 映射为固定角色查询，不改原始审计；Benchmark 内部报告按 Soldier 模板归类。
- 支持 projectId、mode、role、from、to；统计先覆盖完整筛选集，history 的 offset/limit 只影响历史分页。
- 各工具按调用量排序、计算占比，点击查看时间、Project / Graph、Run / Call、角色、开始/完成耗时、参数与结果/错误摘要。只有一端事件的耗时为未知。
- 统计限制为当前真实注册目录的名称；已停用 Schema 仍可查询，历史退役工具不会冒充当前工具。

## 性能与边界

没有新增执行池、队列、锁、重试、模型 fallback、依赖或角色兼容适配层，没有把并行执行改成串行。权限条件复用原生 Schema 激活和 dispatch 边界；审计复用同一 SQLite 记录。全量审计聚合仅在用户打开统计和改变筛选时执行；目录加载不扫描历史。本次新增的控制仅为明确要求的 General Step 前置完成检查和 Planner 事件 Debounce；未新增其他额外控制机制。

## 验证

历史回归覆盖当时的六角色路由、同 Worker 跨模式并发、旧配置/Step 迁移、Planner 规划权限、Benchmark 小队边界和动态模板、General 禁止动态编队、前置依赖、Debounce 事件触发、工具启停/固定角色绑定与 stale/PTC 调用、真实目录、502 次跨 Run 审计配对/分页与 API。Benchmark 的 General / Soldier / Scout / 内部报告 Mission 保持原文；Commander 按用户后续要求补充本地证据读写和交接约束，不改变首派、巡检、换人、止损或常驻 Session 调度。Commander 增加 evidence_read / read_run 检查工具，平台工具数由 20 变为 22；其他 Benchmark 执行权限不变。

原生 DSH 使用本地模拟 Provider 验证会话、并发、Goal、TodoList、报告与交接，不代表外部商业模型或真实 Benchmark 成绩。REA 使用真实 CLI 和本机 Ghidra 对 ELF / PE 反编译，验证同一 MCP Program 两次查询只保留一个 Java 进程，以及取消、超时和清理；Hopper GUI 没有实际设备/许可证验收。

### 本次验收结果

- TypeScript 检查、完整 DSH 上游 / RedTrace 构建通过。新增热加载回归验证现有 Web 会话密钥更新/移除、旧搜索继续完成，以及 MCP 保存新增/修改/停用无需目录轮询。
- Engine 全套：388 项，387 通过、1 项按原环境条件跳过；DSH 全套：63 项，62 通过、真实 Ghidra 默认项跳过。上一轮已单独开启真实 Ghidra 并通过，本轮未改 REA 实现。
- 真实 REA：CLI 的 ELF / PE 反编译、MCP 相同 Program 的重复查询、取消、启动超时和进程清理通过；不以本地模拟 Provider 宣称真实模型成绩。
- Benchmark 原生常驻巡检、单题隔离、交接和压缩恢复回归通过；Commander 提示词只按本次批注增加文件/证据检查职责，其他 Mission 保持原文。
- ego lite 桌面验收：固定角色组、绑定保存 / 恢复、Schema 启停和过滤、统计按需加载、成功 / 失败 / 未完成区分、Project / 模式 / 角色 / 时间筛选、调用历史；1600×1000 无页面横向溢出。工具路径未出现应用 JavaScript 错误。
- 回归夹具同步替换旧 General 编队/自动报告/Bootstrap 契约。一次全量运行的原生协议夹具出现 ECONNRESET；随后单独验证和完整重跑通过，没有增加生产重试或修改调度来掩盖它。
- 所有临时日志、截图和验证副本位于项目外。没有提交、暂存、推送或主动重启用户已有服务；实际配置 / 数据在新代码下次加载时按上述规则迁移。

## 浏览器批注修正：协调者文件能力、原生工具配置与系统日志

参考本地 Sapper v2 的 docker/commander/SKILL.md §1、§3、§5：Commander 可以读取证据、peek Worker 输出、编辑 commander-state.md，但不直接运行侦察、利用或 Flag 提交。保留原有调度工具和运行节奏，新增原生 read/write/edit、已启用的 glob/grep；legion_evidence_read 读取校验后的持久证据，legion_read_run 按页查询原始 Worker 审计，均绑定本 Project。Benchmark 的新增检查工具不要求冗余 projectId；没有赋予 FGS 写入或验收权限。

参考 ARTEX agent/planner.go 的 actool.DefaultTools 和 Web 配置：Planner 获得原生文件、Bash、Skill、可用的文件检索/后台任务/Web 工具。没有开放 REA、C2、WebShell、远程终端或动态编队。TodoList 继续只由 Planner 使用 TodoWrite 管理，不转存为文件调度队列。原生工具服务保留现有文件系统和隔离语义，提示词要求协调者文件用于项目证据、规划与交接，不编辑运行配置或其他 Project。

工具详情不再因来源是 DSH 而整体锁死；能力已注册的固定角色可勾选或取消。未注册的能力标记“不适用”，不能通过绑定越权。原生 Schema 只读，角色/启停可编辑。保存与直接修改配置均热加载：下一次模型 Schema 选择及新调用读取最新配置；原生 when、Schema、执行函数与 disposal 不变。已经执行的调用正常结算，旧选择或嵌套调用不能绕过新的禁用策略。模型/Worker 路线继续在新 Run/下一协调轮次采用新配置，不强切正在执行的模型请求。common_env 修改会刷新现有会话的 Web Provider 配置，新搜索使用新密钥，进行中的搜索保留原配置；MCP 配置目录由现有 refresh 链路监听，保存新增、修改或停用后无需打开目录页面或新建 Run 才生效。Skill 内容/启停复用 DSH 原生文件监听。

工具表格调整列宽、行基线、状态标签不换行和固定角色标签；保留原黑色主题。开关采用短、可中断的位移反馈，支持 reduced-motion。配置对话框说明热加载时机，不把只读 Schema 误写为只读配置。

系统日志仍使用 Cordis 已有的最近 1000 条内存缓冲。将既有 SQLite FGS 事件中的 Project、Step、Run、Fact、Finding 生命周期转入该日志，游标避免重复；协调者轮次、配置刷新、插件同步也记录真实事件。不额外创建工具调用表，不记录模型正文、完整证据或工具参数。Worker 失败/未知结果记为警告；无活动时不添加假心跳。

原代码首次加载需重新启动对应代码进程；这与保存配置后无需重启不同。本轮不擅自恢复真实 Project 或启动商业模型任务。
