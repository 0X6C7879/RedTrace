from __future__ import annotations

from copy import deepcopy
from pathlib import Path

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
    WorkerConfigService,
    _strip_api_path_suffix,
    _worker_payload as _make_worker_payload,
)


@pytest.fixture(autouse=True)
def isolate_native_cli_home(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("REDTRACE_CLI_CONFIG_HOME", str(tmp_path / "home"))


def _raw_config() -> dict:
    return {
        "server": "http://127.0.0.1:8000",
        "runtime": {
            "execution": "container",
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
        "workers": [],
    }


def _write_config(path: Path, raw: dict) -> None:
    temporary = path.with_name(f".{path.name}.test.tmp")
    temporary.write_text(
        yaml.safe_dump(raw, sort_keys=False),
        encoding="utf-8",
    )
    temporary.replace(path)


def _worker_payload(revision: str, *, name: str = "codex-primary") -> dict:
    return {
        "expected_revision": revision,
        "name": name,
        "type": "codex",
        "enabled": True,
        "api_endpoint": "https://api.example.test/v1",
        "api_key": f"sk-{name}-secret",
        "model_id": "gpt-test",
        "context_length": 1_048_576,
        "task_types": ["reason", "explore"],
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
    secret = "sk-codex-primary-secret"
    created = service.create(_worker_payload(initial["revision"]))

    assert created["workers"][0]["api_key"] == secret
    assert created["workers"][0]["api_key_configured"] is True
    assert created["workers"][0]["context_length"] == 1_048_576
    persisted = config_path.read_text(encoding="utf-8")
    assert secret not in persisted
    raw = yaml.safe_load(persisted)
    reference = raw["workers"][0]["env"]["OPENAI_API_KEY"]
    assert raw["workers"][0]["task_types"] == ["reason", "explore"]
    assert raw["workers"][0]["context_length"] == 1_048_576
    assert secret_id_from_reference(reference) is not None
    assert secret.encode() not in (secrets_dir / "worker-config.enc").read_bytes()
    assert DispatchConfig.load(config_path).workers[0].env["OPENAI_API_KEY"] == secret


def test_plaintext_debug_mode_skips_encrypted_secret_store(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    secrets_dir = tmp_path / "secrets"
    raw = _raw_config()
    raw["runtime"]["execution"] = "local"
    raw["runtime"]["worker_healthcheck"] = "disabled"
    raw["local"] = {"completed_action": "keep"}
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

    service = WorkerConfigService(config_path, cli_config_home=tmp_path / "home")
    secret = "sk-plaintext-debug-secret"
    payload = _worker_payload(service.snapshot()["revision"])
    payload["api_key"] = secret
    service.create(payload)

    persisted = config_path.read_text(encoding="utf-8")
    assert secret in persisted
    assert not secrets_dir.exists()


def test_worker_api_response_contains_api_key_for_local_debugging(
    tmp_path: Path,
    monkeypatch,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    _write_config(config_path, _raw_config())
    monkeypatch.setenv("REDTRACE_DISPATCH_CONFIG", str(config_path))
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _config, _worker: {
            "ok": True,
            "status": 200,
            "duration_ms": 2,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    api = FastAPI()
    api.include_router(worker_router)

    with TestClient(api) as client:
        revision = client.get("/worker-config").json()["revision"]
        secret = "sk-api-response-secret"
        payload = _worker_payload(revision, name="api-worker")
        payload["api_key"] = secret
        response = client.post("/worker-config/workers", json=payload)

    assert response.status_code == 201
    assert response.json()["workers"][0]["api_key"] == secret
    assert response.json()["workers"][0]["api_key_configured"] is True


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


def test_connection_failure_detail_redacts_api_key(monkeypatch) -> None:
    raw = _raw_config()
    key = "sk-never-log-this-secret"
    raw["workers"] = [
        {
            "name": "redaction-worker",
            "type": "codex",
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
            "env": {
                "CODEX_BASE_URL": "https://api.example.test/v1",
                "OPENAI_API_KEY": key,
                "CODEX_MODEL": "gpt-test",
            },
        }
    ]
    config = DispatchConfig.model_validate(raw)

    class FakeDriver:
        def check_health(self, _worker, *, timeout):
            assert timeout == 5
            return HealthResult(
                ok=False,
                status=401,
                detail=f"Authorization: Bearer {key}",
            )

    monkeypatch.setattr(
        worker_config_module,
        "get_driver",
        lambda _worker_type, _execution: FakeDriver(),
    )
    result = CONNECTION_TESTER._probe(config, config.workers[0])

    assert result["ok"] is False
    assert key not in result["detail"]
    assert "[REDACTED]" in result["detail"]


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

    copied = service.copy("codex-primary", created["revision"])
    assert [worker["name"] for worker in copied["workers"]] == [
        "codex-primary",
        "codex-primary-copy",
    ]
    disabled = service.set_enabled(
        "codex-primary-copy",
        False,
        copied["revision"],
    )
    assert disabled["workers"][1]["enabled"] is False
    deleted = service.delete("codex-primary-copy", disabled["revision"])
    assert [worker["name"] for worker in deleted["workers"]] == ["codex-primary"]
    with pytest.raises(WorkerConfigConflict):
        service.set_enabled("codex-primary", False, copied["revision"])


def test_dispatch_reloader_applies_only_worker_changes_and_keeps_old_snapshot(
    tmp_path: Path,
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["workers"] = [
        {
            "name": "disabled-one",
            "type": "codex",
            "enabled": False,
            "task_types": ["explore"],
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

    restart_only = deepcopy(updated)
    restart_only["runtime"]["max_workers"] = 4
    _write_config(config_path, restart_only)
    rejected = reloader.refresh()
    assert rejected is not None and rejected.error is not None
    assert reloader.config.workers[0].name == "disabled-two"


def test_disabled_workers_are_excluded_from_new_task_selection() -> None:
    raw = _raw_config()
    raw["workers"] = [
        {
            "name": "disabled",
            "type": "codex",
            "enabled": False,
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 0,
        },
        {
            "name": "enabled",
            "type": "codex",
            "enabled": True,
            "task_types": ["explore"],
            "max_running": 1,
            "priority": 1,
            "env": {
                "CODEX_BASE_URL": "https://api.example.test/v1",
                "OPENAI_API_KEY": "test-secret",
                "CODEX_MODEL": "gpt-test",
            },
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
    assert "task_types" in index
    assert "任务类型" in index
    assert "/worker-config" in index
    assert "showLocalPrefs" not in index
    assert "服务端超时" not in index
    assert "Dagre ↓" not in index
    assert "cytoscape-elk" not in index
    assert "cytoscape-klay" not in index
    assert "rankDir: 'TB'" in index
    assert 'class="max-h-72 overflow-auto whitespace-pre-wrap break-words' in index
    assert "c2Expanded: false" in index
    assert 'operations.js?v=20260813-payload-library-1' in index
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
    assert 'x-model="workerForm.api_key" type="text"' in index
    assert "api_key: worker.api_key || ''" in index
    assert 'x-model="workerForm.context_1m"' in index
    assert "context_length: this.workerForm.context_1m ? 1048576 : null" in index
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


@pytest.mark.parametrize(
    ("worker_type", "input_url", "expected"),
    [
        # Pi OpenAI — base URL passes through unchanged
        ("pi", "https://host/v1", "https://host/v1"),
        # Pi OpenAI — full endpoint stripped
        ("pi", "https://host/v1/chat/completions", "https://host/v1"),
        # Pi Responses — stripped
        ("pi", "https://host/v1/responses", "https://host/v1"),
        # Pi Anthropic — stripped to base (health check re-appends /v1/messages)
        ("pi", "https://host/v1/messages", "https://host"),
        # Codex — base URL passes through
        ("codex", "https://host/v1", "https://host/v1"),
        # Codex — full endpoint stripped
        ("codex", "https://host/v1/responses", "https://host/v1"),
        # Claude — base URL passes through
        ("claudecode", "https://host/v1", "https://host"),
        # Claude — full endpoint stripped
        ("claudecode", "https://host/v1/messages", "https://host"),
        # Non-matching path preserved
        ("pi", "https://host/custom/path", "https://host/custom/path"),
    ],
)
def test_strip_api_path_suffix(
    worker_type: str, input_url: str, expected: str
) -> None:
    assert _strip_api_path_suffix(input_url, worker_type) == expected


def test_worker_payload_normalizes_full_endpoint_for_codex(
    tmp_path: Path, monkeypatch
) -> None:
    """Full /v1/responses endpoint should be stored as bare /v1 base URL."""
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["runtime"]["execution"] = "local"
    raw["runtime"]["worker_healthcheck"] = "disabled"
    raw["local"] = {"completed_action": "keep"}
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_DISPATCH_CONFIG", str(config_path))
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _c, _w: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path, cli_config_home=tmp_path / "home")

    payload = {
        "expected_revision": service.snapshot()["revision"],
        "name": "codex-full-endpoint",
        "type": "codex",
        "enabled": True,
        "api_endpoint": "https://api.example.test/v1/responses",
        "api_key": "sk-test-key-12345",
        "model_id": "gpt-test",
        "task_types": ["explore"],
        "priority": 0,
        "max_running": 1,
    }
    created = service.create(payload)
    worker = created["workers"][0]
    assert worker["api_endpoint"] == "https://api.example.test/v1"


def test_worker_payload_normalizes_full_endpoint_for_pi_openai(
    tmp_path: Path, monkeypatch
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["runtime"]["execution"] = "local"
    raw["runtime"]["worker_healthcheck"] = "disabled"
    raw["local"] = {"completed_action": "keep"}
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_DISPATCH_CONFIG", str(config_path))
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _c, _w: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path, cli_config_home=tmp_path / "home")

    payload = {
        "expected_revision": service.snapshot()["revision"],
        "name": "pi-full-endpoint",
        "type": "pi",
        "enabled": True,
        "api_endpoint": "https://api.example.test/v1/chat/completions",
        "api_key": "sk-test-key-12345",
        "model_id": "gpt-test",
        "task_types": ["explore"],
        "priority": 0,
        "max_running": 1,
    }
    created = service.create(payload)
    worker = created["workers"][0]
    assert worker["api_endpoint"] == "https://api.example.test/v1"


def test_worker_payload_normalizes_full_endpoint_for_claudecode(
    tmp_path: Path, monkeypatch
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["runtime"]["execution"] = "local"
    raw["runtime"]["worker_healthcheck"] = "disabled"
    raw["local"] = {"completed_action": "keep"}
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_DISPATCH_CONFIG", str(config_path))
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _c, _w: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path, cli_config_home=tmp_path / "home")

    payload = {
        "expected_revision": service.snapshot()["revision"],
        "name": "claude-full-endpoint",
        "type": "claudecode",
        "enabled": True,
        "api_endpoint": "https://api.anthropic.com/v1/messages",
        "api_key": "sk-test-key-12345",
        "model_id": "claude-test",
        "task_types": ["explore"],
        "priority": 0,
        "max_running": 1,
    }
    created = service.create(payload)
    worker = created["workers"][0]
    assert worker["api_endpoint"] == "https://api.anthropic.com"


def test_worker_payload_preserves_base_url_without_suffix(
    tmp_path: Path, monkeypatch
) -> None:
    """Base URLs that already lack API path suffixes should pass through."""
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["runtime"]["execution"] = "local"
    raw["runtime"]["worker_healthcheck"] = "disabled"
    raw["local"] = {"completed_action": "keep"}
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_DISPATCH_CONFIG", str(config_path))
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _c, _w: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path, cli_config_home=tmp_path / "home")

    payload = {
        "expected_revision": service.snapshot()["revision"],
        "name": "codex-base-url",
        "type": "codex",
        "enabled": True,
        "api_endpoint": "https://api.example.test/v1",
        "api_key": "sk-test-key-12345",
        "model_id": "gpt-test",
        "task_types": ["explore"],
        "priority": 0,
        "max_running": 1,
    }
    created = service.create(payload)
    worker = created["workers"][0]
    assert worker["api_endpoint"] == "https://api.example.test/v1"


def test_endpoint_mode_defaults_to_auto() -> None:
    """endpoint_mode auto infers 'base' for /v1 URLs, 'direct' for proxy URLs."""
    base_result = _make_worker_payload(
        {
            "name": "test-defaults-base",
            "type": "codex",
            "enabled": True,
            "api_endpoint": "https://api.example.test/v1",
            "api_key": "sk-test-key-12345",
            "model_id": "gpt-test",
            "task_types": ["explore"],
            "priority": 0,
            "max_running": 1,
        },
        runtime_max_workers=3,
    )
    assert base_result["endpoint_mode"] == "base"

    direct_result = _make_worker_payload(
        {
            "name": "test-defaults-direct",
            "type": "codex",
            "enabled": True,
            "api_endpoint": "https://gateway.example.com/proxy/abc",
            "api_key": "sk-test-key-12345",
            "model_id": "gpt-test",
            "task_types": ["explore"],
            "priority": 0,
            "max_running": 1,
        },
        runtime_max_workers=3,
    )
    assert direct_result["endpoint_mode"] == "direct"


def test_endpoint_mode_direct_preserves_full_url() -> None:
    """In direct mode the full endpoint URL must be stored without stripping."""
    result = _make_worker_payload(
        {
            "name": "test-direct",
            "type": "claudecode",
            "enabled": True,
            "api_endpoint": "https://llm-gateway.example.com/llm-gateway/proxy/e/xxxx",
            "api_key": "sk-test-key-12345",
            "model_id": "claude-test",
            "task_types": ["explore"],
            "priority": 0,
            "max_running": 1,
            "endpoint_mode": "direct",
        },
        runtime_max_workers=3,
    )
    assert result["endpoint_mode"] == "direct"
    assert result["env"]["ANTHROPIC_BASE_URL"] == (
        "https://llm-gateway.example.com/llm-gateway/proxy/e/xxxx"
    )


def test_endpoint_mode_direct_requires_endpoint() -> None:
    """Direct mode requires an api_endpoint."""
    with pytest.raises(
        Exception, match="api_endpoint is required when endpoint_mode is direct"
    ):
        _make_worker_payload(
            {
                "name": "test-no-endpoint",
                "type": "codex",
                "enabled": True,
                "api_endpoint": "",
                "api_key": "sk-test-key-12345",
                "model_id": "gpt-test",
                "task_types": ["explore"],
                "priority": 0,
                "max_running": 1,
                "endpoint_mode": "direct",
            },
            runtime_max_workers=3,
        )


def test_endpoint_mode_base_strips_known_suffixes() -> None:
    """In base mode known API path suffixes are stripped."""
    result = _make_worker_payload(
        {
            "name": "test-base-mode",
            "type": "pi",
            "enabled": True,
            "api_endpoint": "https://host/v1/chat/completions",
            "api_key": "sk-test-key-12345",
            "model_id": "gpt-test",
            "task_types": ["explore"],
            "priority": 0,
            "max_running": 1,
            "endpoint_mode": "base",
        },
        runtime_max_workers=3,
    )
    assert result["endpoint_mode"] == "base"
    assert result["env"]["PI_BASE_URL"] == "https://host/v1"


def test_worker_view_includes_endpoint_mode(
    tmp_path: Path, monkeypatch
) -> None:
    config_path = tmp_path / "redtrace.yaml"
    raw = _raw_config()
    raw["runtime"]["execution"] = "local"
    raw["runtime"]["worker_healthcheck"] = "disabled"
    raw["local"] = {"completed_action": "keep"}
    _write_config(config_path, raw)
    monkeypatch.setenv("REDTRACE_DISPATCH_CONFIG", str(config_path))
    monkeypatch.setenv("REDTRACE_CONFIG_SECRETS_DIR", str(tmp_path / "secrets"))
    monkeypatch.setattr(
        CONNECTION_TESTER,
        "_probe",
        lambda _c, _w: {
            "ok": True,
            "status": 200,
            "duration_ms": 1,
            "detail": "connection successful",
        },
    )
    CONNECTION_TESTER._success_cache.clear()
    service = WorkerConfigService(config_path, cli_config_home=tmp_path / "home")

    payload = {
        "expected_revision": service.snapshot()["revision"],
        "name": "direct-worker",
        "type": "codex",
        "enabled": True,
        "api_endpoint": "https://gateway.example.com/proxy/abc",
        "api_key": "sk-test-key-12345",
        "model_id": "gpt-test",
        "task_types": ["explore"],
        "priority": 0,
        "max_running": 1,
        "endpoint_mode": "direct",
    }
    created = service.create(payload)
    worker = created["workers"][0]
    assert worker["endpoint_mode"] == "direct"
    assert worker["api_endpoint"] == "https://gateway.example.com/proxy/abc"


def test_endpoint_relay_register_returns_consistent_url() -> None:
    """Registering the same upstream twice should return the same relay URL."""
    from redtrace.dispatcher.workers.endpoint_relay import EndpointRelay

    url1 = EndpointRelay.register("https://example.com/proxy/test")
    url2 = EndpointRelay.register("https://example.com/proxy/test")
    assert url1 == url2
    assert url1.startswith("http://127.0.0.1:")
