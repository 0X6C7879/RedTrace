"""Mutable scheduler state carried across dispatch cycles."""

from __future__ import annotations

import time
from dataclasses import dataclass, field

from redtrace.dispatcher.runtime.cancellation import TaskCancellation


@dataclass(slots=True)
class RunningTask:
    project_id: str
    task_type: str
    worker_name: str
    cancellation: TaskCancellation
    intent_id: str | None = None
    fact_count: int | None = None
    hint_count: int | None = None
    open_intent_count: int | None = None
    reason_request_generation: int | None = None
    started_at: float = field(default_factory=time.monotonic)


@dataclass(slots=True)
class ReasonCheckpoint:
    fact_count: int
    hint_count: int
    open_intent_count: int
    request_generation: int = 0
