from fastapi import APIRouter

from redtrace.board import intents
from redtrace.board.models import (
    ConcludeRequest,
    ConcludeResponse,
    CreateIntentRequest,
    HeartbeatRequest,
    Intent,
)

router = APIRouter(tags=["intents"])


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


@router.post(
    "/projects/{project_id}/intents/{intent_id}/heartbeat",
)
def heartbeat(project_id: str, intent_id: str, body: HeartbeatRequest):
    return intents.heartbeat(project_id, intent_id, body.worker)


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
