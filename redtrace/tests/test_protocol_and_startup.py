from __future__ import annotations

import requests
from redtrace.dispatcher import control_plane
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.runtime.startup_healthcheck import (
    StartupHealthcheckResult,
    format_failure_summary,
)
from redtrace.dispatcher.scheduler.loop import _local_cli_probe_command


def test_client_request_failure_returns_status_zero() -> None:
    class Session:
        def request(self, *_args, **_kwargs):
            raise requests.ConnectionError("offline")

    client = ControlPlaneClient("http://server/")
    client._local.session = Session()

    result = client.create_intent("proj_001", ["f001"], "investigate", "reasoner")

    assert result.status_code == 0
    assert result.text == "offline"


def test_control_plane_normalizes_base_url_and_reuses_thread_session(
    monkeypatch,
) -> None:
    sessions = []

    class Session:
        def __init__(self):
            self.closed = False
            self.mounts = []
            sessions.append(self)

        def mount(self, prefix, adapter):
            self.mounts.append((prefix, adapter))

        def close(self):
            self.closed = True

    monkeypatch.setattr(control_plane.requests, "Session", Session)
    client = ControlPlaneClient("http://server///")

    first = client._session()
    second = client._session()

    assert client.base_url == "http://server"
    assert first is second
    assert [prefix for prefix, _adapter in first.mounts] == ["http://", "https://"]

    client.close()

    assert sessions == [first]
    assert first.closed is True
    assert client._sessions == {}


def test_blackboard_changes_collects_all_pages() -> None:
    class Response:
        def __init__(self, payload):
            self.payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self.payload

    class Session:
        def __init__(self):
            self.calls = []
            self.responses = iter(
                [
                    Response(
                        {
                            "changes": [{"revision": 5}],
                            "revision": 6,
                            "next_revision": 5,
                            "has_more": True,
                        }
                    ),
                    Response(
                        {
                            "changes": [{"revision": 6}],
                            "revision": 6,
                            "next_revision": 6,
                            "has_more": False,
                        }
                    ),
                ]
            )

        def get(self, url, **kwargs):
            self.calls.append((url, kwargs))
            return next(self.responses)

    client = ControlPlaneClient("http://server")
    session = Session()
    client._local.session = session

    result = client.blackboard_changes(
        "proj_001",
        4,
        worker="worker-a",
        task_type="explore",
        intent_id="i001",
    )

    assert [call[1]["params"]["since"] for call in session.calls] == [4, 5]
    assert session.calls[0][1]["headers"] == {
        "X-RedTrace-Worker": "worker-a",
        "X-RedTrace-Task": "explore",
        "X-RedTrace-Intent": "i001",
    }
    assert result == {
        "project": "proj_001",
        "command": "changes",
        "since": 4,
        "revision": 6,
        "next_revision": 6,
        "has_more": False,
        "changes": [{"revision": 5}, {"revision": 6}],
    }


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
