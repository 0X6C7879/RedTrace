from __future__ import annotations

import requests
from redtrace.dispatcher import control_plane
from redtrace.dispatcher.control_plane import ControlPlaneClient
from redtrace.dispatcher.runtime.startup_healthcheck import (
    StartupHealthcheckResult,
    format_failure_summary,
)


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


def test_dsh_environment_forwards_common_env_with_scrub_allowlist(
    tmp_path, monkeypatch
) -> None:
    from redtrace import startup
    from redtrace.dispatcher.config import DispatchConfig

    manager = type("Manager", (), {"dsh_mcp_configs": staticmethod(lambda: [])})()
    monkeypatch.setattr(
        "redtrace.agent_runtime.AgentRuntimeManager", lambda *a, **k: manager
    )

    config = DispatchConfig.model_validate(
        {
            "server": "http://127.0.0.1:8000",
            "paths": {"root": str(tmp_path)},
            "runtime": {
                "execution": "local",
                "interval": 3,
                "max_workers": 1,
                "max_running_projects": 1,
                "max_project_workers": 1,
                "healthcheck_timeout": 5,
                "prompt_group": "default",
            },
            "tasks": {
                "bootstrap": {"timeout": 20, "conclude_timeout": 10},
                "reason": {"timeout": 20, "conclude_timeout": 10},
                "explore": {"timeout": 20, "conclude_timeout": 10},
            },
            "common_env": {
                "BENCHMARK_BASE_URL": "https://benchmark.example.test",
                "BENCHMARK_TOKEN": "benchmark-secret",
            },
            "providers": {
                "gw": {
                    "api": "openai-completions",
                    "base_url": "https://api.example.test",
                    "api_key": "sk-test",
                    "models": [{"id": "m1", "context_window": 8192, "max_tokens": 1024}],
                }
            },
            "workers": [
                {
                    "name": "w1",
                    "provider": "gw",
                    "model": "m1",
                    "bootstrap": True,
                    "reason": True,
                    "explore": True,
                }
            ],
        }
    )

    child_env = startup._dsh_environment(config, tmp_path, "http://127.0.0.1:8000", "127.0.0.1", 8100)

    assert child_env["BENCHMARK_TOKEN"] == "benchmark-secret"
    assert child_env["BENCHMARK_BASE_URL"] == "https://benchmark.example.test"
    # The allowlist is what carries credential-shaped names past the DSH
    # subprocess scrub into worker shells.
    assert child_env["DSH_FORWARD_ENV"] == "BENCHMARK_BASE_URL,BENCHMARK_TOKEN"
