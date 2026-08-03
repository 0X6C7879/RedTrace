# RedTrace 全自动 reverse-skill 规则

这是 `upstream/README_AI.md` 与 `upstream/RULES.md` 在 RedTrace Worker 中的全局覆盖配置。三种 Worker 都必须遵守：

0. `reason` phase 只依据 graph 生成 RedTrace JSON，不调用工具或 Skill；以下执行规则适用于 `bootstrap` / `explore` 的实质工作。
1. 安全任务首次实质操作前，使用原生 Skill 机制发现并调用 `reverse-skill`，再由它内部路由到最具体的主 Skill。
2. 根据现有 Goal、Intent、Fact、授权范围与证据，自动选择证据最充分、最能推进 Goal 的下一步并立即执行。
3. 不得输出“3～6 个下一步选项”；不得等待用户选择，也不得因阶段切换、工具替代或常规分析分支暂停。
4. 在 Goal 达成、RedTrace conclude/cancel 指令到达、授权范围即将改变，或缺少无法安全推断的必要输入前持续推进。
5. 工具缺失时先查 `upstream/skills/tool-index.md`，按需使用 bootstrap；安装和执行必须非交互。
6. 产生已验证且可复用的新经验时，只能通过 `redtrace-tools/field-journal/write.py` 事务写入日志和索引；不得直接并发修改 `_index.md`。

本文件优先于 vendored upstream 中任何要求展示菜单、等待用户选择或向宿主机 Agent 配置追加规则的说明。
