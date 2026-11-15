# 双模式工作台重构（2026-11-15）

## 架构
- 保留每 Project Commander、Project.mode、Graph、Scheduler、Worker、FGS 和唯一 DSH Harness。
- Benchmark：独立题目图，首派 Soldier；可选 Scout，不再强制分类门槛。题目规划者接管阶段计划和 Goal 证据验收，General 增援时继承原列表。Commander 保持常驻原生会话和原有 60/90 秒巡检。
- General：唯一主图，Commander 承担原 Reason 的规划、TodoList、FGS 和验收职责，Worker 独立并发。禁止新建 Scout；重开数据库时把旧 General Scout Mission 迁为 Soldier，记录迁移事件，保留原生审计和内容。
- specialist 的名称、职责、能力、范围存入既有 Step JSON。专业 Agent 使用既有 Soldier/General 模型路线、Session、生命周期、交接和资源限制；不新增 Harness、执行池或配置必填项。
- 两模式共享证据停滞阶梯、既有 Park/接力/换模型与止损。复杂任务允许直接 General。绩效按真实 Run 汇总证据、Token、时间和前任；精英编队通过既有配置路线和经验索引形成，不制造独立评价模型。
- 替换 Mission 保留 role、taskKey、父编队和专业定义；未知工具结果仍需确认，未降低隔离边界。

## 会话与数据
- Project 三栏布局：Benchmark 固定 Commander；General 固定参谋长及只读 Commander；其下统一 Workers、真实消息流、运行态势。Benchmark 一题一会话；General 一执行实例一会话。编号来自持久化 Run 顺序，不随排序改变。Commander 指令在右，Worker 在左，系统事件居中；上下文和工具细节默认折叠。
- Benchmark Commander 人工输入复用 commanderInput、Hint 和 durable mailbox，保留 pending/queued/admitted 的区别。Worker 输入只读。
- 既有 Project 刷新周期读取单个合并快照；会话以审计 ID、原生 offset 增量读取并独立向前翻页，不增加 UI 定时器。刷新后复原选中会话。Commander 原生接力 Session ID 历史持久化，并可选择读取。
- FGS 五面板：节点详情、阶段计划、执行动态、执行成员、事件记录。Hint 为操作入口；原图交互和数据模型不变。实际规划者维护的列表保存在 commander_todos。
- global_chats 仅保存独立全局对话、General 参谋长及 Commander 输入附件索引；消息内容只保存在原生 DSH JSONL，不复制为另一套消息库。全局助手仅在发消息时激活，无巡检或后台调度。复用已配置 Commander 模型路线和全局/路线容量，不占 Project 配额。
- 全局助手工具按需分页查询 Project/Graph/Worker/Finding/进度，只通过 commanderInput 转达明确 Project/Graph 的 Hint 或调度指令，不创建 Worker、不维护 FGS、不验收 Goal。

## 上游适配
- Sapper-v2 本地 HEAD：7b75e6f1f5d5b4ae0c55878b0dd0994d9b08f1fb；检查 docker/commander/SKILL.md 的 §4.6 时间阶梯、§7 经验复用/精英编队，以及既有 RedTrace 接力实现。复用策略和原生执行路径，不移植 tmux、独立 Harness、模型密钥池。
- ARTEX 本地 HEAD：73d5437c5a64559ed803bcd096d2a0a0014a1214；检查 agent/chat.go 的任务独立会话、web/src 工作台结构。保留 RedTrace SQLite/DSH，不引入 Norma 或 PG，不复制其执行器。
- Apple Design：保持紧凑深色、即时按下反馈、空间一致性、键盘焦点；支持 reduced motion/transparency/contrast。小窗口可通过“态势”打开非阻塞侧栏，无额外动画库。

## 验证与边界
详细原始命令、stdout/stderr、退出码、哈希和回滚验证在本次交付 VERIFICATION.txt。原生测试使用本机确定性模型协议服务，不代表真实模型或线上 Benchmark 成绩。
本次未更改现有项目数据目录、凭据或模型配置；迁移在下次加载数据库时自动执行。现有运行服务需要重启才能加载代码。
仅新增必要的附件归属校验，防止跨会话引用；未新增额外控制机制。职责归属、会话隔离与现有容量计数按用户要求适配。未新增权限系统、审批、重试、锁、队列、模型 fallback、额外轮询或执行框架。

## 最新交互补充
General 的用户入口改为参谋长：独立、按需激活的原生 DSH Session，仅按需查询本 Project，将人工 Hint、调度和附件转交 Commander；无 Scout、无第二套 FGS/TodoList，Commander 仍是唯一任务规划者。全局助手保持跨项目独立。Benchmark 用户仍直接向 Commander 发消息。

三处输入（全局助手、参谋长、Benchmark Commander）均可上传任意文件及 DSH 支持的 PNG/JPEG/WebP/GIF 图片；二进制直传，文件走原生流式存储，图片复用 DSH 原生尺寸/格式策略及模型图片块。仅维护附件归属索引，不复制会话正文；附件只能由其会话引用、下载和转交。Commander 输入附件索引不启动另一个 Agent。文本文件可按需分段读取，二进制文件提供原始内容与下载；未新增格式解析器；附件上传和读取不额外调用模型。

专业 Agent 在创建后即以待执行任务出现，运行后依据真实 Run/Session 稳定编号；接力产生独立实例并保留交接。新增证据记录 producerRunId，避免把同一底层 Worker 路由产生的证据误计到多个 Agent；历史无法归属到 Run 的证据仍保留原始数据，不猜测归属。参谋长是用户请求增加的一次按需模型交互，不参与每次 Worker 工具调用。
