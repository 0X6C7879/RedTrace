import pytest

from redtrace.dispatcher.singleton import (
    DispatcherAlreadyRunning,
    DispatcherInstanceLock,
)


def test_dispatcher_lock_is_scoped_to_server_and_released() -> None:
    first = DispatcherInstanceLock("https://redtrace.test:18000/")
    first.acquire()
    try:
        with pytest.raises(DispatcherAlreadyRunning, match="already running"):
            DispatcherInstanceLock("https://redtrace.test:18000").acquire()
    finally:
        first.release()

    with DispatcherInstanceLock("https://redtrace.test:18000"):
        assert True


def test_dispatcher_locks_different_servers_independently() -> None:
    with DispatcherInstanceLock("https://redtrace.test:18000"), DispatcherInstanceLock(
        "https://redtrace.test:18001"
    ):
        assert True
