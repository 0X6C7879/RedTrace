from __future__ import annotations

import json
import time

from redtrace.board.models import Intent, ProjectDetail, ProjectSummary
from redtrace.dispatcher.scheduler.state import ReasonCheckpoint

BOOTSTRAP_DESCRIPTION = "bootstrap"
BOOTSTRAP_CREATOR = "dispatcher.bootstrap"


def reason_graph_snapshot(project: ProjectDetail) -> str:
    """Serialize the complete Task Graph for the global Reason planner.

    The Blackboard is the agent's long-term memory, so this snapshot is lossless:
    every Fact, Hint, and Intent (including concluded, failed, and retried ones)
    is preserved in full. There is no byte budget, no per-Fact character
    truncation, and no importance pruning. The Reason prompt receives only a
    file reference to this payload, so a large graph never inflates the model
    context directly — the agent decides how much of it to read.
    """
    payload = {
        "project": {
            "title": project.project.title,
            "status": project.project.status,
            "bootstrap_enabled": project.project.bootstrap_enabled,
        },
        "facts": [
            {"id": fact.id, "description": fact.description}
            for fact in project.facts
        ],
        "hints": [hint.model_dump(mode="json") for hint in project.hints],
        "intents": [
            intent.model_dump(mode="json", by_alias=True)
            for intent in project.intents
        ],
    }
    return _serialize(payload)


def compact_snapshot(project: ProjectDetail, intent: Intent) -> str:
    """Serialize the scoped Explore working set for a single Intent.

    Explore executes one concrete Intent, so it receives only the Facts that
    Intent depends on plus the Intent itself. Scoping selects the relevant
    subgraph; it never truncates or prunes content.
    """
    fact_ids = {"origin", "goal", *intent.from_}
    facts = [fact for fact in project.facts if fact.id in fact_ids]
    payload = {
        "project": {
            "title": project.project.title,
            "status": project.project.status,
            "bootstrap_enabled": project.project.bootstrap_enabled,
        },
        "facts": [
            {"id": fact.id, "description": fact.description}
            for fact in facts
        ],
        "hints": [hint.model_dump(mode="json") for hint in project.hints],
        "intents": [intent.model_dump(mode="json", by_alias=True)],
    }
    return _serialize(payload)


def _serialize(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def rotate_projects(
    summaries: list[ProjectSummary], cursor: int
) -> tuple[list[ProjectSummary], int]:
    """Return a stable round-robin ordering and the next cursor."""
    if not summaries:
        return [], cursor
    ordered_ids = sorted(summary.id for summary in summaries)
    offset = cursor % len(ordered_ids)
    ordered_ids = ordered_ids[offset:] + ordered_ids[:offset]
    by_id = {summary.id: summary for summary in summaries}
    return [by_id[project_id] for project_id in ordered_ids], cursor + 1


def open_intent_count(project: ProjectDetail, *, now: float | None = None) -> int:
    """Count the usable Frontier: working plus schedulable unclaimed Intents."""
    current_time = time.time() if now is None else now
    return sum(
        intent.to is None
        and intent.state not in ("concluded", "dropped", "superseded")
        and (
            intent.worker is not None
            or is_schedulable_intent(intent, now=current_time)
        )
        for intent in project.intents
    )


def is_schedulable_intent(intent: Intent, *, now: float | None = None) -> bool:
    if intent.to is not None:
        return False
    if intent.state in ("dropped", "superseded"):
        return False
    if intent.worker is not None:
        return False
    if intent.circuit_open:
        return False
    return not (
        intent.retry_after is not None
        and intent.retry_after > (time.time() if now is None else now)
    )


def is_bootstrap_intent(intent: Intent) -> bool:
    return (
        intent.description == BOOTSTRAP_DESCRIPTION
        and intent.creator == BOOTSTRAP_CREATOR
        and intent.from_ == ["origin"]
        and intent.to is None
    )


def bootstrap_intent(project: ProjectDetail) -> Intent | None:
    candidates = [intent for intent in project.intents if is_bootstrap_intent(intent)]
    return min(
        candidates,
        key=lambda intent: (intent.worker is not None, intent.created_at, intent.id),
        default=None,
    )


def is_initial(project: ProjectDetail) -> bool:
    fact_ids = {fact.id for fact in project.facts}
    return (
        fact_ids == {"origin", "goal"}
        and len(project.facts) == 2
        and all(is_bootstrap_intent(intent) for intent in project.intents)
    )


def requires_bootstrap(project: ProjectDetail) -> bool:
    return project.project.bootstrap_enabled


def reason_trigger(
    checkpoint: ReasonCheckpoint | None,
    *,
    fact_count: int,
    hint_count: int,
    open_intents: int,
    request_generation: int,
) -> str | None:
    if checkpoint is None:
        return "initial"
    changes: list[str] = []
    if fact_count > checkpoint.fact_count:
        changes.append(f"facts:{checkpoint.fact_count}->{fact_count}")
    if hint_count > checkpoint.hint_count:
        changes.append(f"hints:{checkpoint.hint_count}->{hint_count}")
    if open_intents < checkpoint.open_intent_count:
        changes.append(
            f"open_intents:{checkpoint.open_intent_count}->{open_intents}"
        )
    if request_generation > checkpoint.request_generation:
        changes.append(
            f"intent_results:{checkpoint.request_generation}->{request_generation}"
        )
    return ",".join(changes) or None


def newest_unclaimed_intent(
    project: ProjectDetail, running_intent_ids: set[str]
) -> Intent | None:
    candidates = [
        intent
        for intent in project.intents
        if is_schedulable_intent(intent)
        and intent.id not in running_intent_ids
        and not is_bootstrap_intent(intent)
    ]
    # Priority DESC, then created_at ASC (oldest first), then stable by id.
    return min(
        candidates,
        key=lambda intent: (-intent.priority, intent.created_at, intent.id),
        default=None,
    )
