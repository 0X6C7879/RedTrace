#!/usr/bin/env python3
"""离线自检（不联网）：校验 flag 正则、平台错误码映射、网络异常映射与容器回收逻辑。
运行：python3 bench/selfcheck.py"""

from __future__ import annotations

import re

import benchctl
from benchmark import (
    BenchmarkClient,
    BenchmarkError,
    DuplicateSubmit,
    InvalidState,
    TaskNotFound,
    _ERROR_CLASSES,
)

FLAG_RE = re.compile(r"^flag\{[^\s\r\n]{1,500}\}$")


def main() -> None:
    assert FLAG_RE.fullmatch("flag{abc_123}")
    assert FLAG_RE.fullmatch("flag{X}")
    assert not FLAG_RE.fullmatch("flag{}")
    assert not FLAG_RE.fullmatch("flag{with space}")
    assert _ERROR_CLASSES["duplicate"] is DuplicateSubmit
    assert _ERROR_CLASSES["invalid_state"] is InvalidState
    assert _ERROR_CLASSES["task_not_found"] is TaskNotFound

    # 瞬时网络故障（连接拒绝等）应映射为可重试的 BenchmarkError，而非冒泡终止跑分
    unreachable = BenchmarkClient("http://127.0.0.1:1", "token", timeout=1)
    try:
        unreachable.list_challenges()
        raise AssertionError("expected BenchmarkError on connection refused")
    except BenchmarkError as exc:
        assert exc.code == "network_error", exc.code

    # 回收逻辑：只有未被 open intent 引用的容器才该被 close
    benchctl._cairn = lambda method, path, body=None: {
        "intents": [
            {"description": "解 unique_code=WEB001", "concluded_at": None},
            {"description": "解 WEB002", "concluded_at": "2026-08-14T00:00:00Z"},
        ]
    }
    claimed = benchctl._open_intent_codes("p1", {"WEB001", "WEB002", "WEB003"})
    assert claimed == {"WEB001"}, claimed

    # 项目恢复：已有 active 跑分项目时复用，而不是再创建一个
    benchctl._cairn = lambda method, path, body=None: [
        {"id": "p-old", "title": "[tsec] TSecBench 跑分", "status": "stopped"},
        {"id": "p-active", "title": "[tsec] TSecBench 跑分", "status": "active"},
    ]
    assert benchctl._find_or_create_project([]) == "p-active"

    print("selfcheck ok")


if __name__ == "__main__":
    main()
