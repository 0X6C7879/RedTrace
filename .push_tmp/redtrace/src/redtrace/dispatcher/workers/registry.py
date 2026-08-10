from __future__ import annotations

from redtrace.dispatcher.workers.adapters import ClaudeCodeDriver, CodexDriver, MockDriver, PiDriver
from redtrace.dispatcher.workers.base import WorkerDriver


_CLAUDE = ClaudeCodeDriver()
_LOCAL_CLAUDE = ClaudeCodeDriver(local=True)
_MOCK = MockDriver()

DRIVERS: dict[str, WorkerDriver] = {
    "claudecode": _CLAUDE,
    "codex": CodexDriver(),
    "pi": PiDriver(),
    "mock": _MOCK,
}

# Local variants invoke the host CLIs in their native configuration (no redtrace provider
# injection). Claude reads long prompts from stdin locally to avoid Windows
# command-line limits.
LOCAL_DRIVERS: dict[str, WorkerDriver] = {
    "claudecode": _LOCAL_CLAUDE,
    "codex": CodexDriver(local=True),
    "pi": PiDriver(local=True),
    "mock": _MOCK,
}


def get_driver(name: str, execution: str = "container") -> WorkerDriver:
    drivers = LOCAL_DRIVERS if execution == "local" else DRIVERS
    return drivers[name]
