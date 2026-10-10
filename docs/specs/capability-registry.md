# RedTrace Capability Registry(动词能力体系)

能力层只有一轴:

- **能力动词(capability verb)**:`remote.command`、`remote.file.read` 等动作动词,描述"系统能做什么"。Step 的 `requires` 字段声明所需动词,决定该会话暴露哪些动词工具、以及派发时如何选择实现通道。本轴由动词注册表管理。

Skill 无分类轴:Execute 会话统一通过 DSH 原生 skill 栈(`skill` + `skill-filesystem(customSkillDirs=.redtrace/skills)` + `tool-skill`)加载全部启用 Skill,由 agent 按需自主调用;Decide(Reason)不限制 Explore 可用的 Skill,add_step 也不再携带分类字段。

## 组成

| 部件 | 位置 | 职责 |
|---|---|---|
| 动词注册表 | `packages/redtrace-engine/src/capability-verbs.ts` | 动词定义(id/描述/参数 schema/risk/operation action)、适配器声明(verbs/kinds/pluginId/establish 提示)、`GET /capabilities/verbs` 路由 |
| 派发器 | 同上 `dispatchVerb` | 通道选择 → `Operations.createTask` → 轮询至终态;审批等待提前返回 |
| 工具工厂 | 同上 `verbTools` | 按 Step.requires 生成 pi 风格 AgentTool(`remote_command` 等),runPi 与 compat 宿主共用 |
| 通道族插件 | `packages/redtrace-dsh/src/webshell.ts`、`c2.ts` | Cordis 插件 `redtrace-webshell` / `redtrace-c2`,进插件管理页,提供族专属工具(探测、listener/payload/会话)并以其运行状态门控适配器 |

## 派发规则(通道选择)

1. `via` 指定资源 id → 校验在可用列表内后直接使用。
2. `target` 给定 → 在可用通道中按主机规范化匹配(URL 取 hostname,`host:port` 取 host,大小写不敏感);无匹配或多个匹配均报错，多通道时要求指定 `via`，绝不盲选。
3. 无 `via`/`target` → 恰好一个可用通道时自动复用;零个报"无通道";多个报歧义并要求消歧。
4. 选中后走现有 operation_tasks 队列:按资源串行、全局 8 并发。Worker 未命中特定 Resource/目标的项目授权时进入审批；执行前复查授权、插件状态、人工锁和项目状态。Runtime 计算风险下限，不接受 Worker 降低风险或自行审批。
5. 适配器可用性 = 其 pluginId 对应的 Cordis 插件处于 running 状态(compat 宿主经 `adapterAvailability` 注入 `PluginManager.running`);停用插件即从派发中移除该族通道。引擎独立运行(测试)时默认全部可用。
6. 建立通道不在派发器职责内:族专属工具(`webshell_register`、`c2_session_create`、`c2_listener_create` 等)与通用 `resource_register`(引擎侧,支持 secret)负责注册,人机共用,注册结果全部出现在 Web UI 运维页。redtrace-resource 独立插件已退役:通用注册/查询/详情由引擎侧 `resource_register / resource_list / resource_get` 承担(全部 Execute 会话可用,含 secret 存储与 pi 后端),通道族富表单注册在 redtrace-webshell / redtrace-c2 插件。

## Step.requires

- `add_step` 增加 `requires` 参数(enum 动态来自注册表,≤16 项不重复);`store.addStep/updateStep` 校验动词存在;旧意图 API(`POST /projects/:id/intents`)与 v2 steps API 同步透传;`legacyIntent` 投影回显。
- Execute 会话在 `step.requires` 非空时:暴露对应动词工具(任何 `remote.*` 动词自动附带 `remote_task` 轮询工具);launch prompt JSON 附带 `channels` 切片(匹配 kinds 的可用资源,≤8 条)。
- conclude 阶段 restrict 到图工具,动词工具自动切断;Decide 只见图工具,永不接触动词。
- requires 为空 → 行为与旧版完全一致(无动词工具、无 channels 切片)。

## 扩展路径(本期未实现)

- **插件 manifest provides**:plugins.json UserEntry 扩展 `provides` 字段,用户插件声明动词与资源。
- **CLI 适配器**:`tools/bin`(chisel/ligolo 等)的进程生命周期管理,提供 `pivot.socks` 等通道族。
- 当前注册表中的 proxy 为占位适配器(`stub: true`):声明动词、展示 establish 提示、不参与派发。Web 联网能力不走动词层:DSH 原生 `web_search` / `web_fetch` 工具由 redtrace-web 插件直接挂载进 Execute 会话。

## 执行结果与验证边界

- `ExecutionResult.version=1`，携带 completion、远端退出码（未知时 null）、error_code、stdout/stderr/combined_output、output_ref、truncated、execution_context 和时间。不能分流的通道只填写 combined_output。
- HTTP 200 不证明远端执行成功。需要帧的协议缺帧报 PROTOCOL_ERROR；无可靠完成证明的结果保持 unknown，任务终态 failed，不自动重放。
- 模型结果摘要有界；原始证据通过 result_ref 读取。当前持久输出上限 2 MiB，结果记录保存 saved_bytes 和截断标记，不声称保存了超限输出。
- 登记与自报能力不是验证。Worker 登记时无法写入 verified_capabilities；成功 `remote.session.probe` 只证明命令与探测能力，不能自动授予文件、PTY 或持久终端能力。
- Beacon v1 结果必须携带 attempt_id、completion、exit_code、error_code 和 combined_output。旧结果请求缺执行证明会被拒绝；同一 Session 一次只派发一个任务，拒绝旧尝试和已完成任务的迟到覆盖。
- `remote.task` 在通道插件停用后仍可查询历史证据。插件停用同时关闭拥有的监听器和后台运行资源；已派发结果不声称可以撤回。
- 远程终端与 Pivot 代码处于待验收状态：插件默认关闭，适配器 stub，不对 Agent 开放；不能以存在工具名称证明能力完成。

## 授权、租约与迁移

- 项目授权由管理 API 签发，具有动作、Resource/精确目标、Route、有效期和撤销记录。目标按精确值匹配，不使用字符串前缀授权。
- 管理 API 仍属于可信管理边界，Worker HTTP 头不是通用认证系统。部署必须隔离管理平面并使用受控代理/网络访问限制；不得直接暴露此 API 或宣称已实现对恶意客户端的完整身份认证。
- 租约按 conflict_key 串行，写操作检查 owner、有效期和 fencing token。释放只让租约过期，保留递增代次；Run 结束释放其租约，不推断远端进程已经结束。
- Operations schema 2 独立于 FGS schema 2。已有旧 Operations DB 在迁移前用 SQLite VACUUM INTO 创建一致快照，结构升级在事务中完成。重启不会恢复假的网络连接；中断任务保存 unknown 证据，不重放。
- 代码回退不能代替数据库回退：停止派发与服务后，将旧代码与迁移前 DB 快照配对恢复，新日志另存。
