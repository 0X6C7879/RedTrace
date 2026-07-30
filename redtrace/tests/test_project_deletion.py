from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from redtrace.dispatcher.config import LocalConfig
from redtrace.dispatcher.runtime.local_backend import LocalBackend
from redtrace.server import db
from redtrace.server.app import app
from redtrace.server.services import utcnow


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as test_client:
        yield test_client


def _create_project(client: TestClient) -> str:
    response = client.post(
        "/projects",
        json={
            "title": "delete me",
            "origin": "origin",
            "goal": "goal",
            "hints": [],
        },
    )
    assert response.status_code == 201
    return response.json()["project"]["id"]


def test_deletion_failure_is_visible_and_retry_finishes_cleanup(
    client: TestClient,
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_id = _create_project(client)
    root = tmp_path / "redtrace"
    managed = root / ".redtrace"
    audit = managed / "audit"
    project_state = managed / "projects" / project_id
    workspace = root / "workspaces" / project_id
    archive = audit / project_id
    session_file = (
        managed
        / "workers"
        / "pi"
        / "pi-worker"
        / "sessions"
        / "session-delete-001.jsonl"
    )
    for directory in (project_state, workspace, archive, session_file.parent):
        directory.mkdir(parents=True, exist_ok=True)
    (project_state / "prompt.md").write_text("prompt", encoding="utf-8")
    (workspace / "evidence.txt").write_text("evidence", encoding="utf-8")
    (archive / "report.txt").write_text("report", encoding="utf-8")
    session_file.write_text("session", encoding="utf-8")
    monkeypatch.delenv("REDTRACE_DISPATCH_CONFIG", raising=False)
    monkeypatch.setenv("REDTRACE_ROOT", str(root))
    monkeypatch.setenv("REDTRACE_MANAGED_DIR", str(managed))
    monkeypatch.setenv("REDTRACE_WORKSPACE_ROOT", str(root / "workspaces"))
    monkeypatch.setenv("REDTRACE_AUDIT_ROOT", str(audit))

    with db.get_conn() as conn:
        conn.execute(
            """
            INSERT INTO audit_runs (
                id, project_id, intent_id, task_type, phase, worker, provider,
                session_id, workspace_kind, workspace_ref, workspace_root,
                status, started_at
            ) VALUES (?, ?, NULL, 'explore', 'execute', 'pi-worker', 'pi', ?,
                      'local', ?, ?, 'failed', ?)
            """,
            (
                "run-delete-001",
                project_id,
                "session-delete-001",
                str(root / "workspaces" / project_id),
                str(root / "workspaces" / project_id),
                utcnow(),
            ),
        )

    assert client.delete(f"/projects/{project_id}").status_code == 202
    failed = client.post(
        f"/projects/{project_id}/deletion/runtime-cleaned",
        json={"success": False, "error": "container still running"},
    )
    assert failed.status_code == 200
    status = client.get(f"/projects/{project_id}/deletion").json()
    assert status["state"] == "failed"
    assert "container still running" in status["last_error"]
    assert client.get(f"/projects/{project_id}").status_code == 200

    assert client.delete(f"/projects/{project_id}").status_code == 202
    assert client.get(f"/projects/{project_id}/deletion").json()["state"] == "pending"
    completed = client.post(
        f"/projects/{project_id}/deletion/runtime-cleaned",
        json={"success": True},
    )
    assert completed.status_code == 200
    assert completed.json()["completed"] is True
    assert client.get(f"/projects/{project_id}").status_code == 404
    assert not project_state.exists()
    assert not workspace.exists()
    assert not archive.exists()
    assert not session_file.exists()


def test_local_workspace_delete_is_idempotent_and_confined(tmp_path: Path) -> None:
    root = tmp_path / "workspaces"
    backend = LocalBackend(LocalConfig(workspace_root=str(root)))
    workspace = Path(backend.ensure_running("project-001"))
    (workspace / "evidence.txt").write_text("evidence", encoding="utf-8")
    shared = tmp_path / "skills"
    shared.mkdir()
    (shared / "SKILL.md").write_text("shared", encoding="utf-8")

    assert backend.cleanup_deleted("project-001") is True
    assert backend.cleanup_deleted("project-001") is True
    assert not workspace.exists()
    assert (shared / "SKILL.md").is_file()


def test_deletion_refuses_linked_project_root(
    client: TestClient,
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_id = _create_project(client)
    root = tmp_path / "redtrace"
    managed = root / ".redtrace"
    outside = tmp_path / "outside-projects"
    outside_project = outside / project_id
    outside_project.mkdir(parents=True)
    protected = outside_project / "protected.txt"
    protected.write_text("keep", encoding="utf-8")
    managed.mkdir(parents=True)
    try:
        (managed / "projects").symlink_to(outside, target_is_directory=True)
    except OSError:
        pytest.skip("directory symlinks are unavailable on this Windows host")

    monkeypatch.delenv("REDTRACE_DISPATCH_CONFIG", raising=False)
    monkeypatch.setenv("REDTRACE_ROOT", str(root))
    monkeypatch.setenv("REDTRACE_MANAGED_DIR", str(managed))
    monkeypatch.setenv("REDTRACE_WORKSPACE_ROOT", str(root / "workspaces"))
    monkeypatch.setenv("REDTRACE_AUDIT_ROOT", str(managed / "audit"))

    assert client.delete(f"/projects/{project_id}").status_code == 202
    response = client.post(
        f"/projects/{project_id}/deletion/runtime-cleaned",
        json={"success": True},
    )
    assert response.status_code == 200
    assert response.json()["completed"] is False
    status = client.get(f"/projects/{project_id}/deletion").json()
    assert status["state"] == "failed"
    assert protected.read_text(encoding="utf-8") == "keep"
    assert client.get(f"/projects/{project_id}").status_code == 200


def test_repeated_delete_repairs_orphaned_deletion_marker(client: TestClient) -> None:
    with db.get_conn() as conn:
        conn.execute(
            """
            INSERT INTO project_deletions (
                project_id, state, attempts, requested_at, updated_at, last_error
            ) VALUES ('proj_missing', 'pending', 1, ?, ?, NULL)
            """,
            (utcnow(), utcnow()),
        )

    assert client.delete("/projects/proj_missing").status_code == 204
    with db.get_conn() as conn:
        assert conn.execute(
            "SELECT 1 FROM project_deletions WHERE project_id = 'proj_missing'"
        ).fetchone() is None
