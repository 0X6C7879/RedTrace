from fastapi import APIRouter, HTTPException, Response

from redtrace.board import hints
from redtrace.board.models import CreateHintRequest, Hint
from redtrace.board.storage import check_project_hint_writable
from redtrace.server.db import get_conn

router = APIRouter(tags=["hints"])


@router.post(
    "/projects/{project_id}/hints",
    response_model=Hint,
    status_code=201,
)
def create_hint(project_id: str, body: CreateHintRequest):
    return hints.create(project_id, body)


@router.delete("/projects/{project_id}/hints/{hint_id}", status_code=204)
def delete_hint(project_id: str, hint_id: str) -> Response:
    with get_conn(immediate=True) as conn:
        check_project_hint_writable(conn, project_id)
        deleted = conn.execute(
            "DELETE FROM hints WHERE id = ? AND project_id = ?",
            (hint_id, project_id),
        ).rowcount
        if not deleted:
            raise HTTPException(404, "Hint not found")
    return Response(status_code=204)
