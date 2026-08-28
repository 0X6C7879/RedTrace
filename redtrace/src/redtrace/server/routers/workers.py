from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from redtrace.dispatcher.config import TasksConfig
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
    provider: str
    model: str
    enabled: bool
    bootstrap: bool
    reason: bool
    explore: bool
    task_types: list[str]
    priority: int
    max_running: int
    editable: bool


class ProviderModelView(BaseModel):
    id: str
    context_window: int
    max_tokens: int
    reasoning: str
    reasoning_efforts: dict[str, str | None] | bool | None = None
    thinking_format: str


class ProviderView(BaseModel):
    name: str
    api: str
    base_url: str
    api_key_configured: bool
    api_key_env: str | None
    models: list[ProviderModelView]
    referenced: bool


class RuntimeSettings(BaseModel):
    max_workers: int = Field(gt=0)
    max_running_projects: int = Field(gt=0)
    max_project_workers: int = Field(gt=0)


class CommonEnvView(BaseModel):
    name: str
    value: str


class WorkerConfigSnapshot(BaseModel):
    revision: str
    engine: str
    execution: str
    runtime_max_workers: int
    runtime: RuntimeSettings
    tasks: TasksConfig
    common_env: list[CommonEnvView]
    providers: list[ProviderView]
    dsh: dict | None = None
    workers: list[WorkerView]


class RuntimeTaskMutation(BaseModel):
    expected_revision: str = Field(min_length=64, max_length=64)
    runtime: RuntimeSettings
    tasks: TasksConfig


class CommonEnvEntryMutation(BaseModel):
    name: str
    value: str


class CommonEnvMutation(BaseModel):
    expected_revision: str = Field(min_length=64, max_length=64)
    entries: list[CommonEnvEntryMutation]


class WorkerMutation(BaseModel):
    expected_revision: str = Field(min_length=64, max_length=64)
    original_name: str | None = None
    name: str
    provider: str
    model: str = "mock"
    enabled: bool = True
    bootstrap: bool = True
    reason: bool = True
    explore: bool = True
    priority: int
    max_running: int

    def service_payload(self) -> dict:
        return self.model_dump()


class ProviderModelMutation(BaseModel):
    id: str
    context_window: int = Field(default=1_000_000, gt=0)
    max_tokens: int = Field(default=128_000, gt=0)
    reasoning: str = "auto_max"
    reasoning_efforts: dict[str, str | None] | bool | None = None
    thinking_format: str = "auto"


class ProviderMutation(BaseModel):
    expected_revision: str = Field(min_length=64, max_length=64)
    name: str
    api: str = "openai-completions"
    base_url: str
    api_key: str | None = None
    api_key_env: str | None = None
    models: list[ProviderModelMutation] = Field(min_length=1)

    def service_payload(self) -> dict:
        return self.model_dump()


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


@router.put("/runtime-tasks", response_model=WorkerConfigSnapshot)
def update_runtime_tasks(body: RuntimeTaskMutation):
    try:
        return _service().update_runtime_tasks(body.model_dump())
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.put("/common-env", response_model=WorkerConfigSnapshot)
def update_common_env(body: CommonEnvMutation):
    try:
        return _service().update_common_env(body.model_dump())
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


@router.post("/providers", response_model=WorkerConfigSnapshot, status_code=201)
def create_provider(body: ProviderMutation):
    try:
        return _service().create_provider(body.service_payload())
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.put("/providers/{provider_name}", response_model=WorkerConfigSnapshot)
def update_provider(provider_name: str, body: ProviderMutation):
    try:
        return _service().update_provider(provider_name, body.service_payload())
    except WorkerConfigError as exc:
        _raise_http(exc)


@router.delete("/providers/{provider_name}", response_model=WorkerConfigSnapshot)
def delete_provider(
    provider_name: str,
    expected_revision: str = Query(min_length=64, max_length=64),
):
    try:
        return _service().delete_provider(provider_name, expected_revision)
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
