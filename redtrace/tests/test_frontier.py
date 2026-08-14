from __future__ import annotations

import time

import pytest
from fastapi.testclient import TestClient

from conftest import make_intent, make_project
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
    return client.get(f"/projects/{project_id}").json()["blackboard_revision"]


def _patch(client: TestClient, project_id: str, revision: int, body: dict):
    return client.post(
        f"/projects/{project_id}/graph-patch",
        json={"base_revision": revision, "worker": "reasoner", **body},
    )


def test_graph_patch_applies_all_operations_atomically(client: TestClient) -> None:
    project_id = _project(client)
    i1 = _intent(client, project_id, "scan admin api")
    i2 = _intent(client, project_id, "check default creds")
    i3 = _intent(client, project_id, "find sql injection")
    revision = _revision(client, project_id)

    response = _patch(
        client,
        project_id,
        revision,
        {
            "create": [{"from": ["origin"], "description": "verify unauth api", "priority": 80}],
            "drop": [{"intent_id": i1["id"], "reason": "obsolete"}],
            "reprioritize": [{"intent_id": i2["id"], "priority": 95, "reason": "creds found"}],
            "supersede": [{"intent_id": i3["id"], "by": i2["id"], "reason": "covered"}],
        },
    )
    assert response.status_code == 200
    body = response.json()
    assert body["completed"] is False
    assert [item["description"] for item in body["created"]] == ["verify unauth api"]
    assert body["dropped"] == [i1["id"]]
    assert body["reprioritized"] == [i2["id"]]
    assert body["superseded"] == [i3["id"]]

    detail = client.get(f"/projects/{project_id}").json()
    intents = {item["id"]: item for item in detail["intents"]}
    assert intents[i1["id"]]["state"] == "dropped"
    assert intents[i1["id"]]["drop_reason"] == "obsolete"
    assert intents[i2["id"]]["priority"] == 95
    assert intents[i3["id"]]["state"] == "superseded"
    assert intents[i3["id"]]["superseded_by"] == i2["id"]


def test_graph_patch_rejects_stale_revision(client: TestClient) -> None:
    project_id = _project(client)
    revision = _revision(client, project_id)
    _intent(client, project_id, "bumps revision")

    response = _patch(
        client,
        project_id,
        revision,
        {"create": [{"from": ["origin"], "description": "stale"}]},
    )
    assert response.status_code == 409
    assert "revision_conflict" in response.json()["detail"]


def test_graph_patch_rejects_unknown_fact_and_intent(client: TestClient) -> None:
    project_id = _project(client)
    revision = _revision(client, project_id)

    response = _patch(
        client,
        project_id,
        revision,
        {"create": [{"from": ["nope"], "description": "bad fact"}]},
    )
    assert response.status_code == 404

    response = _patch(
        client,
        project_id,
        revision,
        {"drop": [{"intent_id": "nope", "reason": "bad intent"}]},
    )
    assert response.status_code == 404


def test_graph_patch_rejects_invalid_priority(client: TestClient) -> None:
    project_id = _project(client)
    revision = _revision(client, project_id)

    response = _patch(
        client,
        project_id,
        revision,
        {"create": [{"from": ["origin"], "description": "bad", "priority": 150}]},
    )
    assert response.status_code == 422


def test_graph_patch_rejects_duplicate_intent(client: TestClient) -> None:
    project_id = _project(client)
    _intent(client, project_id, "verify unauth api")
    revision = _revision(client, project_id)

    response = _patch(
        client,
        project_id,
        revision,
        {"create": [{"from": ["origin"], "description": "verify unauth api"}]},
    )
    assert response.status_code == 409


def test_graph_patch_rolls_back_on_partial_failure(client: TestClient) -> None:
    project_id = _project(client)
    i1 = _intent(client, project_id, "keep me")
    revision = _revision(client, project_id)

    response = _patch(
        client,
        project_id,
        revision,
        {
            "create": [{"from": ["origin"], "description": "should not persist"}],
            "drop": [{"intent_id": "missing", "reason": "triggers rollback"}],
        },
    )
    assert response.status_code == 404

    detail = client.get(f"/projects/{project_id}").json()
    assert [item["description"] for item in detail["intents"]] == ["keep me"]
    assert detail["intents"][0]["state"] == "open"


def test_dropped_intent_cannot_be_claimed(client: TestClient) -> None:
    project_id = _project(client)
    intent = _intent(client, project_id, "doomed")
    revision = _revision(client, project_id)
    response = _patch(
        client,
        project_id,
        revision,
        {"drop": [{"intent_id": intent["id"], "reason": "no value"}]},
    )
    assert response.status_code == 200

    claimed = client.post(
        f"/projects/{project_id}/intents/{intent['id']}/claim",
        json={"worker": "w"},
    )
    assert claimed.status_code == 409


def test_graph_patch_completes_project(client: TestClient) -> None:
    project_id = _project(client)
    i1 = _intent(client, project_id, "do work")
    client.post(f"/projects/{project_id}/intents/{i1['id']}/claim", json={"worker": "w"})
    client.post(
        f"/projects/{project_id}/intents/{i1['id']}/conclude",
        json={"worker": "w", "description": "found vuln"},
    )
    revision = _revision(client, project_id)

    response = _patch(
        client,
        project_id,
        revision,
        {"complete": {"from": ["f001"], "description": "goal met"}},
    )
    assert response.status_code == 200
    assert response.json()["completed"] is True
    assert client.get(f"/projects/{project_id}").json()["project"]["status"] == "completed"


def test_scheduler_prefers_higher_priority_intent() -> None:
    low = make_intent("i-low")
    low.worker = None
    low.priority = 20
    high = make_intent("i-high")
    high.worker = None
    high.priority = 90
    project = make_project(intents=[low, high])

    assert project_policy.newest_unclaimed_intent(project, set()).id == "i-high"


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


def test_consecutive_failures_decay_priority(client: TestClient) -> None:
    project_id = _project(client)
    intent = _intent(client, project_id, "attempt")
    path = f"/projects/{project_id}/intents/{intent['id']}/outcome"

    for _ in range(2):
        response = client.post(
            path, json={"worker": "w", "outcome": "provider_exit", "detail": ""}
        )
        assert response.status_code == 200

    detail = client.get(f"/projects/{project_id}").json()
    stored = next(item for item in detail["intents"] if item["id"] == intent["id"])
    assert stored["priority"] == 35  # 50 - 5 - 10
    assert stored["state"] == "open"


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
