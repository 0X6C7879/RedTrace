from __future__ import annotations

import re
import uuid
from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Any

from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.workers.health import HealthResult

REDTRACE_OUTPUT_SCHEMA_OBJECT = {
    "type": "object",
    "properties": {
        "accepted": {"type": "boolean"},
        "data": {"type": "object"},
    },
    "required": ["accepted", "data"],
    "additionalProperties": False,
}


@dataclass(frozen=True, slots=True)
class DriverResult:
    argv: list[str]
    session: str | None = None
    stdin: str | None = None
    live_control: Any | None = None


class WorkerDriver(ABC):
    """Provider-specific command and response adapter used by task runners."""

    type_name: str

    @abstractmethod
    def check_health(self, worker: WorkerConfig, *, timeout: float) -> HealthResult:
        """Verify the configured provider without starting a task."""

    @abstractmethod
    def build_execute(
        self, worker: WorkerConfig, prompt: str, session: str | None
    ) -> DriverResult:
        """Build the primary worker invocation."""

    @abstractmethod
    def build_conclude(
        self,
        worker: WorkerConfig,
        prompt: str,
        session: str,
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


class RegexSessionDriver(WorkerDriver):
    session_pattern = re.compile(r"session id:\s*(?P<id>[0-9a-fA-F-]+)")

    def extract_session(
        self, session: str | None, stdout: str, stderr: str
    ) -> str | None:
        if session:
            return session
        match = self.session_pattern.search(stderr)
        return match.group("id") if match else None
