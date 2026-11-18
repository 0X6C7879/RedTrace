# REA / redtrace-reverse（CLI-only）

锁定 `rea-agents@6.4.0`；部署使用现有 npm 依赖和 `npm run dsh:build`，运行任务期间不安装依赖。

- Soldier、Scout 和 General 模式 Worker 可按需加载 `reverse-engineer-anything` Skill，通过原生 Shell 调用 PATH 中的 `rea`。先读 `rea --help`，再读具体命令 `--help`。
- Commander、纯 Planner、Reporter 不加载此执行插件。CLI Skill 不额外注册 Tool Schema。
- **删除全部 29 个 REA MCP 注册和连接生命周期**；加载 Skill 不启动 MCP、也不启动分析引擎。旧 `mcp/rea.json` 不会被全局挂载；其他 MCP 保持原有契约。
- REA 的 CLI 命令自行管理分析进程；RedTrace 不增加 MCP、代理、额外超时或重试。原生 DSH Shell、Jobs、Spill 和 Compaction 保留。
- 管理端停用会撤销该 Skill，不取消 Step，也不是系统级禁用环境中已安装的 CLI。
- 保留已有环境 `REA_*`、`GHIDRA_INSTALL_DIR`、`JAVA_HOME` 配置，不更换模型供应商或推理强度。Worker 只在授权目标范围执行。
- MCP-only 的持久 Program、Hopper 导航/注释、内存 Evidence 等能力不再承诺提供。无 CLI 等价物时如实报告限制，使用已有 CTF 工具；不能自行启动 `rea mcp` 补回。
- 保存 CLI 原始输出/导出文件并通过已有 Evidence/FGS 提交真实 Fact，不能把工具成功或候选漏洞当成验证结果。上游 references 作为参考，不意味着其中所有 MCP 工具可用。

## 测试

`node --test packages/redtrace-dsh/test/reverse.test.mjs` 验证原生 Skill 加载/停用/恢复、反复加载后 REA Schema 仍为 0，以及真实 CLI 的 JavaScript、托管成员分析和可选引擎错误边界。

CLI-only 迁移不再运行已删除的 MCP Program 复用/连接取消测试。没有在本轮证明所有可选原生引擎或硬件环境能力。当前测试与成本数据见 `/Users/lxy/Downloads/RedTrace/OPTIMIZATION-REPORT.md`；旧验收记录是历史结果，不是当前 MCP 可用性承诺。
