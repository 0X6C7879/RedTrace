from __future__ import annotations

import logging
import os
import shutil
from pathlib import Path

from redtrace.audit import AUDIT_ROOT
from redtrace.capabilities import resolve_capabilities_root
from redtrace.dispatcher.config import DispatchConfig
from redtrace.paths import contained_path, resolve_portable_path, safe_project_key
from redtrace.server import db
from redtrace.server.operations import operation_executor
from redtrace.server.services import utcnow

LOG = logging.getLogger(__name__)


def request_deletion(project_id: str) -> str:
    safe_project_key(project_id)
    now = utcnow()
    with db.get_conn() as conn:
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
        conn.execute(
            """
            INSERT INTO project_deletions (
                project_id, state, attempts, requested_at, updated_at, last_error
            ) VALUES (?, 'pending', 1, ?, ?, NULL)
            ON CONFLICT(project_id) DO UPDATE SET
                state = 'pending',
                attempts = project_deletions.attempts + 1,
                updated_at = excluded.updated_at,
                last_error = NULL
            """,
            (project_id, now, now),
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

        with db.get_conn() as conn:
            sessions = [
                (str(row["worker"]), str(row["session_id"]))
                for row in conn.execute(
                    """
                    SELECT worker, session_id
                    FROM audit_runs
                    WHERE project_id = ? AND session_id IS NOT NULL
                    """,
                    (project_id,),
                ).fetchall()
            ]
        _cleanup_project_files(project_id, sessions)
        with db.get_conn() as conn:
            conn.execute("DELETE FROM projects WHERE id = ?", (project_id,))
            conn.execute(
                "DELETE FROM project_deletions WHERE project_id = ?",
                (project_id,),
            )
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


def _cleanup_project_files(
    project_id: str,
    sessions: list[tuple[str, str]],
) -> None:
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
        contained_path(workspaces, project_id),
        contained_path(audit, project_id),
        contained_path(AUDIT_ROOT, project_id),
    }
    for target in targets:
        if target.exists():
            shutil.rmtree(target)

    workers = managed / "workers"
    if not workers.is_dir():
        return
    for worker_name, session_id in sessions:
        safe_project_key(worker_name)
        safe_project_key(session_id)
        for worker_root in workers.glob(f"*/{worker_name}"):
            try:
                worker_root.resolve().relative_to(workers.resolve())
            except ValueError:
                continue
            for candidate in worker_root.rglob(f"*{session_id}*"):
                if candidate.is_symlink() or candidate.is_dir():
                    continue
                candidate.resolve().relative_to(worker_root.resolve())
                candidate.unlink(missing_ok=True)
