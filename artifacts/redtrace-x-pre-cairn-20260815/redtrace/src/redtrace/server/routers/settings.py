from fastapi import APIRouter

from redtrace.board import settings
from redtrace.board.models import Settings

router = APIRouter(tags=["settings"])


@router.get("/settings", response_model=Settings)
def get_settings():
    return settings.read()


@router.put("/settings", response_model=Settings)
def update_settings(body: Settings):
    return settings.replace(body)
