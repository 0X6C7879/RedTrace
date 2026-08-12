from __future__ import annotations

import json
import io
import os
import tarfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from redtrace import blackboard_cli, resource_cli
from redtrace.capabilities import BLACKBOARD_CLI_PATH, RESOURCE_CLI_PATH, CapabilityStore, materialize_local_workspace, workspace_payload, workspace_tar
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

    assert blackboard_cli.main(["snapshot"]) == 0
    assert captured["url"] == "http://redtrace.test/projects/proj_007/blackboard/snapshot"


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
                    {"revision": revision, "kind": "fact", "node_id": f"f{revision:03d}"}
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


def test_prompt_guidance_requires_bounded_blackboard_refresh() -> None:
    prompt = add_blackboard_guidance("Do the task.", 23, hints='[{"content":"keep it"}]')
    assert "Graph snapshot revision 为 23" in prompt
    assert "`redtrace-blackboard snapshot`" in prompt
    assert "`redtrace-blackboard changes --since" in prompt
    assert "$REDTRACE_BLACKBOARD_NOTICE" in prompt
    assert "不得固定频率轮询" in prompt
    assert "$REDTRACE_WORKSPACE" in prompt
    assert "`<题目ID>/`" in prompt
    assert "由你依据当前任务性质自行决定" in prompt
    assert "`/tmp`" in prompt
    assert "通用解题脚本" in prompt
    assert "$REDTRACE_TOOLS_DIR" in prompt
    assert '"content":"keep it"' in prompt
    assert "Web 调研能力贯穿整个会话" in prompt
    assert "不限于第一轮" in prompt
    assert "后续任一对话轮次" in prompt
    assert "同时启用最多 5 个" in prompt


def test_prompt_guidance_describes_windows_local_shell() -> None:
    prompt = add_blackboard_guidance(
        "Do the task.",
        23,
        local_execution=True,
    )
    if os.name == "nt":
        assert "Windows local execution" in prompt
        assert "不得将 PowerShell syntax 传给 Bash" in prompt
        assert "rtk proxy powershell" in prompt
    else:
        assert "Windows local execution" not in prompt
