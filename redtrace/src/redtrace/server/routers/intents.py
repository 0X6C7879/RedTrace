import time

from fastapi import APIRouter, HTTPException

from redtrace.board import intents
from redtrace.board.models import (
    ConcludeRequest,
    ConcludeResponse,
    CreateIntentRequest,
    HeartbeatRequest,
    Intent,
    TaskOutcomeRequest,
)
from redtrace.board.storage import (
    bump_planning_revision,
    check_project_active,
    utcnow,
)
from redtrace.server.db import get_conn

router = APIRouter(tags=["intents"])
RETRY_DELAYS = (5, 15, 60)
MAX_FAILURES = len(RETRY_DELAYS)
BOOTSTRAP_CREATOR = "dispatcher.bootstrap"


@router.post(
    "/projects/{project_id}/intents",
    response_model=Intent,
    status_code=201,
)
def create_intent(project_id: str, body: CreateIntentRequest):
    return intents.create(project_id, body)


@router.post(
    "/projects/{project_id}/intents/{intent_id}/claim",
    response_model=Intent,
)
def claim(project_id: str, intent_id: str, body: HeartbeatRequest):
    return intents.claim(project_id, intent_id, body.worker)


@router.post("/projects/{project_id}/intents/{intent_id}/outcome")
def report_outcome(project_id: str, intent_id: str, body: TaskOutcomeRequest):
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        row = conn.execute(
            "SELECT * FROM intents WHERE id = ? AND project_id = ?",
            (intent_id, project_id),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "Intent not found")
        conn.execute(
            "INSERT INTO intent_execution_events (project_id, intent_id, worker, outcome, detail, runtime_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                project_id,
                intent_id,
                body.worker,
                body.outcome,
                body.detail,
                body.runtime_ms,
                utcnow(),
            ),
        )
        if body.runtime_ms:
            conn.execute(
                "UPDATE intents SET cumulative_runtime_ms = cumulative_runtime_ms + ? WHERE id = ? AND project_id = ?",
                (body.runtime_ms, intent_id, project_id),
            )
        if body.outcome in {"success", "cancelled"}:
            return {"circuitOpen": False, "failureCount": 0}
        if row["to_fact_id"] is not None:
            return {"circuitOpen": bool(row["circuit_open"]), "failureCount": row["failure_count"]}
        count = int(row["failure_count"]) + 1
        signature = body.outcome[:100]
        if row["creator"] == BOOTSTRAP_CREATOR:
            retry_after = time.time() + RETRY_DELAYS[
                min(count - 1, len(RETRY_DELAYS) - 1)
            ]
            conn.execute(
                """
                UPDATE intents SET worker = NULL, last_heartbeat_at = NULL,
                    failure_count = ?, failure_signature = ?, retry_after = ?,
                    circuit_open = 0, state = 'open'
                WHERE id = ? AND project_id = ?
                """,
                (count, signature, retry_after, intent_id, project_id),
            )
            return {
                "circuitOpen": False,
                "failureCount": count,
                "retryAfter": retry_after,
            }
        if count >= MAX_FAILURES:
            conn.execute(
                """
                UPDATE intents SET worker = NULL, last_heartbeat_at = NULL,
                    failure_count = ?,
                    failure_signature = ?, retry_after = NULL, circuit_open = 1,
                    state = 'blocked'
                WHERE id = ? AND project_id = ?
                """,
                (count, signature, intent_id, project_id),
            )
            bump_planning_revision(conn, project_id)
            return {"circuitOpen": True, "failureCount": count, "state": "blocked"}
        retry_after = time.time() + RETRY_DELAYS[count - 1]
        conn.execute(
            """
                UPDATE intents SET worker = NULL, last_heartbeat_at = NULL,
                failure_count = ?, failure_signature = ?, retry_after = ?,
                state = 'open'
            WHERE id = ? AND project_id = ?
            """,
            (count, signature, retry_after, intent_id, project_id),
        )
        return {"circuitOpen": False, "failureCount": count, "retryAfter": retry_after}


@router.post(
    "/projects/{project_id}/intents/{intent_id}/heartbeat",
)
def heartbeat(project_id: str, intent_id: str, body: HeartbeatRequest):
    return intents.heartbeat(project_id, intent_id, body.worker)


@router.post(
    "/projects/{project_id}/intents/{intent_id}/facts",
)
def submit_fact(project_id: str, intent_id: str, body: ConcludeRequest):
    raise HTTPException(
        409,
        "Incremental Fact submission is disabled; use session/workspace for intermediate results and submit formal Facts via conclude",
    )


@router.post(
    "/projects/{project_id}/intents/{intent_id}/release",
    response_model=Intent,
)
def release(project_id: str, intent_id: str, body: HeartbeatRequest):
    return intents.release(project_id, intent_id, body.worker)


@router.post(
    "/projects/{project_id}/intents/{intent_id}/conclude",
    response_model=ConcludeResponse,
)
def conclude(project_id: str, intent_id: str, body: ConcludeRequest):
    return intents.conclude(project_id, intent_id, body)
