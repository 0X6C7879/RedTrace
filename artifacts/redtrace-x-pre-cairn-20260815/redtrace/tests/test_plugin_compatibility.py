from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient

from redtrace.plugin_registry import PluginRegistry
from redtrace.server import db
from redtrace.server.app import app
from redtrace.server.routers.plugins import PluginRunRequest, _create_plugin_project, _stream_project


@pytest.fixture
def client(tmp_path, monkeypatch) -> TestClient:
    monkeypatch.delenv("REDTRACE_PLUGIN_TOKEN", raising=False)
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as test_client:
        yield test_client


def test_registry_manages_both_migrated_plugins() -> None:
    catalog = PluginRegistry().catalog()
    assert {item["id"] for item in catalog["plugins"]} == {
        "cyberstrikeai-browser-extension",
        "cyberstrikeai-burp-extension",
    }
    assert all(item["ready"] for item in catalog["plugins"])


def test_native_and_legacy_session_and_catalog_routes(client: TestClient) -> None:
    paths = {route.path for route in app.routes}
    assert {
        "/api/plugins/v1/runs/stream",
        "/api/eino-agent/stream",
        "/api/multi-agent/stream",
        "/api/agent-loop/cancel",
    } <= paths

    native = client.post("/api/plugins/v1/session", json={"password": ""})
    legacy = client.post("/api/auth/login", json={"password": ""})
    assert native.status_code == legacy.status_code == 200
    assert native.json()["token"] == legacy.json()["token"] == "redtrace-local"

    headers = {"Authorization": "Bearer redtrace-local"}
    assert client.get("/api/plugins/v1/session", headers=headers).json()["service"] == "RedTrace"
    assert client.get("/api/auth/validate", headers=headers).status_code == 200
    assert client.get("/api/plugins/v1/catalog", headers=headers).status_code == 200
    assert client.get("/api/projects?limit=500", headers=headers).json() == {"projects": []}
    assert client.get("/api/roles", headers=headers).json()["roles"][0]["enabled"] is True
    assert client.get("/api/projects").status_code == 401


def test_configured_plugin_token_is_required(client: TestClient, monkeypatch) -> None:
    monkeypatch.setenv("REDTRACE_PLUGIN_TOKEN", "expected-secret")
    assert client.post("/api/auth/login", json={"password": "wrong"}).status_code == 401
    login = client.post("/api/auth/login", json={"password": "expected-secret"})
    assert login.status_code == 200
    assert login.json()["token"] == "expected-secret"
    assert (
        client.get(
            "/api/auth/validate",
            headers={"Authorization": "Bearer expected-secret"},
        ).status_code
        == 200
    )


def test_plugin_run_creates_isolated_project_and_streams_final_response(
    client: TestClient,
) -> None:
    source = client.post(
        "/projects",
        json={"title": "context", "origin": "source", "goal": "context goal"},
    ).json()["project"]["id"]
    project_id = _create_plugin_project(
        PluginRunRequest(
            message="[Target]\nGET example.test/login\n\n[Request]\nGET /login HTTP/1.1",
            projectId=source,
            orchestration="focused",
        )
    )
    assert project_id != source

    detail = client.get(f"/projects/{project_id}").json()
    assert detail["project"]["title"] == "Plugin · GET example.test/login"
    assert detail["project"]["bootstrap_enabled"] is False
    assert source in next(fact["description"] for fact in detail["facts"] if fact["id"] == "origin")

    with db.get_conn() as conn:
        now = "2026-07-26T00:00:00Z"
        conn.execute(
            """
            INSERT INTO intents (
                id, project_id, to_fact_id, description, creator, worker,
                last_heartbeat_at, created_at, concluded_at
            ) VALUES ('i001', ?, 'goal', 'final plugin finding', 'reasoner',
                      'reasoner', ?, ?, ?)
            """,
            (project_id, now, now, now),
        )
        conn.execute("UPDATE projects SET status = 'completed' WHERE id = ?", (project_id,))

    payloads = [
        json.loads(chunk.removeprefix("data: ").strip())
        for chunk in _stream_project(project_id)
        if chunk.startswith("data:")
    ]
    assert [payload["type"] for payload in payloads] == [
        "conversation",
        "progress",
        "response_start",
        "response",
        "done",
    ]
    assert payloads[0]["conversationId"] == project_id
    assert payloads[-2]["message"] == "final plugin finding"


def test_legacy_cancel_stops_only_plugin_project(client: TestClient) -> None:
    headers = {"Authorization": "Bearer redtrace-local"}
    ordinary_project = client.post(
        "/projects",
        json={"title": "ordinary", "origin": "human", "goal": "do not stop"},
    ).json()["project"]["id"]
    protected = client.post(
        "/api/agent-loop/cancel",
        headers=headers,
        json={"conversationId": ordinary_project},
    )
    assert protected.status_code == 403
    assert client.get(f"/projects/{ordinary_project}").json()["project"]["status"] == "active"

    project_id = _create_plugin_project(PluginRunRequest(message="Inspect this request"))
    response = client.post(
        "/api/agent-loop/cancel",
        headers=headers,
        json={"conversationId": project_id},
    )
    assert response.status_code == 200
    assert response.json()["cancelled"] is True
    assert client.get(f"/projects/{project_id}").json()["project"]["status"] == "stopped"
