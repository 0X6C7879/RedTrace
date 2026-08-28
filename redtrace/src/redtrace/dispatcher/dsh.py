"""Worker-centric DSH runtime configuration composition.

Single source for what the Cordis runtime needs: the DSH-native Worker view
(the scheduling and model-routing unit), the pi-ai provider profiles those
Workers route through, the API keys the providers authenticate with, and the
hot-reloadable runtime config snapshot served to the scheduler.

Workers, not task-type routes, decide models: every enabled Worker with a
configured provider becomes a runtime Worker carrying its own eligibility
flags (bootstrap/reason/explore), concurrency cap, and priority. The provider
owns the API protocol, endpoint, credential, and model list; each model entry
carries capacities, reasoning policy/capabilities, and an optional Chat
Completions wire-format override.
"""

from __future__ import annotations

import hashlib
import re
import json
import os
from typing import Any

from redtrace.dispatcher.config import DispatchConfig, ProviderConfig


def provider_credential(config: DispatchConfig, name: str, provider: ProviderConfig) -> str:
    """Resolve a provider's API key: inline value first, then launch env."""

    if provider.api_key is not None and provider.api_key.strip():
        return provider.api_key.strip()
    if provider.api_key_env is not None:
        value = os.environ.get(provider.api_key_env, "").strip()
        if value:
            return value
    raise ValueError(
        f"provider credential is unavailable: set providers.{name}.api_key "
        "or export its api_key_env"
    )


def dsh_workers(config: DispatchConfig) -> list[dict[str, Any]]:
    """The runtime Worker view: one entry per provider-backed Worker.

    ``mock`` Workers (the deterministic test engine) never run on DSH and are
    skipped; disabled Workers are included so the runtime sees enable/disable
    toggles without a restart. Output caps live on the provider's model
    entries in the pi-ai profile, so the route carries no token overrides.
    """

    workers: list[dict[str, Any]] = []
    for worker in config.workers:
        if worker.provider == "mock":
            continue
        provider = config.providers[worker.provider]
        model = next(item for item in provider.models if item.id == worker.model)
        workers.append({
            "name": worker.name,
            "enabled": worker.enabled,
            "provider": worker.provider,
            "model": worker.model,
            "bootstrap": worker.bootstrap,
            "reason": worker.reason,
            "explore": worker.explore,
            "maxRunning": worker.max_running,
            "priority": worker.priority,
            "reasoning": model.reasoning,
        })
    return workers


def dsh_providers(config: DispatchConfig) -> tuple[dict[str, dict[str, Any]], dict[str, str]]:
    """pi-ai provider profiles plus their ``api_key_env`` -> key values.

    One profile per provider referenced by a Worker, carrying every model the
    provider declares: each model entry owns its capacities, reasoning
    capabilities, and optional wire-compatibility override.
    """

    referenced = {worker.provider for worker in config.workers if worker.provider != "mock"}
    providers: dict[str, dict[str, Any]] = {}
    keys: dict[str, str] = {}
    for name, provider in config.providers.items():
        if name not in referenced:
            continue
        env_name = "REDTRACE_DSH_KEY_" + re.sub(r"[^A-Z0-9]", "_", name.upper())
        models: list[dict[str, Any]] = []
        for model in provider.models:
            entry: dict[str, Any] = {
                "id": model.id,
                "name": model.id,
                "contextWindow": model.context_window,
                "maxTokens": model.max_tokens,
            }
            if model.reasoning_efforts is not None:
                entry["reasoningEfforts"] = model.reasoning_efforts
            # pi-ai only exposes thinkingFormat for Chat Completions. Responses
            # and Anthropic Messages encode reasoning through their adapters.
            if (
                model.thinking_format not in {"auto", "none"}
                and provider.api == "openai-completions"
            ):
                entry["compat"] = {"thinkingFormat": model.thinking_format}
            models.append(entry)
        providers[name] = {
            "displayName": name,
            "apiKeyEnv": env_name,
            "api": provider.api,
            "baseURL": provider.base_url.rstrip("/"),
            "models": models,
        }
        keys[env_name] = provider_credential(config, name, provider)
    return providers, keys


def runtime_config(
    config: DispatchConfig,
    mcp_configs: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    """The hot-reloadable worker-centric runtime config served at ``GET /runtime/config``.

    ``mcp_configs`` carries the fresh MCP mount shapes; when provided the
    scheduler remounts MCP clients on change without a runtime restart.
    """

    providers, env = dsh_providers(config)
    payload: dict[str, Any] = {
        "workers": dsh_workers(config),
        "tasks": config.tasks.model_dump(),
        "limits": {
            "maxWorkers": config.runtime.max_workers,
            "maxRunningProjects": config.runtime.max_running_projects,
            "maxProjectWorkers": config.runtime.max_project_workers,
            "interval": config.runtime.interval,
        },
        "providers": providers,
        "env": env,
        # Worker-facing common_env, kept separate from `env` (provider API
        # keys): the runtime forwards only commonEnv entries into worker
        # shell processes, so provider credentials never reach agents.
        "commonEnv": dict(config.common_env),
    }
    if mcp_configs is not None:
        payload["mcpConfigs"] = mcp_configs
    payload["revision"] = hashlib.sha256(
        json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
    ).hexdigest()
    return payload
