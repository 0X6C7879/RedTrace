from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from redtrace.board.storage import utcnow
from redtrace.dispatcher.config import LocalConfig
from redtrace.dispatcher.runtime.local_backend import LocalBackend
from redtrace.server import db
from redtrace.server.app import app


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


def _delete(client: TestClient, project_id: str):
    confirmation = client.post(
        f"/projects/{project_id}/deletion/confirmation"
    )
    assert confirmation.status_code == 200
    return client.request(
        "DELETE",
        f"/projects/{project_id}",
        json={
            "confirmation_token": confirmation.json()["confirmationToken"],
            "actor": "human-ui",
        },
    )


def test_deletion_failure_is_visible_and_retry_finishes_cleanup(
    client: TestClient,
    tmp_path: Path,
    monkeypatch,
) -> None:
    project_id = _create_project(client)
    conversation_marker = "deleted-worker-conversation-secret-7f32"
    root = tmp_path / "redtrace"
    managed = root / ".redtrace"
    audit = managed / "audit"
    project_state = managed / "projects" / project_id
    project_log = managed / "log" / "projects" / project_id
    sibling_log = (
        managed / "log" / "projects" / "other-project" / "worker.log"
    )
    shared_log = managed / "log" / "server.log"
    project_root = root / "workspaces" / project_id
    workspace = project_root / "workspace"
    cache = project_root / "cache"
    runtime = project_root / "runtime"
    archive = audit / project_id
    session_file = project_state / "conversations" / "pi" / "session-delete-001.jsonl"
    worker_log = (
        workspace
        / ".redtrace"
        / "conversations"
        / "pi"
        / "logs"
        / "worker.log"
    )
    for directory in (
        project_state,
        project_log,
        sibling_log.parent,
        workspace,
        cache,
        runtime,
        archive,
        session_file.parent,
        worker_log.parent,
    ):
        directory.mkdir(parents=True, exist_ok=True)
    (project_state / "prompt.md").write_text("prompt", encoding="utf-8")
    (project_log / "dispatcher.log").write_text("task log", encoding="utf-8")
    sibling_log.write_text("keep", encoding="utf-8")
    shared_log.write_text("keep", encoding="utf-8")
    (workspace / "evidence.txt").write_text("evidence", encoding="utf-8")
    (cache / "npm-cache").write_text("cache", encoding="utf-8")
    (runtime / "session.json").write_text("session", encoding="utf-8")
    (archive / "report.txt").write_text("report", encoding="utf-8")
    session_file.write_text("session", encoding="utf-8")
    worker_log.write_text("worker log", encoding="utf-8")
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
                str(root / "workspaces" / project_id / "workspace"),
                str(root / "workspaces" / project_id / "workspace"),
                utcnow(),
            ),
        )
        conn.execute(
            """
            INSERT INTO audit_events (
                event_uid, project_id, run_id, run_sequence, timestamp,
                kind, role, content, payload
            ) VALUES (?, ?, 'run-delete-001', 1, ?, 'assistant.message',
                      'assistant', ?, '{}')
            """,
            ("event-delete-001", project_id, utcnow(), conversation_marker),
        )
        for resource_id, kind in (("ws-keep", "webshell"), ("file-drop", "file")):
            conn.execute(
                """
                INSERT INTO shared_resources (
                    id, project_id, kind, name, created_by, created_at, updated_at
                ) VALUES (?, ?, ?, ?, 'worker', ?, ?)
                """,
                (resource_id, project_id, kind, resource_id, utcnow(), utcnow()),
            )
            conn.execute(
                """
                INSERT INTO resource_audit_events (
                    project_id, resource_id, actor_type, actor, action,
                    status, created_at
                ) VALUES (?, ?, 'worker', 'worker', 'resource.register',
                          'succeeded', ?)
                """,
                (project_id, resource_id, utcnow()),
            )

    assert client.delete(f"/projects/{project_id}").status_code == 403
    assert _delete(client, project_id).status_code == 202
    failed = client.post(
        f"/projects/{project_id}/deletion/runtime-cleaned",
        json={"success": False, "error": "container still running"},
    )
    assert failed.status_code == 200
    status = client.get(f"/projects/{project_id}/deletion").json()
    assert status["state"] == "failed"
    assert "container still running" in status["last_error"]
    assert client.get(f"/projects/{project_id}").status_code == 200

    assert _delete(client, project_id).status_code == 202
    assert client.get(f"/projects/{project_id}/deletion").json()["state"] == "pending"
    completed = client.post(
        f"/projects/{project_id}/deletion/runtime-cleaned",
        json={"success": True},
    )
    assert completed.status_code == 200
    assert completed.json()["completed"] is True
    assert client.get(f"/projects/{project_id}").status_code == 404
    assert not project_state.exists()
    assert not project_log.exists()
    assert sibling_log.read_text(encoding="utf-8") == "keep"
    assert shared_log.read_text(encoding="utf-8") == "keep"
    assert not project_root.exists()
    assert not workspace.exists()
    assert not cache.exists()
    assert not runtime.exists()
    assert not archive.exists()
    assert not session_file.exists()
    assert not worker_log.exists()
    with db.get_conn() as conn:
        kept = conn.execute(
            "SELECT project_id FROM shared_resources WHERE id = 'ws-keep'"
        ).fetchone()
        assert kept is not None and kept["project_id"] is None
        assert conn.execute(
            "SELECT 1 FROM shared_resources WHERE id = 'file-drop'"
        ).fetchone() is None
        assert conn.execute(
            "SELECT project_id FROM resource_audit_events WHERE resource_id = 'ws-keep'"
        ).fetchone()["project_id"] is None
        assert conn.execute(
            "SELECT 1 FROM resource_audit_events WHERE resource_id = 'file-drop'"
        ).fetchone() is None
        assert conn.execute(
            "SELECT 1 FROM project_lifecycle_events WHERE project_id = ?",
            (project_id,),
        ).fetchone() is None
    assert conversation_marker.encode() not in (tmp_path / "redtrace.db").read_bytes()


def test_delete_confirmation_is_single_use(client: TestClient) -> None:
    project_id = _create_project(client)
    confirmation = client.post(
        f"/projects/{project_id}/deletion/confirmation"
    ).json()["confirmationToken"]
    body = {"confirmation_token": confirmation, "actor": "human-ui"}

    assert client.request("DELETE", f"/projects/{project_id}", json=body).status_code == 202
    assert client.request("DELETE", f"/projects/{project_id}", json=body).status_code == 403


def test_intent_retry_budget_persists_and_opens_circuit(client: TestClient) -> None:
    project_id = _create_project(client)
    intent = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "deterministic failure",
            "creator": "reasoner",
            "worker": None,
        },
    ).json()
    path = f"/projects/{project_id}/intents/{intent['id']}/outcome"

    for count in (1, 2):
        response = client.post(
            path, json={"worker": "pi", "outcome": "contract_error"}
        )
        assert response.json()["failureCount"] == count
        assert response.json()["circuitOpen"] is False
    response = client.post(
        path, json={"worker": "pi", "outcome": "contract_error"}
    )

    assert response.json()["circuitOpen"] is True
    detail = client.get(f"/projects/{project_id}").json()
    failed = next(item for item in detail["intents"] if item["id"] == intent["id"])
    assert failed["circuit_open"] is True
    assert failed["state"] == "blocked"
    assert failed["to"] is None
    assert {fact["id"] for fact in detail["facts"]} == {"origin", "goal"}


def test_reason_retry_budget_stops_project(client: TestClient) -> None:
    project_id = _create_project(client)
    path = f"/projects/{project_id}/reason/outcome"
    for _ in range(3):
        response = client.post(
            path, json={"worker": "reasoner", "outcome": "timeout"}
        )

    assert response.json()["circuitOpen"] is True
    project = client.get(f"/projects/{project_id}").json()["project"]
    assert project["status"] == "stopped"
    assert project["reason_circuit_open"] is True


def test_local_workspace_delete_is_idempotent_and_confined(tmp_path: Path) -> None:
    root = tmp_path / "workspaces"
    backend = LocalBackend(LocalConfig(workspace_root=str(root)))
    workspace = Path(backend.ensure_running("project-001"))
    assert workspace.name == "workspace"
    project_root = workspace.parent
    assert project_root.name == "project-001"
    assert (project_root / "cache").is_dir()
    assert (project_root / "runtime").is_dir()
    (workspace / "evidence.txt").write_text("evidence", encoding="utf-8")
    (project_root / "cache" / "npm-cache").write_text("cache", encoding="utf-8")
    (project_root / "runtime" / "session.json").write_text("session", encoding="utf-8")
    shared = tmp_path / "skills"
    shared.mkdir()
    (shared / "SKILL.md").write_text("shared", encoding="utf-8")

    assert backend.cleanup_deleted("project-001") is True
    assert backend.cleanup_deleted("project-001") is True
    assert not workspace.exists()
    assert not project_root.exists()
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

    assert _delete(client, project_id).status_code == 202
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

    assert client.request(
        "DELETE",
        "/projects/proj_missing",
        json={"confirmation_token": "unused", "actor": "human-ui"},
    ).status_code == 204
    with db.get_conn() as conn:
        assert conn.execute(
            "SELECT 1 FROM project_deletions WHERE project_id = 'proj_missing'"
        ).fetchone() is None
