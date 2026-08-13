from __future__ import annotations

import sqlite3
from pathlib import Path

from redtrace.server import db


def test_default_database_migrates_legacy_storage_without_leaving_user_files(
    tmp_path: Path, monkeypatch
) -> None:
    legacy = tmp_path / "home" / ".local" / "share" / "redtrace"
    destination = tmp_path / "repo" / ".redtrace" / "redtrace.db"
    legacy.mkdir(parents=True)
    with sqlite3.connect(legacy / "redtrace.db") as conn:
        conn.executescript(db.SCHEMA)
        conn.execute(
            "INSERT INTO projects (id, title, created_at) VALUES ('proj_legacy', 'legacy', '2026-01-01T00:00:00Z')"
        )
    (legacy / "audit" / "proj_legacy").mkdir(parents=True)
    (legacy / "audit" / "proj_legacy" / "report.txt").write_text("audit")
    (legacy / "payloads").mkdir()
    (legacy / "payloads" / "beacon.bin").write_bytes(b"payload")

    monkeypatch.setattr(db, "DEFAULT_DB", destination)
    monkeypatch.setattr(db, "LEGACY_ROOT", legacy)
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(destination)

    with db.get_conn() as conn:
        assert conn.execute(
            "SELECT title FROM projects WHERE id = 'proj_legacy'"
        ).fetchone()["title"] == "legacy"
    assert (destination.parent / "audit" / "proj_legacy" / "report.txt").read_text() == "audit"
    assert (
        destination.parents[1] / "output" / "c2" / "payloads" / "beacon.bin"
    ).read_bytes() == b"payload"
    assert not legacy.exists()


def test_configure_adds_bootstrap_enabled_to_legacy_projects_table(tmp_path, monkeypatch) -> None:
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                created_at TEXT NOT NULL,
                reason_worker TEXT,
                reason_trigger TEXT,
                reason_started_at TEXT,
                reason_last_heartbeat_at TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO projects (id, title, created_at) VALUES ('proj_001', 'legacy', '2026-01-01T00:00:00Z')"
        )

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)

    with db.get_conn() as conn:
        row = conn.execute("SELECT bootstrap_enabled FROM projects WHERE id = 'proj_001'").fetchone()
    assert row["bootstrap_enabled"] == 1


def test_configure_maps_disabled_bootstrap_mode_to_false(tmp_path, monkeypatch) -> None:
    path = tmp_path / "intermediate.db"
    with sqlite3.connect(path) as conn:
        conn.execute(
            """
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                status TEXT NOT NULL DEFAULT 'active',
                bootstrap_mode TEXT NOT NULL DEFAULT 'auto',
                created_at TEXT NOT NULL,
                reason_worker TEXT,
                reason_trigger TEXT,
                reason_started_at TEXT,
                reason_last_heartbeat_at TEXT
            )
            """
        )
        conn.execute(
            "INSERT INTO projects (id, title, bootstrap_mode, created_at) VALUES ('proj_001', 'disabled', 'disabled', '2026-01-01T00:00:00Z')"
        )
        conn.execute(
            "INSERT INTO projects (id, title, bootstrap_mode, created_at) VALUES ('proj_002', 'enabled', 'enabled', '2026-01-01T00:00:00Z')"
        )

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)

    with db.get_conn() as conn:
        rows = conn.execute("SELECT id, bootstrap_enabled FROM projects ORDER BY id").fetchall()
    assert [(row["id"], row["bootstrap_enabled"]) for row in rows] == [
        ("proj_001", 0),
        ("proj_002", 1),
    ]


def test_configure_backfills_blackboard_revisions_for_existing_nodes(tmp_path, monkeypatch) -> None:
    path = tmp_path / "pre-blackboard.db"
    with sqlite3.connect(path) as conn:
        conn.executescript(
            """
            CREATE TABLE projects (
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
            CREATE TABLE facts (
                id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                description TEXT NOT NULL,
                PRIMARY KEY (id, project_id)
            );
            CREATE TABLE intents (
                id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                to_fact_id TEXT,
                description TEXT NOT NULL,
                creator TEXT NOT NULL,
                worker TEXT,
                last_heartbeat_at TEXT,
                created_at TEXT NOT NULL,
                concluded_at TEXT,
                PRIMARY KEY (id, project_id)
            );
            CREATE TABLE hints (
                id TEXT NOT NULL,
                project_id TEXT NOT NULL,
                content TEXT NOT NULL,
                creator TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (id, project_id)
            );
            INSERT INTO projects (id, title, created_at)
            VALUES ('proj_001', 'legacy', '2026-01-01T00:00:00Z');
            INSERT INTO facts (id, project_id, description)
            VALUES ('origin', 'proj_001', 'start');
            INSERT INTO intents (
                id, project_id, description, creator, created_at
            ) VALUES ('i001', 'proj_001', 'investigate', 'worker', '2026-01-01T00:00:01Z');
            INSERT INTO hints (id, project_id, content, creator, created_at)
            VALUES ('h001', 'proj_001', 'clue', 'human', '2026-01-01T00:00:02Z');
            """
        )

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)

    with db.get_conn() as conn:
        rows = conn.execute(
            """
            SELECT kind, node_id, action
            FROM blackboard_events
            WHERE project_id = 'proj_001'
            ORDER BY revision
            """
        ).fetchall()
    assert [(row["kind"], row["node_id"], row["action"]) for row in rows] == [
        ("fact", "origin", "added"),
        ("intent", "i001", "added"),
        ("hint", "h001", "added"),
    ]

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)
    with db.get_conn() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS count FROM blackboard_events WHERE project_id = 'proj_001'"
        ).fetchone()["count"]
    assert count == 3
