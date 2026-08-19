from __future__ import annotations

import hashlib
import json
import os
import shutil
import sqlite3
import tempfile
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

from redtrace.paths import redtrace_root

DEFAULT_DB = redtrace_root() / ".redtrace" / "redtrace.db"
LEGACY_ROOT = Path.home() / ".local" / "share" / "redtrace"

_db_path: Path | None = None
_change_condition = threading.Condition()
_change_generation = 0
_blackboard_condition = threading.Condition()
_blackboard_generation = 0
_last_blackboard_revision = 0


def current_change_generation() -> int:
    with _change_condition:
        return _change_generation


def wait_for_change(after: int | None, timeout: float) -> int:
    deadline = time.monotonic() + max(0.0, timeout)
    with _change_condition:
        if after is None or after != _change_generation:
            return _change_generation
        while after == _change_generation:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            _change_condition.wait(remaining)
        return _change_generation


def _publish_change() -> None:
    global _change_generation
    with _change_condition:
        _change_generation += 1
        _change_condition.notify_all()


def current_blackboard_generation() -> int:
    with _blackboard_condition:
        return _blackboard_generation


def wait_for_blackboard_change(after: int, timeout: float) -> int:
    deadline = time.monotonic() + max(0.0, timeout)
    with _blackboard_condition:
        while after == _blackboard_generation:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                break
            _blackboard_condition.wait(remaining)
        return _blackboard_generation


def _publish_blackboard_revision(revision: int) -> None:
    global _blackboard_generation, _last_blackboard_revision
    with _blackboard_condition:
        if revision <= _last_blackboard_revision:
            return
        _last_blackboard_revision = revision
        _blackboard_generation += 1
        _blackboard_condition.notify_all()


SCHEMA = """\
CREATE TABLE IF NOT EXISTS settings (
    intent_timeout INTEGER NOT NULL DEFAULT 15,
    reason_timeout INTEGER NOT NULL DEFAULT 15
);

INSERT OR IGNORE INTO settings (rowid, intent_timeout, reason_timeout) VALUES (1, 15, 15);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    bootstrap_enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    reason_worker TEXT,
    reason_trigger TEXT,
    reason_started_at TEXT,
    reason_last_heartbeat_at TEXT,
    reason_failure_count INTEGER NOT NULL DEFAULT 0,
    reason_failure_signature TEXT,
    reason_retry_after REAL,
    reason_circuit_open INTEGER NOT NULL DEFAULT 0,
    planning_revision INTEGER NOT NULL DEFAULT 0,
    reason_evaluated_revision INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS facts (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    description TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS intents (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    to_fact_id TEXT,
    description TEXT NOT NULL,
    creator TEXT NOT NULL,
    worker TEXT,
    last_heartbeat_at TEXT,
    created_at TEXT NOT NULL,
    concluded_at TEXT,
    failure_count INTEGER NOT NULL DEFAULT 0,
    failure_signature TEXT,
    retry_after REAL,
    circuit_open INTEGER NOT NULL DEFAULT 0,
    priority INTEGER NOT NULL DEFAULT 50,
    state TEXT NOT NULL DEFAULT 'open',
    goal_id TEXT,
    superseded_by TEXT,
    invalidated_by TEXT NOT NULL DEFAULT '[]',
    drop_reason TEXT,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    cumulative_runtime_ms INTEGER NOT NULL DEFAULT 0,
    fact_yield INTEGER NOT NULL DEFAULT 0,
    last_progress_at TEXT,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS intent_sources (
    intent_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    fact_id TEXT NOT NULL,
    PRIMARY KEY (intent_id, project_id, fact_id),
    FOREIGN KEY (intent_id, project_id) REFERENCES intents(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS hints (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    creator TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id)
);

CREATE TABLE IF NOT EXISTS observations (
    id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (id, project_id),
    FOREIGN KEY (intent_id, project_id) REFERENCES intents(id, project_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS intent_execution_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT NOT NULL,
    worker TEXT NOT NULL,
    outcome TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    runtime_ms INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (intent_id, project_id) REFERENCES intents(id, project_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_intent_execution_events_project
ON intent_execution_events(project_id, id);

CREATE TABLE IF NOT EXISTS counters (
    name TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO counters (name, value) VALUES ('project', 0);

CREATE TABLE IF NOT EXISTS scoped_counters (
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    value INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (project_id, kind)
);

CREATE TABLE IF NOT EXISTS blackboard_events (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    node_id TEXT NOT NULL,
    action TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blackboard_events_project
ON blackboard_events(project_id, revision);

CREATE TABLE IF NOT EXISTS blackboard_query_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    request_id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    worker TEXT NOT NULL,
    task_type TEXT NOT NULL,
    intent_id TEXT,
    command TEXT NOT NULL,
    arguments TEXT NOT NULL,
    revision INTEGER NOT NULL,
    result_count INTEGER NOT NULL,
    output_sha256 TEXT NOT NULL,
    output_bytes INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_blackboard_query_audit_project
ON blackboard_query_audit(project_id, id);

CREATE TRIGGER IF NOT EXISTS trg_blackboard_fact_added
AFTER INSERT ON facts
BEGIN
    INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
    VALUES (
        NEW.project_id,
        'fact',
        NEW.id,
        'added',
        COALESCE((SELECT created_at FROM projects WHERE id = NEW.project_id), strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_blackboard_intent_added
AFTER INSERT ON intents
BEGIN
    INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
    VALUES (NEW.project_id, 'intent', NEW.id, 'added', NEW.created_at);
END;

DROP TRIGGER IF EXISTS trg_blackboard_intent_state_changed;
CREATE TRIGGER trg_blackboard_intent_state_changed
AFTER UPDATE OF worker, to_fact_id, concluded_at, priority, state,
    goal_id, superseded_by, invalidated_by, drop_reason, attempt_count,
    cumulative_runtime_ms, fact_yield, last_progress_at ON intents
WHEN OLD.worker IS NOT NEW.worker
  OR OLD.to_fact_id IS NOT NEW.to_fact_id
  OR OLD.concluded_at IS NOT NEW.concluded_at
  OR OLD.priority IS NOT NEW.priority
  OR OLD.state IS NOT NEW.state
  OR OLD.goal_id IS NOT NEW.goal_id
  OR OLD.superseded_by IS NOT NEW.superseded_by
  OR OLD.invalidated_by IS NOT NEW.invalidated_by
  OR OLD.drop_reason IS NOT NEW.drop_reason
  OR OLD.attempt_count IS NOT NEW.attempt_count
  OR OLD.cumulative_runtime_ms IS NOT NEW.cumulative_runtime_ms
  OR OLD.fact_yield IS NOT NEW.fact_yield
  OR OLD.last_progress_at IS NOT NEW.last_progress_at
BEGIN
    INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
    VALUES (
        NEW.project_id,
        'intent',
        NEW.id,
        CASE
            WHEN NEW.concluded_at IS NOT NULL AND OLD.concluded_at IS NULL THEN 'concluded'
            WHEN NEW.worker IS NOT NULL AND OLD.worker IS NULL THEN 'claimed'
            WHEN NEW.worker IS NULL AND OLD.worker IS NOT NULL THEN 'released'
            ELSE 'updated'
        END,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    );
END;

CREATE TRIGGER IF NOT EXISTS trg_blackboard_hint_added
AFTER INSERT ON hints
BEGIN
    INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
    VALUES (NEW.project_id, 'hint', NEW.id, 'added', NEW.created_at);
END;

CREATE TABLE IF NOT EXISTS audit_runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT,
    task_type TEXT NOT NULL,
    phase TEXT NOT NULL,
    worker TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT,
    workspace_kind TEXT NOT NULL,
    workspace_ref TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    exit_code INTEGER,
    timed_out INTEGER NOT NULL DEFAULT 0,
    cancelled INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_runs_project
ON audit_runs(project_id, started_at);

CREATE TABLE IF NOT EXISTS session_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    intent_id TEXT,
    worker TEXT NOT NULL,
    provider TEXT NOT NULL,
    session_id TEXT NOT NULL,
    stage TEXT NOT NULL,
    path TEXT NOT NULL,
    exists_flag INTEGER NOT NULL,
    size_bytes INTEGER NOT NULL,
    mtime_ns INTEGER NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session
ON session_checkpoints(project_id, session_id, id);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uid TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    run_id TEXT NOT NULL REFERENCES audit_runs(id) ON DELETE CASCADE,
    run_sequence INTEGER NOT NULL,
    timestamp TEXT NOT NULL,
    kind TEXT NOT NULL,
    role TEXT,
    title TEXT,
    content TEXT,
    payload TEXT NOT NULL,
    is_redacted INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_audit_events_project
ON audit_events(project_id, id);

CREATE INDEX IF NOT EXISTS idx_audit_events_run
ON audit_events(run_id, run_sequence);

CREATE TABLE IF NOT EXISTS shared_resources (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'available',
    target TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    metadata_json TEXT NOT NULL DEFAULT '{}',
    secret_json TEXT NOT NULL DEFAULT '{}',
    created_by_type TEXT NOT NULL DEFAULT 'human',
    created_by TEXT NOT NULL,
    worker TEXT,
    intent_id TEXT,
    fact_id TEXT,
    parent_resource_id TEXT REFERENCES shared_resources(id) ON DELETE SET NULL,
    source_task_id TEXT,
    locked_by_type TEXT,
    locked_by TEXT,
    locked_at TEXT,
    worker_paused INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS project_deletions (
    project_id TEXT PRIMARY KEY,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    requested_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_error TEXT,
    actor TEXT NOT NULL DEFAULT 'unknown',
    source TEXT NOT NULL DEFAULT 'unknown'
);

CREATE TABLE IF NOT EXISTS project_delete_authorizations (
    token_hash TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    actor TEXT NOT NULL,
    expires_at REAL NOT NULL,
    used_at TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_delete_authorizations_project
ON project_delete_authorizations(project_id, expires_at);

CREATE TABLE IF NOT EXISTS project_lifecycle_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor TEXT NOT NULL,
    source TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_shared_resources_project
ON shared_resources(project_id, kind, updated_at);

CREATE INDEX IF NOT EXISTS idx_shared_resources_parent
ON shared_resources(parent_resource_id);

CREATE TABLE IF NOT EXISTS operation_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    resource_id TEXT NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
    intent_id TEXT,
    fact_id TEXT,
    action TEXT NOT NULL,
    actor_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    risk TEXT NOT NULL DEFAULT 'low',
    status TEXT NOT NULL DEFAULT 'queued',
    input_json TEXT NOT NULL DEFAULT '{}',
    output_summary TEXT NOT NULL DEFAULT '',
    result_ref TEXT,
    requires_approval INTEGER NOT NULL DEFAULT 0,
    approved_by TEXT,
    approved_at TEXT,
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_operation_tasks_project
ON operation_tasks(project_id, created_at);

CREATE INDEX IF NOT EXISTS idx_operation_tasks_resource
ON operation_tasks(resource_id, created_at);

CREATE INDEX IF NOT EXISTS idx_operation_tasks_status
ON operation_tasks(status, created_at);

CREATE TABLE IF NOT EXISTS operation_results (
    id TEXT PRIMARY KEY,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    task_id TEXT NOT NULL UNIQUE REFERENCES operation_tasks(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    content TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    resource_id TEXT,
    task_id TEXT,
    actor_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    status TEXT NOT NULL,
    detail_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_resource_audit_project
ON resource_audit_events(project_id, id);

CREATE INDEX IF NOT EXISTS idx_resource_audit_resource
ON resource_audit_events(resource_id, id);
"""

BLACKBOARD_DELETE_TRIGGERS = """\
DROP TRIGGER IF EXISTS trg_blackboard_fact_removed;
CREATE TRIGGER trg_blackboard_fact_removed
AFTER DELETE ON facts
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
    INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
    VALUES (OLD.project_id, 'fact', OLD.id, 'removed', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;

DROP TRIGGER IF EXISTS trg_blackboard_intent_removed;
CREATE TRIGGER trg_blackboard_intent_removed
AFTER DELETE ON intents
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
    INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
    VALUES (OLD.project_id, 'intent', OLD.id, 'removed', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;

DROP TRIGGER IF EXISTS trg_blackboard_hint_removed;
CREATE TRIGGER trg_blackboard_hint_removed
AFTER DELETE ON hints
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
    INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
    VALUES (OLD.project_id, 'hint', OLD.id, 'removed', strftime('%Y-%m-%dT%H:%M:%SZ', 'now'));
END;
"""

PLANNING_REVISION_TRIGGERS = """\
DROP TRIGGER IF EXISTS trg_planning_fact_added;
CREATE TRIGGER trg_planning_fact_added
AFTER INSERT ON facts
BEGIN
    UPDATE projects
    SET planning_revision = planning_revision + 1
    WHERE id = NEW.project_id;
END;

DROP TRIGGER IF EXISTS trg_planning_fact_removed;
CREATE TRIGGER trg_planning_fact_removed
AFTER DELETE ON facts
WHEN EXISTS (SELECT 1 FROM projects WHERE id = OLD.project_id)
BEGIN
    UPDATE projects
    SET planning_revision = planning_revision + 1
    WHERE id = OLD.project_id;
END;

DROP TRIGGER IF EXISTS trg_planning_hint_added;
CREATE TRIGGER trg_planning_hint_added
AFTER INSERT ON hints
BEGIN
    UPDATE projects
    SET planning_revision = planning_revision + 1
    WHERE id = NEW.project_id;
END;

-- Clean up legacy resource planning triggers from old databases.
-- Resource add/change/remove must NOT bump planning_revision.
DROP TRIGGER IF EXISTS trg_planning_resource_added;
DROP TRIGGER IF EXISTS trg_planning_resource_changed;
DROP TRIGGER IF EXISTS trg_planning_resource_removed;
"""


def configure(path: Path) -> None:
    global _db_path, _last_blackboard_revision
    if _db_path is not None:
        return
    _db_path = path
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    _migrate_legacy_storage(_db_path)
    conn = sqlite3.connect(str(_db_path))
    conn.row_factory = sqlite3.Row
    try:
        conn.execute("PRAGMA secure_delete=ON")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("PRAGMA legacy_alter_table=ON")
        conn.executescript(SCHEMA)
        _ensure_global_resource_schema(conn)
        _ensure_project_columns(conn)
        conn.executescript(BLACKBOARD_DELETE_TRIGGERS)
        conn.executescript(PLANNING_REVISION_TRIGGERS)
        _ensure_deletion_columns(conn)
        _backfill_blackboard_events(conn)
        conn.commit()
        _last_blackboard_revision = int(
            conn.execute(
                "SELECT COALESCE(MAX(revision), 0) FROM blackboard_events"
            ).fetchone()[0]
        )
    finally:
        conn.close()


def _migrate_legacy_storage(path: Path) -> None:
    if (
        path.resolve() != DEFAULT_DB.resolve()
        or LEGACY_ROOT.resolve() == path.parent.resolve()
    ):
        return
    legacy_db = LEGACY_ROOT / "redtrace.db"
    if not path.exists() and legacy_db.is_file():
        fd, temporary = tempfile.mkstemp(prefix=".redtrace-migrate-", dir=path.parent)
        os.close(fd)
        target = Path(temporary)
        try:
            source_conn = sqlite3.connect(f"file:{legacy_db}?mode=ro", uri=True)
            target_conn = sqlite3.connect(str(target))
            try:
                source_conn.backup(target_conn)
                target_conn.execute("PRAGMA secure_delete=ON")
                target_conn.execute("PRAGMA temp_store=MEMORY")
                target_conn.execute("VACUUM")
                if target_conn.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                    raise RuntimeError("migrated RedTrace database failed integrity check")
            finally:
                target_conn.close()
                source_conn.close()
            os.replace(target, path)
            legacy_db.unlink()
            for suffix in ("-wal", "-shm"):
                legacy_db.with_name(legacy_db.name + suffix).unlink(missing_ok=True)
        except BaseException:
            target.unlink(missing_ok=True)
            raise
    for source, destination in (
        (LEGACY_ROOT / "audit", path.parent / "audit"),
        (LEGACY_ROOT / "payloads", project_root() / "output" / "c2" / "payloads"),
    ):
        _move_tree_verified(source, destination)
    (LEGACY_ROOT / ".DS_Store").unlink(missing_ok=True)
    try:
        LEGACY_ROOT.rmdir()
    except OSError:
        pass


def _move_tree_verified(source: Path, destination: Path) -> None:
    if not source.is_dir():
        return
    entries = list(source.rglob("*"))
    unsafe = [path for path in entries if path.is_symlink() or not (path.is_file() or path.is_dir())]
    if unsafe:
        raise RuntimeError(f"legacy RedTrace migration contains unsupported entry: {unsafe[0]}")
    files = [path for path in entries if path.is_file()]
    for old in files:
        new = destination / old.relative_to(source)
        new.parent.mkdir(parents=True, exist_ok=True)
        digest = _file_digest(old)
        if new.exists():
            if digest != _file_digest(new):
                raise RuntimeError(f"legacy RedTrace migration collision: {new}")
        else:
            shutil.copy2(old, new)
        if digest != _file_digest(new):
            raise RuntimeError(f"legacy RedTrace migration verification failed: {old}")
    shutil.rmtree(source)


def _file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _needs_nullable_project(conn: sqlite3.Connection, table: str) -> bool:
    columns = {row["name"]: row for row in conn.execute(f"PRAGMA table_info({table})")}
    project = columns.get("project_id")
    if project is None or bool(project["notnull"]):
        return True
    return any(
        row["from"] == "project_id" and str(row["on_delete"]).upper() != "SET NULL"
        for row in conn.execute(f"PRAGMA foreign_key_list({table})")
    )


def _ensure_global_resource_schema(conn: sqlite3.Connection) -> None:
    """Detach durable resources and their audit trail from project lifecycle."""
    if _needs_nullable_project(conn, "shared_resources"):
        conn.executescript(
            """
            ALTER TABLE shared_resources RENAME TO shared_resources_project_scoped;
            CREATE TABLE shared_resources (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                kind TEXT NOT NULL,
                name TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'available',
                target TEXT NOT NULL DEFAULT '',
                summary TEXT NOT NULL DEFAULT '',
                metadata_json TEXT NOT NULL DEFAULT '{}',
                secret_json TEXT NOT NULL DEFAULT '{}',
                created_by_type TEXT NOT NULL DEFAULT 'human',
                created_by TEXT NOT NULL,
                worker TEXT,
                intent_id TEXT,
                fact_id TEXT,
                parent_resource_id TEXT REFERENCES shared_resources(id) ON DELETE SET NULL,
                source_task_id TEXT,
                locked_by_type TEXT,
                locked_by TEXT,
                locked_at TEXT,
                worker_paused INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_seen_at TEXT
            );
            INSERT INTO shared_resources SELECT * FROM shared_resources_project_scoped;
            DROP TABLE shared_resources_project_scoped;
            CREATE INDEX IF NOT EXISTS idx_shared_resources_project
            ON shared_resources(project_id, kind, updated_at);
            CREATE INDEX IF NOT EXISTS idx_shared_resources_parent
            ON shared_resources(parent_resource_id);
            """
        )
    if _needs_nullable_project(conn, "resource_audit_events"):
        conn.executescript(
            """
            ALTER TABLE resource_audit_events RENAME TO resource_audit_events_project_scoped;
            CREATE TABLE resource_audit_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                resource_id TEXT,
                task_id TEXT,
                actor_type TEXT NOT NULL,
                actor TEXT NOT NULL,
                action TEXT NOT NULL,
                status TEXT NOT NULL,
                detail_json TEXT NOT NULL DEFAULT '{}',
                created_at TEXT NOT NULL
            );
            INSERT INTO resource_audit_events SELECT * FROM resource_audit_events_project_scoped;
            DROP TABLE resource_audit_events_project_scoped;
            CREATE INDEX IF NOT EXISTS idx_resource_audit_project
            ON resource_audit_events(project_id, id);
            CREATE INDEX IF NOT EXISTS idx_resource_audit_resource
            ON resource_audit_events(resource_id, id);
            """
        )

    if _needs_nullable_project(conn, "operation_tasks") or _needs_nullable_project(conn, "operation_results"):
        conn.executescript(
            """
            ALTER TABLE operation_results RENAME TO operation_results_project_scoped;
            ALTER TABLE operation_tasks RENAME TO operation_tasks_project_scoped;
            CREATE TABLE operation_tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                resource_id TEXT NOT NULL REFERENCES shared_resources(id) ON DELETE CASCADE,
                intent_id TEXT,
                fact_id TEXT,
                action TEXT NOT NULL,
                actor_type TEXT NOT NULL,
                actor TEXT NOT NULL,
                risk TEXT NOT NULL DEFAULT 'low',
                status TEXT NOT NULL DEFAULT 'queued',
                input_json TEXT NOT NULL DEFAULT '{}',
                output_summary TEXT NOT NULL DEFAULT '',
                result_ref TEXT,
                requires_approval INTEGER NOT NULL DEFAULT 0,
                approved_by TEXT,
                approved_at TEXT,
                cancel_requested INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT
            );
            INSERT INTO operation_tasks SELECT * FROM operation_tasks_project_scoped;
            CREATE TABLE operation_results (
                id TEXT PRIMARY KEY,
                project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
                task_id TEXT NOT NULL UNIQUE REFERENCES operation_tasks(id) ON DELETE CASCADE,
                content_type TEXT NOT NULL DEFAULT 'text/plain',
                content TEXT NOT NULL,
                size_bytes INTEGER NOT NULL,
                sha256 TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            INSERT INTO operation_results SELECT * FROM operation_results_project_scoped;
            DROP TABLE operation_results_project_scoped;
            DROP TABLE operation_tasks_project_scoped;
            CREATE INDEX IF NOT EXISTS idx_operation_tasks_project
            ON operation_tasks(project_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_operation_tasks_resource
            ON operation_tasks(resource_id, created_at);
            CREATE INDEX IF NOT EXISTS idx_operation_tasks_status
            ON operation_tasks(status, created_at);
            """
        )

    # Preserve provenance before a legacy source project can later be deleted.
    # New writes already include this value in metadata_json.
    for row in conn.execute(
        "SELECT id, project_id, metadata_json FROM shared_resources WHERE project_id IS NOT NULL"
    ):
        try:
            metadata = json.loads(row["metadata_json"] or "{}")
        except (TypeError, ValueError):
            metadata = {}
        if metadata.get("source_project_id"):
            continue
        metadata["source_project_id"] = row["project_id"]
        conn.execute(
            "UPDATE shared_resources SET metadata_json = ? WHERE id = ?",
            (json.dumps(metadata, ensure_ascii=False), row["id"]),
        )


def _ensure_project_columns(conn: sqlite3.Connection) -> None:
    columns = {row["name"] for row in conn.execute("PRAGMA table_info(projects)")}
    if "bootstrap_enabled" not in columns:
        conn.execute(
            "ALTER TABLE projects ADD COLUMN bootstrap_enabled INTEGER NOT NULL DEFAULT 1"
        )
        if "bootstrap_mode" in columns:
            conn.execute(
                "UPDATE projects SET bootstrap_enabled = CASE WHEN bootstrap_mode = 'disabled' THEN 0 ELSE 1 END"
            )
    additions = {
        "reason_failure_count": "INTEGER NOT NULL DEFAULT 0",
        "reason_failure_signature": "TEXT",
        "reason_retry_after": "REAL",
        "reason_circuit_open": "INTEGER NOT NULL DEFAULT 0",
        "planning_revision": "INTEGER NOT NULL DEFAULT 0",
        "reason_evaluated_revision": "INTEGER NOT NULL DEFAULT 0",
    }
    planning_revision_added = "planning_revision" not in columns
    for name, definition in additions.items():
        if name not in columns:
            conn.execute(f"ALTER TABLE projects ADD COLUMN {name} {definition}")
    if planning_revision_added:
        conn.execute(
            """
            UPDATE projects
            SET planning_revision = MAX(
                1,
                (SELECT COUNT(*) FROM facts WHERE project_id = projects.id)
                + (SELECT COUNT(*) FROM hints WHERE project_id = projects.id)
            ),
                reason_evaluated_revision = 0
            """
        )
    intent_columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(intents)")
    }
    for name, definition in {
        "failure_count": "INTEGER NOT NULL DEFAULT 0",
        "failure_signature": "TEXT",
        "retry_after": "REAL",
        "circuit_open": "INTEGER NOT NULL DEFAULT 0",
        "priority": "INTEGER NOT NULL DEFAULT 50",
        "state": "TEXT NOT NULL DEFAULT 'open'",
        "goal_id": "TEXT",
        "superseded_by": "TEXT",
        "invalidated_by": "TEXT NOT NULL DEFAULT '[]'",
        "drop_reason": "TEXT",
        "attempt_count": "INTEGER NOT NULL DEFAULT 0",
        "cumulative_runtime_ms": "INTEGER NOT NULL DEFAULT 0",
        "fact_yield": "INTEGER NOT NULL DEFAULT 0",
        "last_progress_at": "TEXT",
    }.items():
        if name not in intent_columns:
            conn.execute(f"ALTER TABLE intents ADD COLUMN {name} {definition}")
    # Backfill the new `state` column from the legacy to_fact_id/worker fields.
    conn.execute(
        """
        UPDATE intents SET state = CASE
            WHEN to_fact_id IS NOT NULL THEN 'concluded'
            WHEN worker IS NOT NULL THEN 'working'
            ELSE 'open'
        END
        WHERE state = 'open'
          AND (to_fact_id IS NOT NULL OR worker IS NOT NULL)
        """
    )


def _ensure_deletion_columns(conn: sqlite3.Connection) -> None:
    columns = {
        row["name"] for row in conn.execute("PRAGMA table_info(project_deletions)")
    }
    for name in ("actor", "source"):
        if name not in columns:
            conn.execute(
                f"ALTER TABLE project_deletions ADD COLUMN {name} TEXT NOT NULL DEFAULT 'unknown'"
            )


def _backfill_blackboard_events(conn: sqlite3.Connection) -> None:
    """Give pre-feature blackboards a stable revision without duplicating live trigger events."""
    conn.execute(
        """
        INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
        SELECT f.project_id, 'fact', f.id, 'added', p.created_at
        FROM facts f
        JOIN projects p ON p.id = f.project_id
        WHERE NOT EXISTS (
            SELECT 1
            FROM blackboard_events e
            WHERE e.project_id = f.project_id
              AND e.kind = 'fact'
              AND e.node_id = f.id
              AND e.action = 'added'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
        SELECT i.project_id, 'intent', i.id, 'added', i.created_at
        FROM intents i
        WHERE NOT EXISTS (
            SELECT 1
            FROM blackboard_events e
            WHERE e.project_id = i.project_id
              AND e.kind = 'intent'
              AND e.node_id = i.id
              AND e.action = 'added'
        )
        """
    )
    conn.execute(
        """
        INSERT INTO blackboard_events (project_id, kind, node_id, action, created_at)
        SELECT h.project_id, 'hint', h.id, 'added', h.created_at
        FROM hints h
        WHERE NOT EXISTS (
            SELECT 1
            FROM blackboard_events e
            WHERE e.project_id = h.project_id
              AND e.kind = 'hint'
              AND e.node_id = h.id
              AND e.action = 'added'
        )
        """
    )


@contextmanager
def get_conn(*, immediate: bool = False) -> Generator[sqlite3.Connection, None, None]:
    assert _db_path is not None
    conn = sqlite3.connect(str(_db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    conn.execute("PRAGMA secure_delete=ON")
    conn.execute("PRAGMA temp_store=MEMORY")
    if immediate:
        conn.execute("BEGIN IMMEDIATE")
    changes_before = conn.total_changes
    try:
        yield conn
        conn.commit()
        if conn.total_changes != changes_before:
            _publish_change()
            latest_blackboard_revision = int(
                conn.execute(
                    "SELECT COALESCE(MAX(revision), 0) FROM blackboard_events"
                ).fetchone()[0]
            )
            _publish_blackboard_revision(latest_blackboard_revision)
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def project_root() -> Path:
    """Resolve the root that owns the configured database and output tree."""
    path = (_db_path or DEFAULT_DB).resolve()
    return path.parent.parent if path.parent.name == ".redtrace" else path.parent


def output_root(category: str) -> Path:
    if category not in {"webshell", "c2"}:
        raise ValueError(f"unsupported output category: {category}")
    root = project_root() / "output" / category
    root.mkdir(parents=True, exist_ok=True)
    return root


def compact() -> None:
    """Physically release deleted task pages without using the system temp dir."""
    assert _db_path is not None
    conn = sqlite3.connect(str(_db_path), timeout=30)
    try:
        conn.execute("PRAGMA secure_delete=ON")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        conn.execute("VACUUM")
        conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        conn.close()
