from __future__ import annotations

from functools import cache

from redtrace.dispatcher.workers.adapters import MockDriver
from redtrace.dispatcher.workers.base import WorkerDriver

_MOCK = MockDriver()


@cache
def get_driver(name: str, execution: str = "container") -> WorkerDriver:
    """Return the adapter for a worker provider on an execution backend.

    The mock test engine is the only in-process driver left; every real
    Worker runs on the DSH Cordis runtime.
    """
    if name != "mock":
        raise ValueError(
            f"no local adapter for worker provider '{name}': real Workers run on the DSH runtime"
        )
    return _MOCK
