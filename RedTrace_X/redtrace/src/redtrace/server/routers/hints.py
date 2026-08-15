from fastapi import APIRouter

from redtrace.board import hints
from redtrace.board.models import CreateHintRequest, Hint

router = APIRouter(tags=["hints"])


@router.post(
    "/projects/{project_id}/hints",
    response_model=Hint,
    status_code=201,
)
def create_hint(project_id: str, body: CreateHintRequest):
    return hints.create(project_id, body)
