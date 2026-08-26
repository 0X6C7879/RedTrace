from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from pathlib import Path
from threading import Event
from types import SimpleNamespace

import pytest
import redtrace.worker_config as worker_config_module
import yaml
from fastapi import FastAPI
from fastapi.testclient import TestClient
from redtrace.config_secrets import (
    resolve_dispatch_config_path,
    secret_id_from_reference,
)
from redtrace.dispatcher.config import DispatchConfig
from redtrace.dispatcher.config_reload import DispatchConfigReloader
from redtrace.dispatcher.scheduler.loop import DispatcherLoop
from redtrace.dispatcher.workers.health import HealthResult
from redtrace.server.routers.workers import router as worker_router
from redtrace.worker_config import (
    CONNECTION_TESTER,
    WorkerConfigConflict,
    WorkerConfigError,
    WorkerConfigService,
    _worker_payload as _make_worker_payload,
)


@pytest.fixture(autouse=True)
def isolate_native_cli_home(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REDTRACE_CLI_CONFIG_HOME", str(tmp_path / "home"))


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
        "container": {
            "image": "redtrace-worker",
            "network_mode": "host",
            "completed_action": "stop",
        },
        "providers": {
            "gw": {
                "api": "openai-completions",
                "base_url": "https://api.example.test",
                "api_key": "sk-gw-secret",
                "models": [
                    {
                        "id": "gpt-test",
                        "context_window": 131072,
                        "max_tokens": 8192,
                        "thinking_format": "deepseek",
                    }
                ],
            }
        },
        "workers": [],
    }


def _write_config(path: Path, raw: dict) -> None:
    temporary = path.with_name(f".{path.name}.test.tmp")
    temporary.write_text(
        yaml.safe_dump(raw, sort_keys=False),
        encoding="utf-8",
    )
    temporary.replace(path)


def _worker_payload(revision: str, *, name: str = "primary") -> dict:
    return {
        "expected_revision": revision,
        "name": name,
        "provider": "gw",
        "model": "gpt-test",
        "enabled": True,
        "bootstrap": False,
        "reason": True,
        "explore": True,
        "priority": 0,
        "max_running": 2,
    }


def test_missing_environment_config_falls_back_to_sibling_redtrace_yaml(
    tmp_path: Path,
    monkeypatch,
) -> None:
    standard = tmp_path / "redtrace.yaml"
    _write_config(standard, _raw_config())
    monkeypatch.setenv(
        "REDTRACE_DISPATCH_CONFIG", str(tmp_path / "legacy.local.yaml")
    )

    assert resolve_dispatch_config_path() == standard
    assert WorkerConfigService().path == standard


def test_explicit_missing_config_path_does_not_silently_fall_back(
    tmp_path: Path,
) -> None:
    standard = tmp_path / "redtrace.yaml"
    requested = tmp_path / "missing.yaml"
    _write_config(standard, _raw_config())

    assert resolve_dispatch_config_path(requested) == requested


def test_worker_config_encrypts_keys_and_never_returns_them(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    secrets_dir = tmp_path / "secrets"
    _write_config(config_path, _raw_config())
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(secrets_dir))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _config, _worker: {
            "ok": True,
            "status": 200,
            "duration_ms": 4,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()

    service = WorkerConfigService(config_path)
    initial = service.snapshot()
    secret = "sk-gw-secret"
    created = service.create(_worker_payload(initial["revision"]))

    assert created["workers"][0]["model"] == "gpt-test"
    assert [provider["name"] for provider in created["providers"]] == ["gw"]
    assert created["providers"][0]["api_key_configured"] is True
    persisted = config_path.read_text(encoding="utf-8")
    assert secret not in persisted
    raw = yaml.safe_load(persisted)
    reference = raw["providers"]["gw"]["api_key"]
    assert raw["workers"][0]["reason"] is True
    assert raw["workers"][0]["explore"] is True
    assert raw["workers"][0]["bootstrap"] is False
    assert secret_id_from_reference(reference) is not None
    assert secret.encode() not in (secrets_dir / "worker-config.enc").read_bytes()
    assert DispatchConfig.load(config_path).providers["gw"].api_key == secret


def test_plaintext_debug_mode_skips_encrypted_secret_store(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    secrets_dir = tmp_path / "secrets"
    raw = _raw_config()
    raw["runtime"]["worker_healthcheck"] = "disabled"
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(secrets_dir))
    monkeypatch.setenv("REDTRACE_PLAINTEXT_SECRETS", "1")
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _config, _worker: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()

    service = WorkerConfigService(config_path)
    service.create(_worker_payload(service.snapshot()["revision"]))

    persisted = config_path.read_text(encoding="utf-8")
    assert "sk-gw-secret" in persisted
    assert not secrets_dir.exists()




def test_explicit_test_and_save_deduplicate_identical_connection_probe(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    _write_config(config_path, _raw_config())
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    calls = 0

    def probe(_config, _worker):
        nonlocal calls
        calls += 1
        return {
            "ok": True,
            "status": 200,
            "duration_ms": 3,
            "detail": "connection successful",
        }

    monkeypatch.setattr(CONNECTION_TESTER, "_probe", probe)
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path)
    payload = _worker_payload(service.snapshot()["revision"], name="dedup-worker")

    tested = service.test_payload(payload)
    created = service.create(payload)

    assert tested["cached"] is False
    assert created["workers"][0]["name"] == "dedup-worker"
    assert calls == 1


def test_openai_responses_connection_probe_uses_responses_protocol(
    monkeypatch,
) -> None:
    raw = _raw_config()
    raw["providers"]["gw"]["api"] = "openai-responses"
    raw["providers"]["gw"]["base_url"] = "https://api.example.test/v1"
    raw["workers"] = [
        {
            "name": "primary",
            "provider": "gw",
            "model": "gpt-test",
            "enabled": True,
            "bootstrap": False,
            "reason": True,
            "explore": True,
            "max_running": 1,
            "priority": 0,
        }
    ]
    config = DispatchConfig.model_validate(raw)
    calls: list[dict] = []

    def post(url, *, headers, json, timeout):
        calls.append({"url": url, "headers": headers, "json": json, "timeout": timeout})
        return SimpleNamespace(status_code=400)

    monkeypatch.setattr(worker_config_module.httpx, "post", post)

    result = CONNECTION_TESTER._probe(config, config.workers[0])

    assert result["ok"] is True
    assert calls == [
        {
            "url": "https://api.example.test/v1/responses",
            "headers": {"authorization": "Bearer sk-gw-secret"},
            "json": {
                "model": "gpt-test",
                "max_output_tokens": 1,
                "input": "ping",
            },
            "timeout": 10.0,
        }
    ]




def test_copy_toggle_delete_and_revision_conflicts_are_atomic(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    _write_config(config_path, _raw_config())
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _config, _worker: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path)
    created = service.create(_worker_payload(service.snapshot()["revision"]))

    copied = service.copy("primary", created["revision"])
    assert [worker["name"] for worker in copied["workers"]] == [
        "primary",
        "primary-copy",
    ]
    disabled = service.set_enabled(
        "primary-copy",
        False,
        copied["revision"],
    )
    assert disabled["workers"][1]["enabled"] is False
    deleted = service.delete("primary-copy", disabled["revision"])
    assert [worker["name"] for worker in deleted["workers"]] == ["primary"]
    with pytest.raises(WorkerConfigConflict):
        service.set_enabled("primary", False, copied["revision"])


def test_runtime_tasks_persist_and_hot_reload_without_interrupting_running_tasks(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["workers"] = [
        {
            "name": "disabled-one",
            "provider": "mock",
            "enabled": False,
            "max_running": 1,
            "priority": 0,
        }
    ]
    _write_config(config_path, raw)
    reloader = DispatchConfigReloader(config_path)
    old_config = reloader.config

    updated = deepcopy(raw)
    updated["workers"][0]["name"] = "disabled-two"
    _write_config(config_path, updated)
    refreshed = reloader.refresh()

    assert refreshed is not None and refreshed.config is not None
    assert old_config.workers[0].name == "disabled-one"
    assert refreshed.config.workers[0].name == "disabled-two"

    service = WorkerConfigService(config_path)
    snapshot = service.update_runtime_tasks(
        {
            "expected_revision": service.snapshot()["revision"],
            "runtime": {
                "max_workers": 4,
                "max_running_projects": 3,
                "max_project_workers": 2,
            },
            "tasks": {
                "bootstrap": {"timeout": 300, "conclude_timeout": 120},
                "reason": {"timeout": 300, "max_intents": 3},
                "explore": {"timeout": 900, "conclude_timeout": 300},
            },
        }
    )
    assert snapshot["runtime"]["max_workers"] == 4
    assert snapshot["tasks"]["explore"]["timeout"] == 900

    loop = DispatcherLoop.__new__(DispatcherLoop)
    loop._config_reloader = reloader
    loop.config = reloader.config
    loop.executor = ThreadPoolExecutor(max_workers=3)
    loop.agent_runtime = SimpleNamespace(initialize=lambda _workers: None)
    started = Event()
    release = Event()
    running = loop.executor.submit(lambda: (started.set(), release.wait(2)))
    assert started.wait(1)
    loop.futures = {running: SimpleNamespace()}
    loop.worker_unhealthy_until = {}
    loop.worker_rejected_until = {}
    loop.explore_retry_avoid = {}
    loop._log_state = {}
    loop._refresh_worker_config()
    assert loop.config.tasks.explore.timeout == 900
    assert loop.executor._max_workers == 4
    assert running.cancelled() is False
    release.set()
    running.result(timeout=1)
    loop.executor.shutdown()

    restart_only = deepcopy(yaml.safe_load(config_path.read_text(encoding="utf-8")))
    restart_only["runtime"]["interval"] = 4
    _write_config(config_path, restart_only)
    rejected = reloader.refresh()
    assert rejected is not None and rejected.error is not None
    assert reloader.config.workers[0].name == "disabled-two"


def test_dsh_worker_view_derives_from_workers_for_hot_reload(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["runtime"].update({"execution": "local"})
    raw["container"] = None
    raw["providers"]["gw"]["models"].append(
        {"id": "gpt-test-next", "context_window": 131072, "max_tokens": 8192}
    )
    raw["workers"] = [
        {
            "name": "primary",
            "provider": "gw",
            "model": "gpt-test",
            "enabled": True,
            "bootstrap": False,
            "reason": True,
            "explore": True,
            "max_running": 2,
            "priority": 0,
        }
    ]
    _write_config(config_path, raw)
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _config, _worker: {
            "ok": True,
            "status": 200,
            "duration_ms": 4,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    reloader = DispatchConfigReloader(config_path)
    service = WorkerConfigService(config_path)
    initial = service.snapshot()

    assert initial["engine"] == "dsh"
    workers = {worker["name"]: worker for worker in initial["dsh"]["workers"]}
    assert workers["primary"]["provider"] == "gw"
    assert workers["primary"]["model"] == "gpt-test"
    assert workers["primary"]["reason"] is True
    assert initial["dsh"]["providers"]["gw"]["apiKeyEnv"] == "REDTRACE_DSH_KEY_GW"

    snapshot = service.update(
        "primary",
        {
            "expected_revision": initial["revision"],
            "original_name": "primary",
            "name": "primary",
            "provider": "gw",
            "model": "gpt-test-next",
            "enabled": True,
            "bootstrap": False,
            "reason": True,
            "explore": False,
            "priority": 0,
            "max_running": 2,
        },
    )

    workers = {worker["name"]: worker for worker in snapshot["dsh"]["workers"]}
    assert workers["primary"]["model"] == "gpt-test-next"
    assert workers["primary"]["explore"] is False
    assert snapshot["dsh"]["providers"]["gw"]["apiKeyEnv"] == "REDTRACE_DSH_KEY_GW"

    tasks_snapshot = service.update_runtime_tasks(
        {
            "expected_revision": snapshot["revision"],
            "runtime": snapshot["runtime"],
            "tasks": snapshot["tasks"],
        }
    )
    workers = {worker["name"]: worker for worker in tasks_snapshot["dsh"]["workers"]}
    assert workers["primary"]["model"] == "gpt-test-next"
    persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert persisted["workers"][0]["model"] == "gpt-test-next"
    assert "dsh" not in persisted

    refreshed = reloader.refresh()
    assert refreshed is not None and refreshed.config is not None
    from redtrace.dispatcher.dsh import dsh_workers

    assert dsh_workers(refreshed.config)[0]["model"] == "gpt-test-next"

def test_provider_crud_hot_reload_snapshot_and_secret_handling(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    secrets_dir = tmp_path / "secrets"
    raw = _raw_config()
    raw["workers"] = [
        {
            "name": "primary",
            "provider": "gw",
            "model": "gpt-test",
            "enabled": True,
            "bootstrap": False,
            "reason": True,
            "explore": True,
            "max_running": 1,
            "priority": 0,
        }
    ]
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(secrets_dir))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _config, _worker: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path)
    initial = service.snapshot()

    assert initial["providers"][0]["models"][0]["thinking_format"] == "deepseek"

    created = service.create_provider(
        {
            "expected_revision": initial["revision"],
            "name": "second",
            "api": "anthropic-messages",
            "base_url": "https://api.second.test/",
            "api_key": "sk-second-secret",
            "models": [
                {
                    "id": "claude-test",
                    "context_window": 200000,
                    "max_tokens": 4096,
                    "thinking_format": "none",
                }
            ],
        }
    )
    assert [provider["name"] for provider in created["providers"]] == ["gw", "second"]
    persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert "sk-second-secret" not in config_path.read_text(encoding="utf-8")
    assert secret_id_from_reference(persisted["providers"]["second"]["api_key"]) is not None
    assert created["providers"][1]["api_key_configured"] is True
    assert created["providers"][1]["models"] == [
        {
            "id": "claude-test",
            "context_window": 200000,
            "max_tokens": 4096,
            "reasoning": "auto_max",
            "reasoning_efforts": None,
            "thinking_format": "auto",
        }
    ]
    config = DispatchConfig.load(config_path)
    assert config.providers["second"].api == "anthropic-messages"
    assert config.providers["second"].base_url == "https://api.second.test"

    updated = service.update_provider(
        "second",
        {
            "expected_revision": created["revision"],
            "name": "second",
            "api": "anthropic-messages",
            "base_url": "https://api.second.test/v2",
            "api_key": None,
            "api_key_env": None,
            "models": [
                {
                    "id": "claude-test",
                    "context_window": 262144,
                    "max_tokens": 8192,
                    "thinking_format": "none",
                }
            ],
        },
    )
    assert updated["providers"][1]["base_url"] == "https://api.second.test/v2"
    assert updated["providers"][1]["models"][0]["context_window"] == 262144
    config = DispatchConfig.load(config_path)
    assert config.providers["second"].api_key == "sk-second-secret"
    # Unreferenced providers get no pi-ai profile; editing a referenced one
    # must be visible to the scheduler's next /runtime/config pull.
    from redtrace.dispatcher.dsh import runtime_config

    assert "second" not in runtime_config(config)["providers"]
    rerouted = service.update_provider(
        "gw",
        {
            "expected_revision": updated["revision"],
            "name": "gw",
            "api": "openai-completions",
            "base_url": "https://api.example.test/v2",
            "api_key": None,
            "models": [
                {
                    "id": "gpt-test",
                    "context_window": 1000000,
                    "max_tokens": 128000,
                    "thinking_format": "openai",
                }
            ],
        },
    )
    config = DispatchConfig.load(config_path)
    profile = runtime_config(config)["providers"]["gw"]
    assert profile["baseURL"] == "https://api.example.test/v2"
    assert profile["models"][0]["contextWindow"] == 1000000
    assert profile["models"][0]["maxTokens"] == 128000
    assert profile["models"][0]["compat"] == {"thinkingFormat": "openai"}
    assert rerouted["providers"][0]["models"][0]["thinking_format"] == "openai"

    deleted = service.delete_provider("second", rerouted["revision"])
    assert [provider["name"] for provider in deleted["providers"]] == ["gw"]
    assert "second" not in DispatchConfig.load(config_path).providers


def test_provider_rename_cascades_to_worker_routes(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["workers"] = [
        {
            "name": "primary",
            "provider": "gw",
            "model": "gpt-test",
            "enabled": True,
            "bootstrap": False,
            "reason": True,
            "explore": True,
            "max_running": 1,
            "priority": 0,
        }
    ]
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    service = WorkerConfigService(config_path)
    initial = service.snapshot()

    renamed = service.update_provider(
        "gw",
        {
            "expected_revision": initial["revision"],
            "name": "gateway",
            "api": "openai-completions",
            "base_url": "https://api.example.test",
            "api_key": None,
            "models": [
                {
                    "id": "gpt-test",
                    "context_window": 131072,
                    "max_tokens": 8192,
                    "thinking_format": "deepseek",
                }
            ],
        },
    )

    assert [provider["name"] for provider in renamed["providers"]] == ["gateway"]
    assert renamed["workers"][0]["provider"] == "gateway"
    assert renamed["workers"][0]["editable"] is True
    persisted = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    assert persisted["workers"][0]["provider"] == "gateway"
    assert "gw" not in persisted["providers"]
    config = DispatchConfig.load(config_path)
    assert config.providers["gateway"].api_key == "sk-gw-secret"


def test_provider_delete_blocked_while_referenced_and_credentials_validated(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["workers"] = [
        {
            "name": "primary",
            "provider": "gw",
            "model": "gpt-test",
            "enabled": True,
            "bootstrap": False,
            "reason": True,
            "explore": True,
            "max_running": 1,
            "priority": 0,
        }
    ]
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    service = WorkerConfigService(config_path)
    snapshot = service.snapshot()

    with pytest.raises(WorkerConfigError, match="primary"):
        service.delete_provider("gw", snapshot["revision"])

    with pytest.raises(WorkerConfigError, match="provider already exists"):
        service.create_provider(
            {
                "expected_revision": snapshot["revision"],
                "name": "gw",
                "api": "openai-completions",
                "base_url": "https://api.example.test",
                "api_key": "sk-x",
                "models": [{"id": "gpt-test"}],
            }
        )
    with pytest.raises(WorkerConfigError, match="api_key or api_key_env"):
        service.create_provider(
            {
                "expected_revision": snapshot["revision"],
                "name": "envless",
                "api": "openai-completions",
                "base_url": "https://api.example.test",
                "api_key": "",
                "api_key_env": "",
                "models": [{"id": "gpt-test"}],
            }
        )
    with pytest.raises(WorkerConfigError, match="http"):
        service.create_provider(
            {
                "expected_revision": snapshot["revision"],
                "name": "ftp",
                "api": "openai-completions",
                "base_url": "ftp://api.example.test",
                "api_key": "sk-x",
                "models": [{"id": "gpt-test"}],
            }
        )
    with pytest.raises(WorkerConfigError, match="at least one model"):
        service.create_provider(
            {
                "expected_revision": snapshot["revision"],
                "name": "modelless",
                "api": "openai-completions",
                "base_url": "https://api.example.test",
                "api_key": "sk-x",
                "models": [],
            }
        )
    env_only = service.create_provider(
        {
            "expected_revision": snapshot["revision"],
            "name": "env-provider",
            "api": "openai-responses",
            "base_url": "https://api.env.test",
            "api_key": "",
            "api_key_env": "ENV_PROVIDER_KEY",
            "models": [
                {
                    "id": "env-model",
                    "context_window": 1000000,
                    "max_tokens": 128000,
                    "thinking_format": "deepseek",
                }
            ],
        },
    )
    entry = next(p for p in env_only["providers"] if p["name"] == "env-provider")
    assert entry["api_key_configured"] is False
    assert entry["api_key_env"] == "ENV_PROVIDER_KEY"
    assert entry["models"][0]["context_window"] == 1000000
    assert entry["models"][0]["max_tokens"] == 128000
    assert entry["referenced"] is False


def test_disabled_workers_are_excluded_from_new_task_selection() -> None:
    raw = _raw_config()
    raw["workers"] = [
        {
            "name": "disabled",
            "provider": "mock",
            "enabled": False,
            "max_running": 1,
            "priority": 0,
        },
        {
            "name": "enabled",
            "provider": "mock",
            "enabled": True,
            "max_running": 1,
            "priority": 1,
        },
    ]
    loop = DispatcherLoop.__new__(DispatcherLoop)
    loop.config = DispatchConfig.model_validate(raw)
    loop.futures = {}
    loop.worker_unhealthy_until = {}
    loop.worker_rejected_until = {}

    selected = loop._select_worker("proj_001", "explore")

    assert selected.worker is not None
    assert selected.worker.name == "enabled"

def test_static_ui_has_only_dagre_and_admin_defaults() -> None:
    static_dir = Path(__file__).parents[1] / "src" / "redtrace" / "server" / "static"
    index = (static_dir / "index.html").read_text(encoding="utf-8")
    operations = (static_dir / "operations.js").read_text(encoding="utf-8")

    assert "Worker 配置" in index
    assert "保存并热加载" in index
    assert "最大运行项目" in index
    assert "Conclude 超时" in index
    assert "task_types" in index
    assert "任务资格" in index
    assert "/worker-config" in index
    assert "Provider 模型服务" in index
    assert "新增 Provider" in index
    assert "showProviderEditor" in index
    assert "providerPayload" in index
    assert 'placeholder="worker-name"' in index
    assert 'placeholder="provider-name"' in index
    assert 'placeholder="model-id"' in index
    assert "模型列表" in index
    assert "推理强度" in index
    assert "自动最高（推荐）" in index
    assert "支持的推理档位" in index
    assert "协议兼容格式" in index
    assert "思考格式" not in index
    assert "workerModelOptions" in index
    assert "mock（测试引擎）" not in index
    assert "showLocalPrefs" not in index
    assert "服务端超时" not in index
    assert "Dagre ↓" not in index
    assert "cytoscape-elk" not in index
    assert "cytoscape-klay" not in index
    assert "rankDir: 'TB'" in index
    assert 'class="max-h-72 overflow-auto whitespace-pre-wrap break-words' in index
    assert "c2Expanded: false" in index
    assert 'operations.js?v=20260826-c2-ledgers-1' in index
    assert 'operations.css?v=20260826-c2-ledgers-1' in index
    assert 'x-show="pageMode === \'c2-tasks\'"' in index
    assert 'aria-label="C2 任务队列"' in index
    assert 'x-show="pageMode === \'c2-events\'"' in index
    assert 'aria-label="C2 事件时间线"' in index
    assert "!['c2-payloads','c2-tasks','c2-events'].includes(pageMode)" in index
    assert "isDedicatedLedgerPage()" in operations
    assert "window.redtraceConfirm" in index
    assert "window.confirm" not in operations
    assert '@click="setAppPage(\'c2-listeners\')" aria-label="打开 C2"' in index
    assert '@click="c2Expanded = !c2Expanded"' in index
    assert "setAppPage('c2-listeners'); c2Expanded" not in index
    assert "/operations/tasks/${encodeURIComponent(taskId)}" in operations
    assert "operations/tasks?limit=200`);\n        const task =" not in operations
    assert "if (page === 'webshell' || page.startsWith('c2-'))" not in index
    assert "const responseText = await r.text();" in index
    assert "data = JSON.parse(responseText);" in index
    assert 'x-model="workerForm.provider"' in index
    assert 'x-model="workerForm.model"' in index
    assert "provider: this.workerForm.provider" in index
    assert "model: this.workerForm.model" in index
    assert "workerForm.context_window" not in index
    assert "任务资格" in index
    assert "return 'admin';" in index
    assert "return 'admin';" in operations
    assert ':disabled="!selectedOpenIntentRecord()"' in index
    assert "return intent?.worker ? intent : null;" in index
    assert "webshellSessionLabel()" in operations
    assert "resource.status === 'available'" in operations
    assert 'x-text="webshellSessionLabel()"' in index
    assert 'x-show="webshellUsable()" @submit.prevent="runCommand()"' in index
    assert "当前 WebShell 不可用" in index


# ── endpoint normalization ────────────────────────────────────────────────────
























def test_shipped_example_configs_all_validate() -> None:
    """Acceptance: every shipped example config parses into a valid
    DispatchConfig — no example may ship in a state the loader rejects."""
    import glob

    from redtrace.dispatcher.config import DispatchConfig

    repo_root = Path(__file__).resolve().parents[2]
    examples = sorted(glob.glob(str(repo_root / "redtrace.*.example.yaml")))
    assert len(examples) >= 4, "expected the dsh/mock/local/container examples"
    for name in examples:
        config = DispatchConfig.load(Path(name))
        assert config.workers, f"{name}: no workers defined"
