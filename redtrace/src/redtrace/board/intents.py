from __future__ import annotations

from redtrace.board.models import (
    ConcludeRequest,
    ConcludeResponse,
    CreateIntentRequest,
    Fact,
    Intent,
)
from redtrace.board.storage import (
    check_project_active,
    get_blackboard_revision,
    get_owned_open_intent_or_404,
    get_releasable_open_intent_or_404,
    get_unclaimed_open_intent_or_404,
    intent_to_model,
    next_fact_id,
    next_intent_id,
    utcnow,
    validate_facts_exist,
    validate_goal_not_in_sources,
    validate_intent_creator_worker,
)
from redtrace.server.db import get_conn


def create(project_id: str, request: CreateIntentRequest) -> Intent:
    """Create an intent and all of its source edges atomically."""
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        validate_facts_exist(conn, project_id, request.from_)
        validate_goal_not_in_sources(request.from_)
        validate_intent_creator_worker(request.creator, request.worker)

        now = utcnow()
        intent_id = next_intent_id(conn, project_id)
        claimed = request.worker is not None
        conn.execute(
            "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL)",
            (
                intent_id,
                project_id,
                request.description,
                request.creator,
                request.worker,
                now if claimed else None,
                now,
            ),
        )
        conn.executemany(
            "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
            [(intent_id, project_id, fact_id) for fact_id in request.from_],
        )

        return Intent(
            id=intent_id,
            **{"from": request.from_},
            to=None,
            description=request.description,
            creator=request.creator,
            worker=request.worker,
            last_heartbeat_at=now if claimed else None,
            created_at=now,
            concluded_at=None,
        )


def claim(project_id: str, intent_id: str, worker: str) -> Intent:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_unclaimed_open_intent_or_404(conn, project_id, intent_id)
        now = utcnow()
        conn.execute(
            "UPDATE intents SET worker = ?, last_heartbeat_at = ? WHERE id = ? AND project_id = ?",
            (worker, now, intent_id, project_id),
        )
        return _load_intent(conn, project_id, intent_id)


def heartbeat(project_id: str, intent_id: str, worker: str) -> dict[str, object]:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_owned_open_intent_or_404(conn, project_id, intent_id, worker)
        now = utcnow()
        conn.execute(
            "UPDATE intents SET last_heartbeat_at = ? WHERE id = ? AND project_id = ?",
            (now, intent_id, project_id),
        )
        result = _load_intent(conn, project_id, intent_id).model_dump(
            mode="json", by_alias=True
        )
        result["blackboard_revision"] = get_blackboard_revision(conn, project_id)
        return result


def release(project_id: str, intent_id: str, worker: str) -> Intent:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        row = get_releasable_open_intent_or_404(conn, project_id, intent_id, worker)
        if row["worker"] == worker:
            conn.execute(
                "UPDATE intents SET worker = NULL WHERE id = ? AND project_id = ?",
                (intent_id, project_id),
            )
            return _load_intent(conn, project_id, intent_id)
        return intent_to_model(conn, row, project_id)


def conclude(
    project_id: str, intent_id: str, request: ConcludeRequest
) -> ConcludeResponse:
    """Turn an owned intent into a fact in one transaction."""
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_owned_open_intent_or_404(conn, project_id, intent_id, request.worker)
        now = utcnow()
        fact_id = next_fact_id(conn, project_id)
        conn.execute(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            (fact_id, project_id, request.description),
        )
        conn.execute(
            "UPDATE intents SET to_fact_id = ?, last_heartbeat_at = ?, concluded_at = ? WHERE id = ? AND project_id = ?",
            (fact_id, now, now, intent_id, project_id),
        )
        return ConcludeResponse(
            fact=Fact(id=fact_id, description=request.description),
            intent=_load_intent(conn, project_id, intent_id),
        )


def _load_intent(conn, project_id: str, intent_id: str) -> Intent:
    row = conn.execute(
        "SELECT * FROM intents WHERE id = ? AND project_id = ?",
        (intent_id, project_id),
    ).fetchone()
    assert row is not None
    return intent_to_model(conn, row, project_id)
