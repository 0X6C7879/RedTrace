from __future__ import annotations

import json
import io
import tarfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from redtrace import blackboard_cli
from redtrace.capabilities import BLACKBOARD_CLI_PATH, CapabilityStore, materialize_local_workspace, workspace_payload, workspace_tar
from redtrace.dispatcher.config import WorkerConfig
from redtrace.dispatcher.prompting import add_blackboard_guidance
from redtrace.dispatcher.runtime.process import ProcessResult
from redtrace.dispatcher.tasks import common
from redtrace.server import db
from redtrace.server.app import app


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


def test_blackboard_status_changes_node_path_context_and_audit(client: TestClient) -> None:
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
    assert status.json()["counts"] == {"facts": 2, "intents": 0, "hints": 1}

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
    assert [change["kind"] for change in changes["changes"]] == ["intent", "fact"]
    assert changes["next_revision"] == changes["revision"]
    assert changes["has_more"] is False
    assert changes["changes"][1]["node"]["description"] == "new shared fact"

    node = client.get(f"/projects/{project_id}/blackboard/nodes/{fact_id}", headers=headers).json()
    assert node["found"] is True
    assert node["node"] == {"kind": "fact", "id": fact_id, "description": "new shared fact"}

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
    assert {item["id"] for item in context["nodes"]} == {intent_id, "origin", fact_id}
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
    assert captured["url"] == "http://redtrace.test/projects/proj_007/blackboard/status?since=41"
    assert captured["headers"]["X-redtrace-worker"] == "pi-1"
    assert captured["headers"]["X-redtrace-task"] == "reason"
    assert captured["headers"]["X-redtrace-intent"] == "i009"
    assert json.loads(capsys.readouterr().out) == {"changed": False, "revision": 41}


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
    _, files = workspace_payload(CapabilityStore(tmp_path / "capabilities"))
    with tarfile.open(fileobj=io.BytesIO(workspace_tar(files)), mode="r:") as archive:
        assert archive.getmember(BLACKBOARD_CLI_PATH).mode == 0o755


@pytest.mark.parametrize("worker_type", ["claudecode", "codex", "pi"])
def test_worker_process_receives_read_only_blackboard_context(monkeypatch, worker_type: str) -> None:
    captured: dict = {}

    class Process:
        def set_output_handler(self, _handler):
            return None

        def start(self):
            return None

        def communicate(self, timeout):
            return ProcessResult(0, "", "")

    class Manager:
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
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
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


def test_prompt_guidance_is_optional_and_forbids_polling() -> None:
    prompt = add_blackboard_guidance("Do the task.", 23)
    assert "revision 23" in prompt
    assert "`redtrace-blackboard`" in prompt
    assert "do not poll it" in prompt
    assert "fixed frequency" in prompt
    assert "may call" in prompt
