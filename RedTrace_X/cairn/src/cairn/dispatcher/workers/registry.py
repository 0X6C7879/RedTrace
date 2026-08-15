from __future__ import annotations

from cairn.dispatcher.workers.adapters import MockDriver, PiDriver
from cairn.dispatcher.workers.base import WorkerDriver


_MOCK = MockDriver()

DRIVERS: dict[str, WorkerDriver] = {
    "pi": PiDriver(),
    "mock": _MOCK,
}

LOCAL_DRIVERS: dict[str, WorkerDriver] = {
    "pi": PiDriver(local=True),
    "mock": _MOCK,
}


def get_driver(name: str, execution: str = "container") -> WorkerDriver:
    drivers = LOCAL_DRIVERS if execution == "local" else DRIVERS
    return drivers[name]
