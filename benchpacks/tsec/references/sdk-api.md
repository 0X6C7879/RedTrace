# tsec-benchmark SDK接入文档

Python SDK，用于对接 **TSec Benchmark 平台**的评测API。让基于 Python 的被测 Agent 能够驱动 Benchmark 流程——列出题目、启动容器、获取提示、提交 flag、关闭容器——无需手写 HTTP 请求代码。
(此 SDK 仅涵盖Agent视角流程——它不会创建 Benchmark 任务或连接 VPN)

```bash
pip install tsec-benchmark
```

- Python ≥ 3.9
- 依赖: `httpx`
- 优先支持异步，同时为脚本提供了同步封装

> **前置条件**：在使用此 SDK 之前，你必须已经从平台获取：
> - BENCHMARK_TOKEN：跑分任务的凭证
> - BENCHMARK_BASE_URL：跑分API的BASE_URL（例如 `https://benchmark.example.com`）
> - 必须已连接靶场环境 VPN（用于访问题目容器地址）
> 
> 以上配置，在tsecbench平台创建跑分任务后下发


## 快速开始

快速开始示例提供最简化的跑分模板，您只需在call_your_agent中对接您的agent解题逻辑即可，如果有其他自定义需求，可自行修改跑分流程。

**注意：运行程序之前，确保您的运行环境已经连接跑分任务下发的VPN配置，否则SDK将会抛出VpnCheckError，无法开始跑分**

### 同步方式（最简单）
```python
from tsec_benchmark import TSecBenchmark, DuplicateSubmit, InvalidState, VpnCheckError


BENCHMARK_TOKEN=os.getenv("BENCHMARK_TOKEN", "")
BENCHMARK_BASE_URL=os.getenv("BENCHMARK_BASE_URL", "")

def call_your_agent(ch, started):
    """← 这里写你自己的解题逻辑。

    题目容器已启动，靶场地址是 started.container_addr（`IP:端口` 地址数组，可能有多个，需经 VPN 直连）。
    在这里调用你的渗透/解题 Agent（读源码、发请求、跑 exploit 等）去拿 flag。
    一道题可能有多个 flag（ch.flag_count），全部拿到后返回 flag 列表。
    """
    # TODO: 在这里实现你的解题逻辑，例如连接 started.container_addr 进行渗透
    flags = ["flag{...}"]  # 替换为你的 Agent 实际拿到的 flag
    return flags


# 进入 with 时 SDK 自动做 VPN 联通预检；不通则抛 VpnCheckError 中断，不会发起任何平台请求。
with TSecBenchmark(base_url=BENCHMARK_BASE_URL, token=BENCHMARK_TOKEN) as client:
    # 1) 列出题目：拿到本轮所有题目及每题作答进度（已通关的跳过）
    challenges = client.list_challenges()
    for ch in challenges:
        if ch.is_completed:
            continue

        # 2) 启动题目容器：拿到靶场直连地址 started.container_addr
        started = client.start_challenge(ch.unique_code)
        print(f"{ch.unique_code} -> {started.container_addr}")

        try:
            # 3) 解题（你自己的逻辑）：连接靶场地址、渗透、拿到 flag
            flags = call_your_agent(ch, started)

            # 4) 提交 flag：每拿到一个就提交一次，推进 correct_flag_count
            for flag in flags:
                try:
                    res = client.submit_flag(ch.unique_code, flag)
                    print(f"  correct={res.correct} awarded={res.awarded} "
                          f"progress={res.correct_flag_count}/{res.total_flag_count}")
                except DuplicateSubmit:
                    # 同一个 flag 已正确提交过（幂等），跳过即可
                    pass
        finally:
            # 5) 关闭题目容器：释放靶场资源与活跃名额，无论解题是否完成
            client.close_challenge(ch.unique_code)
```

### 异步方式（基于 httpx）

```python
import asyncio
from tsec_benchmark import TSecBenchmarkAsync

BENCHMARK_TOKEN=os.getenv("BENCHMARK_TOKEN", "")
BENCHMARK_BASE_URL=os.getenv("BENCHMARK_BASE_URL", "")

async def call_your_agent(ch, started):
    """← 这里写你自己的解题逻辑（异步）。靶场地址是 started.container_addr（`IP:端口` 地址数组，可能有多个），经 VPN 直连。
    调用你的解题 Agent 拿到 flag 列表后返回。"""
    # TODO: 在这里实现你的解题逻辑
    return ["flag{...}"]


async def main():
    # 进入 async with 时 SDK 自动做 VPN 联通预检；不通则抛 VpnCheckError 中断。
    async with TSecBenchmarkAsync(base_url=BENCHMARK_BASE_URL, token=BENCHMARK_TOKEN) as client:
        challenges = await client.list_challenges()              # 1) 列出题目及进度
        for ch in challenges:
            if ch.is_completed:
                continue
            started = await client.start_challenge(ch.unique_code)   # 2) 启动题目容器
            try:
                flags = await call_your_agent(ch, started)            # 3) 解题（你的逻辑）
                for flag in flags:
                    await client.submit_flag(ch.unique_code, flag)    # 4) 提交 flag
            finally:
                await client.close_challenge(ch.unique_code)         # 5) 关闭容器、释放资源

asyncio.run(main())
```

### 数据类

SDK 的每个方法会返回一个不可变（frozen）的数据类，字段信息如下。

#### Challenge
题目信息数据类，由 `list_challenges()` 返回，包含题目基本信息和作答进度。

| 字段 | 类型 | 说明 |
|---|---|---|
| `unique_code` | `str` | 题目唯一标识码，用于启动/提交/关闭等操作 |
| `description` | `str` | 题目描述信息 |
| `difficulty` | `str` | 题目难度级别（如：`easy`/`medium`/`hard`） |
| `level` | `str` | 题目等级 |
| `total_score` | `int` | 题目总分数 |
| `flag_count` | `int` | 题目包含的 flag 总数（一道题可能有多个 flag） |
| `correct_flag_count` | `int` | 已正确提交的 flag 数量 |
| `is_completed` | `bool` | 题目是否已全部完成（所有 flag 都已提交正确） |
| `container_status` | `str` | 该题靶场容器当前状态：`pending`/`available`/`stop_pending`/`stopped`；尚未启动或已关闭为 `stopped` |
| `container_addr` | `list[str]` | 靶场容器直连地址（`IP:端口`）数组；**仅当 `container_status == "available"` 时才有值**，其余状态为空列表 `[]` |

#### StartResult
启动题目容器后返回的结果数据类，由 `start_challenge()` 返回。

| 字段 | 类型 | 说明 |
|---|---|---|
| `unique_code` | `str` | 题目唯一标识码 |
| `container_addr` | `list[str]` | 题目容器的可访问地址数组（格式：`IP:端口`），一个题目可能有多个地址，需要通过 VPN 直连 |

#### HintResult
获取提示后返回的结果数据类，由 `get_hint()` 返回。

| 字段 | 类型 | 说明 |
|---|---|---|
| `unique_code` | `str` | 题目唯一标识码 |
| `hint` | `str \| None` | 提示内容；如果题目没有提示则返回 `None`；**注意**：查看提示后该题 flag 得分会按比例扣减 |

#### SubmitResult
提交 flag 后返回的结果数据类，由 `submit_flag()` 返回。

| 字段 | 类型 | 说明 |
|---|---|---|
| `correct` | `bool` | 提交的 flag 是否正确 |
| `awarded` | `int` | 本次提交获得的分数（错误则为 0） |
| `cumulative_score` | `int` | 累计已获得的总分数 |
| `correct_flag_count` | `int` | 已正确提交的 flag 数量 |
| `total_flag_count` | `int` | 题目包含的 flag 总数 |
| `matched_flag_index` | `int \| None` | 匹配的 flag 索引（从 0 开始）；提交错误时为 `None` |

#### CloseResult
关闭题目容器后返回的结果数据类，由 `close_challenge()` 返回。

| 字段 | 类型 | 说明 |
|---|---|---|
| `unique_code` | `str` | 题目唯一标识码 |
| `closed` | `bool` | 容器是否成功关闭 |

#### VpnCheckResult
VPN 连通性检测结果数据类，由 `check_vpn()` 返回，或在上下文管理器入口自动检测时内部使用。

| 字段 | 类型 | 说明 |
|---|---|---|
| `status` | `str` | 检测状态；正常时为 `"ok"` |
| `client_ip` | `str` | 当前客户端 IP 地址（VPN 分配的地址） |
| `time` | `str` | 检测时间（格式：`YYYY-MM-DD HH:MM:SS`） |
| `ok` | `bool` | 检测是否通过（`status == "ok"` 时为 `True`） |

### 错误处理

每个平台错误码都会抛出专用的异常（所有异常都继承自 `TSecError`，包含 `.code`、`.message`、`.detail`、`.status_code` 属性）：

| 平台 `code` | 异常 | HTTP 状态码 |
|---|---|---|
| (VPN 预检失败) | `VpnCheckError` | — |
| `task_not_found` | `TaskNotFound` | 404 |
| `challenge_not_found` | `ChallengeNotFound` | 404 |
| `invalid_state` | `InvalidState` | 409 |
| `duplicate` | `DuplicateSubmit` | 409 |
| `resource_unavailable` | `ResourceUnavailable` | 503 |
| `internal_error` | `InternalError` | 500 |
| (FastAPI 422) | `ValidationError` | 422 |
| (传输层错误) | `TSecConnectionError` | — |

`VpnCheckError` 的 `message` 固定为 `VPN检测未通过,请检查靶场VPN网络配置`，`detail.reason` 为失败原因（`network_error` / `bad_status` / `bad_body` / `status_not_ok`）。

```python
from tsec_benchmark import (
    TSecBenchmark, TSecError, VpnCheckError, TaskNotFound, InvalidState,
    DuplicateSubmit, ResourceUnavailable, TSecConnectionError,
)

try:
    with TSecBenchmark(base_url="...", token="...") as client:  # 自动预检 VPN
        res = client.submit_flag(code, flag)
except VpnCheckError as e:
    print(e)                    # VPN检测未通过,请检查靶场VPN网络配置 —— 先连 VPN 再重试
except DuplicateSubmit:
    pass                        # 幂等：flag 已计入，跳过即可
except InvalidState as e:
    if "max active" in e.message:
        client.close_challenge(some_other)  # 释放一个名额，然后重试
    else:
        raise                  # 任务已结束（超时）—— 停止
except ResourceUnavailable:
    ...                        # 稍后重试启动，或跳过
except TSecError:
    raise                      # 任何其他平台错误
```

## CLI 冒烟测试

安装包时会附带一个小型 CLI 工具，用于快速连通性检查：

```bash
tsec-run --base-url https://benchmark.example.com --token <BENCHMARK_TOKEN>
# 或通过环境变量：TSEC_BASE_URL / TSEC_TOKEN
```

它会列出任务的题目及每题的 flag 进度——在将 SDK 接入你的 Agent 之前，可以用它来确认你的 token 和 base URL 是否正常工作。
