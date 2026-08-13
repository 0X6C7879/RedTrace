from fastapi import APIRouter, HTTPException, Response
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from redtrace.board import projects
from redtrace.board.models import (
    CompleteRequest,
    CreateProjectRequest,
    HeartbeatRequest,
    Intent,
    ProjectDetail,
    ProjectMeta,
    ProjectSummary,
    ReasonClaimRequest,
    ReopenRequest,
    ReopenResponse,
    UpdateProjectStatusRequest,
    UpdateProjectTitleRequest,
)
from redtrace.paths import PathResolutionError
from redtrace.server.db import wait_for_change
from redtrace.server.project_cleanup import (
    deletion_status,
    report_runtime_cleanup,
    request_deletion,
)

router = APIRouter(tags=["projects"])


@router.get("/dispatcher/changes")
def wait_for_dispatcher_changes(after: int | None = None, timeout: float = 10.0):
    return {"generation": wait_for_change(after, max(0.0, min(timeout, 30.0)))}


class RuntimeCleanupReport(BaseModel):
    success: bool
    error: str = ""


@router.get("/projects", response_model=list[ProjectSummary])
def list_projects():
    return projects.list_all()


@router.post("/projects", response_model=ProjectDetail, status_code=201)
def create_project(body: CreateProjectRequest):
    return projects.create(body)


@router.get("/projects/{project_id}", response_model=ProjectDetail)
def get_project(project_id: str):
    return projects.get(project_id)


@router.delete("/projects/{project_id}", status_code=202)
def delete_project(project_id: str):
    try:
        state = request_deletion(project_id)
    except PathResolutionError as exc:
        raise HTTPException(400, str(exc)) from exc
    if state == "missing":
        return Response(status_code=204)
    return JSONResponse({"projectId": project_id, "state": state}, status_code=202)


@router.get("/projects/{project_id}/deletion")
def get_deletion_status(project_id: str):
    try:
        value = deletion_status(project_id)
    except PathResolutionError as exc:
        raise HTTPException(400, str(exc)) from exc
    return Response(status_code=204) if value is None else value


@router.post("/projects/{project_id}/deletion/runtime-cleaned")
def runtime_cleaned(project_id: str, body: RuntimeCleanupReport):
    try:
        completed = report_runtime_cleanup(
            project_id, success=body.success, error=body.error
        )
    except (PathResolutionError, RuntimeError) as exc:
        raise HTTPException(409, str(exc)) from exc
    return {"projectId": project_id, "completed": completed}


@router.put("/projects/{project_id}/title", response_model=ProjectMeta)
def update_project_title(project_id: str, body: UpdateProjectTitleRequest):
    return projects.rename(project_id, body.title)


@router.put("/projects/{project_id}/status", response_model=ProjectMeta)
def update_project_status(project_id: str, body: UpdateProjectStatusRequest):
    return projects.transition_status(project_id, body.status)


@router.post("/projects/{project_id}/reason/claim", response_model=ProjectMeta)
def claim_project_reason(project_id: str, body: ReasonClaimRequest):
    return projects.claim_reason(project_id, body)


@router.post("/projects/{project_id}/reason/heartbeat")
def heartbeat_project_reason(project_id: str, body: HeartbeatRequest):
    return projects.heartbeat_reason(project_id, body.worker)


@router.post("/projects/{project_id}/reason/release", response_model=ProjectMeta)
def release_project_reason(project_id: str, body: HeartbeatRequest):
    return projects.release_reason(project_id, body.worker)


@router.post("/projects/{project_id}/complete", response_model=Intent)
def complete_project(project_id: str, body: CompleteRequest):
    return projects.complete(project_id, body)


@router.post("/projects/{project_id}/reopen", response_model=ReopenResponse)
def reopen_project(project_id: str, body: ReopenRequest):
    return projects.reopen(project_id, body)
