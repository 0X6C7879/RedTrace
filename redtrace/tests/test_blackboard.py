from __future__ import annotations

import io
import json
import os
import tarfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from redtrace.capabilities import (
    BLACKBOARD_CLI_PATH,
    RESOURCE_CLI_PATH,
    CapabilityStore,
    materialize_local_workspace,
    workspace_payload,
    workspace_tar,
)
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.tasks import common, explore
from redtrace.server import db
from redtrace.server.app import app

from redtrace import blackboard_cli, resource_cli


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as test_client:
        yield test_client


def _create_project(client: TestClient) -> tuple[str, int]:
    response = client.post(
        "/projects",
        json={
            "title": "shared context",
            "origin": "start",
            "goal": "finish",
            "hints": [{"content": "look here", "creator": "human"}],
        },
    )
    assert response.status_code == 201
    body = response.json()
    return body["project"]["id"], body["blackboard_revision"]


def test_blackboard_status_changes_node_path_context_and_audit(
    client: TestClient,
) -> None:
    project_id, baseline = _create_project(client)
    headers = {
        "X-RedTrace-Worker": "codex-1",
        "X-RedTrace-Task": "explore",
        "X-RedTrace-Intent": "i001",
    }

    status = client.get(
        f"/projects/{project_id}/blackboard/status",
        params={"since": baseline},
        headers=headers,
    )
    assert status.status_code == 200
    assert status.json()["changed"] is False
    assert status.json()["counts"] == {
        "facts": 2,
        "intents": 0,
        "hints": 1,
    }

    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "investigate",
            "creator": "codex-1",
            "worker": "codex-1",
        },
    )
    assert created.status_code == 201
    intent_id = created.json()["id"]
    concluded = client.post(
        f"/projects/{project_id}/intents/{intent_id}/conclude",
        json={"worker": "codex-1", "description": "new shared fact"},
    )
    assert concluded.status_code == 200
    fact_id = concluded.json()["fact"]["id"]

    changes = client.get(
        f"/projects/{project_id}/blackboard/changes",
        params={"since": baseline},
        headers=headers,
    ).json()
    assert [change["kind"] for change in changes["changes"]] == [
        "intent",
        "fact",
        "intent",
    ]
    assert [change["action"] for change in changes["changes"]] == [
        "added",
        "added",
        "concluded",
    ]
    assert changes["next_revision"] == changes["revision"]
    assert changes["has_more"] is False
    assert changes["changes"][1]["node"]["description"] == "new shared fact"

    snapshot = client.get(
        f"/projects/{project_id}/blackboard/snapshot", headers=headers
    ).json()
    assert snapshot["revision"] == changes["revision"]
    assert {item["id"] for item in snapshot["facts"]} == {
        "origin",
        "goal",
        fact_id,
    }
    assert [item["id"] for item in snapshot["intents"]] == [intent_id]
    assert snapshot["hints"][0]["content"] == "look here"
    assert len(snapshot["edges"]) == 2

    node = client.get(
        f"/projects/{project_id}/blackboard/nodes/{fact_id}", headers=headers
    ).json()
    assert node["found"] is True
    assert node["node"] == {
        "kind": "fact",
        "id": fact_id,
        "description": "new shared fact",
    }

    path = client.get(
        f"/projects/{project_id}/blackboard/path",
        params={"source": "origin", "target": fact_id},
        headers=headers,
    ).json()
    assert path["found"] is True
    assert [item["id"] for item in path["path"]] == ["origin", intent_id, fact_id]

    context = client.get(
        f"/projects/{project_id}/blackboard/context/{intent_id}",
        params={"depth": 1},
        headers=headers,
    ).json()
    assert {item["id"] for item in context["nodes"]} == {
        intent_id,
        "origin",
        fact_id,
    }
    assert len(context["edges"]) == 2

    with db.get_conn() as conn:
        audit = conn.execute(
            """
            SELECT worker, task_type, intent_id, command, result_count, output_sha256, output_bytes
            FROM blackboard_query_audit
            WHERE project_id = ?
            ORDER BY id DESC
            LIMIT 1
            """,
            (project_id,),
        ).fetchone()
    assert dict(audit) == {
        "worker": "codex-1",
        "task_type": "explore",
        "intent_id": "i001",
        "command": "context",
        "result_count": 3,
        "output_sha256": audit["output_sha256"],
        "output_bytes": audit["output_bytes"],
    }
    assert len(audit["output_sha256"]) == 64
    assert audit["output_bytes"] > 0


def test_cli_uses_worker_context_and_snapshot_cursor(monkeypatch, capsys) -> None:
    monkeypatch.setenv("REDTRACE_SERVER", "http://redtrace.test")
    monkeypatch.setenv("REDTRACE_PROJECT_ID", "proj_007")
    monkeypatch.setenv("REDTRACE_WORKER", "pi-1")
    monkeypatch.setenv("REDTRACE_TASK_TYPE", "reason")
    monkeypatch.setenv("REDTRACE_INTENT_ID", "i009")
    monkeypatch.setenv("REDTRACE_BLACKBOARD_CURSOR", "41")
    captured: dict = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return None

        def read(self) -> bytes:
            return b'{"changed":false,"revision":41}'

    def fake_urlopen(request, timeout):
        captured["url"] = request.full_url
        captured["headers"] = dict(request.header_items())
        captured["timeout"] = timeout
        return Response()

    monkeypatch.setattr(blackboard_cli, "urlopen", fake_urlopen)
    assert blackboard_cli.main(["status"]) == 0
    assert (
        captured["url"]
        == "http://redtrace.test/projects/proj_007/blackboard/status?since=41"
    )
    assert captured["headers"]["X-redtrace-worker"] == "pi-1"
    assert captured["headers"]["X-redtrace-task"] == "reason"
    assert captured["headers"]["X-redtrace-intent"] == "i009"
    assert json.loads(capsys.readouterr().out) == {"changed": False, "revision": 41}

    assert blackboard_cli.main(["snapshot"]) == 0
    assert (
        captured["url"] == "http://redtrace.test/projects/proj_007/blackboard/snapshot"
    )

    assert blackboard_cli.main(["source", "f007"]) == 0
    assert captured["url"] == (
        "http://redtrace.test/projects/proj_007/blackboard/facts/f007/source?limit=50"
    )


def test_parallel_workers_can_query_safely(client: TestClient) -> None:
    project_id, baseline = _create_project(client)

    def query(index: int) -> tuple[int, bool]:
        response = client.get(
            f"/projects/{project_id}/blackboard/status",
            params={"since": baseline},
            headers={
                "X-RedTrace-Worker": f"worker-{index}",
                "X-RedTrace-Task": "reason",
            },
        )
        return response.status_code, response.json()["changed"]

    with ThreadPoolExecutor(max_workers=8) as executor:
        results = list(executor.map(query, range(16)))
    assert results == [(200, False)] * 16
    with db.get_conn() as conn:
        count = conn.execute(
            "SELECT COUNT(*) AS count FROM blackboard_query_audit WHERE project_id = ?",
            (project_id,),
        ).fetchone()["count"]
    assert count == 16


def test_worker_workspace_gets_the_same_executable_cli(tmp_path: Path) -> None:
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    materialize_local_workspace(CapabilityStore(tmp_path / "capabilities"), workspace)

    installed = workspace / BLACKBOARD_CLI_PATH
    source = Path(blackboard_cli.__file__)
    assert installed.read_bytes() == source.read_bytes()
    resource_installed = workspace / RESOURCE_CLI_PATH
    assert resource_installed.read_bytes() == Path(resource_cli.__file__).read_bytes()
    _, files = workspace_payload(CapabilityStore(tmp_path / "capabilities"))
    with tarfile.open(fileobj=io.BytesIO(workspace_tar(files)), mode="r:") as archive:
        assert archive.getmember(BLACKBOARD_CLI_PATH).mode == 0o755
        assert archive.getmember(RESOURCE_CLI_PATH).mode == 0o755


@pytest.mark.parametrize("worker_type", ["claudecode", "codex", "pi"])
def test_worker_process_receives_read_only_blackboard_context(
    monkeypatch, worker_type: str
) -> None:
    captured: dict = {}

    class Process:
        def set_output_handler(self, _handler):
            return None

        def start(self):
            return None

        def communicate(self, timeout):
            return ProcessResult(0, "", "")

    class Manager:
        def conversation_environment(self, _project_id, agent_type):
            return {"REDTRACE_TEST_CONVERSATION_HOME": agent_type}

        def build_exec_process(self, _name, env, _argv, **_kwargs):
            captured.update(env)
            return Process()

    class Publisher:
        def __init__(self, *_args, **_kwargs):
            return None

        def handle_output(self, *_args):
            return None

        def finish(self, _result):
            return None

        def fail(self, _exc):
            return None

        def close(self):
            return None

    monkeypatch.setattr(common, "AuditPublisher", Publisher)
    worker = WorkerConfig.model_validate(
        {
            "name": f"{worker_type}-worker",
            "type": worker_type,
            "task_types": ["explore", "reason"],
            "max_running": 1,
            "priority": 0,
            "context_length": 1_048_576,
        }
    )
    common.run_worker_process(
        Manager(),
        "workspace",
        worker,
        ["agent", "prompt"],
        client=SimpleNamespace(base_url="http://redtrace-server:8000"),
        project_id="proj_001",
        intent_id="i003",
        blackboard_revision=17,
        phase="explore_execute",
        timeout_seconds=10,
    )

    assert captured["REDTRACE_SERVER"] == "http://redtrace-server:8000"
    assert captured["REDTRACE_PROJECT_ID"] == "proj_001"
    assert captured["REDTRACE_WORKER"] == f"{worker_type}-worker"
    assert captured["REDTRACE_TASK_TYPE"] == "explore"
    assert captured["REDTRACE_INTENT_ID"] == "i003"
    assert captured["REDTRACE_BLACKBOARD_CURSOR"] == "17"
    assert "/.redtrace/blackboard-notices/" in captured["REDTRACE_BLACKBOARD_NOTICE"]
    assert captured["REDTRACE_BLACKBOARD_NOTICE"].endswith(".json")
    assert captured["REDTRACE_TEST_CONVERSATION_HOME"] == worker_type
    if worker_type == "claudecode":
        assert captured["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] == "1048576"
    elif worker_type == "pi":
        assert captured["PI_MODEL_CONTEXT_WINDOW"] == "1048576"

    worker.env.update(
        {
            "REDTRACE_SKILLS_DIR": "/skills",
            "REDTRACE_GLOBAL_INSTRUCTIONS": "skill policy",
        }
    )
    captured.clear()
    common.run_worker_process(
        Manager(),
        "workspace",
        worker,
        ["agent", "prompt"],
        client=SimpleNamespace(base_url="http://redtrace-server:8000"),
        project_id="proj_001",
        blackboard_revision=17,
        phase="reason_execute",
        timeout_seconds=10,
    )
    assert captured["REDTRACE_TASK_TYPE"] == "reason"
    assert not {
        "REDTRACE_SKILLS_DIR",
        "REDTRACE_GLOBAL_INSTRUCTIONS",
    } & captured.keys()


def test_running_worker_receives_blackboard_delta_notice(
    tmp_path: Path, monkeypatch
) -> None:
    writes: list[tuple[str, str]] = []
    queried_since: list[int] = []

    class Process:
        def set_output_handler(self, _handler):
            return None

        def start(self):
            return None

        def communicate(self, timeout):
            return ProcessResult(0, "", "")

    class Manager:
        def conversation_environment(self, _project_id, _worker_type):
            return {}

        def write_text_file(self, _name, path, content):
            writes.append((path, content))
            return path

        def build_exec_process(self, _name, _env, _argv, **_kwargs):
            return Process()

    class Client:
        base_url = "http://redtrace.test"

        def blackboard_changes(self, _project_id, since, **_context):
            queried_since.append(since)
            revision = 9 if len(queried_since) == 1 else 11
            return {
                "project": "proj_001",
                "since": since,
                "revision": revision,
                "changes": [
                    {
                        "revision": revision,
                        "kind": "fact",
                        "node_id": f"f{revision:03d}",
                    }
                ],
            }

    class Lease:
        callback = None

        def watch_blackboard(self, _revision, callback):
            self.callback = callback
            return True

        def attach_process(self, _process):
            return None

    class Publisher:
        def __init__(self, *_args, **_kwargs):
            return None

        def handle_output(self, *_args):
            return None

        def finish(self, _result):
            return None

        def fail(self, _exc):
            return None

        def close(self):
            return None

    monkeypatch.setattr(common, "AuditPublisher", Publisher)
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-worker",
            "type": "pi",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
        }
    )
    lease = Lease()
    workspace = tmp_path / "workspace"
    common.run_worker_process(
        Manager(),
        str(workspace),
        worker,
        ["agent", "prompt"],
        client=Client(),
        project_id="proj_001",
        intent_id="i003",
        blackboard_revision=7,
        phase="explore_execute",
        timeout_seconds=10,
        lease=lease,
    )

    initial = json.loads(writes[0][1])
    assert initial == {
        "project": "proj_001",
        "since": 7,
        "revision": 7,
        "changed": False,
        "changes": [],
    }
    assert lease.callback is not None
    lease.callback(7, 9)
    notice = json.loads(writes[-1][1])
    assert notice["changed"] is True
    assert notice["changes"][0]["node_id"] == "f009"
    lease.callback(9, 11)
    notice = json.loads(writes[-1][1])
    assert queried_since == [7, 7]
    assert notice["since"] == 7
    assert notice["changes"][0]["node_id"] == "f011"


def test_fact_source_exposes_worker_conversation(client: TestClient) -> None:
    project_id, baseline = _create_project(client)
    created = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "inspect https://target.test/login",
            "creator": "worker-a",
            "worker": "worker-a",
        },
    ).json()
    generation = db.current_blackboard_generation()
    run = {
        "id": "run-source-1",
        "project_id": project_id,
        "intent_id": created["id"],
        "task_type": "explore",
        "phase": "explore_execute",
        "worker": "worker-a",
        "provider": "codex",
        "workspace_kind": "local",
        "workspace_ref": "workspace",
        "workspace_root": "workspace",
        "status": "completed",
        "started_at": "2026-08-12T00:00:00Z",
    }
    events = [
        {
            "event_uid": "source-user",
            "run_sequence": 1,
            "timestamp": "2026-08-12T00:00:01Z",
            "kind": "user.message",
            "role": "user",
            "content": "inspect the login endpoint",
        },
        {
            "event_uid": "source-assistant",
            "run_sequence": 2,
            "timestamp": "2026-08-12T00:00:02Z",
            "kind": "assistant.message",
            "role": "assistant",
            "content": "credential reuse confirmed",
        },
    ]
    assert (
        client.post("/audit/events", json={"run": run, "events": events}).status_code
        == 200
    )
    assert db.current_blackboard_generation() == generation
    concluded = client.post(
        f"/projects/{project_id}/intents/{created['id']}/conclude",
        json={"worker": "worker-a", "description": "login works"},
    ).json()
    fact_id = concluded["fact"]["id"]
    assert db.current_blackboard_generation() > generation
    headers = {"X-RedTrace-Worker": "worker-b", "X-RedTrace-Task": "explore"}

    changes = client.get(
        f"/projects/{project_id}/blackboard/changes",
        params={"since": baseline, "include_source": True},
        headers=headers,
    ).json()["changes"]
    fact = next(change["node"] for change in changes if change["kind"] == "fact")
    assert fact["source"]["worker"] == "worker-a"
    assert fact["source"]["intent_id"] == created["id"]
    assert [event["content"] for event in fact["source"]["events"]] == [
        "inspect the login endpoint",
        "credential reuse confirmed",
    ]

    source = client.get(
        f"/projects/{project_id}/blackboard/facts/{fact_id}/source",
        headers=headers,
    ).json()
    assert source["found"] is True
    assert source["source"]["runs"][0]["id"] == "run-source-1"


def test_intent_ownership_changes_are_coordination_events(client: TestClient) -> None:
    project_id, baseline = _create_project(client)
    intent = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": ["origin"],
            "description": "inspect target",
            "creator": "reason",
            "worker": None,
        },
    ).json()
    assert (
        client.post(
            f"/projects/{project_id}/intents/{intent['id']}/claim",
            json={"worker": "worker-a"},
        ).status_code
        == 200
    )
    assert (
        client.post(
            f"/projects/{project_id}/intents/{intent['id']}/release",
            json={"worker": "worker-a"},
        ).status_code
        == 200
    )
    actions = [
        change["action"]
        for change in client.get(
            f"/projects/{project_id}/blackboard/changes",
            params={"since": baseline},
        ).json()["changes"]
    ]
    assert actions == ["added", "claimed", "released"]


def test_inbox_signals_only_related_facts_without_injecting_source_context(
    tmp_path: Path,
) -> None:
    writes: list[dict] = []
    signals: list[str] = []

    class Manager:
        def write_text_file(self, _container, path, content):
            writes.append(json.loads(content))
            return path

    def send_signal(message):
        signals.append(message)
        return True

    class Client:
        def wait_for_blackboard(self, *_args, **_kwargs):
            return 7

    inbox = common.BlackboardInbox(
        Client(),
        Manager(),
        str(tmp_path),
        project_id="proj_001",
        intent_id="i002",
        intent_description="test https://target.test/login",
        source_fact_ids=["origin", "f001"],
        worker_name="worker-b",
        revision=7,
    )
    inbox.on_process_attached(send_signal)
    try:
        related = {
            "revision": 8,
            "kind": "fact",
            "node_id": "f008",
            "action": "added",
            "node": {
                "description": "credential found",
                "source": {
                    "intent_id": "i001",
                    "intent_description": "inspect https://target.test/login",
                    "from": ["f001"],
                    "events": [{"kind": "assistant.message", "content": "use admin"}],
                },
            },
        }
        inbox._publish({"revision": 8, "changes": [related]})
        assert len(signals) == 1
        assert "f008" in signals[0]
        assert "credential found" in signals[0]
        assert "不要求采用" in signals[0]
        assert "use admin" not in signals[0]
        assert (
            writes[-1]["changes"][0]["node"]["source"]["events"][0]["content"]
            == "use admin"
        )

        unrelated = {
            **related,
            "revision": 9,
            "node_id": "f009",
            "node": {
                "description": "SMB result",
                "source": {
                    "intent_id": "i003",
                    "intent_description": "inspect 10.0.0.9:445",
                    "from": ["origin"],
                    "events": [],
                },
            },
        }
        inbox._publish({"revision": 9, "changes": [unrelated]})
        assert len(signals) == 1
    finally:
        inbox.stop()


def test_explore_turn_does_not_restart_process_for_fact_signal(monkeypatch) -> None:
    calls = []

    def fake_run(*args, **kwargs):
        calls.append((args, kwargs))
        return ProcessResult(0, '{"status":"success","description":"done"}', "")

    class Driver:
        def extract_session(self, session, _stdout, _stderr):
            return session

    control = SimpleNamespace(session_id="session-1")
    monkeypatch.setattr(explore, "_run_process", fake_run)
    worker = WorkerConfig.model_validate(
        {"name": "codex-1", "type": "codex", "max_running": 1, "priority": 0}
    )
    result, session = explore._run_with_steering(
        Driver(),
        SimpleNamespace(),
        "proj_001",
        "i002",
        SimpleNamespace(),
        "workspace",
        worker,
        SimpleNamespace(
            argv=["execute"],
            stdin="initial",
            session=None,
            live_control=control,
        ),
        session=None,
        phase="explore_execute",
        timeout=30,
        lease=SimpleNamespace(),
        cancellation=SimpleNamespace(),
        inbox=SimpleNamespace(),
    )
    assert result.returncode == 0
    assert session == "session-1"
    assert len(calls) == 1
    assert calls[0][1]["live_control"] is control
