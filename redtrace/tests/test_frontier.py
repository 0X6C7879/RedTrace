from __future__ import annotations

import time

import pytest
from conftest import make_intent, make_project
from fastapi.testclient import TestClient
from redtrace.board.models import ProjectDetail, ProjectSummary
from redtrace.dispatcher.scheduler import project_policy
from redtrace.server import db
from redtrace.server.app import app


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as test_client:
        yield test_client


def _project(client: TestClient) -> str:
    response = client.post("/projects", json={"title": "t", "origin": "o", "goal": "g"})
    assert response.status_code == 201
    return response.json()["project"]["id"]


def _intent(client: TestClient, project_id: str, description: str) -> dict:
    response = client.post(
        f"/projects/{project_id}/intents",
        json={"from": ["origin"], "description": description, "creator": "reasoner"},
    )
    assert response.status_code == 201
    return response.json()


def _revision(client: TestClient, project_id: str) -> int:
    return client.get(f"/projects/{project_id}").json()["project"][
        "planning_revision"
    ]


def test_scheduler_prefers_oldest_unclaimed_intent() -> None:
    newer = make_intent("i-new")
    newer.worker = None
    newer.created_at = "2026-01-01T00:00:03Z"
    older = make_intent("i-old")
    older.worker = None
    older.created_at = "2026-01-01T00:00:01Z"
    project = make_project(intents=[newer, older])

    assert project_policy.newest_unclaimed_intent(project, set()).id == "i-old"


def test_scheduler_skips_dropped_and_superseded_intents() -> None:
    open_intent = make_intent("i-open")
    open_intent.worker = None
    dropped = make_intent("i-dropped")
    dropped.worker = None
    dropped.state = "dropped"
    superseded = make_intent("i-superseded")
    superseded.worker = None
    superseded.state = "superseded"
    project = make_project(intents=[open_intent, dropped, superseded])

    assert project_policy.newest_unclaimed_intent(project, set()).id == "i-open"


def test_scheduler_skips_circuit_open_and_backoff_intents() -> None:
    open_intent = make_intent("i-open")
    open_intent.worker = None
    circuit = make_intent("i-circuit")
    circuit.worker = None
    circuit.circuit_open = True
    backoff = make_intent("i-backoff")
    backoff.worker = None
    backoff.retry_after = time.time() + 1000
    project = make_project(intents=[open_intent, circuit, backoff])

    assert project_policy.newest_unclaimed_intent(project, set()).id == "i-open"


def test_summary_and_detail_share_usable_frontier_count(client: TestClient) -> None:
    project_id = _project(client)
    schedulable = _intent(client, project_id, "schedulable")
    working = _intent(client, project_id, "working")
    circuit = _intent(client, project_id, "circuit")
    backoff = _intent(client, project_id, "backoff")
    assert client.post(
        f"/projects/{project_id}/intents/{working['id']}/claim",
        json={"worker": "explorer"},
    ).status_code == 200
    now = time.time()
    with db.get_conn(immediate=True) as conn:
        conn.execute(
            "UPDATE intents SET circuit_open = 1 WHERE project_id = ? AND id = ?",
            (project_id, circuit["id"]),
        )
        conn.execute(
            "UPDATE intents SET retry_after = ? WHERE project_id = ? AND id = ?",
            (now + 3600, project_id, backoff["id"]),
        )

    summaries = [
        ProjectSummary.model_validate(item) for item in client.get("/projects").json()
    ]
    summary = next(item for item in summaries if item.id == project_id)
    detail = ProjectDetail.model_validate(client.get(f"/projects/{project_id}").json())
    detail_count = project_policy.open_intent_count(detail, now=now)

    assert schedulable["id"] != working["id"]
    assert summary.working_intent_count == 1
    assert summary.unclaimed_intent_count == 1
    assert detail_count == summary.working_intent_count + summary.unclaimed_intent_count


def test_consecutive_failures_block_without_priority(client: TestClient) -> None:
    project_id = _project(client)
    intent = _intent(client, project_id, "attempt")
    path = f"/projects/{project_id}/intents/{intent['id']}/outcome"

    for _ in range(3):
        response = client.post(
            path, json={"worker": "w", "outcome": "provider_exit", "detail": ""}
        )
        assert response.status_code == 200

    detail = client.get(f"/projects/{project_id}").json()
    stored = next(item for item in detail["intents"] if item["id"] == intent["id"])
    assert stored["state"] == "blocked"
    assert {fact["id"] for fact in detail["facts"]} == {"origin", "goal"}
    late_conclusion = client.post(
        f"/projects/{project_id}/intents/{intent['id']}/conclude",
        json={"worker": "w", "description": "late result"},
    )
    assert late_conclusion.status_code == 409
    assert late_conclusion.json()["detail"] == "Intent is blocked"


def test_bootstrap_failures_keep_the_cairn_retry_path_open(
    client: TestClient,
) -> None:
    project_id = _project(client)
    intent = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "bootstrap",
            "creator": "dispatcher.bootstrap",
        },
    ).json()
    before = _revision(client, project_id)

    path = f"/projects/{project_id}/intents/{intent['id']}/outcome"
    for _ in range(4):
        response = client.post(
            path,
            json={"worker": "bootstrap-worker", "outcome": "timeout"},
        )
        assert response.status_code == 200
        assert response.json()["circuitOpen"] is False

    detail = client.get(f"/projects/{project_id}").json()
    stored = next(item for item in detail["intents"] if item["id"] == intent["id"])
    assert stored["state"] == "open"
    assert stored["failure_count"] == 4
    assert stored["circuit_open"] is False
    assert detail["project"]["planning_revision"] == before
    assert {fact["id"] for fact in detail["facts"]} == {"origin", "goal"}


def test_failed_conclude_does_not_delete_committed_facts(client: TestClient) -> None:
    project_id = _project(client)
    i1 = _intent(client, project_id, "work one")
    client.post(f"/projects/{project_id}/intents/{i1['id']}/claim", json={"worker": "w1"})
    concluded = client.post(
        f"/projects/{project_id}/intents/{i1['id']}/conclude",
        json={"worker": "w1", "description": "fact a"},
    )
    assert concluded.status_code == 200

    i2 = _intent(client, project_id, "work two")
    client.post(f"/projects/{project_id}/intents/{i2['id']}/claim", json={"worker": "w2"})
    failed = client.post(
        f"/projects/{project_id}/intents/{i2['id']}/conclude",
        json={"worker": "w1", "description": "wrong owner"},
    )
    assert failed.status_code == 409

    detail = client.get(f"/projects/{project_id}").json()
    descriptions = [fact["description"] for fact in detail["facts"]]
    assert "fact a" in descriptions
