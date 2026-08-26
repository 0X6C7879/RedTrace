from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.workers.health import HealthResult

class ProviderError(RuntimeError):
    """Raised when a worker's upstream provider returns a runtime or API
    error instead of a valid agent response.

    Task runners use this to distinguish provider-level failures (rate
    limits, auth errors, unsupported features) from contract parse errors
    so that conclude fallback is only triggered for the latter.

    Attributes:
        code:  Short provider or protocol error code (e.g.
               ``responses_feature_not_supported``, ``turn/start/failed``).
        message: Human-readable error description.
        raw_event: The raw JSON-RPC event dict, if available.
    """

    def __init__(
        self,
        code: str,
        message: str,
        raw_event: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(f"[{code}] {message}")
        self.code = code
        self.message = message
        self.raw_event = raw_event


@dataclass(frozen=True, slots=True)
class DriverResult:
    argv: list[str]
    session: str | None = None
    stdin: str | None = None


class WorkerDriver(ABC):
    """Provider-specific command and response adapter used by task runners."""

    type_name: str

    @abstractmethod
    def check_health(self, worker: WorkerConfig, *, timeout: float) -> HealthResult:
        """Verify the configured provider without starting a task."""

    @abstractmethod
    def build_execute(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str | None,
        *,
        task_type: str | None = None,
    ) -> DriverResult:
        """Build the primary worker invocation."""

    @abstractmethod
    def build_conclude(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str,
        *,
        task_type: str | None = None,
    ) -> DriverResult:
        """Build the bounded fallback invocation for an existing session."""

    def supports_conclude(self) -> bool:
        return True

    def local_binary(self) -> str | None:
        return None

    def prepare_session(self) -> str | None:
        return None

    def describe_health(self, worker: WorkerConfig) -> str:
        return "in-process API ping"

    def extract_session(
        self, session: str | None, stdout: str, stderr: str
    ) -> str | None:
        return session

    def extract_response_text(self, stdout: str, stderr: str) -> str:
        return stdout


class SeedSessionDriver(WorkerDriver):
    def prepare_session(self) -> str | None:
        return str(uuid.uuid4())
