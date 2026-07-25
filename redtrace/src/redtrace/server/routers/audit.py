from __future__ import annotations

import io
import json
import queue
import tarfile
from pathlib import Path, PurePosixPath
from typing import Any

import docker
from docker.errors import DockerException, NotFound
from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from redtrace.audit import archived_workspace
from redtrace.server import db
from redtrace.server.event_hub import event_hub
from redtrace.server.services import get_project_or_404


router = APIRouter(prefix="/audit", tags=["audit"])
MAX_FILE_BYTES = 256 * 1024


class AuditBatch(BaseModel):
    run: dict[str, Any]
    events: list[dict[str, Any]] = Field(max_length=128)


@router.post("/events")
def append_events(body: AuditBatch) -> dict[str, int]:
    run = body.run
    required = {
        "id",
        "project_id",
        "task_type",
        "phase",
        "worker",
        "provider",
        "workspace_kind",
        "workspace_ref",
        "workspace_root",
        "status",
        "started_at",
    }
    if not required.issubset(run):
        raise HTTPException(422, "Incomplete audit run metadata")
    project_id = str(run["project_id"])
    live_events: list[dict[str, Any]] = []
    with db.get_conn() as conn:
        get_project_or_404(conn, project_id)
        conn.execute(
            """
            INSERT INTO audit_runs (
                id, project_id, intent_id, task_type, phase, worker, provider,
                session_id, workspace_kind, workspace_ref, workspace_root,
                status, started_at, ended_at, exit_code, timed_out, cancelled
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                session_id = COALESCE(excluded.session_id, audit_runs.session_id),
                status = excluded.status,
                ended_at = excluded.ended_at,
                exit_code = excluded.exit_code,
                timed_out = excluded.timed_out,
                cancelled = excluded.cancelled
            """,
            (
                run["id"],
                project_id,
                run.get("intent_id"),
                run["task_type"],
                run["phase"],
                run["worker"],
                run["provider"],
                run.get("session_id"),
                run["workspace_kind"],
                run["workspace_ref"],
                run["workspace_root"],
                run["status"],
                run["started_at"],
                run.get("ended_at"),
                run.get("exit_code"),
                int(bool(run.get("timed_out"))),
                int(bool(run.get("cancelled"))),
            ),
        )
        persistent = []
        for event in body.events:
            event["project_id"] = project_id
            event["run_id"] = run["id"]
            if event.get("kind") == "session.started" and event.get("session_id"):
                conn.execute(
                    "UPDATE audit_runs SET session_id = ? WHERE id = ?",
                    (event["session_id"], run["id"]),
                )
            if event.get("kind") != "assistant.delta":
                persistent.append(
                    (
                        event.get("event_uid"),
                        project_id,
                        run["id"],
                        int(event.get("run_sequence", 0)),
                        event.get("timestamp", run["started_at"]),
                        event.get("kind", "event"),
                        event.get("role"),
                        event.get("title"),
                        event.get("content"),
                        json.dumps(event, ensure_ascii=False, separators=(",", ":")),
                        int(bool(event.get("redacted"))),
                    )
                )
            if not event.get("persist_only"):
                live_events.append(event)
        if persistent:
            conn.executemany(
                """
                INSERT OR IGNORE INTO audit_events (
                    event_uid, project_id, run_id, run_sequence, timestamp,
                    kind, role, title, content, payload, is_redacted
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                persistent,
            )
    for event in live_events:
        event_hub.publish(project_id, event)
    return {"accepted": len(body.events)}


@router.get("/tasks")
def list_tasks() -> list[dict[str, Any]]:
    with db.get_conn() as conn:
        rows = conn.execute(
            """
            SELECT p.id, p.title, p.status, p.created_at,
                   COUNT(r.id) AS run_count,
                   MAX(r.started_at) AS last_run_at,
                   SUM(CASE WHEN r.status = 'running' THEN 1 ELSE 0 END) AS running_count
            FROM projects p
            LEFT JOIN audit_runs r ON r.project_id = p.id
            GROUP BY p.id
            ORDER BY COALESCE(MAX(r.started_at), p.created_at) DESC
            """
        ).fetchall()
        return [dict(row) for row in rows]


@router.get("/tasks/{project_id}/runs")
def list_runs(project_id: str) -> list[dict[str, Any]]:
    with db.get_conn() as conn:
        get_project_or_404(conn, project_id)
        rows = conn.execute(
            "SELECT * FROM audit_runs WHERE project_id = ? ORDER BY started_at DESC",
            (project_id,),
        ).fetchall()
        return [dict(row) for row in rows]


@router.get("/tasks/{project_id}/events")
def list_events(
    project_id: str,
    limit: int = Query(200, ge=1, le=500),
    before_id: int | None = None,
) -> list[dict[str, Any]]:
    with db.get_conn() as conn:
        get_project_or_404(conn, project_id)
        params: list[Any] = [project_id]
        before = ""
        if before_id is not None:
            before = "AND id < ?"
            params.append(before_id)
        params.append(limit)
        rows = conn.execute(
            f"""
            SELECT * FROM (
                SELECT id, payload FROM audit_events
                WHERE project_id = ? {before}
                ORDER BY id DESC
                LIMIT ?
            )
            ORDER BY id ASC
            """,
            params,
        ).fetchall()
        events = []
        for row in rows:
            payload = json.loads(row["payload"])
            payload["id"] = row["id"]
            events.append(payload)
        return events


@router.get("/tasks/{project_id}/stream")
def stream_events(project_id: str) -> StreamingResponse:
    with db.get_conn() as conn:
        get_project_or_404(conn, project_id)
    subscriber = event_hub.subscribe(project_id)

    def generate():
        try:
            yield ": connected\n\n"
            while True:
                try:
                    event = subscriber.get(timeout=15)
                except queue.Empty:
                    yield ": ping\n\n"
                    continue
                yield f"event: audit\ndata: {json.dumps(event, ensure_ascii=False, separators=(',', ':'))}\n\n"
        finally:
            event_hub.unsubscribe(project_id, subscriber)

    return StreamingResponse(
        generate(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.get("/tasks/{project_id}/workspace")
def workspace_entries(project_id: str, path: str = "") -> dict[str, Any]:
    source = _workspace_source(project_id)
    if source["kind"] in {"local", "archive"}:
        root = Path(source["root"])
        target = _resolve_local(root, path)
        if not target.is_dir():
            raise HTTPException(404, "Directory not found")
        entries = [_local_entry(root, child) for child in target.iterdir() if not child.is_symlink()]
    else:
        entries = _container_entries(source["ref"], source["root"], path)
    entries.sort(key=lambda item: (item["type"] != "directory", item["name"].lower()))
    return {"path": path, "source": source["kind"], "entries": entries[:500]}


@router.get("/tasks/{project_id}/workspace/file")
def workspace_file(project_id: str, path: str) -> dict[str, Any]:
    source = _workspace_source(project_id)
    if source["kind"] in {"local", "archive"}:
        target = _resolve_local(Path(source["root"]), path)
        if not target.is_file():
            raise HTTPException(404, "File not found")
        if target.stat().st_size > MAX_FILE_BYTES:
            raise HTTPException(413, "File is too large to preview")
        content = target.read_bytes()
        modified_at = target.stat().st_mtime
    else:
        content, modified_at = _container_file(source["ref"], source["root"], path)
    binary = b"\0" in content
    return {
        "path": path,
        "size": len(content),
        "modified_at": modified_at,
        "binary": binary,
        "content": "" if binary else content.decode("utf-8", errors="replace"),
    }


def _workspace_source(project_id: str) -> dict[str, str]:
    with db.get_conn() as conn:
        get_project_or_404(conn, project_id)
        row = conn.execute(
            """
            SELECT workspace_kind, workspace_ref, workspace_root
            FROM audit_runs WHERE project_id = ?
            ORDER BY started_at DESC LIMIT 1
            """,
            (project_id,),
        ).fetchone()
    archive = archived_workspace(project_id)
    if row is None:
        if archive.exists():
            return {"kind": "archive", "root": str(archive), "ref": str(archive)}
        raise HTTPException(404, "No workspace has been recorded for this task")
    if row["workspace_kind"] == "local" and Path(row["workspace_root"]).exists():
        return {"kind": "local", "root": row["workspace_root"], "ref": row["workspace_ref"]}
    if row["workspace_kind"] == "container" and _container_exists(row["workspace_ref"]):
        return {"kind": "container", "root": row["workspace_root"], "ref": row["workspace_ref"]}
    if archive.exists():
        return {"kind": "archive", "root": str(archive), "ref": str(archive)}
    raise HTTPException(404, "Workspace is no longer available")


def _resolve_local(root: Path, relative: str) -> Path:
    root = root.resolve()
    target = (root / relative).resolve()
    if target != root and root not in target.parents:
        raise HTTPException(403, "Path escapes workspace")
    return target


def _local_entry(root: Path, path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "name": path.name,
        "path": path.relative_to(root).as_posix(),
        "type": "directory" if path.is_dir() else "file",
        "size": stat.st_size,
        "modified_at": stat.st_mtime,
    }


def _container_exists(name: str) -> bool:
    client = None
    try:
        client = docker.from_env()
        client.containers.get(name)
        return True
    except (NotFound, DockerException):
        return False
    finally:
        if client is not None:
            client.close()


def _container_path(root: str, relative: str) -> str:
    parts = PurePosixPath(relative).parts
    if PurePosixPath(relative).is_absolute() or any(part in {"", ".", ".."} for part in parts):
        raise HTTPException(403, "Invalid workspace path")
    return str(PurePosixPath(root).joinpath(*parts))


def _container_entries(name: str, root: str, relative: str) -> list[dict[str, Any]]:
    target = _container_path(root, relative)
    client = None
    try:
        client = docker.from_env()
        container = client.containers.get(name)
        result = container.exec_run(
            ["find", target, "-mindepth", "1", "-maxdepth", "1", "-printf", "%f\t%y\t%s\t%T@\n"],
            demux=True,
        )
        if result.exit_code != 0:
            raise HTTPException(404, "Directory not found")
        stdout = (result.output[0] if isinstance(result.output, tuple) else result.output) or b""
        entries = []
        for line in stdout.decode("utf-8", errors="replace").splitlines():
            name_part, type_part, size_part, modified_part = line.split("\t", 3)
            child = str(PurePosixPath(relative) / name_part) if relative else name_part
            entries.append(
                {
                    "name": name_part,
                    "path": child,
                    "type": "directory" if type_part == "d" else "file",
                    "size": int(size_part),
                    "modified_at": float(modified_part),
                }
            )
        return entries
    except (NotFound, DockerException) as exc:
        raise HTTPException(404, "Workspace container is unavailable") from exc
    finally:
        if client is not None:
            client.close()


def _container_file(name: str, root: str, relative: str) -> tuple[bytes, float | None]:
    target = _container_path(root, relative)
    client = None
    try:
        client = docker.from_env()
        container = client.containers.get(name)
        stream, stat = container.get_archive(target)
        payload = b"".join(stream)
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:*") as archive:
            member = next((item for item in archive if item.isfile()), None)
            if member is None or member.size > MAX_FILE_BYTES:
                raise HTTPException(413, "File is too large to preview")
            handle = archive.extractfile(member)
            if handle is None:
                raise HTTPException(404, "File not found")
            return handle.read(MAX_FILE_BYTES + 1), stat.get("mtime")
    except NotFound as exc:
        raise HTTPException(404, "File not found") from exc
    except DockerException as exc:
        raise HTTPException(404, "Workspace container is unavailable") from exc
    finally:
        if client is not None:
            client.close()
