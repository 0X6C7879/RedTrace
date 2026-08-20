from __future__ import annotations

import logging
import os
import hashlib
import secrets
import shutil
import time
from pathlib import Path

from redtrace.audit import AUDIT_ROOT
from redtrace.board.storage import utcnow
from redtrace.capabilities import resolve_capabilities_root
from redtrace.dispatcher.config import DispatchConfig
from redtrace.paths import contained_path, resolve_portable_path, safe_project_key
from redtrace.server import db
from redtrace.server.operations import operation_executor

LOG = logging.getLogger(__name__)
DURABLE_RESOURCE_KINDS = {
    "webshell",
    "c2_listener",
    "c2_session",
    "c2_payload",
    "c2_profile",
    "credential_ref",
}
DELETE_CONFIRMATION_TTL_SECONDS = 60


def issue_deletion_confirmation(project_id: str, actor: str = "human-ui") -> str:
    safe_project_key(project_id)
    token = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(token.encode()).hexdigest()
    now = utcnow()
    with db.get_conn(immediate=True) as conn:
        if conn.execute(
            "SELECT 1 FROM projects WHERE id = ?", (project_id,)
        ).fetchone() is None:
            return ""
        conn.execute(
            "DELETE FROM project_delete_authorizations WHERE expires_at < ? OR used_at IS NOT NULL",
            (time.time(),),
        )
        conn.execute(
            """
            INSERT INTO project_delete_authorizations (
                token_hash, project_id, actor, expires_at, created_at
            ) VALUES (?, ?, ?, ?, ?)
            """,
            (token_hash, project_id, actor, time.time() + DELETE_CONFIRMATION_TTL_SECONDS, now),
        )
    return token


def request_deletion(
    project_id: str,
    *,
    confirmation_token: str,
    actor: str = "human-ui",
    source: str = "web-ui",
) -> str:
    safe_project_key(project_id)
    now = utcnow()
    token_hash = hashlib.sha256(confirmation_token.encode()).hexdigest()
    with db.get_conn(immediate=True) as conn:
        project = conn.execute(
            "SELECT status FROM projects WHERE id = ?",
            (project_id,),
        ).fetchone()
        existing = conn.execute(
            "SELECT state FROM project_deletions WHERE project_id = ?",
            (project_id,),
        ).fetchone()
        if project is None:
            if existing is not None:
                conn.execute(
                    "DELETE FROM project_deletions WHERE project_id = ?",
                    (project_id,),
                )
            return "missing"
        authorization = conn.execute(
            """
            SELECT actor FROM project_delete_authorizations
            WHERE token_hash = ? AND project_id = ? AND used_at IS NULL AND expires_at >= ?
            """,
            (token_hash, project_id, time.time()),
        ).fetchone()
        if authorization is None or authorization["actor"] != actor:
            return "unauthorized"
        conn.execute(
            "UPDATE project_delete_authorizations SET used_at = ? WHERE token_hash = ?",
            (now, token_hash),
        )
        conn.execute(
            """
            INSERT INTO project_deletions (
                project_id, state, attempts, requested_at, updated_at, last_error,
                actor, source
            ) VALUES (?, 'pending', 1, ?, ?, NULL, ?, ?)
            ON CONFLICT(project_id) DO UPDATE SET
                state = 'pending',
                attempts = project_deletions.attempts + 1,
                updated_at = excluded.updated_at,
                last_error = NULL,
                actor = excluded.actor,
                source = excluded.source
            """,
            (project_id, now, now, actor, source),
        )
        conn.execute(
            """
            INSERT INTO project_lifecycle_events (
                project_id, action, actor, source, created_at
            ) VALUES (?, 'delete.requested', ?, ?, ?)
            """,
            (project_id, actor, source, now),
        )
        conn.execute(
            """
            UPDATE projects
            SET status = 'deleting',
                reason_worker = NULL,
                reason_trigger = NULL,
                reason_started_at = NULL,
                reason_last_heartbeat_at = NULL
            WHERE id = ?
            """,
            (project_id,),
        )
        conn.execute(
            "UPDATE intents SET worker = NULL, last_heartbeat_at = NULL WHERE project_id = ?",
            (project_id,),
        )
    operation_executor.cancel_project(project_id)
    return "pending"


def deletion_status(project_id: str) -> dict[str, object] | None:
    safe_project_key(project_id)
    with db.get_conn() as conn:
        row = conn.execute(
            "SELECT * FROM project_deletions WHERE project_id = ?",
            (project_id,),
        ).fetchone()
    return dict(row) if row is not None else None


def report_runtime_cleanup(
    project_id: str,
    *,
    success: bool,
    error: str = "",
) -> bool:
    safe_project_key(project_id)
    if not success:
        _mark_failed(project_id, error or "runtime cleanup failed")
        return False
    try:
        if operation_executor.has_project_tasks(project_id):
            raise RuntimeError("project operations are still stopping")

        _cleanup_project_files(project_id)
        with db.get_conn() as conn:
            placeholders = ",".join("?" for _ in DURABLE_RESOURCE_KINDS)
            durable = tuple(sorted(DURABLE_RESOURCE_KINDS))
            conn.execute(
                f"""
                DELETE FROM resource_audit_events
                WHERE project_id = ?
                  AND (resource_id IS NULL OR resource_id NOT IN (
                      SELECT id FROM shared_resources
                      WHERE project_id = ? AND kind IN ({placeholders})
                  ))
                """,
                (project_id, project_id, *durable),
            )
            conn.execute(
                f"""
                DELETE FROM shared_resources
                WHERE project_id = ? AND kind NOT IN ({placeholders})
                """,
                (project_id, *durable),
            )
            # project_lifecycle_events has no FK to projects — clean explicitly
            conn.execute(
                "DELETE FROM project_lifecycle_events WHERE project_id = ?",
                (project_id,),
            )
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            conn.execute(
                "DELETE FROM project_deletions WHERE project_id = ?",
                (project_id,),
            )
        try:
            db.compact()
        except Exception:
            LOG.warning("database compaction failed after project deletion", exc_info=True)
        return True
    except Exception as exc:
        LOG.warning("project deletion cleanup failed project=%s", project_id, exc_info=True)
        _mark_failed(project_id, str(exc))
        return False


def _mark_failed(project_id: str, error: str) -> None:
    with db.get_conn() as conn:
        conn.execute(
            """
            UPDATE project_deletions
            SET state = 'failed', updated_at = ?, last_error = ?
            WHERE project_id = ?
            """,
            (utcnow(), error[:1000] or "project cleanup failed", project_id),
        )


def _cleanup_project_files(project_id: str) -> None:
    project_id = safe_project_key(project_id)
    config_path = os.environ.get("REDTRACE_DISPATCH_CONFIG")
    if config_path and Path(config_path).is_file():
        layout = DispatchConfig.load(Path(config_path)).paths.layout()
        managed = layout.managed
        workspaces = layout.workspaces
        audit = layout.audit
    else:
        root = resolve_capabilities_root()
        managed = resolve_portable_path(
            os.environ.get("REDTRACE_MANAGED_DIR", ".redtrace"),
            base=root,
        )
        workspaces = resolve_portable_path(
            os.environ.get("REDTRACE_WORKSPACE_ROOT", "workspaces"),
            base=root,
        )
        audit = resolve_portable_path(
            os.environ.get("REDTRACE_AUDIT_ROOT", str(AUDIT_ROOT)),
            base=root,
        )
    targets = {
        contained_path(managed, "projects", project_id),
        contained_path(managed, "log", "projects", project_id),
        contained_path(managed, "sessions", project_id),
        contained_path(workspaces, project_id),
        contained_path(workspaces, project_id, "workspace"),
        contained_path(workspaces, project_id, "cache"),
        contained_path(workspaces, project_id, "runtime"),
        contained_path(audit, project_id),
        contained_path(AUDIT_ROOT, project_id),
    }
    for target in targets:
        if target.exists():
            shutil.rmtree(target)
