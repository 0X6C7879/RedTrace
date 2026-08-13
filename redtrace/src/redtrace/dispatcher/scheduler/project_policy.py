from __future__ import annotations

import json
import time

from redtrace.board.models import Intent, ProjectDetail, ProjectSummary
from redtrace.dispatcher.scheduler.state import ReasonCheckpoint

BOOTSTRAP_DESCRIPTION = "bootstrap"
BOOTSTRAP_CREATOR = "dispatcher.bootstrap"
FACT_SUMMARY_CHARS = 800
MAX_SNAPSHOT_BYTES = 64 * 1024


def compact_snapshot(project: ProjectDetail, intent: Intent | None = None) -> str:
    """Serialize a bounded graph; full facts remain queryable from Blackboard."""
    fact_ids = None if intent is None else {"origin", "goal", *intent.from_}
    facts = [fact for fact in project.facts if fact_ids is None or fact.id in fact_ids]
    intents = (
        [item for item in project.intents if item.to is None]
        if intent is None
        else [intent]
    )
    payload = {
        "project": {
            "title": project.project.title,
            "status": project.project.status,
            "bootstrap_enabled": project.project.bootstrap_enabled,
        },
        "facts": [_compact_fact(fact.id, fact.description) for fact in facts],
        "hints": [hint.model_dump(mode="json") for hint in project.hints],
        "intents": [item.model_dump(mode="json", by_alias=True) for item in intents],
    }
    serialized = _serialize(payload)
    if len(serialized.encode()) <= MAX_SNAPSHOT_BYTES:
        return serialized

    bounded = {"project": payload["project"], "facts": [], "hints": [], "intents": []}
    for section in ("facts", "hints", "intents"):
        for item in payload[section]:
            bounded[section].append(item)
            candidate = _serialize(bounded)
            if len(candidate.encode()) > MAX_SNAPSHOT_BYTES:
                bounded[section].pop()
                break
    return _serialize(bounded)


def _serialize(payload: object) -> str:
    return json.dumps(payload, ensure_ascii=False, separators=(",", ":"))


def _compact_fact(fact_id: str, description: str) -> dict[str, str]:
    if len(description) <= FACT_SUMMARY_CHARS:
        return {"id": fact_id, "description": description}
    return {
        "id": fact_id,
        "description": (
            description[:FACT_SUMMARY_CHARS]
            + f"… [truncated; run redtrace-blackboard source {fact_id}]"
        ),
    }


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


def open_intent_count(project: ProjectDetail) -> int:
    return sum(intent.to is None for intent in project.intents)


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
    if checkpoint.open_intent_count > 0 and open_intents == 0:
        changes.append(f"open_intents:{checkpoint.open_intent_count}->0")
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
        if intent.to is None
        and intent.worker is None
        and not intent.circuit_open
        and (intent.retry_after is None or intent.retry_after <= time.time())
        and intent.id not in running_intent_ids
        and not is_bootstrap_intent(intent)
    ]
    return max(candidates, key=lambda intent: intent.created_at, default=None)
