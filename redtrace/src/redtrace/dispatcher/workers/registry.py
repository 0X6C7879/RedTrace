from __future__ import annotations

from functools import cache
from typing import Callable

from redtrace.dispatcher.workers.adapters import (
    ClaudeCodeDriver,
    CodexDriver,
    MockDriver,
    PiDriver,
)
from redtrace.dispatcher.workers.base import WorkerDriver

DriverFactory = Callable[[bool], WorkerDriver]

_MOCK = MockDriver()

_FACTORIES: dict[str, DriverFactory] = {
    "claudecode": lambda local: ClaudeCodeDriver(local=local),
    "codex": lambda local: CodexDriver(local=local),
    "pi": lambda local: PiDriver(local=local),
    "mock": lambda _local: _MOCK,
}


@cache
def get_driver(name: str, execution: str = "container") -> WorkerDriver:
    """Return one immutable-mode adapter per worker type and execution backend."""
    return _FACTORIES[name](execution == "local")
