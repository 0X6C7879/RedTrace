from __future__ import annotations

from fastapi import HTTPException

from redtrace.board.models import (
    CompleteRequest,
    CreateProjectRequest,
    Fact,
    Hint,
    Intent,
    ProjectDetail,
    ProjectMeta,
    ProjectSummary,
    ReasonClaimRequest,
    ReopenRequest,
    ReopenResponse,
)
from redtrace.board.storage import (
    build_intents,
    check_project_active,
    check_project_completed,
    clear_project_reason,
    expire_reason_leases,
    expire_workers,
    get_blackboard_revision,
    get_completion_intent_or_409,
    get_project_or_404,
    intent_to_model,
    next_fact_id,
    next_hint_id,
    next_intent_id,
    next_project_id,
    project_meta_from_row,
    project_reason_from_row,
    utcnow,
    validate_facts_exist,
    validate_goal_not_in_sources,
)
from redtrace.server.db import get_conn


def list_all() -> list[ProjectSummary]:
    with get_conn() as conn:
        expire_workers(conn)
        expire_reason_leases(conn)
        rows = conn.execute(
            """
            SELECT p.*,
                (SELECT COUNT(*) FROM facts WHERE project_id = p.id) AS fact_count,
                (SELECT COUNT(*) FROM intents WHERE project_id = p.id) AS intent_count,
                (SELECT COUNT(*) FROM intents WHERE project_id = p.id AND concluded_at IS NULL AND worker IS NOT NULL) AS working_intent_count,
                (SELECT COUNT(*) FROM intents WHERE project_id = p.id AND concluded_at IS NULL AND worker IS NULL) AS unclaimed_intent_count,
                (SELECT COUNT(*) FROM hints WHERE project_id = p.id) AS hint_count
            FROM projects p
            ORDER BY p.created_at
            """
        ).fetchall()
        return [
            ProjectSummary(
                id=row["id"],
                title=row["title"],
                status=row["status"],
                bootstrap_enabled=bool(row["bootstrap_enabled"]),
                created_at=row["created_at"],
                reason=project_reason_from_row(row),
                fact_count=row["fact_count"],
                intent_count=row["intent_count"],
                working_intent_count=row["working_intent_count"],
                unclaimed_intent_count=row["unclaimed_intent_count"],
                hint_count=row["hint_count"],
            )
            for row in rows
        ]


def create(request: CreateProjectRequest) -> ProjectDetail:
    with get_conn(immediate=True) as conn:
        project_id = next_project_id(conn)
        now = utcnow()
        conn.execute(
            "INSERT INTO projects (id, title, status, bootstrap_enabled, created_at) VALUES (?, ?, 'active', ?, ?)",
            (project_id, request.title, request.bootstrap_enabled, now),
        )
        conn.executemany(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            [
                ("origin", project_id, request.origin),
                ("goal", project_id, request.goal),
            ],
        )
        hints = [
            Hint(
                id=next_hint_id(conn, project_id),
                content=hint.content,
                creator=hint.creator,
                created_at=now,
            )
            for hint in request.hints or []
        ]
        conn.executemany(
            "INSERT INTO hints (id, project_id, content, creator, created_at) VALUES (?, ?, ?, ?, ?)",
            [
                (hint.id, project_id, hint.content, hint.creator, hint.created_at)
                for hint in hints
            ],
        )
        return ProjectDetail(
            project=ProjectMeta(
                id=project_id,
                title=request.title,
                status="active",
                bootstrap_enabled=request.bootstrap_enabled,
                created_at=now,
                reason=None,
            ),
            facts=[
                Fact(id="origin", description=request.origin),
                Fact(id="goal", description=request.goal),
            ],
            intents=[],
            hints=hints,
            blackboard_revision=get_blackboard_revision(conn, project_id),
        )


def get(project_id: str) -> ProjectDetail:
    with get_conn() as conn:
        expire_workers(conn, project_id)
        expire_reason_leases(conn, project_id)
        project = get_project_or_404(conn, project_id)
        facts = conn.execute(
            "SELECT * FROM facts WHERE project_id = ?", (project_id,)
        ).fetchall()
        hints = conn.execute(
            "SELECT * FROM hints WHERE project_id = ? ORDER BY created_at",
            (project_id,),
        ).fetchall()
        return ProjectDetail(
            project=project_meta_from_row(project),
            facts=[Fact(**dict(fact)) for fact in facts],
            intents=build_intents(conn, project_id),
            hints=[Hint(**dict(hint)) for hint in hints],
            blackboard_revision=get_blackboard_revision(conn, project_id),
        )


def rename(project_id: str, title: str) -> ProjectMeta:
    with get_conn(immediate=True) as conn:
        get_project_or_404(conn, project_id)
        conn.execute("UPDATE projects SET title = ? WHERE id = ?", (title, project_id))
        return _load_project(conn, project_id)


def transition_status(project_id: str, status: str) -> ProjectMeta:
    with get_conn(immediate=True) as conn:
        expire_reason_leases(conn, project_id)
        current = get_project_or_404(conn, project_id)
        if current["status"] == "completed":
            raise HTTPException(409, "Completed projects cannot change status")
        if current["status"] == status:
            return project_meta_from_row(current)
        conn.execute(
            "UPDATE projects SET status = ? WHERE id = ?", (status, project_id)
        )
        if status == "stopped":
            conn.execute(
                "UPDATE intents SET worker = NULL WHERE project_id = ? AND concluded_at IS NULL",
                (project_id,),
            )
            clear_project_reason(conn, project_id)
        return _load_project(conn, project_id)


def claim_reason(project_id: str, request: ReasonClaimRequest) -> ProjectMeta:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        expire_reason_leases(conn, project_id)
        current = get_project_or_404(conn, project_id)
        if current["reason_worker"] is not None:
            raise HTTPException(
                409,
                f"Project reason is currently claimed by {current['reason_worker']}",
            )
        now = utcnow()
        conn.execute(
            """
            UPDATE projects
            SET reason_worker = ?, reason_trigger = ?, reason_started_at = ?,
                reason_last_heartbeat_at = ?
            WHERE id = ?
            """,
            (request.worker, request.trigger, now, now, project_id),
        )
        return _load_project(conn, project_id)


def heartbeat_reason(project_id: str, worker: str) -> dict[str, object]:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        _owned_reason(conn, project_id, worker)
        now = utcnow()
        conn.execute(
            "UPDATE projects SET reason_last_heartbeat_at = ? WHERE id = ?",
            (now, project_id),
        )
        result = _load_project(conn, project_id).model_dump(mode="json")
        result["blackboard_revision"] = get_blackboard_revision(conn, project_id)
        return result


def release_reason(project_id: str, worker: str) -> ProjectMeta:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        expire_reason_leases(conn, project_id)
        current = get_project_or_404(conn, project_id)
        if current["reason_worker"] is None:
            return project_meta_from_row(current)
        _require_reason_owner(current, worker)
        clear_project_reason(conn, project_id)
        return _load_project(conn, project_id)


def complete(project_id: str, request: CompleteRequest) -> Intent:
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        expire_reason_leases(conn, project_id)
        validate_facts_exist(conn, project_id, request.from_)
        validate_goal_not_in_sources(request.from_)
        now = utcnow()
        intent_id = next_intent_id(conn, project_id)
        conn.execute(
            "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, 'goal', ?, ?, ?, ?, ?, ?)",
            (
                intent_id,
                project_id,
                request.description,
                request.worker,
                request.worker,
                now,
                now,
                now,
            ),
        )
        conn.executemany(
            "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
            [(intent_id, project_id, fact_id) for fact_id in request.from_],
        )
        conn.execute(
            """
            UPDATE projects
            SET status = 'completed', reason_worker = NULL, reason_trigger = NULL,
                reason_started_at = NULL, reason_last_heartbeat_at = NULL
            WHERE id = ?
            """,
            (project_id,),
        )
        return Intent(
            id=intent_id,
            **{"from": request.from_},
            to="goal",
            description=request.description,
            creator=request.worker,
            worker=request.worker,
            last_heartbeat_at=now,
            created_at=now,
            concluded_at=now,
        )


def reopen(project_id: str, request: ReopenRequest) -> ReopenResponse:
    with get_conn(immediate=True) as conn:
        expire_reason_leases(conn, project_id)
        check_project_completed(conn, project_id)
        completion = get_completion_intent_or_409(conn, project_id)
        sources = conn.execute(
            "SELECT fact_id FROM intent_sources WHERE intent_id = ? AND project_id = ? ORDER BY rowid",
            (completion["id"], project_id),
        ).fetchall()
        source_ids = [source["fact_id"] for source in sources]
        if not source_ids:
            raise HTTPException(409, "Completion intent is missing its source facts")

        now = utcnow()
        fact_id = next_fact_id(conn, project_id)
        intent_id = next_intent_id(conn, project_id)
        conn.execute(
            "DELETE FROM intents WHERE id = ? AND project_id = ?",
            (completion["id"], project_id),
        )
        conn.execute(
            "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
            (fact_id, project_id, request.description),
        )
        conn.execute(
            "INSERT INTO intents (id, project_id, to_fact_id, description, creator, worker, last_heartbeat_at, created_at, concluded_at) VALUES (?, ?, ?, 'external_feedback', ?, ?, ?, ?, ?)",
            (
                intent_id,
                project_id,
                fact_id,
                request.creator,
                request.creator,
                now,
                now,
                now,
            ),
        )
        conn.executemany(
            "INSERT INTO intent_sources (intent_id, project_id, fact_id) VALUES (?, ?, ?)",
            [(intent_id, project_id, source_id) for source_id in source_ids],
        )
        clear_project_reason(conn, project_id)
        conn.execute(
            "UPDATE projects SET status = 'active' WHERE id = ?", (project_id,)
        )
        intent_row = conn.execute(
            "SELECT * FROM intents WHERE id = ? AND project_id = ?",
            (intent_id, project_id),
        ).fetchone()
        assert intent_row is not None
        return ReopenResponse(
            project=_load_project(conn, project_id),
            fact=Fact(id=fact_id, description=request.description),
            intent=intent_to_model(conn, intent_row, project_id),
        )


def _load_project(conn, project_id: str) -> ProjectMeta:
    row = conn.execute("SELECT * FROM projects WHERE id = ?", (project_id,)).fetchone()
    assert row is not None
    return project_meta_from_row(row)


def _owned_reason(conn, project_id: str, worker: str):
    expire_reason_leases(conn, project_id)
    current = get_project_or_404(conn, project_id)
    if current["reason_worker"] is None:
        raise HTTPException(409, "Project reason is not currently claimed")
    _require_reason_owner(current, worker)
    return current


def _require_reason_owner(project, worker: str) -> None:
    if project["reason_worker"] != worker:
        raise HTTPException(
            409,
            f"Project reason is currently claimed by {project['reason_worker']}",
        )
