from __future__ import annotations

import hashlib
import os
from pathlib import Path
from types import TracebackType

from redtrace.paths import redtrace_root


class DispatcherAlreadyRunning(RuntimeError):
    """Raised when another dispatcher owns the same scheduling scope."""


class DispatcherInstanceLock:
    """Cross-platform process lock scoped to one RedTrace server."""

    def __init__(self, server: str, lock_root: Path | None = None):
        self.server = server.rstrip("/")
        digest = hashlib.sha256(self.server.encode("utf-8")).hexdigest()[:20]
        root = lock_root or redtrace_root() / ".redtrace" / "runtime" / "locks"
        self.path = root / f"{digest}.lock"
        self._handle = None

    def acquire(self) -> DispatcherInstanceLock:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        handle = self.path.open("a+b")
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        try:
            _lock_file(handle)
        except OSError as exc:
            handle.close()
            holder = _read_holder(self.path)
            detail = f" (holder {holder})" if holder else ""
            raise DispatcherAlreadyRunning(
                f"dispatcher already running for server {self.server}{detail}"
            ) from exc

        handle.seek(0)
        handle.truncate()
        handle.write(f"pid={os.getpid()} server={self.server}\n".encode("utf-8"))
        handle.flush()
        self._handle = handle
        return self

    def release(self) -> None:
        handle = self._handle
        if handle is None:
            return
        self._handle = None
        try:
            handle.seek(0)
            _unlock_file(handle)
        finally:
            handle.close()

    def __enter__(self) -> DispatcherInstanceLock:
        return self.acquire()

    def __exit__(
        self,
        exc_type: type[BaseException] | None,
        exc: BaseException | None,
        traceback: TracebackType | None,
    ) -> None:
        self.release()


def _read_holder(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace").strip()
    except OSError:
        return ""


if os.name == "nt":
    import msvcrt

    def _lock_file(handle) -> None:
        msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)

    def _unlock_file(handle) -> None:
        msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)

else:
    import fcntl

    def _lock_file(handle) -> None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

    def _unlock_file(handle) -> None:
        fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
