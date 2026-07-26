from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field, SecretStr

from redtrace.worker_config import (
    WorkerConfigConflict,
    WorkerConfigError,
    WorkerConfigService,
    WorkerConnectionError,
)

router = APIRouter(prefix="/worker-config", tags=["worker-config"])


class WorkerView(BaseModel):
    name: str
    type: str
    enabled: bool
    api_endpoint: str
    api_key: str
    api_key_configured: bool
    model_id: str
    task_types: list[str]
    priority: int
    max_running: int
    editable: bool
    native_config_paths: list[str]


class WorkerConfigSnapshot(BaseModel):
    revision: str
    execution: str
    runtime_max_workers: int
    cli_config_home: str
    workers: list[WorkerView]


class WorkerMutation(BaseModel):
    expected_revision: str = Field(min_length=64, max_length=64)
    original_name: str | None = None
    name: str
    type: Literal["claudecode", "codex", "pi"]
    enabled: bool = True
    api_endpoint: str = ""
    api_key: SecretStr | None = None
    clear_api_key: bool = False
    model_id: str = ""
    task_types: list[Literal["bootstrap", "reason", "explore"]]
    priority: int
    max_running: int

    def service_payload(self) -> dict:
        payload = self.model_dump(exclude={"api_key"})
        payload["api_key"] = (
            self.api_key.get_secret_value() if self.api_key is not None else None
        )
        return payload


class CopyRequest(BaseModel):
    expected_revision: str = Field(min_length=64, max_length=64)


class EnabledRequest(CopyRequest):
    enabled: bool


class ConnectionTestResult(BaseModel):
    ok: bool
    status: int | None
    duration_ms: int
    detail: str
    cached: bool


def _service() -> WorkerConfigService:
    return WorkerConfigService()


def _raise_http(exc: WorkerConfigError) -> None:
    if isinstance(exc, WorkerConfigConflict):
        raise HTTPException(409, str(exc)) from exc
    if isinstance(exc, WorkerConnectionError):
        raise HTTPException(422, str(exc)) from exc
    raise HTTPException(400, str(exc)) from exc


@router.get("", response_model=WorkerConfigSnapshot)
def get_worker_config():
    try:
        return _service().snapshot()
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.post("/test", response_model=ConnectionTestResult)
def test_worker_config(body: WorkerMutation):
    try:
        return _service().test_payload(
            body.service_payload(),
            original_name=body.original_name,
        )
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.post("/workers", response_model=WorkerConfigSnapshot, status_code=201)
def create_worker(body: WorkerMutation):
    try:
        return _service().create(body.service_payload())
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.put("/workers/{worker_name}", response_model=WorkerConfigSnapshot)
def update_worker(worker_name: str, body: WorkerMutation):
    try:
        return _service().update(worker_name, body.service_payload())
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.post("/workers/{worker_name}/copy", response_model=WorkerConfigSnapshot)
def copy_worker(worker_name: str, body: CopyRequest):
    try:
        return _service().copy(worker_name, body.expected_revision)
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.patch("/workers/{worker_name}/enabled", response_model=WorkerConfigSnapshot)
def set_worker_enabled(worker_name: str, body: EnabledRequest):
    try:
        return _service().set_enabled(
            worker_name,
            body.enabled,
            body.expected_revision,
        )
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.delete("/workers/{worker_name}", response_model=WorkerConfigSnapshot)
def delete_worker(
    worker_name: str,
    expected_revision: str = Query(min_length=64, max_length=64),
):
    try:
        return _service().delete(worker_name, expected_revision)
    except WorkerConfigError as exc:
        _raise_http(exc)
