# RedTrace → Sapper AI Legion：当前实施结果

当前对象：/Users/lxy/Downloads/RedTrace

**本地源码迁移和本地正式切换已完成；E7 切换结束时停止。2026-11-12 已补齐军团、工作台/FGS、日志与设置的前端联动验收。当前另一个终端启动的宿主在线，但 Campaign 停止、项目为空；本批未重启或恢复正式执行。** 没有把外部比赛平台/VPN、未提供的目标或可选引擎的未验收项写成成功。此前本文件中“仅 E0/E1/E2 完成”的记录已归档到 /Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E3-E7/IMPLEMENTATION-before-final.md。旧的“保留独立 Reason / 可选双模式”决定失效。

## E0–E7 已执行结果

- E0：沿用原始工作区基线，不以 Git HEAD 覆盖未提交修改；未主动更新 DSH vendor。
- E1：Fact 文件/工具结果、Finding.details、原生明文/Zstd Session 附件保全与哈希读取；缺失引用明确阻断。文件型 submit_fact 现在立即保存实际文件字节，拒绝不存在路径，图节点 ID 不能冒充路径。原生删除 fixture 验证删除 Step/Run/Session 后附件和成果仍可读、哈希一致、活动引用已脱离。
- E2：一个真实全局 Commander DSH Session；Scout 分类 → General 主线 + 最多两个同题 Soldier/Scout 专项小队 → 共享 FGS → Commander 证据验收；HELP/REPORT/MESSAGE 分开持久化 pending/queued/admitted/uncertain，idle 用原生 steer 唤醒。
- E3：调度、配置、运行预设、界面和技能均改为 Commander/General/Soldier/Scout。独立 Decide/Reason 不能 claim 或执行；Bootstrap 仅为 Soldier 初始 Mission。历史类型/兼容字段只用于读旧数据，不构成双执行模式。Commander 接管 Goal/Step/证据维护与验收。
- E4：Sapper 分类/升级阶梯、战术提示、真实任务用时区间并集、Park/恢复条件、截止时间、Endgame/最终提交阶段；Commander 通过原 SDK 管理实例/扣分提示。关闭前要求同题执行停止、未知工具结果已核验；closed 不明确时保留实例状态。Board 来自现有 FGS/Campaign。
- E5：原生当前请求 Token Meter（不是累计使用量）、85% STATE 提醒、DSH 原生自动压缩、成功压缩后新 Run/Session 接力；避免把整个旧 STATE 递归嵌回新上下文。原生写所有权核验后恢复，未知操作不重放；配置内同角色模型升降级。Commander 与 Worker 共享既有全局及路线并发配额，容量不足时结束 Commander 周期释放既有槽位；未增加锁、队列或替代执行器。未创建过的清理后 Commander 与真正丢失的旧 Session 区分处理，实际首次恢复已验证。
- E6：项目内 Markdown 经验文档、即时 FTS5、Family Transfer 作为未验证 Hint，目标任务 Fact 复验确认；军团 Board、STATE、压力、模型路线、Park、消息、证据检索/预览、迁移与确认界面。
- E7：源代码补丁/归档重建、独立副本回滚、实际运行数据一致性备份与重建、原配置凭据值比对、四角色配置和 18 个已安装 Skill 无漂移迁移、所有 Step/Run/审计 Run/原生 Agent Session 重置。实际宿主启动并读到四个新预设；首次恢复 HTTP 200，再暂停 HTTP 200、SIGTERM 退出 0，最终无 RedTrace 服务进程。

## 指定模型真实验收

模型：auto/deepseek-flash；使用用户提供的本地 API，只在子进程环境注入测试凭据，未改正式 Provider 凭据。

/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E3-E7/real-model-evidence-1794381174959/result.json

源项目：一个 Scout、一个 General、两个 Soldier，四个 Run 全成功、pendingTools 全空；Scout 先完成，General 再启动，两个专项 Run 实际重叠 13428ms。真实相对文件 lane-a.txt=5、lane-b.txt=7，General 核验总数 12，Commander 验收。

Family Transfer：源经验即时索引，目标只有未验证 Hint；目标 Scout/Soldier 独立计算 6+8=14，生成实际文件和目标 Fact；Commander 调用原生确认，使 transfer 状态成为 target-verified 后验收。两个目标 Run 均成功且无未决工具。

/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E3-E7/real-model-evidence-1794381174959/PROJECT-EVIDENCE.tar.gz

此真实归档已重新解包：6 个文件证据引用、4 个不同哈希均找到实际字节，目标文件为 14。最初失败轮次没有改写为成功：包括第三个 Soldier 导致严格断言失败、首轮种子来源误解，以及 Board 的非 lossless JSON 错误。共享工具输出已在根部规范化，并加入真实原生工具回归。

真实验收后还修正了 Park/初始 Mission 标签和冷启动 hasSession 元数据；这些最终改动通过视图模型/原生恢复及完整回归，不声称对该最后小补丁又重跑过整套真实模型。具体源码哈希与后续变更在 /Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E7-cutover/FINAL-ACCEPTANCE.json。

## E7 切换时验证（历史；最新结果见后文）

- 类型检查、DSH 构建：退出 0。
- Engine：243 项，238 通过、4 失败、1 跳过。4 项为原有离线知识库 Python 路径 ENOENT，没有删除/跳过它们。
- DSH：58 项，57 通过、0 失败、1 跳过。
- 退役的 Reason 调度/通知/提示词测试已改为四角色、原生消息、Commander 游标和共享容量契约；旧内容保存在本次 before 快照和原始基线，不用测试数差值冒充功能增量。
- BASELINE：LEGION_SUPPORTED=false / LEGION_RUNTIME_SUPPORTED=false，退出 0。
- MODIFIED：General/Park/恢复以及原生四角色协作、实际消息入模、Commander 验收和同 Session 恢复通过，退出 0。
- ROLLBACK：两个 supported 标志恢复 false，退出 0；405 原基线文件 + redtrace.mock.example.yaml 补充原件，共 406 个原文件哈希一致。91 个变更文件补丁重建及源码归档解包后哈希一致。没有在原仓库执行回滚。

## 实际运行库与备份

检查的正式本地库本来就是空的：Project=0、Step=0、Run=0、audit Run=0、Agent Session=0。因此没有把 fixture 删除数当成正式数据删除数。保留项目/成果的非空删除行为由原生 fixture 另行证明。

/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E7-cutover/runtime-backup-1794381373725/BACKUP.tar.gz

备份权限 0600；完整快照已解包逐文件验证，SQLite integrity_check=ok；随后又在独立副本重开数据库和认证配置。正式 Provider 凭据值哈希与资源行哈希在切换前后及冷恢复副本一致。源源码回滚不是生产数据库备份；不能把 ROLLBACK.sh 盲目用于原工作区。

最终 Campaign=stopped，Step/Run/audit Run/Agent Session 均为 0；服务进程检查为空。实际初次恢复/再停止记录：/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E7-cutover/NATIVE-FRESH-RESUME-STOP.json。

## 控制、性能与范围透明性

只增加迁移明确要求的军规、证据、实例关闭结果、同角色模型路线、既有容量和清理前置校验；已安装 Skill 漂移会在删除前阻断，备份不一致不会执行清理。复用原生 Session 所有权，不新增锁、队列、自动重试、fallback 或依赖。并发没有改成全局串行；同题专项仍可并发，并受原全局/Worker 配额约束。认证、授权、执行隔离、未知结果核验和必要资源配置保留。

## E7 当时 UI QA（历史；以下限制已由后文补验替代）

- Summary：军团页桌面导航、FTS5 结果、实际证据预览和持久消息操作曾在真实浏览器通过；Park/初始 Mission 最终标签通过视图模型回归。
- Environment：本地隔离原生 HTTP fixture；Ego 浏览器桌面。续接原 TaskSpace 返回 task space not found，未绕过或切换浏览器。
- Checks：页面身份/非空/无框架覆盖层/检索预览/持久消息有已保存 DOM 和截图证明；最终移动端、重连后的控制台检查不宣称通过。
- Interaction：进入军团 → 检索 integer → 打开实际经验文档 → 向目标项目发送消息 → 页面显示 pending（不冒充 admitted 或 Fact）。
- Evidence：/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E3-E7/ui-browser-limitation.json；/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/E3-E7/legion-ui-desktop.png。

## E7 当时未验收边界（最新见后文）

外部比赛平台、真实 VPN/部署环境没有获配置或授权，不把本地 SDK process fixture 写成外部平台端到端通过。4 项原有离线 Python 缺失、可选 Ghidra 及移动端/最终浏览器控制台未补验。

## 四件交付物

/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/MODIFIED_FILE.tar.gz
/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/DIFF_FILE.patch
/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/VERIFICATION.txt
/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/ROLLBACK.sh

完整文件列表：/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/CHANGED-FILES.json。ROLLBACK.sh 依赖同目录 BASELINE.tar.gz 和 BASELINE-EXTRA.tar.gz，只验证用于副本。

## 2026-11-12 前端控制台补充：当前有效结果

完整报告：/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/frontend-console-20261111/FRONTEND-REPORT.md。覆盖军团、工作台/FGS、日志、设置，不只军团页。原生对话框替代 raw-ID prompt；真实 Run/消息状态、同角色路线、证据选择/分页/Goal 验收、Commander 原生历史日志、配置冲突保留草稿和四角色共享容量均已实现。

最终类型检查/DSH 构建通过；Engine 264 项：259 通过、4 原有 Python 缺失失败、1 跳过；DSH 59 项：58 通过、0 失败、1 跳过。累计 95 文件补丁/归档重建；完整源码副本回滚恢复 406 原件；本批 --frontend 回滚恢复 13 基线文件、移除 2 新文件，BASELINE/MODIFIED/ROLLBACK 匹配命令和哈希均核验。四角色原生 DSH 协议闭环及当前 Commander 原生日志读取通过。最终源码本批没有重跑指定外部模型，不把协议 fixture 当成真实模型或外部平台验收。

用户批准 ego-browser 后，已完成日志/设置/证据选择的 390px 窄屏和最终 JS error 检查，截图及交互回执见报告；替代上述历史“移动端/最终控制台未补验”限制。军团 Park/消息/交接/Family Transfer 及设置真实409分支、目标验收真实HTTP写入均在隔离夹具验证，非正式运行库。未新增额外控制机制、依赖或轮询器，未改并发语义/权限隔离。

最新只读记录：/Users/lxy/Downloads/RedTrace/docs/legion-implementation-20261110/frontend-console-20261111/LIVE-READONLY-STATE.json。主宿主 PID 59469 在线，Campaign=stopped，projects=[]；Command Session 未创建（available=false）。本批已回收所有自建隔离夹具，未操作该独立启动宿主。E7 的零任务/Session和停止进程记录是当时结果，不应表述为今天宿主已退出。外部比赛平台/VPN/授权目标、离线 Python 缺失与可选 Ghidra 仍未验收。

ROLLBACK.sh 增加可选 --frontend（仅副本），依赖同目录 FRONTEND-BASELINE.tar.gz；默认仍为原全迁移副本回滚。源码回滚不等于数据库备份，且运行前需重建 DSH；不能盲目用于原工作区。
