from __future__ import annotations

import json

import pytest
from conftest import make_config
from pydantic import ValidationError
from redtrace.dispatcher.config import (
    DispatchConfig,
    LocalConfig,
    WorkerConfig,
    validate_prompt_resources
)
from redtrace.dispatcher.runtime.local_backend import LocalBackend


def test_dispatch_config_merges_common_env_with_worker_override() -> None:
    payload = make_config().model_dump()
    payload["common_env"] = {"SHARED": "common", "OVERRIDE": "common"}
    payload["workers"][0]["env"] = {"OVERRIDE": "worker"}

    config = DispatchConfig.model_validate(payload)

    assert config.workers[0].env["SHARED"] == "common"
    assert config.workers[0].env["OVERRIDE"] == "worker"


def test_dispatch_config_defaults_worker_healthcheck_and_rejects_unknown_mode() -> None:
    payload = make_config().model_dump()
    payload["runtime"].pop("worker_healthcheck")

    assert (
        DispatchConfig.model_validate(payload).runtime.worker_healthcheck
        == "startup_only"
    )

    payload["runtime"]["worker_healthcheck"] = "sometimes"
    with pytest.raises(ValidationError):
        DispatchConfig.model_validate(payload)








def test_dispatch_config_rejects_duplicate_workers() -> None:
    payload = make_config().model_dump()
    payload["workers"].append(dict(payload["workers"][0]))
    with pytest.raises(ValidationError, match="worker names must be unique"):
        DispatchConfig.model_validate(payload)


def test_runtime_limits_are_independently_configurable() -> None:
    payload = make_config().model_dump()
    payload["runtime"].update(
        max_workers=6,
        max_running_projects=7,
        max_project_workers=8,
    )
    payload["tasks"]["reason"]["max_intents"] = 9

    config = DispatchConfig.model_validate(payload)

    assert config.runtime.max_workers == 6
    assert config.runtime.max_running_projects == 7
    assert config.runtime.max_project_workers == 8
    assert config.tasks.reason.max_intents == 9


def test_mock_worker_rejects_unknown_phase_configuration() -> None:
    with pytest.raises(ValidationError, match="unsupported mock env keys"):
        WorkerConfig.model_validate(
            {
                "name": "mock",
                "provider": "mock",
                "max_running": 1,
                "priority": 0,
                "env": {"MOCK_UNKNOWN": "{}"},
            }
        )


def test_bundled_prompt_groups_have_required_placeholders() -> None:
    validate_prompt_resources("default")
    validate_prompt_resources("mock")


















def test_dsh_runtime_rejects_removed_routes_section() -> None:
    payload = make_config().model_dump()
    payload["runtime"].update({"execution": "local"})
    payload["providers"] = {
        "gw": {"api": "openai-completions", "base_url": "https://gw.test", "api_key": "sk-x"}
    }
    payload["workers"] = [_api_worker()]
    payload["dsh"] = {
        "routes": {
            name: {"provider": "mimo", "model": "mimo-v2.5-pro"}
            for name in ("bootstrap", "reason", "explore")
        }
    }
    with pytest.raises(ValidationError):
        DispatchConfig.model_validate(payload)


def _api_worker() -> dict:
    return {
        "name": "pi",
        "provider": "gw",
        "model": "deepseek-reasoner",
        "max_running": 1,
        "priority": 0,
    }
