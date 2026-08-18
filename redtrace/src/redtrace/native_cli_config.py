from __future__ import annotations

import json
import os
import re
from copy import deepcopy
from pathlib import Path
from typing import Any

import tomllib

from redtrace.config_secrets import atomic_write_text
from redtrace.dispatcher.config import (
    DEFAULT_PI_MODEL_CONTEXT_WINDOW,
    WorkerConfig,
    model_auto_compact_token_limit,
)


class NativeCliConfigError(ValueError):
    pass


CODEX_DEFAULTS_START = "# >>> RedTrace managed defaults >>>"
CODEX_DEFAULTS_END = "# <<< RedTrace managed defaults <<<"
CODEX_PROVIDER_START = "# >>> RedTrace managed provider >>>"
CODEX_PROVIDER_END = "# <<< RedTrace managed provider <<<"


def resolve_cli_config_home(value: str | Path | None = None) -> Path:
    configured = value or os.environ.get("REDTRACE_CLI_CONFIG_HOME")
    return (
        Path(configured).expanduser().resolve() if configured else Path.home().resolve()
    )


def native_config_paths(home: Path, worker_type: str) -> list[Path]:
    if worker_type == "claudecode":
        return [home / ".claude" / "settings.json"]
    if worker_type == "codex":
        root = home / ".codex"
        return [root / "config.toml", root / "auth.json"]
    if worker_type == "pi":
        root = home / ".pi" / "agent"
        return [root / "settings.json", root / "models.json"]
    return []


def sync_native_cli_config(home: Path, worker: WorkerConfig) -> None:
    if not worker.api_configured():
        return
    try:
        if worker.type == "claudecode":
            _write_claude(home, worker)
        elif worker.type == "codex":
            _write_codex(home, worker)
        elif worker.type == "pi":
            _write_pi(home, worker)
    except NativeCliConfigError:
        raise
    except (OSError, ValueError, TypeError) as exc:
        raise NativeCliConfigError(
            f"failed to update {worker.type} user configuration: {exc}"
        ) from exc


def _read_json_object(path: Path) -> dict[str, Any]:
    if not path.exists():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise NativeCliConfigError(f"{path} is not valid UTF-8 JSON") from exc
    if not isinstance(value, dict):
        raise NativeCliConfigError(f"{path} must contain a JSON object")
    return value


def _write_json(path: Path, value: dict[str, Any]) -> None:
    atomic_write_text(
        path,
        json.dumps(value, ensure_ascii=False, indent=2) + "\n",
    )


def _write_claude(home: Path, worker: WorkerConfig) -> None:
    path = native_config_paths(home, worker.type)[0]
    existing = _read_json_object(path)
    env = existing.get("env")
    if env is None:
        env = {}
    if not isinstance(env, dict):
        raise NativeCliConfigError(f"{path} env must be a JSON object")

    model = worker.env["ANTHROPIC_MODEL"]
    env = deepcopy(env)
    env.pop("CLAUDE_CODE_AUTO_COMPACT_WINDOW", None)
    # Instruct Claude to think and respond in Chinese.
    env["CLAUDE_CODE_USER_PROMPT_APPEND"] = "\n请始终使用中文进行思考、分析和回答。"
    env.update(
        {
            "ANTHROPIC_AUTH_TOKEN": worker.env["ANTHROPIC_AUTH_TOKEN"],
            "ANTHROPIC_MODEL": model,
            "ANTHROPIC_DEFAULT_SONNET_MODEL": model,
            "ANTHROPIC_DEFAULT_OPUS_MODEL": model,
            "ANTHROPIC_DEFAULT_HAIKU_MODEL": model,
            "CLAUDE_CODE_SUBAGENT_MODEL": model,
            "CLAUDE_AUTOCOMPACT_PCT_OVERRIDE": "90",
            "CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION": "1000",
            # Full extended-thinking strength for native Claude Code runs.
            "MAX_THINKING_TOKENS": "31999",
        }
    )
    # In direct endpoint mode the runtime relay provides the URL via the
    # ANTHROPIC_BASE_URL env var.  Writing the raw proxy URL to settings.json
    # would override the env var (settings.json env has higher priority),
    # so skip the base URL write and remove any stale value copied from
    # the user's ~/.claude/settings.json.
    if worker.endpoint_mode != "direct":
        env["ANTHROPIC_BASE_URL"] = worker.env["ANTHROPIC_BASE_URL"]
    else:
        env.pop("ANTHROPIC_BASE_URL", None)
    if worker.context_length is not None:
        env["CLAUDE_CODE_AUTO_COMPACT_WINDOW"] = str(worker.context_length)
    updated = deepcopy(existing)
    updated["model"] = model
    updated["env"] = env
    _write_json(path, updated)


def _strip_marked_block(content: str, start: str, end: str) -> str:
    pattern = re.compile(
        rf"(?ms)^\s*{re.escape(start)}\s*$.*?^\s*{re.escape(end)}\s*$\n?"
    )
    return pattern.sub("", content)


def _remove_redtrace_provider_tables(lines: list[str]) -> list[str]:
    kept: list[str] = []
    skipping = False
    for line in lines:
        match = re.match(r"^\s*\[\s*([^\]]+?)\s*\]\s*(?:#.*)?$", line)
        if match:
            table = match.group(1).strip()
            skipping = table == "model_providers.redtrace" or table.startswith(
                "model_providers.redtrace."
            )
        if not skipping:
            kept.append(line)
    return kept


def _write_codex(home: Path, worker: WorkerConfig) -> None:
    path, auth_path = native_config_paths(home, worker.type)
    try:
        existing = path.read_text(encoding="utf-8") if path.exists() else ""
        if existing.strip():
            tomllib.loads(existing)
    except (OSError, UnicodeDecodeError, tomllib.TOMLDecodeError) as exc:
        raise NativeCliConfigError(f"{path} is not valid UTF-8 TOML") from exc

    cleaned = _strip_marked_block(existing, CODEX_DEFAULTS_START, CODEX_DEFAULTS_END)
    cleaned = _strip_marked_block(cleaned, CODEX_PROVIDER_START, CODEX_PROVIDER_END)
    lines = cleaned.splitlines()
    first_table = next(
        (index for index, line in enumerate(lines) if re.match(r"^\s*\[", line)),
        len(lines),
    )
    managed_root_keys = {
        "approval_policy",
        "model",
        "model_auto_compact_token_limit",
        "model_auto_compact_token_limit_scope",
        "model_context_window",
        "model_provider",
        "model_reasoning_effort",
        "model_reasoning_summary",
        "sandbox_mode",
        "web_search",
    }
    root_lines = []
    for line in lines[:first_table]:
        match = re.match(r"^\s*([A-Za-z0-9_]+)\s*=", line)
        if match and match.group(1) in managed_root_keys:
            continue
        root_lines.append(line)
    table_lines = _remove_redtrace_provider_tables(lines[first_table:])

    quote = lambda value: json.dumps(value, ensure_ascii=False)
    defaults = [
        CODEX_DEFAULTS_START,
        f"model = {quote(worker.env['CODEX_MODEL'])}",
        'model_provider = "redtrace"',
        'approval_policy = "never"',
        'sandbox_mode = "danger-full-access"',
        'web_search = "live"',
        # Full reasoning strength for native Codex runs.
        'model_reasoning_effort = "high"',
        'model_reasoning_summary = "detailed"',
        'custom_instructions = "请始终使用中文进行思考、分析和回答。"',
        *(
            [
                f"model_context_window = {worker.context_length}",
                (
                    "model_auto_compact_token_limit = "
                    f"{model_auto_compact_token_limit(worker.context_length)}"
                ),
                'model_auto_compact_token_limit_scope = "total"',
            ]
            if worker.context_length is not None
            else []
        ),
        CODEX_DEFAULTS_END,
    ]
    provider = [
        CODEX_PROVIDER_START,
        "[model_providers.redtrace]",
        'name = "RedTrace"',
        f"base_url = {quote(worker.env['CODEX_BASE_URL'])}",
        'wire_api = "responses"',
        'env_key = "OPENAI_API_KEY"',
        CODEX_PROVIDER_END,
    ]
    sections = [
        "\n".join(defaults),
        "\n".join(root_lines).strip(),
        "\n".join(provider),
        "\n".join(table_lines).strip(),
    ]
    updated = "\n\n".join(section for section in sections if section) + "\n"
    try:
        tomllib.loads(updated)
    except tomllib.TOMLDecodeError as exc:
        raise NativeCliConfigError(
            f"could not safely merge RedTrace settings into {path}"
        ) from exc
    atomic_write_text(path, updated)
    auth = deepcopy(_read_json_object(auth_path))
    auth["OPENAI_API_KEY"] = worker.env["OPENAI_API_KEY"]
    _write_json(auth_path, auth)


def _write_pi(home: Path, worker: WorkerConfig) -> None:
    settings_path, models_path = native_config_paths(home, worker.type)
    settings = deepcopy(_read_json_object(settings_path))
    settings["defaultProvider"] = "redtrace"
    settings["defaultModel"] = worker.env["PI_MODEL"]
    settings["compaction"] = {
        "enabled": True,
        "reserveTokens": 64 * 1024,
        "keepRecentTokens": 128 * 1024,
    }

    models = deepcopy(_read_json_object(models_path))
    providers = models.get("providers")
    if providers is None:
        providers = {}
    if not isinstance(providers, dict):
        raise NativeCliConfigError(f"{models_path} providers must be a JSON object")
    providers = deepcopy(providers)
    context_window = (
        worker.context_length
        if worker.context_length is not None
        else DEFAULT_PI_MODEL_CONTEXT_WINDOW
    )
    redtrace_provider: dict[str, Any] = {
        "baseUrl": worker.env["PI_BASE_URL"],
        "apiKey": worker.env["PI_API_KEY"],
        "api": worker.env["PI_PROVIDER_API"],
        "models": [
            {
                "id": worker.env["PI_MODEL"],
                "name": worker.env["PI_MODEL"],
                "reasoning": True,
                "input": ["text", "image"],
                "contextWindow": context_window,
                "maxTokens": min(128 * 1024, context_window),
            }
        ],
    }
    providers["redtrace"] = redtrace_provider
    models["providers"] = providers
    if "systemPromptAppend" not in settings:
        settings["systemPromptAppend"] = "请始终使用中文进行思考、分析和回答。"
    _write_json(models_path, models)
    _write_json(settings_path, settings)
