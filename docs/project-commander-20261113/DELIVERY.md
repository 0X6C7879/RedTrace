# 本次交付（2026-11-13）

工作目录：/Users/lxy/Downloads/RedTrace。未创建新会话、Agent 或 worktree，未提交或推送 Git。

1. **架构变化**：每个 Project 一个独立 Commander；Project.mode 为 benchmark/general。Project 是组织边界，Graph 是任务边界，DSH 仍是唯一真实执行器。
2. **主要文件**：/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/src/store.ts、legion-store.ts、legion-tools.ts、legion-missions.ts、scheduler.ts、runner.ts、graph-api.ts、audit-api.ts、project-evidence.ts、benchmark.ts；/Users/lxy/Downloads/RedTrace/packages/redtrace-engine/compat/legion.mjs、cordis.mjs；/Users/lxy/Downloads/RedTrace/static/index.html、fgs-view.js、audit.js。完整 52 文件清单见 SOURCE_FILES.txt，字节哈希见 MODIFIED_HASHES.json。
3. **Benchmark 流程**：打开所属控制台 → SDK 或 legion_graph 初始化每题 Origin/Goal → Scout 确认证据并分类 → Soldier/General → 同题最多两支专项小队 → 按真实证据验收该 Graph。搜索、筛选、排序、题目 FGS、最近调度、角色、消息与日志均用后端状态。
4. **General 流程**：打开唯一 Main FGS → Commander 自主分解目标、直接创建 Soldier/General 或按需 Scout → 共享本图证据 → 最终验收；不强制分类阶梯。控制台通过图页按钮访问。
5. **隔离**：独立 project_campaigns；project_graphs 注册表；节点/事件/Run 的 graph_id 外键及 graphId；Project 工具边界、图内依赖/合并/工件/消息检查，Worker 初始 Hint 与增量限定本图。用户提示先交 Commander；跨项目经验只作为目标题目 Hint。
6. **Sapper-v2**：复用四角色动态实例、HELP/REPORT/MESSAGE 和实际交付状态、STATE/Board、原生压缩与接力、模型升降、Park/恢复、经验 FTS5/迁移/复验与证据验收。新 Run 使用独立 Workspace，旧 Workspace 和未知副作用处理保留。共享原有并发容量，无新增全局锁、执行器、模型池或中间件。新增仅需求要求的归属与唯一性约束，未新增额外控制机制；没有范围外重构。
7. **数据库**：现场原有 0 Project / 0 节点，升级后完整性 ok、无外键错误，保留 1 条旧 Campaign 归档。另对单项目和多项目旧库执行真实保留迁移、重启幂等与失败事务回滚测试。现场备份：/Users/lxy/Downloads/RedTrace/.redtrace/project-commander-upgrade-20261113/engine.before.db。
8. **测试**：Engine 276 项：275 通过、1 条件跳过；DSH 59 项：58 通过、1 条件跳过。TypeScript、完整 dsh:build、补丁检查通过。两条真实 DSH 会话并发和 A 事件不唤醒 B 已用本地模型协议夹具验证。原基线 4 个知识库环境失败，在独立测试 venv 安装仓库既有 requirements 后通过；未改生产配置。
9. **未验收项**：未调用真实模型智能或真实 Benchmark 平台，未验证 VPN、真实实例/扣分提示/flag 提交；不把协议夹具冒充这些验收。原有 Chisel 测试因 tools/bin/chisel 缺失跳过；真实 Ghidra 测试未设置 REDTRACE_REA_REAL_TESTS=1。真实模型吞吐/成本没有测量，不能据此声称提升。
10. **启动/使用**：原服务已在 http://127.0.0.1:8000/ 重启并返回 200（PID 44799）。以后仍在原目录使用 ./start-redtrace.sh 或 Windows start-redtrace.cmd；新建时选模式，现有 Worker 配置和容量继续使用。详细 API、迁移与操作见 GUIDE.md。

## 可逆交付

- MODIFIED_FILE：/Users/lxy/Downloads/RedTrace/docs/project-commander-20261113/MODIFIED_FILE.tar.gz
- DIFF_FILE：/Users/lxy/Downloads/RedTrace/docs/project-commander-20261113/DIFF_FILE.patch
- VERIFICATION：/Users/lxy/Downloads/RedTrace/docs/project-commander-20261113/VERIFICATION.txt
- ROLLBACK：/Users/lxy/Downloads/RedTrace/docs/project-commander-20261113/ROLLBACK.sh

同一输入的实测：BASELINE mode=null、independent=false；MODIFIED mode=general、independent=true；ROLLBACK mode=null、independent=false，均退出 0。52 个修改/新增路径的原始/恢复哈希一致，补丁重建、修改包解包和重应用目标均逐字节验证。原始源码保存在 BASELINE.tar.gz。

**回滚脚本只恢复源码。回滚真实服务前先停机并另行恢复 engine.before.db；不要让旧源码直接打开已升级数据库。**
