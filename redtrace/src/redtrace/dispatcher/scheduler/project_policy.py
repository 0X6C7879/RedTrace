from __future__ import annotations

import json
import time

from redtrace.board.models import Intent, ProjectDetail, ProjectSummary

BOOTSTRAP_DESCRIPTION = "bootstrap"
BOOTSTRAP_CREATOR = "dispatcher.bootstrap"

_DEAD_INTENT_STATES = frozenset({"blocked", "dropped", "superseded"})


def reason_graph_snapshot(project: ProjectDetail) -> str:
    """Serialize the Task Graph for the global Reason planner.

    Aligned with Cairn: the graph contains concluded intents for full task
    lineage.  ``blocked``, ``dropped`` and ``superseded`` intents are excluded
    because they carry no useful signal for the Reason planner.
    Open Intents are filtered separately in reason.py.
    """
    payload = {
        "project": {
            "title": project.project.title,
            "origin": next(
                (f.description for f in project.facts if f.id == "origin"), ""
            ),
            "goal": next(
                (f.description for f in project.facts if f.id == "goal"), ""
            ),
            "bootstrap_enabled": project.project.bootstrap_enabled,
        },
        "hints": [hint.model_dump(mode="json") for hint in project.hints],
        "facts": [
            {"id": fact.id, "description": fact.description}
            for fact in project.facts
        ],
        "intents": [
            _cairn_intent_export(intent)
            for intent in project.intents
            if intent.state not in _DEAD_INTENT_STATES
        ],
    }
    return _serialize(payload)


def compact_snapshot(project: ProjectDetail, intent: Intent) -> str:
    """Serialize the scoped Explore working set for a single Intent."""
    fact_ids = {"origin", "goal", *intent.from_}
    facts = [fact for fact in project.facts if fact.id in fact_ids]
    payload = {
        "project": {
            "title": project.project.title,
            "origin": next(
                (f.description for f in project.facts if f.id == "origin"), ""
            ),
            "goal": next(
                (f.description for f in project.facts if f.id == "goal"), ""
            ),
            "bootstrap_enabled": project.project.bootstrap_enabled,
        },
        "facts": [
            {"id": fact.id, "description": fact.description}
            for fact in facts
        ],
        "hints": [hint.model_dump(mode="json") for hint in project.hints],
        "intents": [_cairn_intent_export(intent)],
    }
    return _serialize(payload)


def _cairn_intent_export(intent: Intent) -> dict[str, object]:
    """Export an Intent in Cairn format: only from, to, description, creator, worker, timestamps."""
    return {
        "from": intent.from_,
        "to": intent.to,
        "description": intent.description,
        "creator": intent.creator,
        "worker": intent.worker,
        "created_at": intent.created_at,
        "concluded_at": intent.concluded_at,
    }


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
    """Count open intents: working plus schedulable unclaimed Intents."""
    current_time = time.time() if now is None else now
    return sum(
        intent.to is None
        and (
            (intent.state == "working" and intent.worker is not None)
            or is_schedulable_intent(intent, now=current_time)
        )
        for intent in project.intents
    )


def is_schedulable_intent(intent: Intent, *, now: float | None = None) -> bool:
    if intent.state != "open":
        return False
    if intent.to is not None:
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
    # Cairn semantics: newest created intent first.
    # max(created_at) DESC, then stable by id descending.
    return max(
        candidates,
        key=lambda intent: (intent.created_at, intent.id),
        default=None,
    )
