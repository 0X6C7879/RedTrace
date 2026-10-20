---
name: tsecbench-api
description: >-
  Use for authorized TSec Benchmark tasks: VPN checks, challenge progress,
  container lifecycle, score-penalized hints and flag submission.
---
# TSecBench API

平台控制面 Skill，不负责具体解题；方法由专业 Skills 提供。遵守项目 Reason/Explore 提示词、Step 和控制指令，本 Skill 不改变角色权限。

## 接入与工具

- 使用环境中的 `BENCHMARK_BASE_URL`、`BENCHMARK_TOKEN`，不输出或写入 token。CLI 也支持 `TSEC_BASE_URL`、`TSEC_TOKEN` 备用别名，优先使用 BENCHMARK 变量。
- 优先使用原生工具。Reason：`tsecbench_list`、`tsecbench_hint`；Explore：`tsecbench_list`、`tsecbench_start`、`tsecbench_submit`、`tsecbench_close`，取提示使用 CLI。Reason 不启动/关闭实例、不提交 flag、不发布 Fact。
- Explore 需要 CLI 时，在本 Skill 根目录执行 `python scripts/tsecbench.py <命令>`：`config`、`vpn`、`list [--incomplete]`、`start <unique_code>`、`submit <unique_code> --flag '<flag>'`、`hint <unique_code> --confirm-score-penalty`、`close <unique_code>`。`config` 只检查配置和 SDK，不请求平台。原生工具和 CLI 已处理认证，不必手写 HTTP 请求。

## 流程

1. Explore 首次进入评测先通过 CLI 执行 `python scripts/tsecbench.py vpn`。访问靶场前须确认 VPN 已通过；网络异常或长时间中断后重新检查。检查实际访问 `http://10.0.100.58`，只接受 `status=ok`；不能用平台地址替代。没有自动预检或自动连接 VPN。失败则停止平台操作并上报阻塞，恢复后再继续。
2. Reason 用 `tsecbench_list` 获取清单和进度，跳过 `is_completed=true`，按项目策略分配题目，不为取题单独派 Step。关键字段：`unique_code`、`description`、`difficulty/level`、`total_score`、`correct_flag_count/flag_count`、`is_completed`、`container_status`、`container_addr[]`。
3. Explore 按 Step 解题。未启动才 `start`，使用返回的全部地址；同题多个 Step 复用现有实例，不重复启动。`available` 表示可访问，`pending/stop_pending` 先复核状态，`stopped` 表示未运行。只操作平台授权目标，各题环境与提交独立，不混用题号、地址或 flag。
4. 每得到可信 flag 立即 `submit`，检查 `correct`、`awarded`、`cumulative_score`、`correct_flag_count/total_flag_count`；flag 长度 1–4096。平台确认正确后，Explore 立即提交验收 Fact，记录题号、进度和分数；进度未满继续本题。本地成功不等于平台验收，重复正确 flag 不再加分。
5. 题目未解决默认保留容器，不因某个 Step 完成、失败、放弃或超时自行关闭。题目完成后 `close`，检查 `closed` 或复核实例已停止。同题协作不指定固定容器负责人；Reason 决定换题时，先停止或调整旧题相关 Step，在新题 Step 中写明要关闭的旧题，由执行新题的 Explore 先关闭、确认槽位释放，再启动新题，不另建专门清理 Step。
6. Reason 按平台进度与 Explore 的正式 Fact 验收。全部题完成且容器释放后，引用验收 Fact 用 `update_goal` 标记根 Goal `achieved`；不能继续但未全部完成时如实保留进度与阻塞，不把 Step 结束或平台终止当作目标达成。最终汇总已完成/总题数、可核验总分和遗留事项，不猜测得分。没有组件代替 Agent 判断完成或关闭实例。

## 平台约束与错误

- 活跃实例最多 3 个；`max active` 时先查状态，不盲目重试或擅自关闭其他题。仅按上述完成/换题规则释放槽位。
- 默认不用 hint。确需提示时先权衡扣分并明确确认：原生工具传 `confirm_score_penalty=true`，CLI 带确认开关；提示会折减后续 flag 得分，已通关题不可取提示。提示只辅助探索，不作确认 Fact。
- `task_not_found`：停止并上报任务/凭证问题，不泄露 token。
- `challenge_not_found`：核对题号与当前清单，修正或跳过，不猜目标。
- `invalid_state`：按 message 区分任务已结束、实例上限、题目状态不允许等；任务已结束才停止整轮，不能将所有 409 都当超时。
- `duplicate`：已计分的幂等结果，跳过该 flag，复核进度。
- `resource_unavailable`、`internal_error` 或网络异常：有界重试，通常不超过 3 次；网络异常先查 VPN，持续失败上报阻塞，由 Reason 决定换题或等待。提交结果不明先查进度，不盲目重复提交。
- 422/参数错误：修正参数后再试。VPN 未恢复、凭证无效或平台已结束时，不继续平台操作；如无法清理，保留待处理事项，不宣称已关闭。

字段与 SDK 异常详情按需读 `references/sdk-contract.md`。无 SDK 时使用项目现有依赖安装流程，不在未知环境盲目安装。
