from __future__ import annotations

import json
from pathlib import Path
from types import SimpleNamespace

import redtrace.worker_config as worker_config_module
import tomllib
import yaml
from redtrace.dispatcher.config import (
    MODEL_CONTEXT_1M,
    DispatchConfig,
    WorkerConfig,
    model_auto_compact_token_limit,
)
from redtrace.dispatcher.workers.health import HealthResult
from redtrace.native_cli_config import sync_native_cli_config
from redtrace.worker_config import CONNECTION_TESTER, WorkerConfigService


def _worker(worker_type: str) -> WorkerConfig:
    environments = {
        "claudecode": {
            "ANTHROPIC_BASE_URL": "https://gateway.example/anthropic",
            "ANTHROPIC_AUTH_TOKEN": "claude-secret",
            "ANTHROPIC_MODEL": "claude-test",
        },
        "codex": {
            "CODEX_BASE_URL": "https://gateway.example/openai/v1",
            "OPENAI_API_KEY": "codex-secret",
            "CODEX_MODEL": "gpt-test",
        },
        "pi": {
            "PI_BASE_URL": "https://gateway.example/openai/v1",
            "PI_API_KEY": "pi-secret",
            "PI_MODEL": "pi-test",
            "PI_PROVIDER_API": "openai-responses",
        },
    }
    return WorkerConfig.model_validate(
        {
            "name": f"{worker_type}-primary",
            "type": worker_type,
            "max_running": 1,
            "priority": 0,
            "context_length": MODEL_CONTEXT_1M,
            "env": environments[worker_type],
        }
    )


def _local_config(worker: WorkerConfig) -> DispatchConfig:
    return DispatchConfig.model_validate(
        {
            "server": "http://127.0.0.1:8000",
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
                "reason": {"timeout": 20, "max_intents": 1},
                "explore": {"timeout": 20, "conclude_timeout": 10},
            },
            "local": {},
            "workers": [worker.model_dump()],
        }
    )


def test_configured_local_worker_tests_gateway_without_executing_cli(
    monkeypatch,
) -> None:
    worker = _worker("claudecode")
    config = _local_config(worker)

    class FakeDriver:
        @staticmethod
        def check_health(_worker, *, timeout):
            assert timeout == 5
            return HealthResult(ok=True, status=200, detail="gateway available")

    monkeypatch.setattr(
        worker_config_module.shutil,
        "which",
        lambda _binary: (_ for _ in ()).throw(
            AssertionError("CLI lookup is not expected")
        ),
    )
    monkeypatch.setattr(
        worker_config_module,
        "get_driver",
        lambda worker_type, execution: (
            FakeDriver()
            if (worker_type, execution) == ("claudecode", "container")
            else (_ for _ in ()).throw(AssertionError("unexpected driver lookup"))
        ),
    )

    result = CONNECTION_TESTER._probe(config, worker)

    assert result["ok"] is True
    assert result["status"] == 200
    assert result["detail"] == "gateway available"


def test_unconfigured_local_worker_uses_version_for_cli_probe(monkeypatch) -> None:
    worker = WorkerConfig.model_validate(
        {
            "name": "claude-native",
            "type": "claudecode",
            "max_running": 1,
            "priority": 0,
        }
    )
    config = _local_config(worker)
    calls: list[list[str]] = []

    class FakeDriver:
        @staticmethod
        def local_binary():
            return "claude"

    monkeypatch.setattr(
        worker_config_module.shutil, "which", lambda _binary: "/cli/claude"
    )
    monkeypatch.setattr(
        worker_config_module,
        "get_driver",
        lambda worker_type, execution: (
            FakeDriver()
            if (worker_type, execution) == ("claudecode", "local")
            else (_ for _ in ()).throw(AssertionError("unexpected driver lookup"))
        ),
    )
    monkeypatch.setattr(
        worker_config_module.subprocess,
        "run",
        lambda argv, **_kwargs: calls.append(argv) or SimpleNamespace(returncode=0),
    )

    result = CONNECTION_TESTER._probe(config, worker)

    assert result["ok"] is True
    assert calls == [["/cli/claude", "--version"]]


def test_claude_settings_merge_preserves_existing_values(tmp_path: Path) -> None:
    path = tmp_path / ".claude" / "settings.json"
    path.parent.mkdir(parents=True)
    path.write_text(
        json.dumps(
            {
                "theme": "dark",
                "hooks": {"SessionStart": []},
                "env": {"KEEP_ME": "yes"},
            }
        ),
        encoding="utf-8",
    )

    sync_native_cli_config(tmp_path, _worker("claudecode"))

    value = json.loads(path.read_text(encoding="utf-8"))
    assert value["theme"] == "dark"
    assert value["hooks"] == {"SessionStart": []}
    assert value["model"] == "claude-test"
    assert value["env"] == {
        "KEEP_ME": "yes",
        "ANTHROPIC_BASE_URL": "https://gateway.example/anthropic",
        "ANTHROPIC_AUTH_TOKEN": "claude-secret",
        "ANTHROPIC_MODEL": "claude-test",
        "ANTHROPIC_DEFAULT_SONNET_MODEL": "claude-test",
        "ANTHROPIC_DEFAULT_OPUS_MODEL": "claude-test",
        "ANTHROPIC_DEFAULT_HAIKU_MODEL": "claude-test",
        "CLAUDE_CODE_SUBAGENT_MODEL": "claude-test",
        "CLAUDE_CODE_AUTO_COMPACT_WINDOW": str(MODEL_CONTEXT_1M),
        "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "90",
        "CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION": "1000",
        "CLAUDE_CODE_USER_PROMPT_APPEND": "\n请始终使用中文进行思考、分析和回答。",
        "MAX_THINKING_TOKENS": "31999",
    }


def test_codex_config_merge_is_valid_preserves_other_tables_and_is_idempotent(
    tmp_path: Path,
) -> None:
    path = tmp_path / ".codex" / "config.toml"
    path.parent.mkdir(parents=True)
    path.write_text(
        """
model = "old-model"
approval_policy = "never"

[features]
shell_snapshot = true

[model_providers.other]
name = "Other"
base_url = "https://other.example/v1"

[model_providers.redtrace]
name = "Old RedTrace"
base_url = "https://old.example/v1"
""".lstrip(),
        encoding="utf-8",
    )

    sync_native_cli_config(tmp_path, _worker("codex"))
    first = path.read_text(encoding="utf-8")
    sync_native_cli_config(tmp_path, _worker("codex"))
    second = path.read_text(encoding="utf-8")
    value = tomllib.loads(second)
    auth = json.loads((tmp_path / ".codex" / "auth.json").read_text(encoding="utf-8"))

    assert first == second
    assert value["model"] == "gpt-test"
    assert value["model_provider"] == "redtrace"
    assert value["approval_policy"] == "never"
    assert value["sandbox_mode"] == "danger-full-access"
    assert value["web_search"] == "live"
    assert value["model_reasoning_summary"] == "detailed"
    assert value["model_context_window"] == MODEL_CONTEXT_1M
    assert value["model_auto_compact_token_limit"] == model_auto_compact_token_limit(
        MODEL_CONTEXT_1M
    )
    assert value["model_auto_compact_token_limit_scope"] == "total"
    assert value["features"]["shell_snapshot"] is True
    assert value["model_providers"]["other"]["name"] == "Other"
    assert value["model_providers"]["redtrace"] == {
        "name": "RedTrace",
        "base_url": "https://gateway.example/openai/v1",
        "wire_api": "responses",
        "env_key": "OPENAI_API_KEY",
    }
    assert "codex-secret" not in second
    assert auth["OPENAI_API_KEY"] == "codex-secret"


def test_pi_settings_and_models_merge_preserves_other_providers(tmp_path: Path) -> None:
    root = tmp_path / ".pi" / "agent"
    root.mkdir(parents=True)
    (root / "settings.json").write_text(
        json.dumps({"theme": "dark"}),
        encoding="utf-8",
    )
    (root / "models.json").write_text(
        json.dumps({"providers": {"other": {"baseUrl": "https://other.example"}}}),
        encoding="utf-8",
    )

    sync_native_cli_config(tmp_path, _worker("pi"))

    settings = json.loads((root / "settings.json").read_text(encoding="utf-8"))
    models = json.loads((root / "models.json").read_text(encoding="utf-8"))
    assert settings == {
        "theme": "dark",
        "defaultProvider": "redtrace",
        "defaultModel": "pi-test",
        "compaction": {
            "enabled": True,
            "reserveTokens": 64 * 1024,
            "keepRecentTokens": 128 * 1024,
        },
        "systemPromptAppend": "请始终使用中文进行思考、分析和回答。",
    }
    assert models["providers"]["other"]["baseUrl"] == "https://other.example"
    assert models["providers"]["redtrace"] == {
        "baseUrl": "https://gateway.example/openai/v1",
        "apiKey": "pi-secret",
        "api": "openai-responses",
        "models": [
            {
                "id": "pi-test",
                "name": "pi-test",
                "reasoning": True,
                "input": ["text", "image"],
                "contextWindow": MODEL_CONTEXT_1M,
                "maxTokens": 128 * 1024,
            }
        ],
    }


def test_container_worker_save_syncs_native_config_and_reports_paths(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _local_config(_worker("claudecode")).model_dump(mode="json")
    raw["runtime"]["execution"] = "container"
    raw["container"] = {
        "image": "redtrace-worker-container:latest",
        "network_mode": "host",
        "cap_add": [],
        "completed_action": "stop",
    }
    raw["local"] = None
    raw["workers"] = []
    config_path.write_text(
        yaml.safe_dump(raw, sort_keys=False),
        encoding="utf-8",
    )
    home = tmp_path / "root"
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _config, _worker: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "gateway available",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path, cli_config_home=home)
    payload = {
        "expected_revision": service.snapshot()["revision"],
        "name": "claude-primary",
        "type": "claudecode",
        "enabled": True,
        "api_endpoint": "https://gateway.example/anthropic",
        "api_key": "claude-secret",
        "model_id": "claude-test",
        "priority": 0,
        "max_running": 1,
    }

    snapshot = service.create(payload)

    settings_path = home / ".claude" / "settings.json"
    assert snapshot["cli_config_home"] == str(home.resolve())
    assert snapshot["workers"][0]["native_config_paths"] == [str(settings_path)]
    assert (
        json.loads(settings_path.read_text(encoding="utf-8"))["model"] == "claude-test"
    )
