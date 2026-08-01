import pytest

from redtrace.dispatcher.singleton import (
    DispatcherAlreadyRunning,
    DispatcherInstanceLock,
)


def test_dispatcher_lock_is_scoped_to_server_and_released() -> None:
    first = DispatcherInstanceLock("http://127.0.0.1:8000/")
    first.acquire()
    try:
        with pytest.raises(DispatcherAlreadyRunning, match="already running"):
            DispatcherInstanceLock("http://127.0.0.1:8000").acquire()
    finally:
        first.release()

    with DispatcherInstanceLock("http://127.0.0.1:8000"):
        assert True


def test_dispatcher_locks_different_servers_independently() -> None:
    with DispatcherInstanceLock("http://127.0.0.1:8000"), DispatcherInstanceLock(
        "http://127.0.0.1:8001"
    ):
        assert True
