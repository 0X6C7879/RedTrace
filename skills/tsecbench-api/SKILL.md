---
name: tsecbench-api
description: >-
  Use when running authorized TSec Benchmark evaluation tasks through the
  tsec-benchmark SDK: verify VPN/configuration, list challenge progress, start
  and close challenge containers, obtain score-penalized hints deliberately,
  submit flags, and recover platform errors. This Skill controls benchmark
  lifecycle only; delegate challenge solving to specialist Skills.
---
# Tsecbench API

## ACTION REQUIRED（读完后立刻执行）

1. `NOW`: 确认这是 **TSec Benchmark 已授权测评任务**，不要把本 Skill 用于平台外目标。
2. `NOW`: 检查 `BENCHMARK_BASE_URL` 与 `BENCHMARK_TOKEN` 已注入环境（来自 `redtrace.yaml` 的 `common_env` 手工配置）；禁止把 token 写入 Skill、脚本、日志或学习记录。
3. `NOW`: 使用本 Skill 的 CLI 做 VPN/API 预检；VPN 不通时立即停止，不要继续启动题目。
4. `NOW`: 列出全部题目与进度，跳过 `is_completed=true` 的题目。
5. `NEXT`: 对待解题调用 `start`，获取 `container_addr` 后，将题目描述、难度、flag 数量和容器地址交给 Explore；由 Explore 再路由到 Web/Pwn/Reverse/Crypto/Network 等对应方向 Skill。
6. `ACT`: 每发现一个可信 flag 就立即调用 `submit`，根据 `correct_flag_count/total_flag_count` 判断是否还需继续。
7. `ACT`: 默认不取提示；只有明显卡住且剩余时间/得分权衡合理时，才允许带 `--confirm-score-penalty` 调用 `hint`。
8. `ALWAYS`: 当前题完成、失败、放弃、超时或任务结束时都调用 `close` 释放容器。不要因为异常跳过关闭。
9. `END`: 再次执行 `list`，以平台返回的 `is_completed` 和 flag 进度作为最终事实，不以本地推测代替平台状态。

> 本 Skill 是 **TSec Benchmark 平台控制面适配器**，不包含具体漏洞利用方法。解题知识由专业方向 Skill 负责，本 Skill 只管理评测生命周期。

---

## 依赖与配置

官方 SDK：

```bash
python -m pip install tsec-benchmark
```

要求：Python >= 3.9，运行环境必须已经连接平台下发的靶场 VPN。

配置变量（在 `redtrace.yaml` 的 `common_env` 中**手工设置**，dispatcher 会把它们注入所有 worker 进程环境；改动后需重启 dispatcher）：

```yaml
common_env:
  BENCHMARK_BASE_URL: "https://benchmark.example.com"
  BENCHMARK_TOKEN: "..."
```

也支持 `${REDTRACE_SECRET:...}` 密钥引用，避免明文落盘。

本 Skill 的 CLI 兼容官方冒烟工具使用的 `TSEC_BASE_URL` / `TSEC_TOKEN` 作为备用别名，但优先级为：

1. CLI `--base-url` / `--token`
2. `BENCHMARK_BASE_URL` / `BENCHMARK_TOKEN`
3. `TSEC_BASE_URL` / `TSEC_TOKEN`

禁止输出 token 的实际值。

### CLI 路径

本 Skill 的脚本位于 Skill 根目录下，以下命令均在 Skill 根目录（含 `scripts/tsecbench.py`）中执行：

```bash
python scripts/tsecbench.py config
```

---

## 标准执行流程

### 1. 配置检查

```bash
python scripts/tsecbench.py config
```

预期只返回是否已配置，不显示 token：

```json
{"ok":true,"base_url_configured":true,"token_configured":true,"sdk_available":true}
```

SDK 缺失时，先通过当前环境允许的依赖/bootstrap 机制安装 `tsec-benchmark`，不要在未知 Python 环境中盲目安装。

### 2. VPN 预检

```bash
python scripts/tsecbench.py vpn
```

VPN 检测失败时：

- 将 `VpnCheckError` 作为阻塞事实返回；
- 不调用 `list/start/submit/hint/close` 继续推进；
- 不尝试由 SDK 自动连接 VPN，因为 SDK 不负责 VPN 连接。

### 3. 获取题目和当前进度

```bash
python scripts/tsecbench.py list
```

只看未完成题：

```bash
python scripts/tsecbench.py list --incomplete
```

对每题至少关注：

- `unique_code`
- `description`
- `difficulty`
- `level`
- `total_score`
- `flag_count`
- `correct_flag_count`
- `is_completed`
- `container_status`
- `container_addr`

### 4. 启动题目

```bash
python scripts/tsecbench.py start <unique_code>
```

成功后使用平台返回的 `container_addr`。地址可能有多个，全部保留给 Explore，不要只取第一个。

**并发约束**：

- 一个 Worker 只管理自己当前认领的 Challenge 生命周期；
- `InvalidState` 若包含 `max active`，不要随意关闭其他 Worker 正在解的容器；
- 只有明确确认某个容器已无人使用时才释放它，否则把资源已满作为事实返回给调度器/Reason。

### 5. 解题路由

把以下信息一起交给解题 Explore：

```text
TSecBench Challenge: <unique_code>
Description: <description>
Difficulty: <difficulty>
Level: <level>
Flags: <correct_flag_count>/<flag_count>
Targets: <container_addr[]>
Goal: 获取尚未提交的 flag；每拿到一个立即交回 Tsecbench API Skill 提交。
```

根据题目实际内容路由，不要让 Tsecbench API Skill 自己承载攻击知识：

- Web / API / WebSocket → Web 方向 Skill
- Binary / Pwn → Pwn 方向 Skill
- Reverse / APK / Firmware → Reverse 方向 Skill
- Crypto → Crypto 方向 Skill
- AD / Linux 内网 / 横向 / 提权 → Network / Post-exploitation 方向 Skill
- Blockchain → Blockchain 方向 Skill
- 无法判断时先做最小识别，再选择方向

### 6. 提交 flag

```bash
python scripts/tsecbench.py submit <unique_code> --flag 'flag{...}'
```

提交后必须读取：

- `correct`
- `awarded`
- `cumulative_score`
- `correct_flag_count`
- `total_flag_count`
- `matched_flag_index`

规则：

- `correct=true`：立即把平台确认结果写成 Fact；若进度未满则继续当前题。
- `correct=false`：不要重复提交完全相同内容，回到解题流程验证来源。
- `DuplicateSubmit`：视为幂等结果，不算失败，继续读取平台进度。
- 当 `correct_flag_count == total_flag_count` 时，此题已经完成，可以关闭容器。

### 7. 获取提示（会扣分）

默认禁止直接调用。需要明确传入确认开关：

```bash
python scripts/tsecbench.py hint <unique_code> --confirm-score-penalty
```

只有以下情况才考虑取提示：

- 当前路线长期没有新增证据；
- 剩余时间不足以继续大范围探索；
- 预计提示带来的通关收益高于扣分损失。

获取后将 `hint` 作为新的题目证据交回当前 Explore，不要因此另起无关攻击链。

### 8. 关闭容器

```bash
python scripts/tsecbench.py close <unique_code>
```

关闭动作必须出现在题目生命周期的收尾路径。即使 Exploit/Agent 抛错，也要尽最大努力执行关闭。

### 9. 最终复核

```bash
python scripts/tsecbench.py list
```

最终完成条件只认平台返回：

```text
目标 Challenge: is_completed == true
整轮任务: 所有要求作答的 Challenge 均 is_completed == true，或平台任务已经进入不可继续状态
```

---

## Reason / Explore 协作约定

### Reason

Reason 负责：

- 根据 `list` 的未完成题维持 Intent 池；
- 每个 Challenge 原则上对应一个独立 Intent；
- 依据 `difficulty`、`total_score`、剩余时间和可用 Worker 调整优先级；
- 资源上限触发时避免继续创建会占用容器的新执行；
- 以平台确认的 flag 进度更新 Graph，而不是仅凭 Explore 声称“拿到 flag”。

### Explore

Explore 负责：

- 在收到 Challenge 后读取 `description` 和全部 `container_addr`；
- 调用相应专业 Skill 解题；
- 找到 flag 后立即交给本 Skill 提交；
- 平台确认 flag 正确后，立即返回对应 Fact；
- 当前 Intent 的目标达到后停止，不继续推进 Intent 外的其他 Challenge。

---

## 错误处理

CLI 会把平台错误转成结构化 JSON，重点按下表处理：

| 错误/状态 | 行为 |
|---|---|
| `VpnCheckError` | 立即停止平台流程，修复 VPN 后再继续 |
| `task_not_found` | 任务不存在/凭证不对应，停止并上报 |
| `challenge_not_found` | Challenge code 错误或不存在，重新 `list` 校验 |
| `invalid_state` | 检查任务状态；若 `max active`，协调释放已确认空闲容器 |
| `duplicate` | 幂等处理，不重复计为失败 |
| `resource_unavailable` | 有界重试或换题；不要无限循环 |
| `internal_error` | 有界重试，持续失败则上报平台错误 |
| `ValidationError` / 422 | 检查参数，不盲目重试相同请求 |
| `TSecConnectionError` | 检查 VPN/网络/API 地址后再重试 |

### 重试规则

- 只对明确的临时性错误进行重试：`resource_unavailable`、部分 `internal_error`、传输层错误；
- 推荐最多 3 次，使用短退避；
- 参数错误、任务结束、Challenge 不存在不要机械重试；
- `submit` 不因网络不确定性就换 flag；先重新 `list` 确认进度，避免重复工作。

---

## 禁止事项

- 不创建 Benchmark 任务；SDK 不具备该能力。
- 不通过本 Skill 建立 VPN；VPN 是外部前置条件。
- 不把 `BENCHMARK_TOKEN` 写入文件、Fact、Graph、Skill Memory 或命令输出。
- 不在未确认所有权的情况下关闭其他 Worker 的活跃 Challenge。
- 不因为拿到一个 flag 就假设多 flag 题已经完成。
- 不把提示当作免费信息；`get_hint()` 会导致该题 flag 得分按比例扣减。
- 不以本地 exploit 成功替代平台 `submit_flag()` 的正确性确认。

---

## SDK 原始契约

详细字段和官方异常映射见：

- `references/sdk-contract.md`

需要直接复核 SDK 行为时，以平台接入文档为准。
