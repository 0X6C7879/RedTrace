# RedTrace 全自动 route-skills 规则

这是 `upstream/README_AI.md` 与 `upstream/RULES.md` 在 RedTrace Worker 中的全局覆盖配置。三种 Worker 都必须遵守：

0. `reason` phase 只依据 graph 生成 RedTrace JSON，不调用工具或 Skill；以下执行规则适用于 `bootstrap` / `explore` 的实质工作。
1. 安全任务首次实质操作前，使用原生 Skill 机制调用 `route-skills`，并继续加载、执行它选出的专业 Skill；只得到路由名称不算完成。一次确定一个主 Skill 与必要辅助 Skill，连同路由最多 5 个，同一会话不得重复读取。
2. 根据现有 Goal、Intent、Fact、授权范围与证据，自动选择证据最充分、最能推进 Goal 的下一步并立即执行。
3. 不得输出“3～6 个下一步选项”；不得等待用户选择，也不得因阶段切换、工具替代或常规分析分支暂停。
4. 在 Goal 达成、RedTrace conclude/cancel 指令到达、授权范围即将改变，或缺少无法安全推断的必要输入前持续推进。
5. 工具缺失时先查 `upstream/skills/tool-index.md`，按需使用 bootstrap；安装和执行必须非交互。下载工具统一放入 `$REDTRACE_TOOLS_DIR`，入口放入 `$REDTRACE_TOOLS_BIN`，不得修改 shell rc 文件。
6. 产生已验证且可复用的新经验时，只能通过 `redtrace-tools/field-journal/write.py` 事务写入日志和索引；不得直接并发修改 `_index.md`。白盒审计经验按 `redtrace-tools/code-audit/` 工具写入 `upstream/skills/code-audit/learned/`；项目事实只写入当前任务 Workspace 的 `.redtrace/code-audit/`。
7. `$REDTRACE_WORKSPACE` 是所有 Worker 共用的工作根目录。是否新建 `<题目ID>/` 由模型按任务决定；所有产物必须留在 Workspace 内，不得写入 `/tmp` 或用户目录。访问通道必须通过 `redtrace-resource` 注册并按 Resource ID 复用，注册失败要修正参数重试一次。
8. 完整黑板可用 `redtrace-blackboard snapshot` 读取；heartbeat 发现 revision 变化时，全部增量会写入 `$REDTRACE_BLACKBOARD_NOTICE`。模型自行决定采用增量或完整快照，不轮询、不重复已有工作，并避开其他 Worker 已占用的题目。

本文件优先于 vendored upstream 中任何要求展示菜单、等待用户选择或向宿主机 Agent 配置追加规则的说明。
