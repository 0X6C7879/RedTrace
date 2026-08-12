from __future__ import annotations

import json
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from redtrace.server import db
from redtrace.server.app import app


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as test_client:
        yield test_client


def _create_project(client: TestClient) -> str:
    response = client.post(
        "/projects",
        json={
            "title": "test",
            "origin": "starting point",
            "goal": "finish",
            "hints": [{"content": "initial clue", "creator": "human"}],
        },
    )
    assert response.status_code == 201
    assert response.json()["project"]["bootstrap_enabled"] is False
    return response.json()["project"]["id"]


def test_projects_can_be_created_concurrently_without_id_collisions(
    client: TestClient,
) -> None:
    def create(index: int):
        return client.post(
            "/projects",
            json={
                "title": f"task {index}",
                "origin": f"origin {index}",
                "goal": f"goal {index}",
            },
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(create, range(8)))

    assert [response.status_code for response in responses] == [201] * 8
    project_ids = {response.json()["project"]["id"] for response in responses}
    assert project_ids == {f"proj_{index:03d}" for index in range(1, 9)}


def test_concurrent_intent_claim_has_exactly_one_winner(client: TestClient) -> None:
    project_id = _create_project(client)
    response = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "parallel work",
            "creator": "reasoner",
            "worker": None,
        },
    )
    assert response.status_code == 201

    def claim(worker: str):
        return client.post(
            f"/projects/{project_id}/intents/i001/claim",
            json={"worker": worker},
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(claim, (f"worker-{index}" for index in range(8))))

    assert sorted(response.status_code for response in responses) == [200] + [409] * 7


def test_dispatcher_change_cursor_advances_on_project_write(
    client: TestClient,
) -> None:
    before = client.get("/dispatcher/changes", params={"timeout": 0}).json()[
        "generation"
    ]

    _create_project(client)

    after = client.get(
        "/dispatcher/changes",
        params={"after": before, "timeout": 0},
    ).json()["generation"]
    assert after != before


def test_delete_project_cascades_without_blackboard_trigger_failure(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    intent = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "investigate",
            "creator": "reasoner",
            "worker": None,
        },
    )
    assert intent.status_code == 201

    response = client.delete(f"/projects/{project_id}")

    assert response.status_code == 202
    finalize = client.post(
        f"/projects/{project_id}/deletion/runtime-cleaned",
        json={"success": True},
    )
    assert finalize.status_code == 200
    assert finalize.json()["completed"] is True
    assert client.get(f"/projects/{project_id}").status_code == 404
    with db.get_conn() as conn:
        for table in (
            "facts",
            "intents",
            "intent_sources",
            "hints",
            "scoped_counters",
            "blackboard_events",
            "blackboard_query_audit",
            "audit_runs",
            "audit_events",
            "shared_resources",
            "operation_tasks",
            "operation_results",
            "resource_audit_events",
        ):
            count = conn.execute(
                f"SELECT COUNT(*) FROM {table} WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
            assert count == 0
        assert (
            conn.execute(
                "SELECT COUNT(*) FROM project_deletions WHERE project_id = ?",
                (project_id,),
            ).fetchone()[0]
            == 0
        )
    assert client.delete(f"/projects/{project_id}").status_code == 204


def test_audit_events_are_task_scoped_and_workspace_is_browsable(
    client: TestClient,
    tmp_path: Path,
) -> None:
    project_id = _create_project(client)
    workspace = tmp_path / "workspace"
    (workspace / "scripts").mkdir(parents=True)
    (workspace / "scripts" / "exploit.py").write_text(
        "print('audited')\n", encoding="utf-8"
    )
    run = {
        "id": "run-001",
        "project_id": project_id,
        "intent_id": "i001",
        "task_type": "explore",
        "phase": "explore_execute",
        "worker": "codex-1",
        "provider": "codex",
        "workspace_kind": "local",
        "workspace_ref": str(workspace),
        "workspace_root": str(workspace),
        "status": "completed",
        "started_at": "2026-01-01T00:00:00Z",
        "ended_at": "2026-01-01T00:00:02Z",
        "exit_code": 0,
    }
    events = [
        {
            "event_uid": "event-001",
            "run_sequence": 1,
            "timestamp": "2026-01-01T00:00:00Z",
            "kind": "user.message",
            "content": "inspect the script",
            "worker": "codex-1",
            "provider": "codex",
        },
        {
            "event_uid": "event-002",
            "run_sequence": 2,
            "timestamp": "2026-01-01T00:00:01Z",
            "kind": "assistant.delta",
            "content": "temporary live delta",
            "worker": "codex-1",
            "provider": "codex",
        },
        {
            "event_uid": "event-003",
            "run_sequence": 3,
            "timestamp": "2026-01-01T00:00:02Z",
            "kind": "assistant.message",
            "content": "inspection complete",
            "worker": "codex-1",
            "provider": "codex",
            "persist_only": True,
        },
    ]

    response = client.post("/audit/events", json={"run": run, "events": events})
    assert response.status_code == 200
    assert response.json() == {"accepted": 3}

    tasks = client.get("/audit/tasks").json()
    assert tasks[0]["id"] == project_id
    assert tasks[0]["run_count"] == 1
    assert (
        client.get(f"/audit/tasks/{project_id}/runs").json()[0]["worker"] == "codex-1"
    )

    history = client.get(f"/audit/tasks/{project_id}/events").json()
    assert [event["kind"] for event in history] == ["user.message", "assistant.message"]
    assert history[0]["content"] == "inspect the script"
    with db.get_conn() as conn:
        stored = json.loads(
            conn.execute(
                "SELECT payload FROM audit_events WHERE event_uid = ?",
                ("event-001",),
            ).fetchone()["payload"]
        )
    assert "content" not in stored

    tree = client.get(f"/audit/tasks/{project_id}/workspace").json()
    assert tree["entries"][0]["name"] == "scripts"
    file_response = client.get(
        f"/audit/tasks/{project_id}/workspace/file",
        params={"path": "scripts/exploit.py"},
    )
    assert file_response.status_code == 200
    assert file_response.json()["content"].splitlines() == ["print('audited')"]


def test_project_workflow_create_conclude_complete_and_reopen(
    client: TestClient,
) -> None:
    project_id = _create_project(client)

    response = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "investigate",
            "creator": "reasoner",
            "worker": None,
        },
    )
    assert response.status_code == 201
    assert response.json()["id"] == "i001"

    response = client.post(
        f"/projects/{project_id}/intents/i001/claim",
        json={"worker": "explorer"},
    )
    assert response.status_code == 200
    assert response.json()["worker"] == "explorer"

    response = client.post(
        f"/projects/{project_id}/intents/i001/claim",
        json={"worker": "explorer"},
    )
    assert response.status_code == 409
    assert "explorer" in response.json()["detail"]

    response = client.post(
        f"/projects/{project_id}/intents/i001/heartbeat",
        json={"worker": "explorer"},
    )
    assert response.status_code == 200
    assert response.json()["worker"] == "explorer"
    assert response.json()["blackboard_revision"] >= 1

    response = client.post(
        f"/projects/{project_id}/intents/i001/conclude",
        json={"worker": "explorer", "description": "new fact"},
    )
    assert response.status_code == 200
    assert response.json()["fact"] == {"id": "f001", "description": "new fact"}

    response = client.post(
        f"/projects/{project_id}/complete",
        json={"from": ["f001"], "description": "solved", "worker": "reasoner"},
    )
    assert response.status_code == 200
    assert response.json()["to"] == "goal"

    response = client.post(
        f"/projects/{project_id}/reopen",
        json={"description": "human correction", "creator": "human"},
    )
    assert response.status_code == 200
    payload = response.json()
    assert payload["project"]["status"] == "active"
    assert payload["fact"] == {"id": "f002", "description": "human correction"}
    assert payload["intent"]["from"] == ["f001"]
    assert payload["intent"]["to"] == "f002"


def test_stopping_project_releases_claims_and_reason_but_keeps_hints_writable(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "work",
            "creator": "worker-a",
            "worker": "worker-a",
        },
    )
    client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "worker-b", "trigger": "facts:2->3"},
    )

    response = client.put(f"/projects/{project_id}/status", json={"status": "stopped"})
    assert response.status_code == 200
    assert response.json()["reason"] is None

    detail = client.get(f"/projects/{project_id}").json()
    assert detail["intents"][0]["worker"] is None
    assert (
        client.post(
            f"/projects/{project_id}/hints",
            json={"content": "manual note", "creator": "human"},
        ).status_code
        == 201
    )
    assert (
        client.post(
            f"/projects/{project_id}/intents",
            json={
                "from": ["origin"],
                "description": "blocked",
                "creator": "reasoner",
                "worker": None,
            },
        ).status_code
        == 403
    )


def test_intent_creation_rejects_goal_source_and_mismatched_initial_worker(
    client: TestClient,
) -> None:
    project_id = _create_project(client)

    assert (
        client.post(
            f"/projects/{project_id}/intents",
            json={
                "from": ["goal"],
                "description": "invalid",
                "creator": "reasoner",
                "worker": None,
            },
        ).status_code
        == 400
    )
    assert (
        client.post(
            f"/projects/{project_id}/intents",
            json={
                "from": ["origin"],
                "description": "invalid",
                "creator": "reasoner",
                "worker": "explorer",
            },
        ).status_code
        == 400
    )


def test_settings_and_export_are_backed_by_the_same_database(
    client: TestClient,
) -> None:
    project_id = _create_project(client)

    response = client.put(
        "/settings", json={"intent_timeout": 30, "reason_timeout": 45}
    )
    assert response.status_code == 200
    assert client.get("/settings").json() == {
        "intent_timeout": 30,
        "reason_timeout": 45,
    }

    exported = client.get(f"/projects/{project_id}/export?format=yaml")
    assert exported.status_code == 200
    assert "origin: starting point" in exported.text
    assert "goal: finish" in exported.text
    assert (
        client.get(f"/projects/{project_id}/export?format=invalid").status_code == 400
    )


def test_expired_intent_and_reason_leases_can_be_reclaimed(client: TestClient) -> None:
    project_id = _create_project(client)
    client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "work",
            "creator": "worker-a",
            "worker": "worker-a",
        },
    )
    client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "worker-a", "trigger": "bootstrap"},
    )
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE intents SET last_heartbeat_at = '2000-01-01T00:00:00Z' WHERE project_id = ?",
            (project_id,),
        )
        conn.execute(
            "UPDATE projects SET reason_last_heartbeat_at = '2000-01-01T00:00:00Z' WHERE id = ?",
            (project_id,),
        )

    response = client.post(
        f"/projects/{project_id}/intents/i001/claim",
        json={"worker": "worker-b"},
    )
    assert response.status_code == 200
    assert response.json()["worker"] == "worker-b"

    response = client.post(
        f"/projects/{project_id}/intents/i001/heartbeat",
        json={"worker": "worker-b"},
    )
    assert response.status_code == 200

    response = client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "worker-b", "trigger": "facts:2->3"},
    )
    assert response.status_code == 200
    assert response.json()["reason"]["worker"] == "worker-b"


def test_live_reason_lease_rejects_competing_worker(client: TestClient) -> None:
    project_id = _create_project(client)
    assert (
        client.post(
            f"/projects/{project_id}/reason/claim",
            json={"worker": "worker-a", "trigger": "bootstrap"},
        ).status_code
        == 200
    )

    response = client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "worker-b", "trigger": "facts:2->3"},
    )

    assert response.status_code == 409
    assert "worker-a" in response.json()["detail"]

    response = client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "worker-a", "trigger": "duplicate"},
    )
    assert response.status_code == 409
    assert "worker-a" in response.json()["detail"]


def test_project_creation_persists_disabled_bootstrap_and_exports_it(
    client: TestClient,
) -> None:
    response = client.post(
        "/projects",
        json={
            "title": "no bootstrap",
            "origin": "start",
            "goal": "finish",
            "bootstrap_enabled": False,
        },
    )

    assert response.status_code == 201
    project_id = response.json()["project"]["id"]
    assert (
        client.get(f"/projects/{project_id}").json()["project"]["bootstrap_enabled"]
        is False
    )
    assert (
        "bootstrap_enabled: false"
        in client.get(f"/projects/{project_id}/export?format=yaml").text
    )


def test_project_creation_rejects_invalid_bootstrap_enabled(client: TestClient) -> None:
    response = client.post(
        "/projects",
        json={
            "title": "invalid bootstrap",
            "origin": "start",
            "goal": "finish",
            "bootstrap_enabled": "sometimes",
        },
    )

    assert response.status_code == 422
