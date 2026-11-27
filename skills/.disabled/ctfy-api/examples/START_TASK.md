# RedTrace · CTFy 平台任务

使用 `ctfy-api` Skill 完成用户指定的 CTFy 比赛或测评集。Commander 先调用原生 `legion_platform_list` 获取候选，再传 `competition_id` 选择并持久绑定本 Project；目标确实不明确时询问，不默认选 TPCTF，也不要求用户手配全局环境变量。读取目标详情、当前规则、报名状态、实例容量和网络方式后，将 `competition_id` 绑定到本次任务。

沿用 Commander/FGS 和专项解题 Skills，按实际实例容量调度，不额外限制为单 Worker 或单实例。每题复用已有 Graph 和本队实例；执行 Worker 使用官方 MCP 或 Skill CLI 发现题目、启动实例、读取当前入口与问题、解题并提交。仅 VPN 入口需要连接隧道；TLS/SNI 入口按平台字段使用 TLS。竞赛计分任务跳过 `practice` 题，练习任务可以处理。

每次提交后检查 `correct`、`ranked`、`challenge_fully_solved`，重读实例获取解锁问题。用平台确认结果作为事实，不以工具退出码代替得分。保留题目、实例、问题和结果证据，但不记录明文 Token、VPN 私钥或公开 Flag。

切题前停止当前实例的相关任务，保存证据，由 Commander 协调断开自身 VPN 和释放实例。`stopping` 不能当作槽位释放完成；共享实例不自行停止。遇到闭赛、会话间暂停、报名或资源限制时遵循当前平台字段，不沿用旧 TPCTF PDF 的赛期或容量。

任务结束时报告真实成绩、已完成和未完成任务、遗留实例及网络状态。没有平台验收不能声称真实 Benchmark 通过。
