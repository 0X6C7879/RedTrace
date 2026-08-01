from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager
from copy import deepcopy
from dataclasses import dataclass
from pathlib import Path
from secrets import token_hex
from typing import Any
from urllib.parse import urlsplit, urlunsplit

import yaml
from pydantic import ValidationError

from redtrace.config_secrets import (
    SecretStore,
    atomic_write_text,
    resolve_dispatch_config_path,
    secret_id_from_reference,
    secret_reference,
)
from redtrace.dispatcher.config import (
    MODEL_CONTEXT_1M,
    DispatchConfig,
    WorkerConfig,
    validate_prompt_resources,
)
from redtrace.dispatcher.workers.registry import get_driver
from redtrace.native_cli_config import (
    NativeCliConfigError,
    native_config_paths,
    resolve_cli_config_home,
    sync_native_cli_config,
)

NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
TASK_TYPES = frozenset({"bootstrap", "reason", "explore"})
EDITABLE_WORKER_TYPES = frozenset({"claudecode", "codex", "pi"})
LOCK_TIMEOUT_SECONDS = 10.0
STALE_LOCK_SECONDS = 60.0
TEST_CACHE_SECONDS = 60.0


@dataclass(frozen=True, slots=True)
class WorkerEnvFields:
    endpoint: str
    api_key: str
    model: str


WORKER_ENV_FIELDS: dict[str, WorkerEnvFields] = {
    "claudecode": WorkerEnvFields(
        endpoint="ANTHROPIC_BASE_URL",
        api_key="ANTHROPIC_AUTH_TOKEN",
        model="ANTHROPIC_MODEL",
    ),
    "codex": WorkerEnvFields(
        endpoint="CODEX_BASE_URL",
        api_key="OPENAI_API_KEY",
        model="CODEX_MODEL",
    ),
    "pi": WorkerEnvFields(
        endpoint="PI_BASE_URL",
        api_key="PI_API_KEY",
        model="PI_MODEL",
    ),
}
SECRET_ENV_KEYS = frozenset(fields.api_key for fields in WORKER_ENV_FIELDS.values())


class WorkerConfigError(ValueError):
    pass


class WorkerConfigConflict(WorkerConfigError):
    pass


class WorkerConnectionError(WorkerConfigError):
    pass


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


def _normalize_endpoint(value: object) -> str:
    endpoint = str(value or "").strip().rstrip("/")
    if not endpoint:
        return ""
    parsed = urlsplit(endpoint)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
        or parsed.query
        or parsed.fragment
    ):
        raise WorkerConfigError(
            "API endpoint must be an http(s) URL without credentials, query, or fragment"
        )
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path.rstrip("/"), "", ""))


def _worker_payload(
    payload: dict[str, Any],
    *,
    runtime_max_workers: int,
    existing: dict[str, Any] | None = None,
) -> dict[str, Any]:
    worker_type = str(payload.get("type") or "").strip()
    if worker_type not in EDITABLE_WORKER_TYPES:
        raise WorkerConfigError("Agent CLI type must be claudecode, codex, or pi")
    name = _normalize_name(payload.get("name"))
    task_types = payload.get("task_types")
    if (
        not isinstance(task_types, list)
        or not task_types
        or len(set(task_types)) != len(task_types)
        or any(task_type not in TASK_TYPES for task_type in task_types)
    ):
        raise WorkerConfigError(
            "task_types must contain unique bootstrap, reason, or explore values"
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

    endpoint = _normalize_endpoint(payload.get("api_endpoint"))
    model_id = str(payload.get("model_id") or "").strip()
    if len(model_id) > 256:
        raise WorkerConfigError("model ID must not exceed 256 characters")
    context_length = payload.get("context_length")
    if context_length is not None:
        try:
            context_length = int(context_length)
        except (TypeError, ValueError) as exc:
            raise WorkerConfigError("context_length must be an integer") from exc
        if context_length != MODEL_CONTEXT_1M:
            raise WorkerConfigError(
                f"context_length must be {MODEL_CONTEXT_1M} when 1M context is enabled"
            )
    fields = WORKER_ENV_FIELDS[worker_type]
    previous_env = (
        dict(existing.get("env") or {})
        if isinstance(existing, dict) and isinstance(existing.get("env"), dict)
        else {}
    )
    env = previous_env
    for mapped in WORKER_ENV_FIELDS.values():
        if mapped.endpoint != fields.endpoint:
            env.pop(mapped.endpoint, None)
        if mapped.model != fields.model:
            env.pop(mapped.model, None)
        if mapped.api_key != fields.api_key:
            env.pop(mapped.api_key, None)
    if endpoint:
        env[fields.endpoint] = endpoint
    else:
        env.pop(fields.endpoint, None)
    if model_id:
        env[fields.model] = model_id
    else:
        env.pop(fields.model, None)

    clear_api_key = bool(payload.get("clear_api_key"))
    supplied_key = payload.get("api_key")
    if supplied_key is not None:
        supplied_key = str(supplied_key).strip()
    if clear_api_key:
        env.pop(fields.api_key, None)
    elif supplied_key:
        if len(supplied_key) < 8 or len(supplied_key) > 4096:
            raise WorkerConfigError(
                "API Key must contain between 8 and 4096 characters"
            )
        env[fields.api_key] = supplied_key

    if worker_type == "pi" and endpoint and model_id and env.get(fields.api_key):
        env.setdefault("PI_PROVIDER_API", "openai-completions")
    else:
        env.pop("PI_PROVIDER_API", None)
    env.pop("PI_MODEL_CONTEXT_WINDOW", None)

    return {
        "name": name,
        "type": worker_type,
        "enabled": bool(payload.get("enabled", True)),
        "task_types": list(task_types),
        "max_running": max_running,
        "priority": priority,
        **(
            {"context_length": context_length}
            if context_length is not None
            else {}
        ),
        "env": env,
    }


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
    return resolved


def _secure_plaintext_keys(
    raw: dict[str, Any],
    secrets: dict[str, str],
) -> None:
    environments: list[dict[str, Any]] = []
    common_env = raw.get("common_env")
    if isinstance(common_env, dict):
        environments.append(common_env)
    for worker in raw.get("workers", []):
        if isinstance(worker, dict) and isinstance(worker.get("env"), dict):
            environments.append(worker["env"])
    for env in environments:
        for key in SECRET_ENV_KEYS:
            value = env.get(key)
            if (
                not isinstance(value, str)
                or not value
                or secret_id_from_reference(value)
            ):
                continue
            secret_id = token_hex(16)
            secrets[secret_id] = value
            env[key] = secret_reference(secret_id)


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
    for worker in config.workers:
        if not worker.enabled or worker.type not in EDITABLE_WORKER_TYPES:
            continue
        fields = WORKER_ENV_FIELDS[worker.type]
        values = (
            worker.env.get(fields.endpoint, "").strip(),
            worker.env.get(fields.api_key, "").strip(),
            worker.env.get(fields.model, "").strip(),
        )
        if config.runtime.execution == "container" and not all(values):
            raise WorkerConfigError(
                f"worker {worker.name} requires API endpoint, API Key, and model ID"
            )
        if config.runtime.execution == "local" and any(values) and not all(values):
            raise WorkerConfigError(
                f"worker {worker.name} must configure endpoint, API Key, and model ID together"
            )
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
        fields = WORKER_ENV_FIELDS[worker.type]
        payload = {
            "execution": config.runtime.execution,
            "type": worker.type,
            "endpoint": worker.env.get(fields.endpoint),
            "key": worker.env.get(fields.api_key),
            "model": worker.env.get(fields.model),
            "pi_api": worker.env.get("PI_PROVIDER_API"),
        }
        return hashlib.sha256(
            json.dumps(payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
        ).hexdigest()

    @staticmethod
    def _probe(config: DispatchConfig, worker: WorkerConfig) -> dict[str, Any]:
        fields = WORKER_ENV_FIELDS[worker.type]
        key = worker.env.get(fields.api_key, "")
        configured = worker.api_configured()
        started = time.perf_counter()
        if config.runtime.execution == "local" and not configured:
            binary = get_driver(worker.type, "local").local_binary()
            path = shutil.which(binary) if binary else None
            if path is None:
                return {
                    "ok": False,
                    "status": None,
                    "duration_ms": 0,
                    "detail": f"{binary or worker.type} CLI was not found on PATH",
                }
            try:
                completed = subprocess.run(
                    [path, "--version"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    timeout=config.runtime.healthcheck_timeout,
                    check=False,
                )
            except (OSError, subprocess.SubprocessError):
                completed = None
            duration_ms = int((time.perf_counter() - started) * 1000)
            if completed is None or completed.returncode != 0:
                return {
                    "ok": False,
                    "status": None,
                    "duration_ms": duration_ms,
                    "detail": f"{binary} CLI could not be executed",
                }
            return {
                "ok": True,
                "status": None,
                "duration_ms": duration_ms,
                "detail": f"{binary} CLI is available",
            }

        result = get_driver(worker.type, "container").check_health(
            worker,
            timeout=config.runtime.healthcheck_timeout,
        )
        duration_ms = int((time.perf_counter() - started) * 1000)
        detail = (result.detail or "connection successful").replace(key, "[REDACTED]")
        detail = re.sub(
            r"(?i)(authorization|api[-_ ]?key)\s*[:=]\s*\S+",
            r"\1=[REDACTED]",
            detail,
        )
        return {
            "ok": result.ok,
            "status": result.status,
            "duration_ms": duration_ms,
            "detail": detail[:240],
        }


CONNECTION_TESTER = WorkerConnectionTester()


class WorkerConfigService:
    def __init__(
        self,
        config_path: str | Path | None = None,
        cli_config_home: str | Path | None = None,
    ):
        self.path = resolve_dispatch_config_path(config_path)
        self.secrets = SecretStore(self.path)
        self.cli_config_home = resolve_cli_config_home(cli_config_home)

    def snapshot(self) -> dict[str, Any]:
        raw, revision = _read_raw(self.path)
        secrets = self.secrets.load()
        config = _validate_config(raw, secrets)
        workers = [self._view(worker) for worker in config.workers]
        return {
            "revision": revision,
            "execution": config.runtime.execution,
            "runtime_max_workers": config.runtime.max_workers,
            "cli_config_home": str(self.cli_config_home),
            "workers": workers,
        }

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
        if source.get("type") not in EDITABLE_WORKER_TYPES:
            raise WorkerConfigError("this Worker type cannot be copied in the Web UI")
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
        if worker.type in EDITABLE_WORKER_TYPES:
            CONNECTION_TESTER.test(config, worker)
        self._commit(raw, revision, secrets=secrets, native_worker=worker)
        return self.snapshot()

    def _commit(
        self,
        raw: dict[str, Any],
        expected_revision: str,
        *,
        secrets: dict[str, str] | None = None,
        native_worker: WorkerConfig | None = None,
    ) -> None:
        with _config_lock(self.path):
            _, current_revision = _read_raw(self.path)
            self._check_revision(current_revision, expected_revision)
            secret_values = dict(
                secrets if secrets is not None else self.secrets.load()
            )
            runtime = raw.get("runtime")
            local_execution = (
                isinstance(runtime, dict) and runtime.get("execution") == "local"
            )
            if local_execution or os.environ.get("REDTRACE_PLAINTEXT_SECRETS") == "1":
                plaintext = _resolved_copy(deepcopy(raw), secret_values)
                _validate_config(plaintext, {})
                self._sync_native_config(native_worker)
                atomic_write_text(self.path, _dump_raw(plaintext))
                return

            secured = deepcopy(raw)
            _secure_plaintext_keys(secured, secret_values)
            _validate_config(secured, secret_values)
            self._sync_native_config(native_worker)
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
        if worker.type not in WORKER_ENV_FIELDS:
            return {
                "name": worker.name,
                "type": worker.type,
                "enabled": worker.enabled,
                "api_endpoint": "",
                "api_key": "",
                "api_key_configured": False,
                "model_id": "",
                "context_length": worker.context_length,
                "task_types": worker.task_types,
                "priority": worker.priority,
                "max_running": worker.max_running,
                "editable": False,
                "native_config_paths": [],
            }
        fields = WORKER_ENV_FIELDS[worker.type]
        return {
            "name": worker.name,
            "type": worker.type,
            "enabled": worker.enabled,
            "api_endpoint": worker.env.get(fields.endpoint, ""),
            "api_key": worker.env.get(fields.api_key, ""),
            "api_key_configured": bool(worker.env.get(fields.api_key)),
            "model_id": worker.env.get(fields.model, ""),
            "context_length": worker.context_length,
            "task_types": worker.task_types,
            "priority": worker.priority,
            "max_running": worker.max_running,
            "editable": True,
            "native_config_paths": [
                str(path)
                for path in native_config_paths(self.cli_config_home, worker.type)
            ],
        }

    def _sync_native_config(self, worker: WorkerConfig | None) -> None:
        if worker is None or not worker.api_configured():
            return
        try:
            sync_native_cli_config(self.cli_config_home, worker)
        except NativeCliConfigError as exc:
            raise WorkerConfigError(str(exc)) from exc
