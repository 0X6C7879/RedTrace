# Project Commander + 双模式 FGS（2026-11-13）

> 历史指南：下文保留当时的配置和行为。Scout 已退役；当前可用角色及迁移规则见[角色与工具系统](../role-tool-system.md)。

## 1. 架构变化

Project 是组织和调度边界；Graph 是任务状态边界；每个 Project 的 Commander 只管理自己。DSH 仍是唯一真实 Agent 执行器，Scheduler、模型路由、FGS、审计、消息、FTS5 和原生压缩继续复用，没有第二套 Reason/Decide 执行路径。

- 每项目一行 project_campaigns：独立 Session、STATE、事件确认游标、模型路线、用量与运行状态。
- project_graphs 注册实际图；nodes / events / runs 增加带外键的 graph_id，JSON 同步携带 graphId。节点 ID 仍在项目内唯一，图内 revision、Fact / evidence / Hint / ended 序号独立维护。
- 同步 Store 图视图共享同一数据库和提交通知；没有新连接池、全局串行锁或第二调度器。节点引用、证据合并、工件读取和 Worker 消息执行 Graph 边界检查。
- 原生 Context 的 Scope、初始 Hint、read_graph、delta 和事件等待均限定所属 Graph。Project 级授权 Scope 和 Resource 仍共享，不能充当题目成果。

## 2. 创建与使用

使用原有启动器：在仓库根目录执行 ./start-redtrace.sh（Windows 用 start-redtrace.cmd），打开启动器显示的本机 URL。Node 要求 24.15+ 且小于 25。Worker 设置保留 commander/general/soldier/scout 角色、provider/model、max_running 与 priority；Commander 同样计入全局、项目和 Worker 容量，max_project_workers=1 时 Commander 必须保存 STATE 释放槽位后 Worker 才能运行。

创建 Project 时必须选 Benchmark 或 General；API 同样要求 mode，不提供创建后的直接切换开关。已有代码内部的单图创建调用仍按 General 处理；历史项目迁移也为 General。

### Benchmark

打开项目 → 当前 Project Commander 控制台 → 真实 Graph 题目列表（搜索、状态、排序、Goal 进度、角色、耗时、阻塞、最后状态变化）→ 点击题目复用同一 FGS 页面 → 返回所属控制台。

TSecBench 的 legion_platform_list 复用 SDK；未完成题目按 unique_code 幂等注册 Graph，各有 Origin / Root Goal。其他平台或本地任务使用通用 legion_graph，不将核心写成 TSecBench 专用。Commander 为新图派 Scout，已完成 Scout 的确认 Fact 支持分类，Easy/Medium 派 Soldier，Hard 可立即派 General，既有 10/20/30/45 分钟阶梯与 Park 规则保留。

### General

打开项目 → 唯一 Main FGS。Commander 读取 Origin、Hint 和目标，自主创建子目标及 Mission；可以直接派 Soldier 或 General，不强制 Scout 分类，也不应用 Benchmark 的分类升级推荐。General 最多组织两个同题 Soldier/Scout 小队。图页按钮打开 Commander 的 Board / STATE / 消息，默认首页不变。

### 用户提示

图页添加提示会保存为该 Graph 的未验证 Hint，同时进入所属 Commander 的持久化收件箱，携带 graphId / hintId；不会直接注入 Worker。控制台输入首先交给 Commander，未能关联题目的内容不会广播。Commander 用 legion_hint 关联图，用 legion_message 给对应 General/Soldier/Scout 发送，或调整 Mission / 创建角色。pending、queued、admitted、uncertain 分开显示；送达不等于执行，更不等于 Fact。

## 3. API 与工具

- POST /v2/projects：mode、title、origin、goal；mode 为 benchmark 或 general。
- GET/POST /v2/projects/:project/graphs：注册表 / 初始化题目（taskKey、title、origin、goal）。General 不允许第二张图；Benchmark 的 taskKey 项目内唯一。
- GET /v2/projects/:project/commander：只含本项目的 Campaign、Board、消息、分配与经验迁移。
- Benchmark 的 FGS / 节点接口显式传 ?graphId=...，例如 /v2/projects/:project/graph?graphId=...、/graph/delta?graphId=...。General 默认其主图。Benchmark 无 Graph 的项目读取只返回元数据和注册表，不拼接 FGS。
- POST /v2/projects/:project/hints?graphId=...：Hint + Commander 收件记录。未指定 Graph 的 Benchmark 提示只进入 Commander 收件箱。
- /v2/legion/session/events?projectId=...：只读该 Commander 原生日志；pause、resume、deadline、command 请求必须指定 projectId。
- /audit/tasks/:project/runs、events、usage、stream 支持 graphId；Commander 用量按各项目累加。无 Graph 的 Benchmark Snapshot 导出独立 graphs 数组，不混合节点。
- legion_graph / legion_hint 新增参数入口；legion_spawn 支持 graphId。任务角色、交接、模型升级、Park、最终验收仍复用原工具。

## 4. 隔离与执行语义

Commander 在项目限定 Store 上运行，工具拒绝其他 projectId / targetProject；生命周期管理器只管理会话，不共享决策状态。不同项目 Commander 可以重叠模型调用，事件只激活所属项目。Worker 只能读取自己的图；General 委派必须保持 taskKey 和 Graph，相邻无隶属关系或跨图 Worker 的消息经 Commander 筛选转达。

所有新增 Worker Run 在项目下 agents/<graphId>/<runId> 使用独立 cwd；暂停恢复保留原 Run 的 workspaceRoot，历史工作目录不移动。文件证据从真实执行 cwd 提升至现有项目哈希工件库，新增 Graph ↔ artifact 归属关系，已有 General 工件回填到主图。相同内容可以分别被两个图实际发布，不能仅凭另一题的 artifact ID 越图读取或引用。

图根 Goal 验收依赖当前 Fact/Finding，不接受 Origin、Hint 或消息作为证明。Benchmark 完成一题只完成自己的 Graph，不会关闭其他图或整个 Project；General 根 Goal 达成保留原项目完成语义。

## 5. Sapper-v2 复用情况

保留四角色动态实例、HELP/REPORT/MESSAGE、收件实际状态、STATE、Board、两支专项小队、原生 Token Meter 85% 提醒、DSH 自动压缩、新 Run/Session 接力、未确认工具不得重放、同角色模型接力、Park 与恢复条件、FTS5 经验检索及目标复验。跨项目经验只通过已发表的经验文档迁移为目标题目的 Hint，不复制来源 Fact 或私有 Commander STATE。

仅新增需求必需的 Project/Graph 归属校验和数据库唯一性约束；未新增额外控制机制（重试、fallback、限流、消息中间件、全局锁、执行器、模型池均未增加）。没有更改现有认证、授权或扣分确认边界。

## 6. 数据库迁移

当前 schema 2 内通过 project-graphs 迁移标记升级，使用一个 SQLite 事务：建立注册表及列、为历史 Project 建 main Graph、回填节点/事件/Run、设 mode=general、检查外键。保留原节点 ID、引用、运行、审计和 Workspace；不按不明确的 taskKey 强拆旧图，不清库。

旧 campaign 改名 campaign_archive 保留完整历史。仅一个历史 Project 时保留其 Session / STATE，并裁掉其他项目游标；多个 Project 时每个项目创建独立身份和空 STATE，不复制混合旧上下文；零 Project 时只保留归档。事务中的任意异常回滚 Schema 与数据，迁移标记保证重启幂等。

运行中旧进程不能与新 Schema 混用；先确认无活动执行并备份 SQLite，再停旧进程、升级、重启。代码回滚不会自动降级数据库；需要同时恢复升级前数据库备份，且应先停机、保存升级后新产生的数据。

## 7. 主要文件与验证边界

核心：packages/redtrace-engine/src/{types,store,legion-store,legion-tools,legion-missions,scheduler,runner,graph-api,audit-api,benchmark,project-evidence,legion-experience}.ts；原生宿主：compat/{legion,cordis}.mjs；前端：static/{index.html,fgs-view.js,audit.js}。

新测试涵盖多图引用/合并/事件/证据、API、单图直派、分类与同题小队、并发 Scheduler、历史迁移及事务回滚、两个真实 DSH Session 重叠与 A 事件不唤醒 B。原生角色、HELP 入模、交接/压缩、模型升降、Park 和知识检索沿用原有回归；模型协议夹具验证真实 DSH 调用链，但不是生产模型智能或真实平台验收。

具体命令、stdout/stderr、退出码、基线差异、现场数据库升级及可逆源码补丁见同目录 VERIFICATION.txt。真实模型推理、VPN/平台实例与 flag 提交没有用夹具冒充完成。

知识库原默认 Python 路径缺失时，验证可用独立测试 venv 安装仓库已有 tools/knowledge/requirements.txt，再通过 REDTRACE_KNOWLEDGE_PYTHON 指定；不改生产配置或声明新依赖。
