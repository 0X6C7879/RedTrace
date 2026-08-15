from __future__ import annotations

from io import StringIO

import pytest

from redtrace import resource_cli


def _parse(*argv: str):
    return resource_cli.build_parser().parse_args(
        [
            "--server",
            "http://redtrace.test",
            "--project",
            "p001",
            "--worker",
            "codex-1",
            *argv,
        ]
    )


def test_worker_can_lock_and_unlock_shared_resource(monkeypatch) -> None:
    requests = []

    def request(args, method, path, **kwargs):
        requests.append((method, path, kwargs.get("body")))
        return {"ok": True}

    monkeypatch.setattr(resource_cli, "_request", request)
    assert resource_cli._perform(_parse("lock", "file_123")) == {"ok": True}
    assert resource_cli._perform(_parse("unlock", "file_123")) == {"ok": True}
    assert requests == [
        (
            "POST",
            "/projects/p001/resources/file_123/lock",
            {"actor_type": "worker", "actor": "codex-1"},
        ),
        (
            "POST",
            "/projects/p001/resources/file_123/unlock",
            {"actor_type": "worker", "actor": "codex-1"},
        ),
    ]


def test_listener_and_payload_commands_use_worker_aware_api(monkeypatch) -> None:
    calls: list[tuple[str, str, dict | None, dict | None]] = []

    def request(args, method, path, *, params=None, body=None):
        calls.append((method, path, params, body))
        return {"ok": True}

    monkeypatch.setattr(resource_cli, "_request", request)

    listener = resource_cli._perform(
        _parse(
            "listener-create",
            "--name",
            "primary",
            "--listener-type",
            "http_beacon",
            "--bind-port",
            "8443",
            "--callback-host",
            "c2.example.test",
        )
    )
    oneliner = resource_cli._perform(
        _parse(
            "payload-oneliner",
            "lis_123",
            "curl_beacon",
            "--callback-host",
            "edge.example.test",
        )
    )
    built = resource_cli._perform(
        _parse("payload-build", "lis_123", "--os", "windows", "--arch", "amd64")
    )

    assert listener == {"ok": True}
    assert oneliner == {"ok": True}
    assert built == {"ok": True}
    assert calls[0] == (
        "POST",
        "/projects/p001/resources",
        None,
        {
            "kind": "c2_listener",
            "name": "primary",
            "target": "0.0.0.0:8443",
            "summary": "",
            "status": "available",
            "metadata": {
                "listener_type": "http_beacon",
                "bind_host": "0.0.0.0",
                "bind_port": 8443,
                "callback_host": "c2.example.test",
                "profile_id": "",
            },
            "actor_type": "worker",
            "actor": "codex-1",
            "worker": "codex-1",
            "intent_id": None,
        },
    )
    assert calls[1][1:] == (
        "/projects/p001/c2/payloads/oneliner",
        None,
        {
            "listener_id": "lis_123",
            "kind": "curl_beacon",
            "callback_host": "edge.example.test",
        },
    )
    assert calls[2][3]["actor"] == "codex-1"


def test_worker_registers_direct_session_credential_and_custom_payload(monkeypatch) -> None:
    calls = []

    def request(args, method, path, *, params=None, body=None):
        calls.append((method, path, body))
        return {"ok": True}

    monkeypatch.setattr(resource_cli, "_request", request)
    monkeypatch.setattr(resource_cli.sys, "stdin", StringIO('{"password":"secret"}'))
    resource_cli._perform(
        _parse(
            "session-register", "--name", "winrm", "--target", "10.0.0.8",
            "--shell-type", "evil_winrm", "--secret-stdin",
        )
    )
    monkeypatch.setattr(resource_cli.sys, "stdin", StringIO('{"value":"krbtgt-hash"}'))
    resource_cli._perform(
        _parse(
            "credential-create", "--name", "krbtgt", "--credential-type",
            "active_directory", "--domain", "LAB", "--secret-stdin",
        )
    )
    resource_cli._perform(
        _parse(
            "payload-import", "--name", "custom.exe", "--target", "artifact://custom.exe",
            "--framework", "sliver", "--listener", "lis_123",
        )
    )

    assert [call[2]["kind"] for call in calls] == ["c2_session", "credential_ref", "c2_payload"]
    assert calls[0][2]["metadata"]["shell_type"] == "evil_winrm"
    assert calls[1][2]["secret"] == {"value": "krbtgt-hash"}
    assert calls[2][2]["metadata"] == {"format": "custom", "framework": "sliver", "custom": True}


def test_listener_create_only_accepts_supported_transports() -> None:
    assert _parse(
        "listener-create", "--name", "reverse", "--listener-type", "tcp_reverse",
        "--bind-port", "4444",
    ).listener_type == "tcp_reverse"
    assert _parse(
        "listener-create", "--name", "dns", "--listener-type", "external_c2",
        "--bind-port", "53", "--adapter-endpoint", "http://adapter.test",
    ).listener_type == "external_c2"
    with pytest.raises(SystemExit):
        _parse(
            "listener-create", "--name", "fake", "--listener-type", "sliver",
            "--bind-port", "4444",
        )


def test_webshell_create_reads_password_from_stdin_without_echo(monkeypatch) -> None:
    captured: dict = {}

    def request(args, method, path, *, params=None, body=None):
        captured.update({"method": method, "path": path, "body": body})
        return {"resource": {"id": "ws_123"}}

    monkeypatch.setattr(resource_cli, "_request", request)
    monkeypatch.setattr(resource_cli.sys, "stdin", StringIO("p@ssword\n"))

    result = resource_cli._perform(
        _parse(
            "webshell-create",
            "--name",
            "primary",
            "--target",
            "https://target.test/shell.php",
            "--command-param",
            "cmd",
            "--password-stdin",
        )
    )

    assert result["resource"]["id"] == "ws_123"
    assert captured["body"]["secret"] == {"password": "p@ssword"}
    assert captured["body"]["actor_type"] == "worker"
    assert captured["body"]["worker"] == "codex-1"


def test_snapshot_changes_and_waiting_run_are_bounded(monkeypatch) -> None:
    calls: list[tuple[str, str, dict | None]] = []
    task_states = iter(
        [
            {"task": {"id": "op_123", "status": "running"}},
            {
                "task": {
                    "id": "op_123",
                    "status": "succeeded",
                    "output_summary": "uid=33",
                }
            },
        ]
    )

    def request(args, method, path, *, params=None, body=None):
        calls.append((method, path, params))
        if method == "POST":
            return {"task": {"id": "op_123", "status": "queued"}}
        if "/operations/tasks/" in path:
            return next(task_states)
        return {"audit_cursor": 7, "resources": []}

    monkeypatch.setattr(resource_cli, "_request", request)
    monkeypatch.setattr(resource_cli.time, "sleep", lambda _: None)

    snapshot = resource_cli._perform(
        _parse("snapshot", "--kind", "webshell", "--kind", "c2_session")
    )
    changes = resource_cli._perform(_parse("changes", "--since", "7"))
    completed = resource_cli._perform(
        _parse(
            "run",
            "ws_123",
            "command",
            "--command-text",
            "id",
            "--wait",
            "--poll-interval",
            "0.05",
        )
    )

    assert snapshot["audit_cursor"] == 7
    assert changes["audit_cursor"] == 7
    assert completed["task"]["status"] == "succeeded"
    assert calls[0] == (
        "GET",
        "/projects/p001/operations/snapshot",
        {"kinds": "webshell,c2_session", "limit": 100},
    )
    assert calls[1] == (
        "GET",
        "/projects/p001/operations/audit",
        {"since": 7, "limit": 100, "order": "asc"},
    )
    assert calls[-1][1] == "/projects/p001/operations/tasks/op_123"


def test_capabilities_tell_worker_to_create_channels_and_refresh_once() -> None:
    capabilities = resource_cli._perform(_parse("capabilities"))
    workflow = " ".join(capabilities["workflow"])

    assert "create a Listener and generate a Payload" in workflow
    assert "webshell-create" in workflow
    assert "changes once" in workflow
    assert "do not poll changes at a fixed frequency" in workflow
