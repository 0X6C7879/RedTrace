import pytest

from redtrace.dispatcher.singleton import (
    DispatcherAlreadyRunning,
    DispatcherInstanceLock,
)


def test_dispatcher_lock_is_scoped_to_server_and_released(tmp_path) -> None:
    first = DispatcherInstanceLock("http://127.0.0.1:8000/", tmp_path)
    first.acquire()
    try:
        with pytest.raises(DispatcherAlreadyRunning, match="already running"):
            DispatcherInstanceLock("http://127.0.0.1:8000", tmp_path).acquire()
    finally:
        first.release()

    with DispatcherInstanceLock("http://127.0.0.1:8000", tmp_path):
        assert True


def test_dispatcher_locks_different_servers_independently(tmp_path) -> None:
    with DispatcherInstanceLock("http://127.0.0.1:8000", tmp_path), DispatcherInstanceLock(
        "http://127.0.0.1:8001", tmp_path
    ):
        assert True
