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


def _patch(client: TestClient, project_id: str, revision: int, body: dict):
    project = client.get(f"/projects/{project_id}").json()["project"]
    if project["reason"] is None:
        claim = client.post(
            f"/projects/{project_id}/reason/claim",
            json={"worker": "reasoner", "trigger": "test"},
        )
        assert claim.status_code == 200
    return client.post(
        f"/projects/{project_id}/graph-patch",
        json={
            "base_planning_revision": revision,
            "worker": "reasoner",
            **body,
        },
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
    client.post(
        f"/projects/{project_id}/hints",
        json={"content": "new direction", "creator": "human"},
    )

    response = _patch(
        client,
        project_id,
        revision,
        {"create": [{"from": ["origin"], "description": "stale"}]},
    )
    assert response.status_code == 409
    assert "revision_conflict" in response.json()["detail"]


def test_noop_patch_marks_current_planning_revision_evaluated(
    client: TestClient,
) -> None:
    project_id = _project(client)
    revision = _revision(client, project_id)

    response = _patch(client, project_id, revision, {})

    assert response.status_code == 200
    assert response.json()["planning_revision"] == revision
    assert response.json()["reason_evaluated_revision"] == revision
    project = client.get(f"/projects/{project_id}").json()["project"]
    assert project["reason_evaluated_revision"] == project["planning_revision"]
    assert client.post(
        f"/projects/{project_id}/reason/release",
        json={"worker": "reasoner"},
    ).status_code == 200

    duplicate = client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "other-reasoner", "trigger": "stale-summary"},
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["detail"] == "Planning revision is already evaluated"


def test_graph_patch_cannot_modify_working_intent(client: TestClient) -> None:
    project_id = _project(client)
    intent = _intent(client, project_id, "already executing")
    assert client.post(
        f"/projects/{project_id}/intents/{intent['id']}/claim",
        json={"worker": "explorer"},
    ).status_code == 200

    response = _patch(
        client,
        project_id,
        _revision(client, project_id),
        {
            "reprioritize": [
                {"intent_id": intent["id"], "priority": 99, "reason": "too late"}
            ]
        },
    )

    assert response.status_code == 409
    stored = client.get(f"/projects/{project_id}").json()["intents"][0]
    assert stored["state"] == "working"
    assert stored["priority"] == 50


def test_runtime_noise_does_not_conflict_with_reason_patch(client: TestClient) -> None:
    project_id = _project(client)
    intent = _intent(client, project_id, "long running")
    assert client.post(
        f"/projects/{project_id}/intents/{intent['id']}/claim",
        json={"worker": "explorer"},
    ).status_code == 200
    revision = _revision(client, project_id)
    assert client.post(
        f"/projects/{project_id}/reason/claim",
        json={"worker": "reasoner", "trigger": "test"},
    ).status_code == 200
    assert client.post(
        f"/projects/{project_id}/intents/{intent['id']}/heartbeat",
        json={"worker": "explorer"},
    ).status_code == 200

    response = client.post(
        f"/projects/{project_id}/graph-patch",
        json={"base_planning_revision": revision, "worker": "reasoner"},
    )

    assert response.status_code == 200
    assert response.json()["planning_revision"] == revision


def test_frontier_only_update_does_not_invalidate_planning_revision(
    client: TestClient,
) -> None:
    project_id = _project(client)
    intent = _intent(client, project_id, "reprioritize me")
    revision = _revision(client, project_id)

    changed = _patch(
        client,
        project_id,
        revision,
        {
            "reprioritize": [
                {"intent_id": intent["id"], "priority": 90, "reason": "new evidence"}
            ]
        },
    )
    assert changed.status_code == 200
    assert changed.json()["planning_revision"] == revision

    follow_up = _patch(
        client,
        project_id,
        revision,
        {"drop": [{"intent_id": intent["id"], "reason": "stale planner"}]},
    )
    assert follow_up.status_code == 200


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
    _intent(client, project_id, "keep me")
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


def test_graph_patch_rejects_terminal_self_and_cyclic_mutations(
    client: TestClient,
) -> None:
    project_id = _project(client)
    first = _intent(client, project_id, "first")
    second = _intent(client, project_id, "second")

    self_reference = _patch(
        client,
        project_id,
        _revision(client, project_id),
        {
            "supersede": [
                {"intent_id": first["id"], "by": first["id"], "reason": "invalid"}
            ]
        },
    )
    assert self_reference.status_code == 400

    cycle = _patch(
        client,
        project_id,
        _revision(client, project_id),
        {
            "supersede": [
                {"intent_id": first["id"], "by": second["id"], "reason": "a"},
                {"intent_id": second["id"], "by": first["id"], "reason": "b"},
            ]
        },
    )
    assert cycle.status_code == 409
    assert all(
        item["state"] == "open"
        for item in client.get(f"/projects/{project_id}").json()["intents"]
    )

    dropped = _patch(
        client,
        project_id,
        _revision(client, project_id),
        {"drop": [{"intent_id": first["id"], "reason": "done"}]},
    )
    assert dropped.status_code == 200
    terminal = _patch(
        client,
        project_id,
        _revision(client, project_id),
        {
            "reprioritize": [
                {"intent_id": first["id"], "priority": 99, "reason": "too late"}
            ]
        },
    )
    assert terminal.status_code == 409


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


def test_consecutive_failures_preserve_priority_and_block_without_fact(
    client: TestClient,
) -> None:
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
    assert stored["priority"] == 50
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


def test_observation_and_runtime_update_branch_budget(
    client: TestClient,
) -> None:
    project_id = _project(client)
    intent = _intent(client, project_id, "long investigation")
    claimed = client.post(
        f"/projects/{project_id}/intents/{intent['id']}/claim",
        json={"worker": "explorer"},
    )
    assert claimed.status_code == 200

    legacy_fact = client.post(
        f"/projects/{project_id}/intents/{intent['id']}/facts",
        json={"worker": "explorer", "description": "must not bypass conclude"},
    )
    assert legacy_fact.status_code == 409

    denied = client.post(
        f"/projects/{project_id}/intents/{intent['id']}/observations",
        json={"worker": "other", "content": "spoofed"},
    )
    assert denied.status_code == 409

    submitted = client.post(
        f"/projects/{project_id}/intents/{intent['id']}/observations",
        json={"worker": "explorer", "content": "possible /admin endpoint"},
    )
    assert submitted.status_code == 201
    assert submitted.json()["observation"]["id"] == "o001"
    assert submitted.json()["intent"]["to"] is None
    assert submitted.json()["intent"]["state"] == "working"
    assert submitted.json()["intent"]["fact_yield"] == 0
    assert submitted.json()["intent"]["last_progress_at"] is not None
    detail = client.get(f"/projects/{project_id}").json()
    assert {fact["id"] for fact in detail["facts"]} == {"origin", "goal"}

    outcome = client.post(
        f"/projects/{project_id}/intents/{intent['id']}/outcome",
        json={"worker": "explorer", "outcome": "cancelled", "runtime_ms": 1234},
    )
    assert outcome.status_code == 200
    stored = next(
        item
        for item in client.get(f"/projects/{project_id}").json()["intents"]
        if item["id"] == intent["id"]
    )
    assert stored["cumulative_runtime_ms"] == 1234
    assert stored["fact_yield"] == 0


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
