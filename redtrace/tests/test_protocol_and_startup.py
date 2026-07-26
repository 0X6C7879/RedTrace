from __future__ import annotations

import requests

from redtrace.dispatcher.protocol.client import CairnClient
from redtrace.dispatcher.runtime.startup_healthcheck import (
    StartupHealthcheckResult,
    format_failure_summary,
)
from redtrace.dispatcher.scheduler.loop import _local_cli_probe_command


def test_client_request_failure_returns_status_zero() -> None:
    class Session:
        def request(self, *_args, **_kwargs):
            raise requests.ConnectionError("offline")

    client = CairnClient("http://server/")
    client._local.session = Session()

    result = client.create_intent("proj_001", ["f001"], "investigate", "reasoner")

    assert result.status_code == 0
    assert result.text == "offline"


def test_windows_cli_probe_runs_cmd_shims_through_comspec(monkeypatch) -> None:
    monkeypatch.setenv("COMSPEC", r"C:\Windows\System32\cmd.exe")

    command = _local_cli_probe_command(
        r"C:\Users\user\AppData\Roaming\npm\claude.CMD",
        platform="nt",
    )

    assert command[:4] == [
        r"C:\Windows\System32\cmd.exe",
        "/d",
        "/s",
        "/c",
    ]
    assert "claude.CMD" in command[4]
    assert "--help" in command[4]


def test_non_windows_cli_probe_executes_resolved_path_directly() -> None:
    assert _local_cli_probe_command("/usr/local/bin/codex", platform="posix") == [
        "/usr/local/bin/codex",
        "--help",
    ]


def test_startup_healthcheck_failure_summary_includes_worker_details() -> None:
    results = [
        StartupHealthcheckResult(
            worker_name="worker-a",
            ok=False,
            status=401,
            duration_ms=12,
            detail="unauthorized",
            endpoint="POST http://api/v1/messages",
        ),
        StartupHealthcheckResult(
            worker_name="worker-b",
            ok=True,
            status=200,
            duration_ms=8,
            detail="",
            endpoint="POST http://api/v1/messages",
        ),
    ]

    summary = format_failure_summary(results)

    assert summary == (
        "startup healthchecks failed for all workers: worker-a(http=401, detail=unauthorized)"
    )
