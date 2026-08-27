# TSec Benchmark SDK Contract

本文件是 `Tsecbench API` Skill 使用的精简契约，内容只保留平台 SDK 接入所需字段与行为。

## 安装与前置条件

```bash
pip install tsec-benchmark
```

- Python >= 3.9
- 依赖 `httpx`
- SDK 优先支持异步，也提供同步封装
- 使用前需要平台下发的 `BENCHMARK_TOKEN`、`BENCHMARK_BASE_URL`
- 运行环境必须已经连接靶场 VPN
- SDK 不负责创建 Benchmark 任务，也不负责连接 VPN

## 同步客户端

```python
from tsec_benchmark import TSecBenchmark

with TSecBenchmark(base_url=BENCHMARK_BASE_URL, token=BENCHMARK_TOKEN) as client:
    challenges = client.list_challenges()
    started = client.start_challenge(unique_code)
    hint = client.get_hint(unique_code)
    result = client.submit_flag(unique_code, flag)
    closed = client.close_challenge(unique_code)
```

进入上下文管理器时会自动执行 VPN 联通预检；失败抛出 `VpnCheckError`。

## Challenge

`list_challenges()` 返回：

| 字段 | 类型 | 语义 |
|---|---|---|
| `unique_code` | `str` | Challenge 唯一标识 |
| `description` | `str` | 题目描述 |
| `difficulty` | `str` | 难度，如 easy/medium/hard |
| `level` | `str` | 题目等级 |
| `total_score` | `int` | 总分 |
| `flag_count` | `int` | flag 总数 |
| `correct_flag_count` | `int` | 已正确提交数量 |
| `is_completed` | `bool` | 是否所有 flag 均已正确提交 |
| `container_status` | `str` | `pending` / `available` / `stop_pending` / `stopped` |
| `container_addr` | `list[str]` | 仅 `available` 时有值，格式 `IP:端口` |

## StartResult

`start_challenge(unique_code)`：

- `unique_code: str`
- `container_addr: list[str]`

一个 Challenge 可以返回多个容器地址，均需要通过 VPN 直连。

## HintResult

`get_hint(unique_code)`：

- `unique_code: str`
- `hint: str | None`

注意：查看提示后，该题 flag 得分会按比例扣减。

## SubmitResult

`submit_flag(unique_code, flag)`：

- `correct: bool`
- `awarded: int`
- `cumulative_score: int`
- `correct_flag_count: int`
- `total_flag_count: int`
- `matched_flag_index: int | None`

## CloseResult

`close_challenge(unique_code)`：

- `unique_code: str`
- `closed: bool`

## VpnCheckResult

`check_vpn()`：

- `status: str`，正常为 `ok`
- `client_ip: str`
- `time: str`
- `ok: bool`

## 平台异常

所有平台异常继承自 `TSecError`，包含 `.code`、`.message`、`.detail`、`.status_code`。

| code / 类型 | 异常 | HTTP |
|---|---|---|
| VPN 预检失败 | `VpnCheckError` | - |
| `task_not_found` | `TaskNotFound` | 404 |
| `challenge_not_found` | `ChallengeNotFound` | 404 |
| `invalid_state` | `InvalidState` | 409 |
| `duplicate` | `DuplicateSubmit` | 409 |
| `resource_unavailable` | `ResourceUnavailable` | 503 |
| `internal_error` | `InternalError` | 500 |
| FastAPI 422 | `ValidationError` | 422 |
| 传输层错误 | `TSecConnectionError` | - |

`VpnCheckError.detail.reason` 可能为：

- `network_error`
- `bad_status`
- `bad_body`
- `status_not_ok`

## 官方冒烟测试

```bash
tsec-run --base-url https://benchmark.example.com --token <BENCHMARK_TOKEN>
```

也支持环境变量：`TSEC_BASE_URL` / `TSEC_TOKEN`。
