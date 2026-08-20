from __future__ import annotations

import threading
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace

from redtrace.dispatcher.config import ContainerConfig
from redtrace.dispatcher.control_plane import ApiResult
from redtrace.dispatcher.runtime.cancellation import TaskCancellation
from redtrace.dispatcher.runtime.containers import ContainerManager
from redtrace.dispatcher.runtime.heartbeat import HeartbeatLease
from redtrace.paths import RedTracePaths


@dataclass
class FakeProcess:
    cancelled: list[str] = field(default_factory=list)
    kill_count: int = 0

    def cancel(self, reason: str) -> None:
        self.cancelled.append(reason)

    def kill(self) -> None:
        self.kill_count += 1


class FakeContainer:
    def __init__(self) -> None:
        self.client = type("Client", (), {"api": object()})()
        self.stop_count = 0
        self.archives: list[tuple[str, bytes]] = []
        self.archive_result = True
        self.exec_calls: list[list[str]] = []

    def stop(self, timeout: int) -> None:
        assert timeout == 1
        self.stop_count += 1

    def put_archive(self, path: str, archive: bytes) -> bool:
        self.archives.append((path, archive))
        return self.archive_result

    def exec_run(self, command: list[str]):
        self.exec_calls.append(command)
        return SimpleNamespace(exit_code=0, output=b"container ready\n")


def _manager(*, completed_action: str = "stop") -> ContainerManager:
    manager = ContainerManager.__new__(ContainerManager)
    manager._config = ContainerConfig(
        image="image",
        network_mode="host",
        completed_action=completed_action,
    )
    return manager


def test_task_cancellation_keeps_first_reason_and_cancels_late_process() -> None:
    cancellation = TaskCancellation()

    assert cancellation.cancel("project stopped")
    assert not cancellation.cancel("second reason")
    assert cancellation.reason == "project stopped"

    process = FakeProcess()
    cancellation.attach_process(process)
    assert process.cancelled == ["project stopped"]


def test_heartbeat_conflict_failure_kills_attached_process() -> None:
    process = FakeProcess()
    lease = HeartbeatLease(lambda: ApiResult(409, text="lost"), "intent", "worker", interval=60)
    lease.attach_process(process)

    lease._fail(409, "lost")

    assert lease.failure is not None
    assert lease.failure.status_code == 409
    assert process.kill_count == 1


def test_heartbeat_notifies_only_new_blackboard_revisions() -> None:
    seen: list[tuple[int, int]] = []
    lease = HeartbeatLease(
        lambda: ApiResult(200, {}), "intent", "worker", interval=60
    )
    assert lease.watch_blackboard(7, lambda previous, current: seen.append((previous, current)))
    assert not lease.watch_blackboard(0, lambda *_revision: seen.append((-1, -1)))

    lease._notify_blackboard(ApiResult(200, {"blackboard_revision": 7}))
    lease._notify_blackboard(ApiResult(200, {"blackboard_revision": 9}))
    lease._notify_blackboard(ApiResult(200, {"blackboard_revision": 9}))

    assert seen == [(7, 9)]


def test_container_manager_build_exec_process_wraps_command_with_timeout() -> None:
    manager = _manager()
    container = FakeContainer()
    manager._require_container = lambda _name: container

    process = manager.build_exec_process("container", {"A": "B"}, ["agent", "-p", "prompt"], timeout_seconds=300)

    assert process.command == ["timeout", "-k", "5s", "300s", "agent", "-p", "prompt"]
    assert process.env["A"] == "B"
    assert process.env["PATH"].startswith("/opt/redtrace/runtime/bin:")
    assert "/opt/redtrace/tools/bin:" in process.env["PATH"]
    assert process.env["REDTRACE_TOOLS_DIR"] == "/opt/redtrace/tools"
    assert "/home/kali/.local/bin:" in process.env["PATH"]
    assert "/home/kali/go/bin:" in process.env["PATH"]
    assert process.workdir == "/home/kali/workspace"
    assert process.env["REDTRACE_WORKSPACE"] == process.workdir
    assert process.env["TMPDIR"] == process.workdir


def test_container_ready_has_no_skill_bootstrap_side_effect() -> None:
    manager = _manager()
    container = FakeContainer()
    manager._require_container = lambda _name: container

    assert manager._ready("container") == "container"
    assert manager._ready("container") == "container"

    assert container.exec_calls == []


def test_container_mounts_only_current_worker_session_and_native_config(
    tmp_path: Path,
    monkeypatch,
) -> None:
    home = tmp_path / "home"
    home.mkdir()
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: home))
    (home / ".claude").mkdir()
    (home / ".claude" / "settings.json").write_text("{}", encoding="utf-8")
    (home / ".codex").mkdir()
    (home / ".codex" / "config.toml").write_text("", encoding="utf-8")
    paths = RedTracePaths(
        root=tmp_path,
        skills=tmp_path / "skills",
        mcp=tmp_path / "mcp",
        managed=tmp_path / ".redtrace",
        workspaces=tmp_path / "workspaces",
        audit=tmp_path / ".redtrace" / "audit",
    )
    manager = ContainerManager.__new__(ContainerManager)
    manager._paths = paths
    manager._host_source = lambda path: path.resolve()

    volumes = manager._shared_volumes("project-1", "worker-a", "codex")

    workspace = paths.workspaces / "project-1"
    assert volumes[str(workspace.resolve())] == {
        "bind": "/home/kali/workspace",
        "mode": "rw",
    }
    session = paths.managed / "sessions" / "project-1" / "codex" / "worker-a"
    assert volumes[str(session.resolve())]["bind"] == "/home/kali/.codex"
    assert str((home / ".pi").resolve()) not in volumes
    assert str((home / ".claude" / "settings.json").resolve()) not in volumes
    assert volumes[str((home / ".codex" / "config.toml").resolve())]["bind"] == (
        "/home/kali/.codex/config.toml"
    )
    assert volumes[str((paths.runtime / "mcp" / "pi.json").resolve())]["bind"] == (
        "/home/kali/workspace/.pi/mcp.json"
    )
    targets = {volume["bind"] for volume in volumes.values()}
    assert "/opt/redtrace/workers" not in targets
    assert volumes[str(paths.mcp.resolve())]["bind"] == "/opt/redtrace/mcp"
    assert volumes[str(paths.skills.resolve())] == {
        "bind": "/opt/redtrace/claude-plugin/skills",
        "mode": "rw",
    }
    assert "/opt/redtrace/skill-memory" not in targets
    assert volumes[str((paths.runtime / "tools").resolve())] == {
        "bind": "/opt/redtrace/tools",
        "mode": "rw",
    }
    assert "/opt/redtrace/plugins" not in targets


def test_host_mount_lookup_is_cached(monkeypatch, tmp_path: Path) -> None:
    calls = 0

    def get(_name: str):
        nonlocal calls
        calls += 1
        return SimpleNamespace(
            attrs={
                "Mounts": [
                    {"Destination": str(tmp_path), "Source": "C:/host/redtrace"}
                ]
            }
        )

    manager = ContainerManager.__new__(ContainerManager)
    manager._client = SimpleNamespace(containers=SimpleNamespace(get=get))
    manager._host_mounts = None
    monkeypatch.setenv("HOSTNAME", "dispatcher")

    manager._host_source(tmp_path / "one")
    manager._host_source(tmp_path / "two")

    assert calls == 1


def test_completed_container_stop_action_only_stops_running_container() -> None:
    manager = _manager()
    container = FakeContainer()
    states = iter(["running", "exited"])
    manager.inspect_state = lambda _name: next(states)
    manager._require_container = lambda _name: container

    assert manager.cleanup_completed("proj-001")
    assert manager.container_name("proj-001") == "redtrace-dispatch-proj-001"
    assert container.stop_count == 1


def test_stopped_container_cleanup_is_noop_after_container_has_already_stopped() -> None:
    manager = _manager()
    manager.inspect_state = lambda _name: "exited"

    assert manager.cleanup_stopped("proj_001")


def test_write_text_file_uses_archive_api_and_rejects_false_result() -> None:
    manager = _manager()
    container = FakeContainer()
    manager._require_container = lambda _name: container

    manager.write_text_file("container", "/tmp/graph.yaml", "facts: []\n")
    assert container.archives[0][0] == "/tmp"

    container.archive_result = False
    try:
        manager.write_text_file("container", "/tmp/graph.yaml", "facts: []\n")
    except RuntimeError as exc:
        assert "failed to write container file" in str(exc)
    else:
        raise AssertionError("expected failed put_archive result to raise")
