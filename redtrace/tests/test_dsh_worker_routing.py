from __future__ import annotations

from pathlib import Path

import pytest
import yaml
from fastapi.testclient import TestClient
from redtrace.dispatcher.config import DispatchConfig
from redtrace.dispatcher.dsh import dsh_providers, dsh_workers
from redtrace.server import db
from redtrace.server.app import app


def _raw_config() -> dict:
    return {
        "server": "http://127.0.0.1:8000",
        "runtime": {
            "execution": "local",
            "worker_healthcheck": "startup_only",
            "interval": 3,
            "max_workers": 3,
            "max_running_projects": 2,
            "max_project_workers": 2,
            "healthcheck_timeout": 5,
            "prompt_group": "default",
        },
        "tasks": {
            "bootstrap": {"timeout": 20, "conclude_timeout": 10},
            "reason": {"timeout": 20, "max_intents": 3},
            "explore": {"timeout": 20, "conclude_timeout": 10},
        },
        "providers": {
            "gw": {
                "api": "openai-completions",
                "base_url": "https://api.example.test",
                "api_key": "sk-gw-secret",
                "models": [
                    {
                        "id": "deepseek-reasoner",
                        "context_window": 131072,
                        "max_tokens": 8192,
                        "thinking_format": "deepseek",
                    },
                    {
                        "id": "deepseek-chat",
                        "context_window": 262144,
                        "max_tokens": 8192,
                        "thinking_format": "none",
                    },
                ],
            },
            "anthropic-gw": {
                "api": "anthropic-messages",
                "base_url": "https://claude.example.test",
                "api_key": "sk-claude-secret",
                "models": [
                    {
                        "id": "claude-model",
                        "context_window": 1000000,
                        "max_tokens": 128000,
                        "thinking_format": "none",
                    }
                ],
            },
        },
        "workers": [],
    }


def _gw_worker(
    name: str = "primary",
    priority: int = 0,
    model: str = "deepseek-reasoner",
    enabled: bool = True,
    **flags: bool,
) -> dict:
    return {
        "name": name,
        "provider": "gw",
        "model": model,
        "enabled": enabled,
        "bootstrap": flags.get("bootstrap", True),
        "reason": flags.get("reason", True),
        "explore": flags.get("explore", True),
        "max_running": 2,
        "priority": priority,
    }


def _claude_worker(name: str = "claude", priority: int = 0, enabled: bool = True) -> dict:
    return {
        "name": name,
        "provider": "anthropic-gw",
        "model": "claude-model",
        "enabled": enabled,
        "bootstrap": False,
        "reason": False,
        "explore": True,
        "max_running": 1,
        "priority": priority,
    }


def test_dsh_workers_is_the_worker_centric_routing_view() -> None:
    raw = _raw_config()
    raw["workers"] = [_claude_worker(priority=0), _gw_worker(priority=1)]
    workers = dsh_workers(DispatchConfig.model_validate(raw))

    by_name = {worker["name"]: worker for worker in workers}
    assert by_name["claude"] == {
        "name": "claude",
        "enabled": True,
        "provider": "anthropic-gw",
        "model": "claude-model",
        "bootstrap": False,
        "reason": False,
        "explore": True,
        "maxRunning": 1,
        "priority": 0,
    }
    assert by_name["primary"]["reason"] is True
    assert by_name["primary"]["maxRunning"] == 2


def test_dsh_workers_skip_mock_and_disabled_workers_stay_visible() -> None:
    raw = _raw_config()
    raw["workers"] = [
        {"name": "mock-1", "provider": "mock", "max_running": 1, "priority": 0},
        _gw_worker(name="off", enabled=False),
        _gw_worker(name="on"),
    ]
    workers = dsh_workers(DispatchConfig.model_validate(raw))

    by_name = {worker["name"]: worker for worker in workers}
    assert "mock-1" not in by_name
    assert by_name["off"]["enabled"] is False
    assert by_name["on"]["enabled"] is True


def test_dsh_providers_serve_per_model_capacities_and_thinking() -> None:
    raw = _raw_config()
    raw["workers"] = [
        _gw_worker(
            name="reasoner",
            priority=0,
            model="deepseek-reasoner",
            reason=True,
            bootstrap=False,
            explore=False,
        ),
        _gw_worker(
            name="explorer",
            priority=1,
            model="deepseek-chat",
            reason=False,
            bootstrap=False,
            explore=True,
        ),
    ]
    config = DispatchConfig.model_validate(raw)
    providers, keys = dsh_providers(config)

    assert list(providers) == ["gw"]
    models = {model["id"]: model for model in providers["gw"]["models"]}
    assert models["deepseek-reasoner"]["contextWindow"] == 131072
    assert models["deepseek-reasoner"]["maxTokens"] == 8192
    assert models["deepseek-reasoner"]["compat"] == {"thinkingFormat": "deepseek"}
    assert models["deepseek-chat"]["contextWindow"] == 262144
    assert "compat" not in models["deepseek-chat"]
    assert providers["gw"]["apiKeyEnv"] == "REDTRACE_DSH_KEY_GW"
    assert keys == {"REDTRACE_DSH_KEY_GW": "sk-gw-secret"}


def test_worker_referencing_undeclared_provider_is_rejected() -> None:
    raw = _raw_config()
    raw["workers"] = [
        {"name": "bad", "provider": "missing", "model": "m", "max_running": 1, "priority": 0}
    ]
    with pytest.raises(ValueError, match="undeclared provider 'missing'"):
        DispatchConfig.model_validate(raw)


def test_worker_referencing_undeclared_model_is_rejected() -> None:
    raw = _raw_config()
    raw["workers"] = [_gw_worker(model="gpt-unknown")]
    with pytest.raises(ValueError, match="not declared by provider 'gw'"):
        DispatchConfig.model_validate(raw)


@pytest.fixture
def runtime_client(tmp_path, monkeypatch) -> TestClient:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["workers"] = [_gw_worker(), _claude_worker(priority=1)]
    config_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")
    monkeypatch.setenv("REDTRACE_DISPATCH_CONFIG", str(config_path))
    monkeypatch.setattr(db, "_db_path", None)
    db.configure(tmp_path / "redtrace.db")
    with TestClient(app) as client:
        yield client


def test_runtime_config_endpoint_serves_worker_centric_snapshot(
    runtime_client: TestClient, tmp_path: Path
) -> None:
    response = runtime_client.get("/runtime/config")
    assert response.status_code == 200
    payload = response.json()

    workers = {worker["name"]: worker for worker in payload["workers"]}
    assert set(workers) == {"primary", "claude"}
    assert workers["claude"]["explore"] is True
    assert workers["claude"]["reason"] is False
    assert workers["primary"]["provider"] == "gw"
    assert payload["providers"]["gw"]["apiKeyEnv"] == "REDTRACE_DSH_KEY_GW"
    assert payload["providers"]["gw"]["baseURL"] == "https://api.example.test"
    assert payload["providers"]["gw"]["api"] == "openai-completions"
    assert payload["env"]["REDTRACE_DSH_KEY_GW"] == "sk-gw-secret"
    assert payload["env"]["REDTRACE_DSH_KEY_ANTHROPIC_GW"] == "sk-claude-secret"
    assert payload["limits"]["maxWorkers"] == 3
    assert payload["limits"]["interval"] == 3
    assert len(payload["revision"]) == 64

    config_path = tmp_path / "redtrace.yaml"
    raw = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    raw["workers"][0]["model"] = "deepseek-chat"
    raw["workers"][0]["explore"] = False
    config_path.write_text(yaml.safe_dump(raw, sort_keys=False), encoding="utf-8")

    refreshed = runtime_client.get("/runtime/config").json()
    refreshed_workers = {worker["name"]: worker for worker in refreshed["workers"]}
    assert refreshed_workers["primary"]["model"] == "deepseek-chat"
    assert refreshed_workers["primary"]["explore"] is False
    assert refreshed["providers"]["gw"]["models"] == [
        {
            "id": "deepseek-reasoner",
            "name": "deepseek-reasoner",
            "contextWindow": 131072,
            "maxTokens": 8192,
            "compat": {"thinkingFormat": "deepseek"},
        },
        {
            "id": "deepseek-chat",
            "name": "deepseek-chat",
            "contextWindow": 262144,
            "maxTokens": 8192,
        },
    ]
    assert refreshed["revision"] != payload["revision"]
