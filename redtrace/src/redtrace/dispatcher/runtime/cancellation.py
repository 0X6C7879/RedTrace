from __future__ import annotations

from threading import Event, RLock

from redtrace.dispatcher.runtime.process import ExecProcess


class TaskCancellation:
    def __init__(self) -> None:
        self._cancelled = Event()
        self._lock = RLock()
        self._process: ExecProcess | None = None
        self._reason: str | None = None

    def attach_process(self, process: ExecProcess | None) -> None:
        with self._lock:
            self._process = process
            reason = self._reason if self._cancelled.is_set() else None
        if process is not None and reason is not None:
            process.cancel(reason)

    def cancel(self, reason: str) -> bool:
        with self._lock:
            first_request = not self._cancelled.is_set()
            if first_request:
                self._reason = reason
                self._cancelled.set()
            process = self._process
        if process is not None:
            process.cancel(reason)
        return first_request

    @property
    def is_cancelled(self) -> bool:
        return self._cancelled.is_set()

    @property
    def reason(self) -> str | None:
        with self._lock:
            return self._reason
