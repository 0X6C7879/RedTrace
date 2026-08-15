from __future__ import annotations

from redtrace.board.models import (
    Observation,
    ObservationRequest,
    ObservationResponse,
)
from redtrace.board.storage import (
    check_project_active,
    get_intent_or_404,
    get_owned_open_intent_or_404,
    intent_to_model,
    next_observation_id,
    utcnow,
)
from redtrace.server.db import get_conn


def create(
    project_id: str, intent_id: str, request: ObservationRequest
) -> ObservationResponse:
    """Share an intermediate observation without promoting it to a Fact."""
    with get_conn(immediate=True) as conn:
        check_project_active(conn, project_id)
        get_owned_open_intent_or_404(conn, project_id, intent_id, request.worker)
        observation = Observation(
            id=next_observation_id(conn, project_id),
            intent_id=intent_id,
            worker=request.worker,
            content=request.content,
            created_at=utcnow(),
        )
        conn.execute(
            "INSERT INTO observations (id, project_id, intent_id, worker, content, created_at) VALUES (?, ?, ?, ?, ?, ?)",
            (
                observation.id,
                project_id,
                intent_id,
                request.worker,
                request.content,
                observation.created_at,
            ),
        )
        conn.execute(
            "UPDATE intents SET last_progress_at = ? WHERE id = ? AND project_id = ?",
            (observation.created_at, intent_id, project_id),
        )
        return ObservationResponse(
            observation=observation,
            intent=intent_to_model(
                conn, get_intent_or_404(conn, project_id, intent_id), project_id
            ),
        )
