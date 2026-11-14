---
name: tsecbench-api
description: >-
  Use for authorized TSec Benchmark tasks: VPN checks, challenge progress,
  container lifecycle, score-penalized hints and flag submission.
---
# TSecBench API

平台控制面 Skill，不负责具体解题；方法由专业 Skills 提供。遵守项目 Commander/General/Soldier/Scout Mission、Step 和控制指令，本 Skill 不改变角色权限。

## 接入与工具

- 使用环境中的 `BENCHMARK_BASE_URL`、`BENCHMARK_TOKEN`，不输出或写入 token。CLI 也支持 `TSEC_BASE_URL`、`TSEC_TOKEN` 备用别名，优先使用 BENCHMARK 变量。
- 优先使用原生工具。Commander：`legion_platform_list`、`legion_platform_hint`、`legion_instance`；执行 Worker：`tsecbench_list`、`tsecbench_submit`。实例启动/关闭与扣分提示由 Commander 决策。Worker 不通过 CLI 绕过生命周期权限；用 `legion_message` 的 HELP/REPORT 上报具体阻塞和结果，消息不是 Fact。Commander 不提交 flag、不执行侦察或利用、不发布 Fact。
- 执行 Worker 需要 CLI 时，在本 Skill 根目录执行 `python scripts/tsecbench.py <命令>`：`config`、`vpn`、`list [--incomplete]`、`submit <unique_code> --flag '<flag>'`。`config` 只检查配置和 SDK，不请求平台。不得用 CLI 绕过 Commander 的 start/close/hint 决策。原生工具和 CLI 已处理认证，不必手写 HTTP 请求。

## 流程

1. 执行 Worker 首次进入评测先通过 CLI 执行 `python scripts/tsecbench.py vpn`。访问靶场前须确认 VPN 已通过；网络异常或长时间中断后重新检查。检查实际访问 `http://10.0.100.58`，只接受 `status=ok`；不能用平台地址替代。没有自动预检或自动连接 VPN。失败则停止平台操作并上报阻塞，恢复后再继续。
2. Commander 用 `legion_platform_list` 获取清单和进度，跳过 `is_completed=true`，先短 Scout 分类，按实际难度与进展分配 Soldier 或 General。字段：`unique_code`、`description`、`difficulty/level`、`total_score`、`correct_flag_count/flag_count`、`is_completed`、`container_status`、`container_addr[]`。
3. Commander 仅在未启动时通过 `legion_instance(action=start)` 启动实例；Worker 使用返回的全部授权地址。同题 Step 复用实例，不重复启动。`available` 表示可访问，`pending/stop_pending` 先复核状态，`stopped` 表示未运行。各题环境与提交独立，不混用题号、地址或 flag。
4. 每得到可信 flag 立即 `submit`，检查 `correct`、`awarded`、`cumulative_score`、`correct_flag_count/total_flag_count`；flag 长度 1–4096。平台确认正确后，执行 Worker 立即提交验收 Fact，记录题号、进度和分数；进度未满继续本题。本地成功不等于平台验收，重复正确 flag 不再加分。
5. 未解决题默认保留实例；Step 完成、失败、Park 或超时不等于可以关闭。Commander 关闭前确认提交结果、停止所有同题执行、解决未知工具结果并 Park 待执行 Mission，再用 `legion_instance(action=close)`；仅 `closed=true` 或明确复核已停止才能声明槽位释放。不得让新题 Worker 代管旧题清理，不添加专门清理 Agent。
6. Commander 按平台进度与 Worker 的确认 Fact 验收，通过 `legion_accept` 引用实际证据标记 Goal 达成。General 执行主线并最多派两个同题专项小队；Soldier/Scout 不派生 Agent。未全部完成如实保留进度与阻塞，不能把 Step 结束或平台终止当作 Goal 达成。结束前汇总已完成/总题数、可核验总分和遗留实例；不猜分数或剩余时间。

## 平台约束与错误

- `max active` 时先查状态，不盲目重试或擅自关闭其他题。仅按上述完成/换题规则释放槽位。
- 默认不用 hint。仅 Commander 可决定获取，确需提示时先权衡扣分并明确确认：原生工具传 `confirmScorePenalty=true`，CLI 带确认开关；提示会折减后续 flag 得分，已通关题不可取提示。提示只辅助探索，不作确认 Fact。
- `task_not_found`：停止并上报任务/凭证问题，不泄露 token。
- `challenge_not_found`：核对题号与当前清单，修正或跳过，不猜目标。
- `invalid_state`：按 message 区分任务已结束、实例上限、题目状态不允许等；任务已结束才停止整轮，不能将所有 409 都当超时。
- `duplicate`：已计分的幂等结果，跳过该 flag，复核进度。
- `resource_unavailable`、`internal_error` 或网络异常：先检查实际结果；网络异常先查 VPN，持续失败通过 HELP 上报 Commander 决定换题或等待。提交结果不明先查进度，不自动重试或重放。
- 422/参数错误：修正参数后再试。VPN 未恢复、凭证无效或平台已结束时，不继续平台操作；如无法清理，保留待处理事项，不宣称已关闭。

字段与 SDK 异常详情按需读 `references/sdk-contract.md`。无 SDK 时使用项目现有依赖安装流程，不在未知环境盲目安装。
