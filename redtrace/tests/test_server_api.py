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


def test_intent_execution_profile_defaults_edits_and_freezes_on_claim(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "isolated work",
            "creator": "reasoner",
            "worker": None,
        },
    )
    assert created.status_code == 201
    intent = created.json()
    assert intent["execution_profile"] == "direct"

    path = f"/projects/{project_id}/intents/{intent['id']}/execution-profile"
    updated = client.patch(path, json={"execution_profile": "isolated"})
    assert updated.status_code == 200
    assert updated.json()["execution_profile"] == "isolated"

    assert client.post(
        f"/projects/{project_id}/intents/{intent['id']}/claim",
        json={"worker": "worker-a"},
    ).status_code == 200
    assert client.patch(path, json={"execution_profile": "direct"}).status_code == 409


def test_concurrent_reason_intent_creation_respects_active_limit(
    client: TestClient,
) -> None:
    project_id = _create_project(client)

    def create(index: int):
        return client.post(
            f"/projects/{project_id}/intents",
            json={
                "from": ["origin"],
                "description": f"parallel work {index}",
                "creator": "reasoner",
                "worker": None,
                "max_active_intents": 2,
            },
        )

    with ThreadPoolExecutor(max_workers=8) as executor:
        responses = list(executor.map(create, range(8)))

    statuses = sorted(response.status_code for response in responses)
    assert statuses == [201] * 2 + [409] * 6
    detail = client.get(f"/projects/{project_id}").json()
    assert len(
        [
            intent
            for intent in detail["intents"]
            if intent["to"] is None and intent["state"] in {"open", "working"}
        ]
    ) == 2


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

    confirmation = client.post(
        f"/projects/{project_id}/deletion/confirmation"
    ).json()["confirmationToken"]
    response = client.request(
        "DELETE",
        f"/projects/{project_id}",
        json={"confirmation_token": confirmation, "actor": "human-ui"},
    )

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

    late_running = {**run, "status": "running", "ended_at": None, "exit_code": None}
    assert client.post(
        "/audit/events", json={"run": late_running, "events": []}
    ).status_code == 200

    tasks = client.get("/audit/tasks").json()
    assert tasks[0]["id"] == project_id
    assert tasks[0]["run_count"] == 1
    stored_run = client.get(f"/audit/tasks/{project_id}/runs").json()[0]
    assert stored_run["worker"] == "codex-1"
    assert stored_run["status"] == "completed"
    assert stored_run["ended_at"] == "2026-01-01T00:00:02Z"

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


def test_audit_events_carry_run_identity_and_render_in_session_order(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    run = {
        "id": "run-dsh-1",
        "project_id": project_id,
        "task_type": "reason",
        "phase": "reason",
        "worker": "reason-1",
        "provider": "glm",
        "engine": "dsh",
        "workspace_kind": "local",
        "workspace_ref": "/tmp/w",
        "workspace_root": "/tmp/w",
        "status": "running",
        "started_at": "2026-01-01T00:00:00Z",
    }
    user_message = {
        "event_uid": "dsh-1",
        "run_sequence": 1,
        "timestamp": "2026-01-01T00:00:01Z",
        "kind": "user.message",
        "content": "分析任务",
    }
    assistant = {
        "event_uid": "dsh-2",
        "run_sequence": 2,
        "timestamp": "2026-01-01T00:00:02Z",
        "kind": "assistant.message",
        "content": "结论",
    }
    # Concurrent ingest POSTs may land out of session order.
    assert client.post(
        "/audit/events", json={"run": run, "events": [assistant]}
    ).status_code == 200
    assert client.post(
        "/audit/events", json={"run": run, "events": [user_message]}
    ).status_code == 200

    history = client.get(f"/audit/tasks/{project_id}/events").json()
    assert [event["kind"] for event in history] == ["user.message", "assistant.message"]
    for event in history:
        assert event["task_type"] == "reason"
        assert event["worker"] == "reason-1"
        assert event["provider"] == "glm"


def _post_run(client: TestClient, run: dict) -> None:
    assert client.post("/audit/events", json={"run": run, "events": []}).status_code == 200


def _run_body(project_id: str, run_id: str, task_type: str, **extra: dict) -> dict:
    run = {
        "id": run_id,
        "project_id": project_id,
        "task_type": task_type,
        "phase": task_type,
        "worker": f"{task_type}-1",
        "provider": "dsh",
        "engine": "dsh",
        "workspace_kind": "local",
        "workspace_ref": "/tmp/w",
        "workspace_root": "/tmp/w",
        "status": "running",
        "started_at": "2026-01-01T00:00:00Z",
    }
    run.update(extra)
    return run


def test_token_usage_aggregates_per_task_type_and_follows_deletion(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    other_id = _create_project(client)

    # Cumulative upsert: the same run reports growing totals, then a stale
    # zero-usage POST must not clobber what already landed.
    _post_run(client, _run_body(project_id, "run-b1", "bootstrap", input_tokens=100, output_tokens=40))
    _post_run(client, _run_body(project_id, "run-b1", "bootstrap", input_tokens=300, output_tokens=100,
                                cache_read_tokens=10, cache_write_tokens=5))
    _post_run(client, _run_body(project_id, "run-b1", "bootstrap"))
    _post_run(client, _run_body(project_id, "run-r1", "reason", input_tokens=500, output_tokens=200))
    _post_run(client, _run_body(project_id, "run-x1", "explore", input_tokens=50, output_tokens=20,
                                status="completed"))
    # A nested usage object is accepted as an alternative to flat columns.
    _post_run(client, _run_body(other_id, "run-o1", "reason",
                                usage={"input_tokens": 10, "output_tokens": 5}))

    usage = client.get(f"/audit/tasks/{project_id}/usage").json()
    assert usage == {"bootstrap": 415, "reason": 700, "explore": 70, "total": 1185}
    assert client.get(f"/audit/tasks/{other_id}/usage").json() == {
        "bootstrap": 0, "reason": 15, "explore": 0, "total": 15,
    }
    assert client.get("/audit/usage").json() == {
        "bootstrap": 415, "reason": 715, "explore": 70, "total": 1200,
    }

    tasks = {task["id"]: task for task in client.get("/audit/tasks").json()}
    assert tasks[project_id]["token_total"] == 1185
    assert tasks[other_id]["token_total"] == 15

    stored = client.get(f"/audit/tasks/{project_id}/runs").json()
    assert {run["id"]: run["input_tokens"] for run in stored}["run-b1"] == 300

    confirmation = client.post(
        f"/projects/{project_id}/deletion/confirmation"
    ).json()["confirmationToken"]
    assert client.request(
        "DELETE",
        f"/projects/{project_id}",
        json={"confirmation_token": confirmation, "actor": "human-ui"},
    ).status_code == 202
    assert client.post(
        f"/projects/{project_id}/deletion/runtime-cleaned", json={"success": True}
    ).status_code == 200

    assert client.get("/audit/usage").json() == {
        "bootstrap": 0, "reason": 15, "explore": 0, "total": 15,
    }
    assert client.get("/audit/tasks").json()[0]["token_total"] == 15


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


def test_bootstrap_conclude_with_completion_ends_project_and_reopens(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "bootstrap",
            "creator": "dispatcher.bootstrap",
            "worker": None,
        },
    )
    assert created.status_code == 201
    intent_id = created.json()["id"]
    assert (
        client.post(
            f"/projects/{project_id}/intents/{intent_id}/claim",
            json={"worker": "boot"},
        ).status_code
        == 200
    )

    concluded = client.post(
        f"/projects/{project_id}/intents/{intent_id}/conclude",
        json={
            "worker": "boot",
            "description": "flag captured: FLAG{ok}",
            "complete_description": "flag 已确认,Goal 满足",
        },
    )
    assert concluded.status_code == 200
    assert concluded.json()["completed"] is True
    fact_id = concluded.json()["fact"]["id"]

    detail = client.get(f"/projects/{project_id}").json()
    assert detail["project"]["status"] == "completed"
    completion = [
        intent
        for intent in detail["intents"]
        if intent["to"] == "goal"
    ]
    assert len(completion) == 1
    assert completion[0]["from"] == [fact_id]
    assert completion[0]["description"] == "flag 已确认,Goal 满足"

    outcome = client.post(
        f"/projects/{project_id}/intents/{intent_id}/outcome",
        json={"worker": "boot", "outcome": "success"},
    )
    assert outcome.status_code == 200

    reopened = client.post(
        f"/projects/{project_id}/reopen",
        json={"description": "human correction", "creator": "human"},
    )
    assert reopened.status_code == 200
    payload = reopened.json()
    assert payload["project"]["status"] == "active"
    assert payload["intent"]["from"] == [fact_id]


def test_conclude_with_completion_rejected_for_non_bootstrap_intents(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "investigate",
            "creator": "reasoner",
            "worker": None,
        },
    )
    assert created.status_code == 201
    intent_id = created.json()["id"]
    assert (
        client.post(
            f"/projects/{project_id}/intents/{intent_id}/claim",
            json={"worker": "explorer"},
        ).status_code
        == 200
    )

    rejected = client.post(
        f"/projects/{project_id}/intents/{intent_id}/conclude",
        json={
            "worker": "explorer",
            "description": "found something",
            "complete_description": "goal reached",
        },
    )
    assert rejected.status_code == 422

    detail = client.get(f"/projects/{project_id}").json()
    assert detail["project"]["status"] == "active"


def test_admin_can_force_release_and_conclude_owned_intents(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "investigate",
            "creator": "worker-a",
            "worker": "worker-a",
        },
    ).json()
    path = f"/projects/{project_id}/intents/{created['id']}"

    assert (
        client.post(f"{path}/release", json={"worker": "worker-b"}).status_code
        == 409
    )
    released = client.post(f"{path}/release", json={"worker": "admin"})
    assert released.status_code == 200
    assert released.json()["worker"] is None

    assert (
        client.post(f"{path}/claim", json={"worker": "worker-a"}).status_code
        == 200
    )
    assert client.post(
        f"{path}/conclude",
        json={"worker": "worker-b", "description": "wrong owner"},
    ).status_code == 409
    concluded = client.post(
        f"{path}/conclude",
        json={"worker": "admin", "description": "manual fact"},
    )
    assert concluded.status_code == 200
    assert concluded.json()["fact"]["description"] == "manual fact"
    assert concluded.json()["intent"]["worker"] == "admin"


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

    # Settings are read-only defaults now (the legacy PUT endpoint is gone).
    settings = client.get("/settings")
    assert settings.status_code == 200
    assert settings.json() == {
        "intent_timeout": 15,
        "reason_timeout": 15,
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


def test_reason_outcome_releases_lease_and_persists_context_revision(
    client: TestClient,
) -> None:
    project_id = _create_project(client)
    claimed = client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "worker-a", "trigger": "bootstrap"},
    )
    assert claimed.status_code == 200
    planning_revision = claimed.json()["planning_revision"]

    outcome = client.post(
        f"/projects/{project_id}/reason/outcome",
        json={
            "worker": "worker-a",
            "outcome": "success",
            "base_planning_revision": planning_revision,
            "context_revision": 2,
        },
    )

    assert outcome.status_code == 200
    project = client.get(f"/projects/{project_id}").json()["project"]
    assert project["reason"] is None
    assert project["reason_evaluated_revision"] == planning_revision
    assert project["reason_context_revision"] == 2


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
