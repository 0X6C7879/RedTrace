#!/usr/bin/env python3
"""离线自检（不联网）：校验 flag 正则与平台错误码映射。运行：python3 bench/selfcheck.py"""

from __future__ import annotations

import re

from benchmark import _ERROR_CLASSES, DuplicateSubmit, InvalidState, TaskNotFound

FLAG_RE = re.compile(r"^flag\{[^\s\r\n]{1,500}\}$")


def main() -> None:
    assert FLAG_RE.fullmatch("flag{abc_123}")
    assert FLAG_RE.fullmatch("flag{X}")
    assert not FLAG_RE.fullmatch("flag{}")
    assert not FLAG_RE.fullmatch("flag{with space}")
    assert _ERROR_CLASSES["duplicate"] is DuplicateSubmit
    assert _ERROR_CLASSES["invalid_state"] is InvalidState
    assert _ERROR_CLASSES["task_not_found"] is TaskNotFound
    print("selfcheck ok")


if __name__ == "__main__":
    main()
