"""Fact-graph domain and transport models."""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, Field, field_validator


class Settings(BaseModel):
    intent_timeout: int = Field(ge=5)
    reason_timeout: int = Field(ge=5)


class Fact(BaseModel):
    id: str
    description: str


class Intent(BaseModel):
    id: str
    from_: list[str] = Field(alias="from")
    to: str | None = None
    description: str
    creator: str
    worker: str | None = None
    last_heartbeat_at: str | None = None
    created_at: str
    concluded_at: str | None = None
    failure_count: int = 0
    failure_signature: str | None = None
    retry_after: float | None = None
    circuit_open: bool = False
    priority: int = Field(default=50, ge=0, le=100)
    state: Literal[
        "open", "claimed", "working", "concluded", "dropped", "superseded"
    ] = "open"
    goal_id: str | None = None
    superseded_by: str | None = None
    invalidated_by: list[str] = Field(default_factory=list)
    drop_reason: str | None = None
    attempt_count: int = 0
    cumulative_runtime_ms: int = 0
    fact_yield: int = 0
    last_progress_at: str | None = None

    model_config = {"populate_by_name": True}


class Hint(BaseModel):
    id: str
    content: str
    creator: str
    created_at: str


class ProjectReason(BaseModel):
    worker: str
    trigger: str
    started_at: str
    last_heartbeat_at: str


class ProjectMeta(BaseModel):
    id: str
    title: str
    status: Literal["active", "stopped", "completed", "deleting"]
    bootstrap_enabled: bool
    created_at: str
    reason: ProjectReason | None = None
    reason_failure_count: int = 0
    reason_failure_signature: str | None = None
    reason_retry_after: float | None = None
    reason_circuit_open: bool = False


class ProjectSummary(ProjectMeta):
    fact_count: int
    intent_count: int
    working_intent_count: int
    unclaimed_intent_count: int
    hint_count: int


class ProjectDetail(BaseModel):
    project: ProjectMeta
    facts: list[Fact]
    intents: list[Intent]
    hints: list[Hint]
    blackboard_revision: int = 0


class CreateHintInline(BaseModel):
    content: str
    creator: str

    @field_validator("content", "creator")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CreateProjectRequest(BaseModel):
    title: str
    origin: str
    goal: str
    bootstrap_enabled: bool = False
    hints: list[CreateHintInline] | None = None

    @field_validator("title", "origin", "goal")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CreateHintRequest(BaseModel):
    content: str
    creator: str

    @field_validator("content", "creator")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CreateIntentRequest(BaseModel):
    from_: list[str] = Field(alias="from", min_length=1)
    description: str
    creator: str
    worker: str | None = None
    priority: int = Field(default=50, ge=0, le=100)

    model_config = {"populate_by_name": True}

    @field_validator("description", "creator", "worker")
    @classmethod
    def validate_non_empty_text(cls, value: str | None) -> str | None:
        if value is None:
            return None
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text

    @field_validator("from_")
    @classmethod
    def validate_fact_ids(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            text = item.strip()
            if not text:
                raise ValueError("fact ids must not be empty")
            cleaned.append(text)
        return cleaned


class HeartbeatRequest(BaseModel):
    worker: str


class TaskOutcomeRequest(BaseModel):
    worker: str
    outcome: Literal[
        "success",
        "cancelled",
        "heartbeat_loss",
        "timeout",
        "session_missing",
        "provider_exit",
        "contract_error",
        "api_error",
        "workspace_integrity",
        "internal_error",
        "unhealthy",
        "rejected",
    ]
    detail: str = ""

    @field_validator("worker")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ReasonClaimRequest(BaseModel):
    worker: str
    trigger: str

    @field_validator("worker", "trigger")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ConcludeRequest(BaseModel):
    worker: str
    description: str

    @field_validator("worker", "description")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class CompleteRequest(BaseModel):
    from_: list[str] = Field(alias="from", min_length=1)
    description: str
    worker: str

    model_config = {"populate_by_name": True}

    @field_validator("description", "worker")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text

    @field_validator("from_")
    @classmethod
    def validate_fact_ids(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            text = item.strip()
            if not text:
                raise ValueError("fact ids must not be empty")
            cleaned.append(text)
        return cleaned


class ConcludeResponse(BaseModel):
    fact: Fact
    intent: Intent


class GraphPatchCreate(BaseModel):
    from_: list[str] = Field(alias="from", min_length=1)
    description: str
    priority: int = Field(default=50, ge=0, le=100)
    goal_id: str | None = None

    model_config = {"populate_by_name": True}

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class GraphPatchDrop(BaseModel):
    intent_id: str
    reason: str

    @field_validator("intent_id", "reason")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class GraphPatchReprioritize(BaseModel):
    intent_id: str
    priority: int = Field(ge=0, le=100)
    reason: str = ""

    @field_validator("intent_id")
    @classmethod
    def validate_intent_id(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class GraphPatchSupersede(BaseModel):
    intent_id: str
    by: str
    reason: str = ""

    @field_validator("intent_id", "by")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class GraphPatchComplete(BaseModel):
    from_: list[str] = Field(alias="from", min_length=1)
    description: str

    model_config = {"populate_by_name": True}

    @field_validator("description")
    @classmethod
    def validate_description(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text

    @field_validator("from_")
    @classmethod
    def validate_fact_ids(cls, value: list[str]) -> list[str]:
        cleaned = []
        for item in value:
            text = item.strip()
            if not text:
                raise ValueError("fact ids must not be empty")
            cleaned.append(text)
        return cleaned


class GraphPatchRequest(BaseModel):
    base_revision: int = Field(ge=0)
    worker: str
    create: list[GraphPatchCreate] = Field(default_factory=list)
    drop: list[GraphPatchDrop] = Field(default_factory=list)
    reprioritize: list[GraphPatchReprioritize] = Field(default_factory=list)
    supersede: list[GraphPatchSupersede] = Field(default_factory=list)
    complete: GraphPatchComplete | None = None

    @field_validator("worker")
    @classmethod
    def validate_worker(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class GraphPatchResponse(BaseModel):
    revision: int
    created: list[Intent] = Field(default_factory=list)
    dropped: list[str] = Field(default_factory=list)
    reprioritized: list[str] = Field(default_factory=list)
    superseded: list[str] = Field(default_factory=list)
    completed: bool = False


class UpdateProjectStatusRequest(BaseModel):
    status: Literal["active", "stopped"]


class UpdateProjectTitleRequest(BaseModel):
    title: str

    @field_validator("title")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ReopenRequest(BaseModel):
    description: str
    creator: str

    @field_validator("description", "creator")
    @classmethod
    def validate_non_empty_text(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("must not be empty")
        return text


class ReopenResponse(BaseModel):
    project: ProjectMeta
    fact: Fact
    intent: Intent
