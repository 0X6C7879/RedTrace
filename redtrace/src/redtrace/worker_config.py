from __future__ import annotations

import hashlib
import json
import os
import re
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from secrets import token_hex
from typing import Any

import httpx
import yaml
from pydantic import ValidationError

from redtrace.config_secrets import (
    SecretStore,
    atomic_write_text,
    resolve_dispatch_config_path,
    secret_id_from_reference,
    secret_reference,
)
from redtrace.dispatcher import dsh
from redtrace.dispatcher.config import (
    DispatchConfig,
    WorkerConfig,
    validate_prompt_resources,
)
from redtrace.dispatcher.dsh import provider_credential

NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TASK_TYPES = frozenset({"bootstrap", "reason", "explore"})
TASK_TYPES_ORDER = ("bootstrap", "reason", "explore")
PROVIDER_APIS = ("openai-completions", "openai-responses", "anthropic-messages")
PROVIDER_THINKING_FORMATS = ("auto", "deepseek", "openai", "none")
PROVIDER_REASONING_POLICIES = (
    "auto_max",
    "max",
    "xhigh",
    "high",
    "medium",
    "low",
    "minimal",
    "off",
)
PROVIDER_REASONING_EFFORTS = frozenset(PROVIDER_REASONING_POLICIES[1:])
ENV_NAME_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]*$")
HTTP_URL_PATTERN = re.compile(r"^https?://\S+$")
LOCK_TIMEOUT_SECONDS = 10.0
STALE_LOCK_SECONDS = 60.0
TEST_CACHE_SECONDS = 60.0


class WorkerConfigError(RuntimeError):
    """The dispatcher config could not be read or does not accept the change."""


class WorkerConfigConflict(WorkerConfigError):
    """The config revision moved between read and write."""


class WorkerConnectionError(WorkerConfigError):
    """A Worker's provider endpoint failed its connection test."""


def _safe_validation_error(exc: ValidationError) -> str:
    messages = []
    for error in exc.errors(include_input=False, include_url=False):
        location = ".".join(str(part) for part in error.get("loc", ()))
        message = str(error.get("msg") or "invalid value")
        messages.append(f"{location}: {message}" if location else message)
    return "; ".join(messages) or "worker configuration is invalid"


def _revision(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def _read_raw(path: Path) -> tuple[dict[str, Any], str]:
    try:
        content = path.read_bytes()
    except FileNotFoundError as exc:
        raise WorkerConfigError(f"dispatcher config not found: {path}") from exc
    try:
        value = yaml.safe_load(content.decode("utf-8")) or {}
    except (UnicodeDecodeError, yaml.YAMLError) as exc:
        raise WorkerConfigError("dispatcher config is not valid UTF-8 YAML") from exc
    if not isinstance(value, dict):
        raise WorkerConfigError("dispatcher config root must be an object")
    workers = value.get("workers")
    if not isinstance(workers, list):
        raise WorkerConfigError("dispatcher config workers must be an array")
    return value, _revision(content)


def _dump_raw(value: dict[str, Any]) -> str:
    return yaml.safe_dump(
        value,
        allow_unicode=True,
        default_flow_style=False,
        sort_keys=False,
    )


@contextmanager


def _config_lock(path: Path) -> Iterator[None]:
    lock_path = path.with_name(f".{path.name}.lock")
    deadline = time.monotonic() + LOCK_TIMEOUT_SECONDS
    while True:
        try:
            fd = os.open(lock_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            try:
                stale = time.time() - lock_path.stat().st_mtime > STALE_LOCK_SECONDS
            except FileNotFoundError:
                continue
            if stale:
                lock_path.unlink(missing_ok=True)
                continue
            if time.monotonic() >= deadline:
                raise WorkerConfigConflict("worker configuration is busy; retry")
            time.sleep(0.05)
            continue
        with os.fdopen(fd, "w", encoding="ascii") as handle:
            handle.write(f"{os.getpid()}\n")
        break
    try:
        yield
    finally:
        lock_path.unlink(missing_ok=True)


def _find_worker(raw: dict[str, Any], name: str) -> tuple[int, dict[str, Any]]:
    for index, worker in enumerate(raw["workers"]):
        if isinstance(worker, dict) and worker.get("name") == name:
            return index, worker
    raise WorkerConfigError(f"worker not found: {name}")


def _normalize_name(value: object) -> str:
    name = str(value or "").strip()
    if not NAME_PATTERN.fullmatch(name):
        raise WorkerConfigError(
            "worker name must match ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$"
        )
    return name


def _worker_payload(
    payload: dict[str, Any],
    *,
    runtime_max_workers: int,
    existing: dict[str, Any] | None = None,
    providers: dict[str, Any] | None = None,
) -> dict[str, Any]:
    name = _normalize_name(payload.get("name"))
    provider = str(payload.get("provider") or "").strip()
    known = set(providers or {})
    if provider != "mock" and provider not in known:
        raise WorkerConfigError(
            "provider must be 'mock' or a providers entry: "
            + (", ".join(sorted(known)) or "(none configured)")
        )
    model = str(payload.get("model") or "").strip()
    if provider != "mock" and not model:
        raise WorkerConfigError("model is required")
    if len(model) > 256:
        raise WorkerConfigError("model must not exceed 256 characters")
    if provider != "mock":
        declared = _provider_model_ids((providers or {}).get(provider))
        if model not in declared:
            raise WorkerConfigError(
                "model must be one of provider "
                f"{provider}'s models: " + (", ".join(declared) or "(none)")
            )

    flags = {task_type: bool(payload.get(task_type, True)) for task_type in TASK_TYPES_ORDER}
    if provider != "mock" and not any(flags.values()):
        raise WorkerConfigError(
            "at least one of bootstrap, reason, or explore is required"
        )

    try:
        priority = int(payload.get("priority"))
        max_running = int(payload.get("max_running"))
    except (TypeError, ValueError) as exc:
        raise WorkerConfigError("priority and max_running must be integers") from exc
    if not 0 <= priority <= 1000:
        raise WorkerConfigError("priority must be between 0 and 1000")
    if not 1 <= max_running <= runtime_max_workers:
        raise WorkerConfigError(
            f"max_running must be between 1 and runtime.max_workers ({runtime_max_workers})"
        )

    mock_env: dict[str, Any] = {}
    if provider == "mock" and isinstance(existing, dict) and isinstance(existing.get("env"), dict):
        mock_env = dict(existing["env"])

    return {
        "name": name,
        "enabled": bool(payload.get("enabled", True)),
        "provider": provider,
        "model": model or "mock",
        **flags,
        "max_running": max_running,
        "priority": priority,
        **({"env": mock_env} if mock_env else {}),
    }


def _positive_int(payload: dict[str, Any], field: str, default: int) -> int:
    value = payload.get(field, default)
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise WorkerConfigError(f"{field} must be an integer") from exc
    if parsed <= 0:
        raise WorkerConfigError(f"{field} must be greater than 0")
    return parsed


def _provider_model_payload(
    payload: dict[str, Any],
    index: int,
) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise WorkerConfigError(f"models[{index}] must be an object")
    model_id = str(payload.get("id") or "").strip()
    if not model_id:
        raise WorkerConfigError(f"models[{index}].id is required")
    if len(model_id) > 256:
        raise WorkerConfigError(
            f"models[{index}].id must not exceed 256 characters"
        )
    reasoning = str(payload.get("reasoning") or "auto_max").strip()
    if reasoning not in PROVIDER_REASONING_POLICIES:
        raise WorkerConfigError(
            f"models[{index}].reasoning must be one of: "
            + ", ".join(PROVIDER_REASONING_POLICIES)
        )
    raw_efforts = payload.get("reasoning_efforts")
    reasoning_efforts: dict[str, str | None] | bool | None
    if raw_efforts is None or raw_efforts is False:
        reasoning_efforts = raw_efforts
    elif isinstance(raw_efforts, dict) and raw_efforts:
        unknown = set(raw_efforts) - PROVIDER_REASONING_EFFORTS
        if unknown:
            raise WorkerConfigError(
                f"models[{index}].reasoning_efforts has unknown levels: "
                + ", ".join(sorted(unknown))
            )
        reasoning_efforts = {}
        for level, value in raw_efforts.items():
            if level == "off" and value is None:
                reasoning_efforts[level] = None
                continue
            wire_value = str(value or "").strip()
            if not wire_value:
                raise WorkerConfigError(
                    f"models[{index}].reasoning_efforts.{level} must be non-empty"
                )
            reasoning_efforts[level] = wire_value
    else:
        raise WorkerConfigError(
            f"models[{index}].reasoning_efforts must be an object, false, or null"
        )
    thinking_format = str(payload.get("thinking_format") or "auto").strip()
    if thinking_format not in PROVIDER_THINKING_FORMATS:
        raise WorkerConfigError(
            f"models[{index}].thinking_format must be one of: "
            + ", ".join(PROVIDER_THINKING_FORMATS)
        )
    return {
        "id": model_id,
        "context_window": _positive_int(payload, "context_window", 1_000_000),
        "max_tokens": _positive_int(payload, "max_tokens", 128_000),
        "reasoning": reasoning,
        **(
            {"reasoning_efforts": reasoning_efforts}
            if reasoning_efforts is not None
            else {}
        ),
        "thinking_format": thinking_format,
    }


def _provider_payload(
    payload: dict[str, Any],
    *,
    existing: dict[str, Any] | None = None,
) -> tuple[str, dict[str, Any]]:
    """Validate one provider entry; returns ``(name, body)`` for the YAML map.

    The provider owns its model list; each model entry carries capacities,
    reasoning policy/capabilities, and a protocol override. Credential
    semantics: a missing
    ``api_key``/``api_key_env`` inherits the existing entry's value (so a UI
    edit can leave the secret untouched) while an empty string clears it; at
    least one credential must remain.
    """
    name = _normalize_name(payload.get("name"))
    api = str(payload.get("api") or "openai-completions").strip()
    if api not in PROVIDER_APIS:
        raise WorkerConfigError(
            "api must be one of: " + ", ".join(PROVIDER_APIS)
        )
    base_url = str(payload.get("base_url") or "").strip().rstrip("/")
    if not HTTP_URL_PATTERN.fullmatch(base_url):
        raise WorkerConfigError("base_url must be an http(s) URL")

    raw_models = payload.get("models")
    if not isinstance(raw_models, list) or not raw_models:
        raise WorkerConfigError("at least one model is required")
    models = [_provider_model_payload(item, index) for index, item in enumerate(raw_models)]
    ids = [model["id"] for model in models]
    if len(set(ids)) != len(ids):
        raise WorkerConfigError("model ids must be unique within a provider")

    body: dict[str, Any] = {
        "api": api,
        "base_url": base_url,
        "models": models,
    }

    previous = existing if isinstance(existing, dict) else {}
    api_key: str | None
    if payload.get("api_key") is None:
        api_key = previous.get("api_key")
    else:
        api_key = str(payload["api_key"]).strip() or None
    api_key_env: str | None
    if payload.get("api_key_env") is None:
        api_key_env = previous.get("api_key_env")
    else:
        api_key_env = str(payload["api_key_env"]).strip() or None
    if api_key_env is not None and not ENV_NAME_PATTERN.fullmatch(api_key_env):
        raise WorkerConfigError(
            "api_key_env must match ^[A-Z][A-Z0-9_]*$"
        )
    if api_key:
        body["api_key"] = api_key
    if api_key_env:
        body["api_key_env"] = api_key_env
    if not api_key and not api_key_env:
        raise WorkerConfigError("provider needs api_key or api_key_env")
    return name, body


def _provider_model_ids(raw_provider: Any) -> list[str]:
    if not isinstance(raw_provider, dict):
        return []
    models = raw_provider.get("models")
    if not isinstance(models, list):
        return []
    return [
        str(model.get("id"))
        for model in models
        if isinstance(model, dict) and model.get("id")
    ]


def _resolved_copy(raw: dict[str, Any], secrets: dict[str, str]) -> dict[str, Any]:
    resolved = deepcopy(raw)
    environments: list[dict[str, Any]] = []
    common_env = resolved.get("common_env")
    if isinstance(common_env, dict):
        environments.append(common_env)
    for worker in resolved.get("workers", []):
        if isinstance(worker, dict) and isinstance(worker.get("env"), dict):
            environments.append(worker["env"])
    for env in environments:
        for key, value in list(env.items()):
            secret_id = secret_id_from_reference(value)
            if secret_id is None:
                continue
            try:
                env[key] = secrets[secret_id]
            except KeyError as exc:
                raise WorkerConfigError(
                    "worker configuration references a missing secret"
                ) from exc
    providers = resolved.get("providers")
    if isinstance(providers, dict):
        for name, provider in providers.items():
            if not isinstance(provider, dict):
                continue
            secret_id = secret_id_from_reference(provider.get("api_key"))
            if secret_id is None:
                continue
            try:
                provider["api_key"] = secrets[secret_id]
            except KeyError as exc:
                raise WorkerConfigError(
                    f"provider {name} references a missing secret"
                ) from exc
    return resolved


def _secure_plaintext_keys(
    raw: dict[str, Any],
    secrets: dict[str, str],
) -> None:
    providers = raw.get("providers")
    if not isinstance(providers, dict):
        return
    for provider in providers.values():
        if not isinstance(provider, dict):
            continue
        value = provider.get("api_key")
        if (
            not isinstance(value, str)
            or not value
            or secret_id_from_reference(value)
        ):
            continue
        secret_id = token_hex(16)
        secrets[secret_id] = value
        provider["api_key"] = secret_reference(secret_id)


def _referenced_secret_ids(raw: dict[str, Any]) -> set[str]:
    referenced: set[str] = set()
    stack: list[Any] = [raw]
    while stack:
        value = stack.pop()
        if isinstance(value, dict):
            stack.extend(value.values())
        elif isinstance(value, list):
            stack.extend(value)
        else:
            secret_id = secret_id_from_reference(value)
            if secret_id:
                referenced.add(secret_id)
    return referenced


def _validate_config(raw: dict[str, Any], secrets: dict[str, str]) -> DispatchConfig:
    try:
        config = DispatchConfig.model_validate(_resolved_copy(raw, secrets))
        validate_prompt_resources(config.runtime.prompt_group)
    except ValidationError as exc:
        raise WorkerConfigError(_safe_validation_error(exc)) from exc
    except ValueError as exc:
        raise WorkerConfigError(str(exc)) from exc
    return config


class WorkerConnectionTester:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._success_cache: dict[str, tuple[float, dict[str, Any]]] = {}

    def test(self, config: DispatchConfig, worker: WorkerConfig) -> dict[str, Any]:
        digest = self._digest(config, worker)
        now = time.monotonic()
        with self._lock:
            cached = self._success_cache.get(digest)
            if cached and now - cached[0] <= TEST_CACHE_SECONDS:
                return {**cached[1], "cached": True}
        result = self._probe(config, worker)
        if not result["ok"]:
            raise WorkerConnectionError(result["detail"])
        with self._lock:
            self._success_cache = {
                key: value
                for key, value in self._success_cache.items()
                if now - value[0] <= TEST_CACHE_SECONDS
            }
            self._success_cache[digest] = (now, result)
        return {**result, "cached": False}

    @staticmethod
    def _digest(config: DispatchConfig, worker: WorkerConfig) -> str:
        provider = config.providers.get(worker.provider)
        payload = {
            "api": provider.api if provider else None,
            "base_url": provider.base_url if provider else None,
            "api_key": provider.api_key if provider else None,
            "api_key_env": provider.api_key_env if provider else None,
            "model": worker.model,
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _probe(config: DispatchConfig, worker: WorkerConfig) -> dict[str, Any]:
        if worker.provider == "mock":
            return {
                "ok": True,
                "status": None,
                "duration_ms": 0,
                "detail": "mock worker needs no connection",
            }
        provider = config.providers.get(worker.provider)
        if provider is None:
            return {
                "ok": False,
                "status": None,
                "duration_ms": 0,
                "detail": f"provider '{worker.provider}' is not configured",
            }
        try:
            key = provider_credential(config, worker.provider, provider)
        except ValueError as exc:
            return {"ok": False, "status": None, "duration_ms": 0, "detail": str(exc)}

        if provider.api == "anthropic-messages":
            url = f"{provider.base_url.rstrip('/')}/v1/messages"
            headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
            body = {
                "model": worker.model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "ping"}],
            }
        elif provider.api == "openai-responses":
            url = f"{provider.base_url.rstrip('/')}/responses"
            headers = {"authorization": f"Bearer {key}"}
            body = {
                "model": worker.model,
                "max_output_tokens": 1,
                "input": "ping",
            }
        else:
            url = f"{provider.base_url.rstrip('/')}/chat/completions"
            headers = {"authorization": f"Bearer {key}"}
            body = {
                "model": worker.model,
                "max_tokens": 1,
                "messages": [{"role": "user", "content": "ping"}],
            }
        started = time.perf_counter()
        try:
            response = httpx.post(url, headers=headers, json=body, timeout=10.0)
        except httpx.HTTPError as exc:
            return {
                "ok": False,
                "status": None,
                "duration_ms": int((time.perf_counter() - started) * 1000),
                "detail": f"connection failed: {exc.__class__.__name__}",
            }
        duration_ms = int((time.perf_counter() - started) * 1000)
        if response.status_code == 401 or response.status_code == 403:
            return {
                "ok": False,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "detail": "authentication failed: check the provider API key",
            }
        if response.status_code == 404:
            return {
                "ok": False,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "detail": "endpoint not found: check the provider base URL",
            }
        if response.status_code >= 500:
            return {
                "ok": False,
                "status": response.status_code,
                "duration_ms": duration_ms,
                "detail": f"provider error {response.status_code}",
            }
        # 400 (bad request for a probe) and 2xx both prove reachability and auth.
        return {
            "ok": True,
            "status": response.status_code,
            "duration_ms": duration_ms,
            "detail": "connection successful",
        }


CONNECTION_TESTER = WorkerConnectionTester()


class WorkerConfigService:
    def __init__(self, path: Path | None = None) -> None:
        self.path = resolve_dispatch_config_path(path)
        self.secrets = SecretStore(self.path)

    def snapshot(self) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        secrets = self.secrets.load()
        config = _validate_config(raw, secrets)
        workers = [self._view(worker) for worker in config.workers]
        dsh_snapshot = (
            dsh.runtime_config(config)
            if any(worker.provider != "mock" for worker in config.workers)
            else None
        )
        if dsh_snapshot is not None:
            # The scheduler-only runtime endpoint needs these resolved values;
            # the admin settings snapshot must never send them to the browser.
            dsh_snapshot.pop("env", None)
            dsh_snapshot.pop("commonEnv", None)
        return {
            "revision": revision,
            "engine": (
                "dsh"
                if any(worker.provider != "mock" for worker in config.workers)
                else "mock"
            ),
            "execution": config.runtime.execution,
            "runtime_max_workers": config.runtime.max_workers,
            "runtime": {
                "max_workers": config.runtime.max_workers,
                "max_running_projects": config.runtime.max_running_projects,
                "max_project_workers": config.runtime.max_project_workers,
            },
            "tasks": config.tasks.model_dump(),
            "common_env": [
                {
                    "name": name,
                    "value": value,
                }
                for name, value in sorted(config.common_env.items())
            ],
            "providers": [
                {
                    "name": name,
                    "api": provider.api,
                    "base_url": provider.base_url,
                    "api_key_configured": bool(provider.api_key),
                    "api_key_env": provider.api_key_env,
                    "models": [
                        {
                            "id": model.id,
                            "context_window": model.context_window,
                            "max_tokens": model.max_tokens,
                            "reasoning": model.reasoning,
                            "reasoning_efforts": model.reasoning_efforts,
                            "thinking_format": (
                                "auto"
                                if model.thinking_format == "none"
                                else model.thinking_format
                            ),
                        }
                        for model in provider.models
                    ],
                    "referenced": any(
                        worker.provider == name for worker in config.workers
                    ),
                }
                for name, provider in sorted(config.providers.items())
            ],
            "dsh": dsh_snapshot,
            "workers": workers,
        }

    def update_runtime_tasks(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, str(payload.get("expected_revision") or ""))
        runtime = payload.get("runtime")
        tasks = payload.get("tasks")
        if not isinstance(runtime, dict) or not isinstance(tasks, dict):
            raise WorkerConfigError("runtime and tasks are required")
        runtime_fields = (
            "max_workers",
            "max_running_projects",
            "max_project_workers",
        )
        task_fields = {
            "bootstrap": ("timeout", "conclude_timeout"),
            "reason": ("timeout", "max_intents"),
            "explore": ("timeout", "conclude_timeout"),
        }
        if any(field not in runtime for field in runtime_fields):
            raise WorkerConfigError("all runtime limits are required")
        for field in runtime_fields:
            raw["runtime"][field] = runtime[field]
        for task_type, fields in task_fields.items():
            values = tasks.get(task_type)
            if not isinstance(values, dict) or any(field not in values for field in fields):
                raise WorkerConfigError(f"all tasks.{task_type} settings are required")
            for field in fields:
                raw["tasks"][task_type][field] = values[field]
        # The worker-centric DSH view derives from Workers; the runtime picks
        # it up through /runtime/config hot reload.
        secrets = self.secrets.load()
        _validate_config(raw, secrets)
        self._commit(raw, revision, secrets=secrets)
        return self.snapshot()

    def update_common_env(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, str(payload.get("expected_revision") or ""))
        entries = payload.get("entries")
        if not isinstance(entries, list):
            raise WorkerConfigError("common_env entries must be an array")
        common_env: dict[str, str] = {}
        for index, entry in enumerate(entries):
            if not isinstance(entry, dict):
                raise WorkerConfigError(f"common_env entries[{index}] must be an object")
            name = str(entry.get("name") or "").strip()
            if not ENV_NAME_PATTERN.fullmatch(name):
                raise WorkerConfigError(
                    f"common_env entries[{index}].name must match ^[A-Z][A-Z0-9_]*$"
                )
            if name in common_env:
                raise WorkerConfigError(f"duplicate common_env name: {name}")
            value = entry.get("value")
            if not isinstance(value, str):
                raise WorkerConfigError(f"common_env {name} value is required")
            common_env[name] = value

        raw["common_env"] = common_env
        secrets = self.secrets.load()
        _validate_config(raw, secrets)
        self._commit(raw, revision, secrets=secrets)
        return self.snapshot()

    def set_common_env_value(self, name: str, value: str) -> None:
        """Set one plaintext common environment value for deployment helpers."""
        normalized = str(name or "").strip()
        if not ENV_NAME_PATTERN.fullmatch(normalized):
            raise WorkerConfigError(
                "common_env name must match ^[A-Z][A-Z0-9_]*$"
            )
        if not isinstance(value, str):
            raise WorkerConfigError("common_env value must be a string")
        raw, revision = _read_raw(self.path)
        common_env = raw.setdefault("common_env", {})
        if not isinstance(common_env, dict):
            raise WorkerConfigError("dispatcher config common_env must be an object")
        common_env[normalized] = value
        secrets = self.secrets.load()
        _validate_config(raw, secrets)
        self._commit(raw, revision, secrets=secrets)

    def create_provider(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, str(payload.get("expected_revision") or ""))
        name, body = _provider_payload(payload)
        providers = raw.setdefault("providers", {})
        if not isinstance(providers, dict):
            raise WorkerConfigError("dispatcher config providers must be an object")
        if name in providers:
            raise WorkerConfigError(f"provider already exists: {name}")
        providers[name] = body
        return self._commit_provider(raw, revision)

    def update_provider(self, original_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, str(payload.get("expected_revision") or ""))
        providers = raw.get("providers")
        if not isinstance(providers, dict) or original_name not in providers:
            raise WorkerConfigError(f"provider not found: {original_name}")
        name, body = _provider_payload(
            payload,
            existing=providers[original_name] if isinstance(providers[original_name], dict) else {},
        )
        if name != original_name:
            if name in providers:
                raise WorkerConfigError(f"provider already exists: {name}")
            # Rename cascades: every Worker route through this provider follows it.
            for worker in raw["workers"]:
                if isinstance(worker, dict) and worker.get("provider") == original_name:
                    worker["provider"] = name
            del providers[original_name]
        providers[name] = body
        return self._commit_provider(raw, revision)

    def delete_provider(self, name: str, expected_revision: str) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, expected_revision)
        providers = raw.get("providers")
        if not isinstance(providers, dict) or name not in providers:
            raise WorkerConfigError(f"provider not found: {name}")
        referencing = [
            worker.get("name")
            for worker in raw["workers"]
            if isinstance(worker, dict) and worker.get("provider") == name
        ]
        if referencing:
            raise WorkerConfigError(
                f"provider {name} is referenced by workers: "
                + ", ".join(str(item) for item in referencing)
                + "; remove or repoint them first"
            )
        del providers[name]
        return self._commit_provider(raw, revision)

    def _commit_provider(self, raw: dict[str, Any], revision: str) -> dict[str, Any]:
        # Provider edits carry no model to probe; Workers test the live route
        # on save. Validation plus the hot-reload path (/runtime/config) make
        # the change visible to the scheduler without a restart.
        secrets = self.secrets.load()
        _validate_config(raw, secrets)
        self._commit(raw, revision, secrets=secrets)
        return self.snapshot()

    def test_payload(
        self,
        payload: dict[str, Any],
        *,
        original_name: str | None = None,
    ) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        expected = str(payload.get("expected_revision") or "")
        self._check_revision(revision, expected)
        existing = _find_worker(raw, original_name)[1] if original_name else None
        candidate = _worker_payload(
            payload,
            runtime_max_workers=int(raw["runtime"]["max_workers"]),
            existing=existing,
            providers=raw.get("providers") if isinstance(raw.get("providers"), dict) else {},
        )
        candidate_raw = deepcopy(raw)
        if original_name:
            index, _ = _find_worker(candidate_raw, original_name)
            candidate_raw["workers"][index] = candidate
        else:
            candidate_raw["workers"].append(candidate)
        secrets = self.secrets.load()
        config = _validate_config(candidate_raw, secrets)
        worker = next(item for item in config.workers if item.name == candidate["name"])
        return CONNECTION_TESTER.test(config, worker)

    def create(self, payload: dict[str, Any]) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, str(payload.get("expected_revision") or ""))
        candidate = _worker_payload(
            payload,
            runtime_max_workers=int(raw["runtime"]["max_workers"]),
            providers=raw.get("providers") if isinstance(raw.get("providers"), dict) else {},
        )
        if any(
            isinstance(worker, dict) and worker.get("name") == candidate["name"]
            for worker in raw["workers"]
        ):
            raise WorkerConfigError(f"worker already exists: {candidate['name']}")
        raw["workers"].append(candidate)
        return self._test_and_commit(raw, revision, candidate["name"])

    def update(self, original_name: str, payload: dict[str, Any]) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, str(payload.get("expected_revision") or ""))
        index, existing = _find_worker(raw, original_name)
        candidate = _worker_payload(
            payload,
            runtime_max_workers=int(raw["runtime"]["max_workers"]),
            existing=existing,
            providers=raw.get("providers") if isinstance(raw.get("providers"), dict) else {},
        )
        if candidate["name"] != original_name and any(
            isinstance(worker, dict) and worker.get("name") == candidate["name"]
            for worker in raw["workers"]
        ):
            raise WorkerConfigError(f"worker already exists: {candidate['name']}")
        raw["workers"][index] = candidate
        return self._test_and_commit(raw, revision, candidate["name"])

    def copy(self, name: str, expected_revision: str) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, expected_revision)
        _, source = _find_worker(raw, name)
        if source.get("provider") == "mock":
            raise WorkerConfigError("mock Workers cannot be copied in the Web UI")
        copied = deepcopy(source)
        copied["name"] = self._copy_name(raw, name)
        raw["workers"].append(copied)
        return self._test_and_commit(raw, revision, copied["name"])

    def set_enabled(
        self,
        name: str,
        enabled: bool,
        expected_revision: str,
    ) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, expected_revision)
        index, worker = _find_worker(raw, name)
        updated = deepcopy(worker)
        updated["enabled"] = enabled
        raw["workers"][index] = updated
        if enabled:
            return self._test_and_commit(raw, revision, name)
        self._commit(raw, revision)
        return self.snapshot()

    def delete(self, name: str, expected_revision: str) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        self._check_revision(revision, expected_revision)
        index, _ = _find_worker(raw, name)
        raw["workers"].pop(index)
        secrets = self.secrets.load()
        _validate_config(raw, secrets)
        self._commit(raw, revision, secrets=secrets)
        return self.snapshot()

    def _test_and_commit(
        self,
        raw: dict[str, Any],
        revision: str,
        worker_name: str,
    ) -> dict[str, Any]:
        secrets = self.secrets.load()
        config = _validate_config(raw, secrets)
        worker = next(item for item in config.workers if item.name == worker_name)
        if worker.provider != "mock":
            CONNECTION_TESTER.test(config, worker)
        self._commit(raw, revision, secrets=secrets)
        return self.snapshot()

    def _commit(
        self,
        raw: dict[str, Any],
        expected_revision: str,
        *,
        secrets: dict[str, str] | None = None,
    ) -> None:
        with _config_lock(self.path):
            _, current_revision = _read_raw(self.path)
            self._check_revision(current_revision, expected_revision)
            secret_values = dict(
                secrets if secrets is not None else self.secrets.load()
            )
            if os.environ.get("REDTRACE_PLAINTEXT_SECRETS") == "1":
                plaintext = _resolved_copy(deepcopy(raw), secret_values)
                _validate_config(plaintext, {})
                atomic_write_text(self.path, _dump_raw(plaintext))
                return

            secured = deepcopy(raw)
            _secure_plaintext_keys(secured, secret_values)
            _validate_config(secured, secret_values)
            # Keep old entries through the YAML swap so a concurrent dispatcher read can
            # resolve either the old or new atomic config snapshot.
            old_values = self.secrets.load()
            self.secrets.save({**old_values, **secret_values})
            atomic_write_text(self.path, _dump_raw(secured))
            referenced = _referenced_secret_ids(secured)
            self.secrets.save(
                {
                    secret_id: secret_values.get(
                        secret_id, old_values.get(secret_id, "")
                    )
                    for secret_id in referenced
                    if secret_id in secret_values or secret_id in old_values
                }
            )

    @staticmethod
    def _check_revision(current: str, expected: str) -> None:
        if not expected:
            raise WorkerConfigConflict("expected_revision is required")
        if current != expected:
            raise WorkerConfigConflict(
                "worker configuration changed; reload before saving"
            )

    @staticmethod
    def _copy_name(raw: dict[str, Any], source_name: str) -> str:
        existing = {
            str(worker.get("name"))
            for worker in raw["workers"]
            if isinstance(worker, dict)
        }
        base = f"{source_name}-copy"
        if len(base) > 64:
            base = base[:64]
        candidate = base
        suffix = 2
        while candidate in existing:
            tail = f"-{suffix}"
            candidate = f"{base[:64 - len(tail)]}{tail}"
            suffix += 1
        return candidate

    def _view(self, worker: WorkerConfig) -> dict[str, Any]:
        editable = worker.provider != "mock"
        return {
            "name": worker.name,
            "type": worker.type,
            "provider": worker.provider,
            "model": worker.model,
            "enabled": worker.enabled,
            "bootstrap": worker.bootstrap,
            "reason": worker.reason,
            "explore": worker.explore,
            "task_types": worker.task_types,
            "priority": worker.priority,
            "max_running": worker.max_running,
            "editable": editable,
        }
