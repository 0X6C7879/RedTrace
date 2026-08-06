"""Benchmark Pack adapter protocol shared by benchctl and every pack adapter."""
from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any


class BenchmarkAdapter(ABC):
    """Minimal async contract between benchctl and a benchmark platform SDK."""

    def __init__(self, config: dict[str, Any]) -> None:
        self.config = config

    async def __aenter__(self) -> "BenchmarkAdapter":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        return None

    @abstractmethod
    async def check_connection(self) -> Any: ...

    @abstractmethod
    async def list_tasks(self) -> list[dict[str, Any]]: ...

    @abstractmethod
    async def start_task(self, task_id: str) -> dict[str, Any]: ...

    @abstractmethod
    async def submit_answer(self, task_id: str, answer: str) -> dict[str, Any]: ...

    @abstractmethod
    async def close_task(self, task_id: str) -> dict[str, Any]: ...

    async def get_task_context(self, task_id: str) -> dict[str, Any] | None:
        """Return fresh task info, or None when the platform lost the task."""
        raise NotImplementedError

    async def get_hint(self, task_id: str) -> dict[str, Any]:
        raise NotImplementedError

    @staticmethod
    def classify_error(exc: BaseException) -> str:
        """Map an SDK exception to a policy key: vpn | duplicate | invalid_state |
        resource_unavailable | connection | task_not_found | challenge_not_found | other."""
        return "other"
