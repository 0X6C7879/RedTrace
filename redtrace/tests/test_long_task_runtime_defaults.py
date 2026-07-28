from __future__ import annotations

import inspect

from redtrace.dispatcher.runtime.local_backend import LocalBackend
from redtrace.dispatcher.runtime.local_process import (
    FORCE_KILL_REAP_TIMEOUT_SECONDS,
    STREAM_JOIN_TIMEOUT_SECONDS,
    LocalProcess,
)
from redtrace.dispatcher.runtime.process import EXEC_KILL_JOIN_TIMEOUT_SECONDS, ManagedProcess
from redtrace.dispatcher.tasks.common import (
    PROCESS_COMMUNICATE_GRACE_SECONDS,
    PROCESS_TERMINATION_GRACE_SECONDS,
)


def test_long_task_process_grace_defaults() -> None:
    assert PROCESS_COMMUNICATE_GRACE_SECONDS == 60
    assert PROCESS_TERMINATION_GRACE_SECONDS == 30
    assert EXEC_KILL_JOIN_TIMEOUT_SECONDS == 30.0
    assert STREAM_JOIN_TIMEOUT_SECONDS == 30.0
    assert FORCE_KILL_REAP_TIMEOUT_SECONDS == 10.0

    local_backend_default = inspect.signature(LocalBackend.build_exec_process).parameters[
        "kill_after_seconds"
    ].default
    local_grace_default = inspect.signature(LocalProcess.__init__).parameters[
        "term_grace_seconds"
    ].default
    local_output_default = inspect.signature(LocalProcess.__init__).parameters[
        "max_output_chars"
    ].default
    managed_output_default = inspect.signature(ManagedProcess.__init__).parameters[
        "max_output_chars"
    ].default

    assert local_backend_default == 30
    assert local_grace_default == 30
    assert local_output_default == 32 * 1024 * 1024
    assert managed_output_default == 32 * 1024 * 1024
