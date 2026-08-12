from __future__ import annotations

import json

import pytest
from conftest import make_config
from pydantic import ValidationError
from redtrace.capabilities import PI_MCP_EXTENSION, PI_PROVIDER_EXTENSION_PATH
from redtrace.dispatcher.config import (
    DispatchConfig,
    LocalConfig,
    WorkerConfig,
    validate_prompt_resources,
)
from redtrace.dispatcher.runtime.local_backend import LocalBackend
from redtrace.dispatcher.workers.adapters.claudecode import ClaudeCodeDriver
from redtrace.dispatcher.workers.adapters.codex import CodexDriver
from redtrace.dispatcher.workers.adapters.pi import PiDriver


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

    assert DispatchConfig.model_validate(payload).runtime.worker_healthcheck == "startup_only"

    payload["runtime"]["worker_healthcheck"] = "sometimes"
    with pytest.raises(ValidationError):
        DispatchConfig.model_validate(payload)


def test_dispatch_config_rejects_duplicate_workers_and_excess_project_parallelism() -> None:
    payload = make_config().model_dump()
    payload["workers"].append(dict(payload["workers"][0]))
    with pytest.raises(ValidationError, match="worker names must be unique"):
        DispatchConfig.model_validate(payload)

    payload = make_config().model_dump()
    payload["runtime"]["max_project_workers"] = 3
    with pytest.raises(ValidationError, match="max_project_workers cannot exceed max_workers"):
        DispatchConfig.model_validate(payload)


def test_pi_worker_rejects_invalid_context_window() -> None:
    with pytest.raises(ValidationError, match="PI_MODEL_CONTEXT_WINDOW must be greater than 0"):
        WorkerConfig.model_validate(
            {
                "name": "pi",
                "type": "pi",
                "max_running": 1,
                "priority": 0,
                "env": {
                    "PI_MODEL": "model",
                    "PI_BASE_URL": "http://api",
                    "PI_API_KEY": "secret",
                    "PI_PROVIDER_API": "openai-completions",
                    "PI_MODEL_CONTEXT_WINDOW": "0",
                },
            }
        )


def test_mock_worker_rejects_unknown_phase_configuration() -> None:
    with pytest.raises(ValidationError, match="unsupported mock env keys"):
        WorkerConfig.model_validate(
            {
                "name": "mock",
                "type": "mock",
                "max_running": 1,
                "priority": 0,
                "env": {"MOCK_UNKNOWN": "{}"},
            }
        )


def test_bundled_prompt_groups_have_required_placeholders() -> None:
    validate_prompt_resources("default")
    validate_prompt_resources("mock")


def test_pi_driver_builds_models_from_environment_without_key_in_argv() -> None:
    worker = WorkerConfig.model_validate(
        {
            "name": "pi-worker",
            "type": "pi",
            "max_running": 1,
            "priority": 0,
            "env": {
                "PI_MODEL": "model",
                "PI_BASE_URL": "http://api",
                "PI_API_KEY": "secret",
                "PI_PROVIDER_API": "openai-completions",
                "PI_MODEL_CONTEXT_WINDOW": "131072",
            },
        }
    )

    result = PiDriver().build_execute(worker, "prompt", None)

    assert result.argv[:2] == ["pi", "--extension"]
    assert PI_PROVIDER_EXTENSION_PATH in result.argv
    assert "secret" not in result.argv
    assert PI_MCP_EXTENSION in result.argv
    assert "--session-dir" not in result.argv
    assert "--approve" in result.argv
    assert "--tools" not in result.argv
    assert "--no-skills" not in result.argv
    assert result.argv[-2:] == ["-p", "prompt"]


def test_local_pi_and_codex_use_complete_provider_config_without_exposing_key() -> None:
    pi_worker = WorkerConfig.model_validate(
        {
            "name": "pi-worker",
            "type": "pi",
            "max_running": 1,
            "priority": 0,
            "env": {
                "PI_MODEL": "model",
                "PI_BASE_URL": "http://api",
                "PI_API_KEY": "pi-secret",
                "PI_PROVIDER_API": "openai-completions",
            },
        }
    )
    pi_argv = PiDriver(local=True).build_execute(pi_worker, "prompt", None).argv

    assert "--provider" in pi_argv
    assert "redtrace" in pi_argv
    assert PI_PROVIDER_EXTENSION_PATH in pi_argv
    assert pi_argv[0] == "pi"
    assert "pi-secret" not in pi_argv

    codex_worker = WorkerConfig.model_validate(
        {
            "name": "codex-worker",
            "type": "codex",
            "max_running": 1,
            "priority": 0,
            "context_length": 1_048_576,
            "env": {
                "CODEX_MODEL": "gpt-test",
                "CODEX_BASE_URL": "http://api/v1",
                "OPENAI_API_KEY": "codex-secret",
            },
        }
    )
    codex_argv = CodexDriver(local=True).build_execute(
        codex_worker, "prompt", None
    ).argv

    assert "--model" in codex_argv
    assert 'model_provider="redtrace"' in codex_argv
    assert 'web_search="live"' in codex_argv
    assert "model_context_window=1048576" in codex_argv
    assert "model_auto_compact_token_limit=943718" in codex_argv
    assert "codex-secret" not in codex_argv


def test_local_workers_keep_global_cli_config_and_isolate_api_overrides(
    tmp_path,
    monkeypatch,
) -> None:
    monkeypatch.setenv("HOME", str(tmp_path / "home"))
    monkeypatch.setenv("CODEX_HOME", str(tmp_path / "codex-home"))
    monkeypatch.setenv("PI_CODING_AGENT_DIR", str(tmp_path / "pi-home"))
    monkeypatch.setenv("ANTHROPIC_API_KEY", "host-claude-key")
    monkeypatch.setenv("CLAUDE_CODE_USE_BEDROCK", "1")
    backend = LocalBackend(LocalConfig(workspace_root=str(tmp_path)))

    first = backend.build_exec_process(
        str(tmp_path),
        {
            "CODEX_BASE_URL": "https://one.example/v1",
            "OPENAI_API_KEY": "first-key",
            "CODEX_MODEL": "first-model",
        },
        ["codex", "--help"],
    )
    second = backend.build_exec_process(
        str(tmp_path),
        {
            "CODEX_BASE_URL": "https://two.example/v1",
            "OPENAI_API_KEY": "second-key",
            "CODEX_MODEL": "second-model",
        },
        ["codex", "--help"],
    )
    claude = backend.build_exec_process(
        str(tmp_path),
        {
            "ANTHROPIC_BASE_URL": "https://claude.example",
            "ANTHROPIC_AUTH_TOKEN": "worker-claude-key",
            "ANTHROPIC_MODEL": "claude-worker-model",
        },
        ["claude", "--help"],
    )
    native_claude = backend.build_exec_process(
        str(tmp_path),
        {},
        ["claude", "--help"],
    )

    for process in (first, second, claude, native_claude):
        assert process.env["HOME"] == str(tmp_path / "home")
        assert process.env["PI_CODING_AGENT_DIR"] == str(tmp_path / "pi-home")
    for process in (claude, native_claude):
        assert process.env["CODEX_HOME"] == str(tmp_path / "codex-home")
    assert first.env["OPENAI_API_KEY"] == "first-key"
    assert first.env["CODEX_MODEL"] == "first-model"
    assert first.env["CODEX_HOME"] == str(tmp_path / "codex-home")
    assert second.env["OPENAI_API_KEY"] == "second-key"
    assert second.env["CODEX_MODEL"] == "second-model"
    assert "ANTHROPIC_API_KEY" not in claude.env
    assert "CLAUDE_CODE_USE_BEDROCK" not in claude.env
    assert native_claude.env["ANTHROPIC_API_KEY"] == "host-claude-key"
    assert native_claude.env["CLAUDE_CODE_USE_BEDROCK"] == "1"


def test_claude_driver_uses_configured_model_and_native_fallback() -> None:
    configured = WorkerConfig.model_validate(
        {
            "name": "claude-configured",
            "type": "claudecode",
            "max_running": 1,
            "priority": 0,
            "env": {
                "ANTHROPIC_BASE_URL": "https://api.example",
                "ANTHROPIC_AUTH_TOKEN": "worker-secret",
                "ANTHROPIC_MODEL": "claude-test",
            },
        }
    )
    native = configured.model_copy(update={"env": {}})

    configured_argv = ClaudeCodeDriver().build_execute(
        configured, "prompt", "session"
    ).argv
    native_argv = ClaudeCodeDriver().build_execute(
        native, "prompt", "session"
    ).argv

    assert configured_argv[configured_argv.index("--model") + 1] == "claude-test"
    assert "--model" not in native_argv
    assert "--json-schema" in configured_argv
    assert "--json-schema" in native_argv


def test_claude_and_pi_receive_redtrace_global_instructions() -> None:
    instructions = "RedTrace automation rules"
    claude_worker = WorkerConfig.model_validate(
        {
            "name": "claude",
            "type": "claudecode",
            "max_running": 1,
            "priority": 0,
            "env": {"REDTRACE_GLOBAL_INSTRUCTIONS": instructions},
        }
    )
    pi_worker = claude_worker.model_copy(update={"name": "pi", "type": "pi"})

    claude = ClaudeCodeDriver().build_execute(claude_worker, "prompt", "session").argv
    pi = PiDriver(local=True).build_execute(pi_worker, "prompt", None).argv

    assert claude[claude.index("--append-system-prompt") + 1] == instructions
    assert pi[pi.index("--append-system-prompt") + 1] == instructions


def test_claude_driver_root_mode_is_noninteractive_and_allows_native_web(
    monkeypatch,
) -> None:
    monkeypatch.setattr(
        "redtrace.dispatcher.workers.adapters.claudecode.os.geteuid",
        lambda: 0,
    )
    argv = ClaudeCodeDriver().build_execute(
        WorkerConfig.model_validate(
            {
                "name": "claude",
                "type": "claudecode",
                "max_running": 1,
                "priority": 0,
            }
        ),
        "prompt",
        "session",
    ).argv

    assert argv[argv.index("--permission-mode") + 1] == "dontAsk"
    allowed_index = argv.index("--allowedTools")
    allowed = argv[allowed_index + 1 : argv.index("--output-format")]
    assert "WebFetch" in allowed
    assert "WebSearch" in allowed
    assert "Bash(*)" in allowed
    assert "--dangerously-skip-permissions" not in argv


def test_claude_driver_extracts_structured_stream_result() -> None:
    stdout = "\n".join(
        [
            '{"type":"system","subtype":"init"}',
            '{"type":"result","structured_output":{"accepted":true,"data":{"description":"ok"}}}',
        ]
    )

    extracted = ClaudeCodeDriver().extract_response_text(stdout, "")

    assert json.loads(extracted) == {
        "accepted": True,
        "data": {"description": "ok"},
    }


def test_codex_driver_execute_argv_passes_model_endpoint_and_prompt() -> None:
    worker = WorkerConfig.model_validate(
        {
            "name": "codex",
            "type": "codex",
            "max_running": 1,
            "priority": 0,
            "context_length": 1_048_576,
            "env": {
                "CODEX_MODEL": "gpt-test",
                "CODEX_BASE_URL": "http://api/v1",
                "OPENAI_API_KEY": "secret",
            },
        }
    )

    argv = CodexDriver().build_execute(worker, "prompt", None).argv

    assert "--model" in argv
    assert "gpt-test" in argv
    assert 'model_providers.redtrace.base_url="http://api/v1"' in argv
    assert 'web_search="live"' in argv
    assert "model_context_window=1048576" in argv
    assert "model_auto_compact_token_limit=943718" in argv
    assert argv[-2:] == ["--", "prompt"]
