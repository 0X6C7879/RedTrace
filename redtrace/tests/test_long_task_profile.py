from __future__ import annotations

import importlib.util
from pathlib import Path
from types import ModuleType


def _load_migrator() -> ModuleType:
    path = Path(__file__).resolve().parents[2] / "scripts" / "apply-long-task-profile.py"
    spec = importlib.util.spec_from_file_location("redtrace_long_task_profile", path)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_profile_raises_legacy_limits_and_configures_pi() -> None:
    migrator = _load_migrator()
    config = {
        "runtime": {"healthcheck_timeout": 15},
        "tasks": {
            "bootstrap": {"timeout": 120, "conclude_timeout": 30},
            "reason": {"timeout": 45},
            "explore": {"timeout": 600, "conclude_timeout": 120},
        },
        "context_harness": {
            "inline_bytes": 32768,
            "visible_bytes": 8192,
            "query_bytes": 65536,
            "parse_bytes": 16777216,
            "worker_output_chars": 8388608,
        },
        "workers": [{"name": "pi", "type": "pi", "env": {}}],
    }

    changes = migrator.apply_profile(config)

    assert changes
    assert config["runtime"]["healthcheck_timeout"] == 60
    assert config["tasks"]["bootstrap"] == {
        "timeout": 7200,
        "conclude_timeout": 1800,
    }
    assert config["tasks"]["reason"]["timeout"] == 1800
    assert config["tasks"]["explore"] == {
        "timeout": 14400,
        "conclude_timeout": 1800,
    }
    assert config["context_harness"] == {
        "inline_bytes": 262144,
        "visible_bytes": 131072,
        "query_bytes": 1048576,
        "parse_bytes": 67108864,
        "worker_output_chars": 33554432,
    }
    assert config["workers"][0]["env"]["PI_MODEL_CONTEXT_WINDOW"] == "1048576"


def test_profile_preserves_larger_custom_values() -> None:
    migrator = _load_migrator()
    config = {
        "runtime": {"healthcheck_timeout": 120},
        "tasks": {
            "bootstrap": {"timeout": 28800, "conclude_timeout": 3600},
            "reason": {"timeout": 3600},
            "explore": {"timeout": 28800, "conclude_timeout": 3600},
        },
        "context_harness": {
            "inline_bytes": 1048576,
            "visible_bytes": 524288,
            "query_bytes": 4194304,
            "parse_bytes": 268435456,
            "worker_output_chars": 67108864,
        },
        "workers": [
            {
                "name": "pi",
                "type": "pi",
                "env": {"PI_MODEL_CONTEXT_WINDOW": "2097152"},
            }
        ],
    }
    original = {
        "runtime": dict(config["runtime"]),
        "tasks": {name: dict(value) for name, value in config["tasks"].items()},
        "context_harness": dict(config["context_harness"]),
        "pi_context": config["workers"][0]["env"]["PI_MODEL_CONTEXT_WINDOW"],
    }

    changes = migrator.apply_profile(config)

    assert changes == []
    assert config["runtime"] == original["runtime"]
    assert config["tasks"] == original["tasks"]
    assert config["context_harness"] == original["context_harness"]
    assert config["workers"][0]["env"]["PI_MODEL_CONTEXT_WINDOW"] == original["pi_context"]
