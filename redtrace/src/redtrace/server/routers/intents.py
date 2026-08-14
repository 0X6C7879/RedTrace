import time

from fastapi import APIRouter, HTTPException

from redtrace.board import intents
from redtrace.board.models import (
    ConcludeRequest,
    ConcludeResponse,
    CreateIntentRequest,
    HeartbeatRequest,
    IncrementalFactResponse,
    Intent,
    TaskOutcomeRequest,
)
from redtrace.board.storage import check_project_active, next_fact_id, utcnow
from redtrace.server.db import get_conn

router = APIRouter(tags=["intents"])
RETRY_DELAYS = (5, 15, 60)
MAX_FAILURES = len(RETRY_DELAYS)


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
        decay = 5 if count == 1 else 10
        now = utcnow()
        if count >= MAX_FAILURES:
            fact_id = next_fact_id(conn, project_id)
            description = (
                f"Intent stopped after {count} failed attempts; retry circuit opened. "
                f"category={signature}; detail={body.detail[:500]}"
            )
            conn.execute(
                "INSERT INTO facts (id, project_id, description) VALUES (?, ?, ?)",
                (fact_id, project_id, description),
            )
            conn.execute(
                """
                UPDATE intents SET to_fact_id = ?, worker = NULL,
                    last_heartbeat_at = NULL, concluded_at = ?, failure_count = ?,
                    failure_signature = ?, retry_after = NULL, circuit_open = 1,
                    state = 'concluded', priority = MAX(0, priority - ?)
                WHERE id = ? AND project_id = ?
                """,
                (fact_id, now, count, signature, decay, intent_id, project_id),
            )
            return {"circuitOpen": True, "failureCount": count, "factId": fact_id}
        retry_after = time.time() + RETRY_DELAYS[count - 1]
        conn.execute(
            """
            UPDATE intents SET worker = NULL, last_heartbeat_at = NULL,
                failure_count = ?, failure_signature = ?, retry_after = ?,
                state = 'open', priority = MAX(0, priority - ?)
            WHERE id = ? AND project_id = ?
            """,
            (count, signature, retry_after, decay, intent_id, project_id),
        )
        return {"circuitOpen": False, "failureCount": count, "retryAfter": retry_after}


@router.post(
    "/projects/{project_id}/intents/{intent_id}/heartbeat",
)
def heartbeat(project_id: str, intent_id: str, body: HeartbeatRequest):
    return intents.heartbeat(project_id, intent_id, body.worker)


@router.post(
    "/projects/{project_id}/intents/{intent_id}/facts",
    response_model=IncrementalFactResponse,
    status_code=201,
)
def submit_fact(project_id: str, intent_id: str, body: ConcludeRequest):
    return intents.submit_fact(project_id, intent_id, body)


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
