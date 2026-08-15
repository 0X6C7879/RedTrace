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
    planning_revision: int | None = None
    started_at: float = field(default_factory=time.monotonic)
