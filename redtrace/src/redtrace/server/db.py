from __future__ import annotations

import sqlite3
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

DEFAULT_DB = Path.home() / ".local" / "share" / "redtrace" / "redtrace.db"

_db_path: Path | None = None
_change_condition = threading.Condition()
_change_generation = 0


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
    reason_last_heartbeat_at TEXT
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
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_shared_resources_project
ON shared_resources(project_id, kind, updated_at);

CREATE INDEX IF NOT EXISTS idx_shared_resources_parent
ON shared_resources(parent_resource_id);

CREATE TABLE IF NOT EXISTS operation_tasks (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    task_id TEXT NOT NULL UNIQUE REFERENCES operation_tasks(id) ON DELETE CASCADE,
    content_type TEXT NOT NULL DEFAULT 'text/plain',
    content TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS resource_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
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


def configure(path: Path) -> None:
    global _db_path
    if _db_path is not None:
        return
    _db_path = path
    _db_path.parent.mkdir(parents=True, exist_ok=True)
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        conn.executescript(BLACKBOARD_DELETE_TRIGGERS)
        _ensure_project_columns(conn)
        _backfill_blackboard_events(conn)


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
def get_conn() -> Generator[sqlite3.Connection, None, None]:
    assert _db_path is not None
    conn = sqlite3.connect(str(_db_path))
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    changes_before = conn.total_changes
    try:
        yield conn
        conn.commit()
        if conn.total_changes != changes_before:
            _publish_change()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()
