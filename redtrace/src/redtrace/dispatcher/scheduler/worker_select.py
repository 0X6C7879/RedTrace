from __future__ import annotations

import random
from dataclasses import dataclass

from redtrace.dispatcher.config import WorkerConfig


@dataclass(slots=True)
class WorkerSelection:
    worker: WorkerConfig | None
    blocked_busy: list[str]
    blocked_unhealthy: list[str]
    blocked_rejected: list[str]


def select_worker(
    workers: list[WorkerConfig],
    running_counts: dict[str, int],
    unhealthy_until: dict[str, float],
    rejected_until: dict[tuple[str, str, str], float],
    *,
    project_id: str,
    work_kind: str,
    now: float,
) -> WorkerSelection:
    candidates: list[WorkerConfig] = []
    blocked_busy: list[str] = []
    blocked_unhealthy: list[str] = []
    blocked_rejected: list[str] = []

    for worker in workers:
        if not worker.enabled:
            continue
        running = running_counts.get(worker.name, 0)
        if running >= worker.max_running:
            blocked_busy.append(f"{worker.name}({running}/{worker.max_running})")
            continue
        unhealthy_deadline = unhealthy_until.get(worker.name, 0)
        if unhealthy_deadline > now:
            blocked_unhealthy.append(f"{worker.name}({unhealthy_deadline - now:.1f}s)")
            continue
        rejected_deadline = rejected_until.get((project_id, work_kind, worker.name), 0)
        if rejected_deadline > now:
            blocked_rejected.append(f"{worker.name}({rejected_deadline - now:.1f}s)")
            continue
        candidates.append(worker)

    ordered = sorted(
        candidates,
        key=lambda worker: (
            running_counts.get(worker.name, 0) != 0,
            worker.priority,
            running_counts.get(worker.name, 0),
            random.random(),
        ),
    )
    return WorkerSelection(
        worker=ordered[0] if ordered else None,
        blocked_busy=blocked_busy,
        blocked_unhealthy=blocked_unhealthy,
        blocked_rejected=blocked_rejected,
    )
