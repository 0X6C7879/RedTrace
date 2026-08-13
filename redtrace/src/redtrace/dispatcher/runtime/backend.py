from __future__ import annotations

from pathlib import Path
from typing import Any, Protocol, runtime_checkable

from redtrace.dispatcher.runtime.process import ExecProcess


def is_agent_runtime_state(worker_type: str, name: str) -> bool:
    if name == "skills":
        return True
    if worker_type == "claudecode":
        return name in {
            "debug",
            "file-history",
            "history.jsonl",
            "projects",
            "session-env",
            "shell-snapshots",
            "tasks",
            "telemetry",
            "todos",
        }
    return (
        name
        in {
            "archived_sessions",
            "history.jsonl",
            "log",
            "logs",
            "session_index.jsonl",
            "sessions",
            "shell_snapshots",
            "tmp",
        }
        or name.startswith("state_")
        or name.startswith("logs_")
    )


def session_file_checkpoint(root: Path, session_id: str) -> dict[str, Any]:
    latest: tuple[int, Path, int] | None = None
    for path in root.rglob(f"*{session_id}*"):
        try:
            stat = path.stat()
        except OSError:
            continue
        if not path.is_file():
            continue
        candidate = (stat.st_mtime_ns, path, stat.st_size)
        if latest is None or candidate[0] > latest[0]:
            latest = candidate
    if latest is None:
        return {"path": "", "exists": False, "size_bytes": 0, "mtime_ns": 0}
    mtime_ns, path, size = latest
    return {
        "path": str(path.resolve()),
        "exists": True,
        "size_bytes": size,
        "mtime_ns": mtime_ns,
    }


@runtime_checkable
class ExecutionBackend(Protocol):
    """The execution substrate for worker processes.

    Two implementations exist: ContainerManager (one Docker container per project) and
    LocalBackend (host subprocesses, one working directory per project). The scheduler,
    task runners and startup healthcheck only depend on this surface so the two backends
    are interchangeable behind a single ``runtime.execution`` switch.
    """

    def container_name(self, project_id: str) -> str: ...

    def ensure_running(
        self,
        project_id: str,
        worker_name: str | None = None,
        worker_type: str | None = None,
    ) -> str: ...

    def ensure_worker_running(
        self, project_id: str, worker_name: str, worker_type: str
    ) -> str: ...

    def conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str
    ) -> dict[str, str]: ...

    def worker_conversation_environment(
        self, project_id: str, worker_type: str, worker_name: str
    ) -> dict[str, str]: ...

    def session_checkpoint(
        self, project_id: str, worker_type: str, worker_name: str, session_id: str
    ) -> dict[str, Any]: ...

    def build_exec_process(
        self,
        container_name: str,
        env: dict[str, str],
        command: list[str],
        stdin_text: str | None = None,
        keep_stdin_open: bool = False,
        timeout_seconds: int | None = None,
        kill_after_seconds: int = 5,
    ) -> ExecProcess: ...

    def write_text_file(self, container_name: str, path: str, content: str) -> str: ...

    def needs_completed_cleanup(self, project_id: str) -> bool: ...

    def needs_stopped_cleanup(self, project_id: str) -> bool: ...

    def cleanup_completed(self, project_id: str) -> bool: ...

    def cleanup_stopped(self, project_id: str) -> bool: ...

    def cleanup_deleted(self, project_id: str) -> bool: ...

    def close(self) -> None: ...
