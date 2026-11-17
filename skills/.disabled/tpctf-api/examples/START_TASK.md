# RedTrace · TPCTF 2026 智能体入围赛启动任务

使用 `tpctf-api` Skill 完成本队已授权的 TPCTF 2026 智能体赛道入围赛。

目标：由 RedTrace 自主读取当前开放的题目并完成解题、Flag 提交与平台确认；使用既有 Commander/FGS/Mission 和专项解题 Skills，不替换现有执行器和调度器。

**开赛前**：先运行 Skill 的 `doctor --online` / `competitions --registered` / `challenges --unsolved`，确认权限、赛道编号、网络和 WireGuard 依赖；未开始就保留准备状态，不对平台超频轮询、不开启不存在的靶机。

**开赛后**：Commander 获取题目列表，按得分效率和已确认的能力优先级选择一道题，建立或复用一个题目 Graph，安排 Scout 分类并委派执行 Worker。全队同时只能运行一个授权靶机实例；不得多 Worker 抢占多个实例。执行 Worker 按 Skill 顺序使用 CLI：`detail`、`start --wait`、`vpn up`、调用专业工具解题、`submit`、复核是否全部问题解锁且已正确、`vpn down`、`close`。自动进入下一道未解决的计分题。

每获得可信答案就按 `question_id` 提交。只有平台 `correct=true` 才确认当前问题；只有 `challenge_fully_solved=true` 才确认整题；只有 `ranked=true` 才作为计分证据。错误提交次数不足时先补充分析，不使用 Flag 穷举。

若某题长时间没有证据推进，遵循 RedTrace 现有 Park/任务止损和交接流程，Commander 协调资源释放后换题，不得由另一 Worker 擅自关闭正在使用的实例。记录当前题目 ID、实例 ID、已解问题、平台提交结果和残留资源；不保存明文 Token。

比赛结束、题目已全部完成，或官方平台不再提供可计分任务时，停止新实例启动，复核成绩，输出当前真实计分、已完成题数、未完成题与遗留实例状态。严守比赛智能体自主性规则，仅使用本队合法资源。
