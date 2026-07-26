from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Response, status
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field, field_validator

from redtrace.server import db
from redtrace.server.db import get_conn
from redtrace.server.c2_payloads import build_beacon, compatible_oneliners, generate_oneliner
from redtrace.server.operations import (
    EXECUTABLE_KINDS,
    RESOURCE_KINDS,
    RISK_LEVELS,
    audit_event,
    create_resource,
    expire_stale_c2_sessions,
    json_dump,
    json_load,
    operation_executor,
    output_summary,
    probe_webshell_config,
    public_audit,
    public_resource,
    public_task,
    store_result,
    task_id,
    utcnow,
    verify_token,
)
from redtrace.server.routers.blackboard import QueryContext, query_context
from redtrace.server.services import get_project_or_404

router = APIRouter(tags=["operations"])


class ResourceCreate(BaseModel):
    kind: str
    name: str = Field(min_length=1, max_length=160)
    target: str = Field(default="", max_length=4096)
    summary: str = Field(default="", max_length=2000)
    status: str = Field(default="available", max_length=32)
    metadata: dict[str, Any] = Field(default_factory=dict)
    secret: dict[str, Any] = Field(default_factory=dict)
    actor_type: Literal["human", "worker", "system"] = "human"
    actor: str = Field(default="admin", min_length=1, max_length=128)
    worker: str | None = Field(default=None, max_length=128)
    intent_id: str | None = Field(default=None, max_length=128)
    fact_id: str | None = Field(default=None, max_length=128)
    parent_resource_id: str | None = Field(default=None, max_length=64)
    source_task_id: str | None = Field(default=None, max_length=64)
    publish_fact: bool = True

    @field_validator("kind")
    @classmethod
    def validate_kind(cls, value: str) -> str:
        if value not in RESOURCE_KINDS - {"c2_session", "result"}:
            raise ValueError("unsupported resource kind")
        return value


class ResourceUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=160)
    target: str | None = Field(default=None, max_length=4096)
    summary: str | None = Field(default=None, max_length=2000)
    status: str | None = Field(default=None, max_length=32)
    metadata: dict[str, Any] | None = None
    secret: dict[str, Any] | None = None
    actor: str = Field(default="admin", min_length=1, max_length=128)


class ResourceLockRequest(BaseModel):
    actor_type: Literal["human", "worker"] = "human"
    actor: str = Field(min_length=1, max_length=128)


class ResourceControlRequest(BaseModel):
    paused: bool
    actor: str = Field(default="admin", min_length=1, max_length=128)


class ResourceStateRequest(BaseModel):
    status: Literal["available", "offline", "degraded", "retired"]
    actor: str = Field(default="admin", min_length=1, max_length=128)


class OperationCreate(BaseModel):
    action: str = Field(min_length=1, max_length=128)
    arguments: dict[str, Any] = Field(default_factory=dict)
    actor_type: Literal["human", "worker", "system"] = "human"
    actor: str = Field(default="admin", min_length=1, max_length=128)
    risk: Literal["low", "medium", "high", "critical"] = "low"
    requires_approval: bool | None = None
    intent_id: str | None = Field(default=None, max_length=128)
    fact_id: str | None = Field(default=None, max_length=128)


class ApprovalRequest(BaseModel):
    actor: str = Field(default="admin", min_length=1, max_length=128)
    decision: Literal["approve", "reject"] = "approve"


class CancelRequest(BaseModel):
    actor: str = Field(default="admin", min_length=1, max_length=128)
    reason: str = Field(default="cancelled by operator", max_length=500)


class C2Checkin(BaseModel):
    external_id: str = Field(min_length=1, max_length=256)
    hostname: str = Field(default="", max_length=256)
    username: str = Field(default="", max_length=256)
    os: str = Field(default="", max_length=128)
    arch: str = Field(default="", max_length=64)
    process: str = Field(default="", max_length=256)
    pid: int | None = None
    capabilities: list[str] = Field(default_factory=list, max_length=128)


class C2TaskResult(BaseModel):
    success: bool = True
    output: str = Field(default="", max_length=2 * 1024 * 1024)
    summary: str = Field(default="", max_length=1000)


class WebShellTestRequest(BaseModel):
    target: str = Field(min_length=1, max_length=4096)
    password: str = Field(default="", max_length=512)
    shell_type: Literal["php", "asp", "aspx", "jsp", "custom"] = "php"
    protocol: Literal["auto", "eval", "antsword", "raw"] = "auto"
    method: Literal["POST", "GET"] = "POST"
    command_param: str = Field(default="", max_length=128)
    password_param: str = Field(default="", max_length=128)
    target_os: Literal["auto", "linux", "windows"] = "auto"
    encoding: Literal["auto", "utf-8", "gbk", "gb18030"] = "auto"
    verify_tls: bool = False


class C2OnelinerRequest(BaseModel):
    listener_id: str = Field(min_length=1, max_length=64)
    kind: str = Field(min_length=1, max_length=64)
    callback_host: str = Field(default="", max_length=512)


class C2BuildRequest(BaseModel):
    listener_id: str = Field(min_length=1, max_length=64)
    callback_url: str = Field(default="", max_length=2048)
    os: Literal["linux", "windows", "darwin"] = "linux"
    arch: Literal["amd64", "arm64", "386"] = "amd64"
    sleep_seconds: int = Field(default=5, ge=1, le=3600)
    actor: str = Field(default="admin", min_length=1, max_length=128)


def _actor(body_actor_type: str, body_actor: str, context: QueryContext) -> tuple[str, str, str | None]:
    if context.worker != "unknown":
        return "worker", context.worker, context.intent_id
    return body_actor_type, body_actor.strip() or "admin", context.intent_id


def _resource_or_404(conn: sqlite3.Connection, project_id: str, resource_id: str):
    get_project_or_404(conn, project_id)
    row = conn.execute(
        "SELECT * FROM shared_resources WHERE id = ? AND project_id = ?",
        (resource_id, project_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Shared resource not found")
    return row


def _task_or_404(conn: sqlite3.Connection, project_id: str, operation_id: str):
    get_project_or_404(conn, project_id)
    row = conn.execute(
        "SELECT * FROM operation_tasks WHERE id = ? AND project_id = ?",
        (operation_id, project_id),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Operation task not found")
    return row


def _ensure_resource_available_for_actor(resource: Any, actor_type: str, actor: str) -> None:
    if actor_type == "worker" and resource["worker_paused"]:
        raise HTTPException(status.HTTP_423_LOCKED, "Worker operations are paused for this resource")
    locked_by = resource["locked_by"]
    if locked_by and (resource["locked_by_type"] != actor_type or locked_by != actor):
        raise HTTPException(
            status.HTTP_423_LOCKED,
            f"Resource is locked by {resource['locked_by_type']}:{locked_by}",
        )
    if resource["status"] == "retired":
        raise HTTPException(409, "Resource is retired")


def _submit_if_executable(resource: Any, operation_id: str, operation_status: str) -> None:
    if operation_status == "queued" and resource["kind"] in EXECUTABLE_KINDS:
        operation_executor.submit(operation_id)


@router.get("/projects/{project_id}/operations/summary")
def operation_summary(project_id: str):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        expire_stale_c2_sessions(conn, project_id)
        resource_counts = conn.execute(
            """
            SELECT kind, COUNT(*) AS count,
                   SUM(CASE WHEN status = 'available' THEN 1 ELSE 0 END) AS available
            FROM shared_resources WHERE project_id = ? GROUP BY kind
            """,
            (project_id,),
        ).fetchall()
        task_counts = conn.execute(
            "SELECT status, COUNT(*) AS count FROM operation_tasks WHERE project_id = ? GROUP BY status",
            (project_id,),
        ).fetchall()
        return {
            "project_id": project_id,
            "resources": {row["kind"]: {"count": row["count"], "available": row["available"] or 0} for row in resource_counts},
            "tasks": {row["status"]: row["count"] for row in task_counts},
        }


@router.get("/projects/{project_id}/resources")
def list_resources(
    project_id: str,
    kind: str | None = None,
    resource_status: str | None = Query(default=None, alias="status"),
    q: str = "",
    limit: int = Query(default=200, ge=1, le=500),
    context: QueryContext = Depends(query_context),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        expire_stale_c2_sessions(conn, project_id)
        clauses = ["project_id = ?"]
        params: list[Any] = [project_id]
        if kind:
            clauses.append("kind = ?")
            params.append(kind)
        if resource_status:
            clauses.append("status = ?")
            params.append(resource_status)
        if q.strip():
            clauses.append("(name LIKE ? OR target LIKE ? OR summary LIKE ?)")
            needle = f"%{q.strip()}%"
            params.extend([needle, needle, needle])
        params.append(limit)
        rows = conn.execute(
            f"SELECT * FROM shared_resources WHERE {' AND '.join(clauses)} ORDER BY updated_at DESC LIMIT ?",
            params,
        ).fetchall()
        if context.worker != "unknown":
            audit_event(
                conn,
                project_id=project_id,
                resource_id_value=None,
                task_id_value=None,
                actor_type="worker",
                actor=context.worker,
                action="resource.list",
                status="succeeded",
                detail={"kind": kind, "count": len(rows), "intent_id": context.intent_id},
            )
        return {"project_id": project_id, "resources": [public_resource(row) for row in rows]}


@router.post("/projects/{project_id}/resources", status_code=201)
def register_resource(
    project_id: str,
    body: ResourceCreate,
    context: QueryContext = Depends(query_context),
):
    actor_type, actor, context_intent = _actor(body.actor_type, body.actor, context)
    with get_conn() as conn:
        project = get_project_or_404(conn, project_id)
        if project["status"] == "completed" and body.kind not in {"file", "result"}:
            raise HTTPException(409, "Completed projects only accept evidence and result resources")
        try:
            resource, secret_once = create_resource(
                conn,
                project_id=project_id,
                kind=body.kind,
                name=body.name,
                target=body.target,
                summary=body.summary,
                status=body.status,
                metadata=body.metadata,
                secret=body.secret,
                actor_type=actor_type,
                actor=actor,
                worker=context.worker if actor_type == "worker" else body.worker,
                intent_id=context_intent or body.intent_id,
                fact_id=body.fact_id,
                parent_resource_id=body.parent_resource_id,
                source_task_id=body.source_task_id,
                publish_fact=body.publish_fact,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        response = {"resource": resource}
        if secret_once is not None and actor_type == "human":
            response["secret_once"] = secret_once
        return response


@router.post("/projects/{project_id}/webshell/test")
def test_webshell_connection(project_id: str, body: WebShellTestRequest):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
    metadata = {
        "shell_type": body.shell_type,
        "protocol": body.protocol,
        "method": body.method,
        "command_param": body.command_param,
        "password_param": body.password_param,
        "os": body.target_os,
        "encoding": body.encoding,
        "verify_tls": body.verify_tls,
        "timeout": 20,
    }
    try:
        output = probe_webshell_config(
            url=body.target,
            metadata=metadata,
            secret={"password": body.password},
        )
    except Exception as exc:
        raise HTTPException(400, f"连接测试失败：{exc}") from exc
    return {"ok": True, "summary": output_summary(output) or "连接成功"}


def _payload_root() -> Path:
    configured = db._db_path or db.DEFAULT_DB
    root = Path(configured).parent / "payloads"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


@router.get("/projects/{project_id}/c2/listeners/{listener_id}/oneliner-kinds")
def c2_oneliner_kinds(project_id: str, listener_id: str):
    with get_conn() as conn:
        listener = _resource_or_404(conn, project_id, listener_id)
        if listener["kind"] != "c2_listener":
            raise HTTPException(400, "Resource is not a C2 listener")
        metadata = json_load(listener["metadata_json"], {})
        return {"listener_id": listener_id, "kinds": compatible_oneliners(metadata)}


@router.post("/projects/{project_id}/c2/payloads/oneliner")
def create_c2_oneliner(project_id: str, body: C2OnelinerRequest):
    with get_conn() as conn:
        listener = _resource_or_404(conn, project_id, body.listener_id)
        if listener["kind"] != "c2_listener":
            raise HTTPException(400, "Resource is not a C2 listener")
        metadata = json_load(listener["metadata_json"], {})
        secret = json_load(listener["secret_json"], {})
        try:
            oneliner = generate_oneliner(
                metadata=metadata,
                listener_id=listener["id"],
                listener_token=str(secret.get("listener_token") or ""),
                kind=body.kind,
                host_override=body.callback_host,
            )
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=listener["id"],
            task_id_value=None,
            actor_type="human",
            actor="admin",
            action="c2.payload_oneliner",
            status="succeeded",
            detail={"kind": body.kind},
        )
        return {"oneliner": oneliner, "kind": body.kind, "listener_id": listener["id"]}


@router.post("/projects/{project_id}/c2/payloads/build", status_code=201)
def build_c2_payload(project_id: str, body: C2BuildRequest):
    with get_conn() as conn:
        listener = _resource_or_404(conn, project_id, body.listener_id)
        if listener["kind"] != "c2_listener":
            raise HTTPException(400, "Resource is not a C2 listener")
        metadata = json_load(listener["metadata_json"], {})
        secret = json_load(listener["secret_json"], {})
        token = str(secret.get("listener_token") or "")
        if not token:
            raise HTTPException(409, "Listener token is unavailable; recreate the listener")
    try:
        artifact = build_beacon(
            output_dir=_payload_root(),
            listener_id=body.listener_id,
            listener_token=token,
            metadata=metadata,
            callback_url=body.callback_url,
            target_os=body.os,
            target_arch=body.arch,
            sleep_seconds=body.sleep_seconds,
        )
    except (ValueError, RuntimeError) as exc:
        raise HTTPException(400, str(exc)) from exc
    with get_conn() as conn:
        resource, _ = create_resource(
            conn,
            project_id=project_id,
            kind="c2_payload",
            name=artifact.name,
            target=f"/projects/{project_id}/c2/payloads/download/{artifact.name}",
            summary=f"{body.os}/{body.arch} Beacon，绑定 {listener['name']}",
            metadata={
                "listener_id": body.listener_id,
                "platform": body.os,
                "arch": body.arch,
                "size_bytes": artifact.stat().st_size,
                "filename": artifact.name,
            },
            secret={"artifact_path": str(artifact)},
            actor_type="human",
            actor=body.actor,
            parent_resource_id=body.listener_id,
            publish_fact=True,
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=body.listener_id,
            task_id_value=None,
            actor_type="human",
            actor=body.actor,
            action="c2.payload_build",
            status="succeeded",
            detail={"payload_id": resource["id"], "os": body.os, "arch": body.arch},
        )
        return {"payload": resource}


@router.get("/projects/{project_id}/c2/payloads/download/{filename}")
def download_c2_payload(project_id: str, filename: str):
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(400, "Invalid payload filename")
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        rows = conn.execute(
            "SELECT * FROM shared_resources WHERE project_id = ? AND kind = 'c2_payload'",
            (project_id,),
        ).fetchall()
        row = next(
            (
                item
                for item in rows
                if json_load(item["metadata_json"], {}).get("filename") == filename
            ),
            None,
        )
        if row is None:
            raise HTTPException(404, "Payload not found")
        secret = json_load(row["secret_json"], {})
    root = _payload_root()
    artifact = Path(str(secret.get("artifact_path") or "")).resolve()
    try:
        artifact.relative_to(root)
    except ValueError as exc:
        raise HTTPException(404, "Payload not found") from exc
    if not artifact.is_file():
        raise HTTPException(404, "Payload not found")
    return FileResponse(artifact, filename=filename, media_type="application/octet-stream")


@router.get("/projects/{project_id}/resources/{resource_id}")
def get_resource(project_id: str, resource_id: str):
    with get_conn() as conn:
        expire_stale_c2_sessions(conn, project_id)
        row = _resource_or_404(conn, project_id, resource_id)
        tasks = conn.execute(
            "SELECT * FROM operation_tasks WHERE resource_id = ? ORDER BY created_at DESC LIMIT 50",
            (resource_id,),
        ).fetchall()
        audit = conn.execute(
            "SELECT * FROM resource_audit_events WHERE project_id = ? AND resource_id = ? ORDER BY id DESC LIMIT 100",
            (project_id, resource_id),
        ).fetchall()
        return {
            "resource": public_resource(row),
            "tasks": [public_task(task) for task in tasks],
            "audit": [public_audit(event) for event in audit],
        }


@router.put("/projects/{project_id}/resources/{resource_id}")
def update_resource(project_id: str, resource_id: str, body: ResourceUpdate):
    with get_conn() as conn:
        row = _resource_or_404(conn, project_id, resource_id)
        values = {
            "name": body.name if body.name is not None else row["name"],
            "target": body.target if body.target is not None else row["target"],
            "summary": body.summary if body.summary is not None else row["summary"],
            "status": body.status if body.status is not None else row["status"],
            "metadata_json": json_dump(body.metadata) if body.metadata is not None else row["metadata_json"],
            "secret_json": json_dump(body.secret) if body.secret is not None else row["secret_json"],
        }
        conn.execute(
            """
            UPDATE shared_resources
            SET name = ?, target = ?, summary = ?, status = ?, metadata_json = ?,
                secret_json = ?, updated_at = ?
            WHERE id = ? AND project_id = ?
            """,
            (
                values["name"],
                values["target"],
                values["summary"],
                values["status"],
                values["metadata_json"],
                values["secret_json"],
                utcnow(),
                resource_id,
                project_id,
            ),
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=resource_id,
            task_id_value=None,
            actor_type="human",
            actor=body.actor,
            action="resource.update",
            status="succeeded",
        )
        updated = conn.execute("SELECT * FROM shared_resources WHERE id = ?", (resource_id,)).fetchone()
        return {"resource": public_resource(updated)}


@router.delete("/projects/{project_id}/resources/{resource_id}", status_code=204)
def delete_resource(
    project_id: str,
    resource_id: str,
    actor: str = Query(default="admin", min_length=1, max_length=128),
):
    with get_conn() as conn:
        row = _resource_or_404(conn, project_id, resource_id)
        running = conn.execute(
            "SELECT COUNT(*) AS count FROM operation_tasks WHERE resource_id = ? AND status IN ('queued', 'running', 'awaiting_approval')",
            (resource_id,),
        ).fetchone()["count"]
        if running:
            raise HTTPException(409, "Cancel active tasks before deleting this resource")
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=resource_id,
            task_id_value=None,
            actor_type="human",
            actor=actor,
            action="resource.delete",
            status="succeeded",
            detail={"kind": row["kind"], "name": row["name"]},
        )
        conn.execute("DELETE FROM shared_resources WHERE id = ?", (resource_id,))
    return Response(status_code=204)


@router.post("/projects/{project_id}/resources/{resource_id}/lock")
def lock_resource(project_id: str, resource_id: str, body: ResourceLockRequest):
    with get_conn() as conn:
        row = _resource_or_404(conn, project_id, resource_id)
        if row["locked_by"] and (row["locked_by"] != body.actor or row["locked_by_type"] != body.actor_type):
            raise HTTPException(status.HTTP_423_LOCKED, f"Resource is already locked by {row['locked_by']}")
        conn.execute(
            "UPDATE shared_resources SET locked_by_type = ?, locked_by = ?, locked_at = ?, updated_at = ? WHERE id = ?",
            (body.actor_type, body.actor, utcnow(), utcnow(), resource_id),
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=resource_id,
            task_id_value=None,
            actor_type=body.actor_type,
            actor=body.actor,
            action="resource.lock",
            status="succeeded",
        )
        updated = conn.execute("SELECT * FROM shared_resources WHERE id = ?", (resource_id,)).fetchone()
        return {"resource": public_resource(updated)}


@router.post("/projects/{project_id}/resources/{resource_id}/unlock")
def unlock_resource(project_id: str, resource_id: str, body: ResourceLockRequest):
    with get_conn() as conn:
        row = _resource_or_404(conn, project_id, resource_id)
        if row["locked_by"] and body.actor_type != "human" and (
            row["locked_by"] != body.actor or row["locked_by_type"] != body.actor_type
        ):
            raise HTTPException(status.HTTP_423_LOCKED, "Only the lock owner or a human operator can unlock")
        conn.execute(
            """
            UPDATE shared_resources SET locked_by_type = NULL, locked_by = NULL,
                locked_at = NULL, updated_at = ? WHERE id = ?
            """,
            (utcnow(), resource_id),
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=resource_id,
            task_id_value=None,
            actor_type=body.actor_type,
            actor=body.actor,
            action="resource.unlock",
            status="succeeded",
        )
        updated = conn.execute("SELECT * FROM shared_resources WHERE id = ?", (resource_id,)).fetchone()
        return {"resource": public_resource(updated)}


@router.post("/projects/{project_id}/resources/{resource_id}/worker-control")
def set_worker_control(project_id: str, resource_id: str, body: ResourceControlRequest):
    with get_conn() as conn:
        _resource_or_404(conn, project_id, resource_id)
        conn.execute(
            "UPDATE shared_resources SET worker_paused = ?, updated_at = ? WHERE id = ?",
            (int(body.paused), utcnow(), resource_id),
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=resource_id,
            task_id_value=None,
            actor_type="human",
            actor=body.actor,
            action="resource.worker_pause" if body.paused else "resource.worker_resume",
            status="succeeded",
        )
        updated = conn.execute("SELECT * FROM shared_resources WHERE id = ?", (resource_id,)).fetchone()
        return {"resource": public_resource(updated)}


@router.post("/projects/{project_id}/resources/{resource_id}/state")
def set_resource_state(project_id: str, resource_id: str, body: ResourceStateRequest):
    with get_conn() as conn:
        row = _resource_or_404(conn, project_id, resource_id)
        if row["kind"] == "c2_listener" and body.status not in {"available", "offline", "retired"}:
            raise HTTPException(400, "C2 listeners support available, offline, or retired")
        conn.execute(
            "UPDATE shared_resources SET status = ?, updated_at = ? WHERE id = ?",
            (body.status, utcnow(), resource_id),
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=resource_id,
            task_id_value=None,
            actor_type="human",
            actor=body.actor,
            action="resource.state",
            status="succeeded",
            detail={"from": row["status"], "to": body.status},
        )
        updated = conn.execute("SELECT * FROM shared_resources WHERE id = ?", (resource_id,)).fetchone()
        return {"resource": public_resource(updated)}


@router.post("/projects/{project_id}/resources/{resource_id}/tasks", status_code=202)
def create_operation(
    project_id: str,
    resource_id: str,
    body: OperationCreate,
    context: QueryContext = Depends(query_context),
):
    actor_type, actor, context_intent = _actor(body.actor_type, body.actor, context)
    with get_conn() as conn:
        resource = _resource_or_404(conn, project_id, resource_id)
        _ensure_resource_available_for_actor(resource, actor_type, actor)
        if resource["kind"] not in EXECUTABLE_KINDS | {"c2_session"}:
            raise HTTPException(409, "This resource type does not accept operation tasks")
        risk = body.risk if body.risk in RISK_LEVELS else "low"
        requires_approval = (
            body.requires_approval
            if body.requires_approval is not None
            else actor_type == "worker" and risk in {"high", "critical"}
        )
        op_id = task_id()
        op_status = "awaiting_approval" if requires_approval else "queued"
        now = utcnow()
        conn.execute(
            """
            INSERT INTO operation_tasks (
                id, project_id, resource_id, intent_id, fact_id, action,
                actor_type, actor, risk, status, input_json, requires_approval,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                op_id,
                project_id,
                resource_id,
                context_intent or body.intent_id,
                body.fact_id,
                body.action,
                actor_type,
                actor,
                risk,
                op_status,
                json_dump(body.arguments),
                int(requires_approval),
                now,
            ),
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=resource_id,
            task_id_value=op_id,
            actor_type=actor_type,
            actor=actor,
            action=f"operation.{body.action}",
            status=op_status,
            detail={"risk": risk, "intent_id": context_intent or body.intent_id},
        )
        row = conn.execute("SELECT * FROM operation_tasks WHERE id = ?", (op_id,)).fetchone()
        result = public_task(row)
        resource_snapshot = dict(resource)
    _submit_if_executable(resource_snapshot, op_id, op_status)
    return {"task": result}


@router.get("/projects/{project_id}/operations/tasks")
def list_operation_tasks(
    project_id: str,
    resource_id: str | None = None,
    task_status: str | None = Query(default=None, alias="status"),
    limit: int = Query(default=200, ge=1, le=500),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        clauses = ["project_id = ?"]
        params: list[Any] = [project_id]
        if resource_id:
            clauses.append("resource_id = ?")
            params.append(resource_id)
        if task_status:
            clauses.append("status = ?")
            params.append(task_status)
        params.append(limit)
        rows = conn.execute(
            f"SELECT * FROM operation_tasks WHERE {' AND '.join(clauses)} ORDER BY created_at DESC LIMIT ?",
            params,
        ).fetchall()
        return {"project_id": project_id, "tasks": [public_task(row) for row in rows]}


@router.post("/projects/{project_id}/operations/tasks/{operation_id}/approval")
def decide_operation(project_id: str, operation_id: str, body: ApprovalRequest):
    with get_conn() as conn:
        task = _task_or_404(conn, project_id, operation_id)
        if task["status"] != "awaiting_approval":
            raise HTTPException(409, "Task is not awaiting approval")
        resource = _resource_or_404(conn, project_id, task["resource_id"])
        if body.decision == "reject":
            conn.execute(
                """
                UPDATE operation_tasks SET status = 'rejected', approved_by = ?,
                    approved_at = ?, completed_at = ? WHERE id = ?
                """,
                (body.actor, utcnow(), utcnow(), operation_id),
            )
            next_status = "rejected"
        else:
            conn.execute(
                """
                UPDATE operation_tasks SET status = 'queued', approved_by = ?,
                    approved_at = ? WHERE id = ?
                """,
                (body.actor, utcnow(), operation_id),
            )
            next_status = "queued"
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=task["resource_id"],
            task_id_value=operation_id,
            actor_type="human",
            actor=body.actor,
            action="operation.approval",
            status=next_status,
            detail={"decision": body.decision},
        )
        updated = conn.execute("SELECT * FROM operation_tasks WHERE id = ?", (operation_id,)).fetchone()
        result = public_task(updated)
        resource_snapshot = dict(resource)
    _submit_if_executable(resource_snapshot, operation_id, next_status)
    return {"task": result}


@router.post("/projects/{project_id}/operations/tasks/{operation_id}/cancel")
def cancel_operation(project_id: str, operation_id: str, body: CancelRequest):
    with get_conn() as conn:
        task = _task_or_404(conn, project_id, operation_id)
        if task["status"] in {"succeeded", "failed", "cancelled", "rejected"}:
            return {"task": public_task(task)}
        conn.execute(
            """
            UPDATE operation_tasks SET status = 'cancelled', cancel_requested = 1,
                output_summary = ?, completed_at = ? WHERE id = ?
            """,
            (body.reason, utcnow(), operation_id),
        )
        audit_event(
            conn,
            project_id=project_id,
            resource_id_value=task["resource_id"],
            task_id_value=operation_id,
            actor_type="human",
            actor=body.actor,
            action="operation.cancel",
            status="cancelled",
            detail={"reason": body.reason},
        )
        updated = conn.execute("SELECT * FROM operation_tasks WHERE id = ?", (operation_id,)).fetchone()
        return {"task": public_task(updated)}


@router.get("/projects/{project_id}/operations/results/{result_id}")
def get_operation_result(project_id: str, result_id: str):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        row = conn.execute(
            "SELECT * FROM operation_results WHERE id = ? AND project_id = ?",
            (result_id, project_id),
        ).fetchone()
        if row is None:
            raise HTTPException(404, "Operation result not found")
        return Response(
            content=row["content"],
            media_type=row["content_type"],
            headers={
                "X-RedTrace-SHA256": row["sha256"],
                "X-RedTrace-Task": row["task_id"],
            },
        )


@router.get("/projects/{project_id}/operations/audit")
def list_operation_audit(
    project_id: str,
    resource_id: str | None = None,
    since: int = Query(default=0, ge=0),
    limit: int = Query(default=200, ge=1, le=500),
):
    with get_conn() as conn:
        get_project_or_404(conn, project_id)
        clauses = ["project_id = ?", "id > ?"]
        params: list[Any] = [project_id, since]
        if resource_id:
            clauses.append("resource_id = ?")
            params.append(resource_id)
        params.append(limit)
        rows = conn.execute(
            f"SELECT * FROM resource_audit_events WHERE {' AND '.join(clauses)} ORDER BY id DESC LIMIT ?",
            params,
        ).fetchall()
        return {"project_id": project_id, "events": [public_audit(row) for row in rows]}


def _listener_for_token(conn, listener_id: str, token: str):
    row = conn.execute(
        "SELECT * FROM shared_resources WHERE id = ? AND kind = 'c2_listener'",
        (listener_id,),
    ).fetchone()
    if row is None or row["status"] != "available":
        raise HTTPException(404, "Listener not found")
    secret = json_load(row["secret_json"], {})
    if not verify_token(token, str(secret.get("listener_token_sha256", ""))):
        raise HTTPException(404, "Listener not found")
    return row


def _session_for_token(conn, session_id: str, token: str):
    row = conn.execute(
        "SELECT * FROM shared_resources WHERE id = ? AND kind = 'c2_session'",
        (session_id,),
    ).fetchone()
    if row is None:
        raise HTTPException(404, "Session not found")
    secret = json_load(row["secret_json"], {})
    if not verify_token(token, str(secret.get("session_token_sha256", ""))):
        raise HTTPException(404, "Session not found")
    return row


@router.post("/c2/checkin/{listener_id}")
def c2_checkin(
    listener_id: str,
    body: C2Checkin,
    listener_token: str = Header(default="", alias="X-RedTrace-Listener-Token"),
):
    with get_conn() as conn:
        listener = _listener_for_token(conn, listener_id, listener_token)
        metadata = {
            "external_id": body.external_id,
            "hostname": body.hostname,
            "username": body.username,
            "os": body.os,
            "arch": body.arch,
            "process": body.process,
            "pid": body.pid,
            "capabilities": body.capabilities,
        }
        row = conn.execute(
            """
            SELECT * FROM shared_resources
            WHERE project_id = ? AND kind = 'c2_session'
              AND parent_resource_id = ? AND target = ?
            """,
            (listener["project_id"], listener_id, body.external_id),
        ).fetchone()
        session_token = __import__("secrets").token_urlsafe(32)
        session_secret = {"session_token_sha256": __import__("hashlib").sha256(session_token.encode()).hexdigest()}
        now = utcnow()
        if row is None:
            session_name = f"{body.username + '@' if body.username else ''}{body.hostname or body.external_id}"
            session, _ = create_resource(
                conn,
                project_id=listener["project_id"],
                kind="c2_session",
                name=session_name,
                target=body.external_id,
                summary=f"{body.os} {body.arch}".strip(),
                status="available",
                metadata=metadata,
                secret=session_secret,
                actor_type="system",
                actor=f"listener:{listener_id}",
                parent_resource_id=listener_id,
                publish_fact=True,
            )
            session_id = session["id"]
            action = "c2.session_online"
        else:
            session_id = row["id"]
            conn.execute(
                """
                UPDATE shared_resources SET status = 'available', metadata_json = ?,
                    secret_json = ?, updated_at = ?, last_seen_at = ? WHERE id = ?
                """,
                (json_dump(metadata), json_dump(session_secret), now, now, session_id),
            )
            action = "c2.session_checkin"
        conn.execute(
            "UPDATE shared_resources SET last_seen_at = ?, updated_at = ? WHERE id = ?",
            (now, now, listener_id),
        )
        audit_event(
            conn,
            project_id=listener["project_id"],
            resource_id_value=session_id,
            task_id_value=None,
            actor_type="system",
            actor=f"listener:{listener_id}",
            action=action,
            status="succeeded",
            detail={"hostname": body.hostname, "os": body.os, "arch": body.arch},
        )
        return {
            "project_id": listener["project_id"],
            "session_id": session_id,
            "session_token": session_token,
            "poll_path": f"/c2/sessions/{session_id}/poll",
        }


@router.post("/c2/sessions/{session_id}/poll")
def c2_poll(
    session_id: str,
    session_token: str = Header(default="", alias="X-RedTrace-Session-Token"),
    limit: int = Query(default=10, ge=1, le=20),
):
    with get_conn() as conn:
        session = _session_for_token(conn, session_id, session_token)
        now = utcnow()
        conn.execute(
            "UPDATE shared_resources SET status = 'available', updated_at = ?, last_seen_at = ? WHERE id = ?",
            (now, now, session_id),
        )
        tasks = conn.execute(
            """
            SELECT * FROM operation_tasks
            WHERE resource_id = ? AND status = 'queued' AND cancel_requested = 0
            ORDER BY created_at LIMIT ?
            """,
            (session_id, limit),
        ).fetchall()
        payload = []
        for task in tasks:
            conn.execute(
                "UPDATE operation_tasks SET status = 'running', started_at = ? WHERE id = ?",
                (now, task["id"]),
            )
            audit_event(
                conn,
                project_id=session["project_id"],
                resource_id_value=session_id,
                task_id_value=task["id"],
                actor_type="system",
                actor=session_id,
                action="operation.dispatch",
                status="running",
            )
            payload.append(
                {
                    "id": task["id"],
                    "action": task["action"],
                    "arguments": json_load(task["input_json"], {}),
                    "created_at": task["created_at"],
                }
            )
        return {"session_id": session_id, "tasks": payload}


@router.post("/c2/sessions/{session_id}/results/{operation_id}")
def c2_result(
    session_id: str,
    operation_id: str,
    body: C2TaskResult,
    session_token: str = Header(default="", alias="X-RedTrace-Session-Token"),
):
    with get_conn() as conn:
        session = _session_for_token(conn, session_id, session_token)
        task = conn.execute(
            "SELECT * FROM operation_tasks WHERE id = ? AND resource_id = ?",
            (operation_id, session_id),
        ).fetchone()
        if task is None:
            raise HTTPException(404, "Task not found")
        if task["status"] in {"cancelled", "rejected"}:
            return {"task": public_task(task)}
        content = body.output
        summary = body.summary.strip() or output_summary(content) or (
            "任务已完成" if body.success else "任务执行失败"
        )
        out_id, ref = store_result(conn, task["project_id"], operation_id, content)
        next_status = "succeeded" if body.success else "failed"
        conn.execute(
            """
            UPDATE operation_tasks
            SET status = ?, output_summary = ?, result_ref = ?, completed_at = ?
            WHERE id = ?
            """,
            (next_status, summary, ref, utcnow(), operation_id),
        )
        arguments = json_load(task["input_json"], {})
        if body.success and bool(arguments.get("publish_result")):
            result_resource, _ = create_resource(
                conn,
                project_id=task["project_id"],
                kind="result",
                name=f"{session['name']} · {task['action']}",
                target=ref,
                summary=summary,
                metadata={"result_id": out_id, "task_id": operation_id},
                actor_type=task["actor_type"],
                actor=task["actor"],
                worker=task["actor"] if task["actor_type"] == "worker" else None,
                intent_id=task["intent_id"],
                source_task_id=operation_id,
                publish_fact=True,
            )
            conn.execute(
                "UPDATE operation_tasks SET fact_id = ? WHERE id = ?",
                (result_resource.get("fact_id"), operation_id),
            )
        audit_event(
            conn,
            project_id=task["project_id"],
            resource_id_value=session_id,
            task_id_value=operation_id,
            actor_type="system",
            actor=session_id,
            action=f"operation.{task['action']}",
            status=next_status,
            detail={"result_ref": ref, "summary": summary},
        )
        updated = conn.execute("SELECT * FROM operation_tasks WHERE id = ?", (operation_id,)).fetchone()
        return {"task": public_task(updated)}
