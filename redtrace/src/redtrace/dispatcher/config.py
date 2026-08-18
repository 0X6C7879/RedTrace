from __future__ import annotations

from decimal import Decimal, InvalidOperation
import json
import os
from importlib import resources
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from redtrace.config_secrets import resolve_config_secrets
from redtrace.paths import RedTracePaths, resolve_portable_path


TaskType = Literal["reason", "explore", "bootstrap"]
WorkerType = Literal["claudecode", "codex", "pi", "mock"]
EndpointMode = Literal["auto", "base", "direct"]
CompletedAction = Literal["remove", "stop"]
WorkerHealthcheckMode = Literal["startup_and_task", "startup_only", "disabled"]
ExecutionMode = Literal["container", "local"]
LocalCompletedAction = Literal["keep", "remove"]

MODEL_CONTEXT_1M = 1_048_576
DEFAULT_PI_MODEL_CONTEXT_WINDOW = 128_000


def model_auto_compact_token_limit(context_length: int) -> int:
    return context_length * 9 // 10

WORKER_ENV_KEYS: dict[WorkerType, tuple[str, ...]] = {
    "claudecode": (
        "ANTHROPIC_MODEL",
        "ANTHROPIC_BASE_URL",
        "ANTHROPIC_AUTH_TOKEN",
    ),
    "codex": (
        "CODEX_MODEL",
        "CODEX_BASE_URL",
        "OPENAI_API_KEY",
    ),
    "pi": (
        "PI_MODEL",
        "PI_BASE_URL",
        "PI_API_KEY",
        "PI_PROVIDER_API",
    ),
    "mock": (),
}

DEFAULT_PROMPT_REQUIRED_TOKENS: dict[str, tuple[str, ...]] = {
    "reason.md": (
        "{graph_yaml}",
        "{fact_ids}",
        "{open_intents}",
        "{execution}",
        "{max_intents}",
    ),
    "explore.md": ("{graph_yaml}", "{intent_id}", "{intent_description}"),
    "explore_conclude.md": ("{graph_yaml}", "{intent_id}", "{intent_description}"),
    "bootstrap.md": ("{origin}", "{goal}", "{hints}"),
    "bootstrap_conclude.md": ("{origin}", "{goal}", "{hints}"),
}

PROMPT_REQUIRED_TOKENS_BY_GROUP: dict[str, dict[str, tuple[str, ...]]] = {
    "mock": {
        "reason.md": ("{fact_ids}", "{open_intents}", "{max_intents}"),
        "explore.md": ("{intent_id}",),
        "explore_conclude.md": ("{intent_id}",),
        "bootstrap.md": ("{origin}", "{goal}", "{hints}"),
        "bootstrap_conclude.md": ("{origin}", "{goal}", "{hints}"),
    }
}

MOCK_ALLOWED_OUTCOMES: dict[str, frozenset[str]] = {
    "healthcheck": frozenset({"ok", "fail"}),
    "reason": frozenset({"complete", "intent", "noop", "rejected", "invalid_json", "invalid_payload", "command_fail"}),
    "explore_execute": frozenset({"fact", "rejected", "invalid_json", "invalid_payload", "command_fail"}),
    "explore_conclude": frozenset({"fact", "rejected", "invalid_json", "invalid_payload", "command_fail"}),
    "bootstrap": frozenset({"complete", "fact", "rejected", "invalid_json", "invalid_payload", "command_fail"}),
    "bootstrap_conclude": frozenset({"fact", "rejected", "invalid_json", "invalid_payload", "command_fail"}),
}

MOCK_DEFAULT_BEHAVIOR: dict[str, dict[str, Any]] = {
    "healthcheck": {
        "delay": [0.05, 0.15],
        "outcomes": {"ok": "1.0", "fail": "0.0"},
    },
    "reason": {
        "delay": [0.05, 0.3],
        "outcomes": {
            "complete": "0.0",
            "intent": "1.0",
            "noop": "0.0",
            "rejected": "0.0",
            "invalid_json": "0.0",
            "invalid_payload": "0.0",
            "command_fail": "0.0",
        },
    },
    "explore_execute": {
        "delay": [0.05, 0.3],
        "outcomes": {
            "fact": "1.0",
            "rejected": "0.0",
            "invalid_json": "0.0",
            "invalid_payload": "0.0",
            "command_fail": "0.0",
        },
    },
    "explore_conclude": {
        "delay": [0.05, 0.3],
        "outcomes": {
            "fact": "1.0",
            "rejected": "0.0",
            "invalid_json": "0.0",
            "invalid_payload": "0.0",
            "command_fail": "0.0",
        },
    },
    "bootstrap": {
        "delay": [0.05, 0.3],
        "outcomes": {
            "complete": "1.0",
            "fact": "0.0",
            "rejected": "0.0",
            "invalid_json": "0.0",
            "invalid_payload": "0.0",
            "command_fail": "0.0",
        },
    },
    "bootstrap_conclude": {
        "delay": [0.05, 0.3],
        "outcomes": {
            "fact": "1.0",
            "rejected": "0.0",
            "invalid_json": "0.0",
            "invalid_payload": "0.0",
            "command_fail": "0.0",
        },
    },
}

MOCK_ALLOWED_ENV_KEYS = frozenset(
    {f"MOCK_{phase.upper()}" for phase in MOCK_ALLOWED_OUTCOMES}
)


class ReasonTaskConfig(BaseModel):
    timeout: int = Field(gt=0)
    max_intents: int = Field(gt=0, default=4)


class ExploreTaskConfig(BaseModel):
    timeout: int = Field(gt=0)
    conclude_timeout: int = Field(gt=0)


class BootstrapTaskConfig(BaseModel):
    timeout: int = Field(gt=0)
    conclude_timeout: int = Field(gt=0)


class TasksConfig(BaseModel):
    bootstrap: BootstrapTaskConfig
    reason: ReasonTaskConfig
    explore: ExploreTaskConfig


class ContainerConfig(BaseModel):
    image: str
    network_mode: str
    completed_action: CompletedAction
    cap_add: list[str] = Field(default_factory=list)


class LocalConfig(BaseModel):
    workspace_root: str | None = None
    completed_action: LocalCompletedAction = "keep"


class PathsConfig(BaseModel):
    """Portable RedTrace directory layout, normalized by ``DispatchConfig.load``."""

    model_config = ConfigDict(extra="forbid")

    root: str = "."
    skills: str = "skills"
    mcp: str = "mcp"
    plugins: str = "plugins"
    managed: str = ".redtrace"
    workspaces: str = "workspaces"
    audit: str = ".redtrace/audit"

    def layout(self) -> RedTracePaths:
        return RedTracePaths(
            root=Path(self.root),
            skills=Path(self.skills),
            mcp=Path(self.mcp),
            plugins=Path(self.plugins),
            managed=Path(self.managed),
            workspaces=Path(self.workspaces),
            audit=Path(self.audit),
        )


class ContextHarnessConfig(BaseModel):
    """Low-overhead, post-RTK Artifact capture visible to every Worker type."""

    model_config = ConfigDict(extra="forbid")

    enabled: bool = True
    artifact_root: str = ".redtrace/artifacts/context"
    inline_bytes: int = Field(default=256 * 1024, ge=1024)
    visible_bytes: int = Field(default=64 * 1024, ge=512)
    query_bytes: int = Field(default=1024 * 1024, ge=1024)
    parse_bytes: int = Field(default=64 * 1024 * 1024, ge=64 * 1024)
    worker_output_chars: int = Field(default=8 * 1024 * 1024, ge=64 * 1024)

    @field_validator("artifact_root")
    @classmethod
    def validate_artifact_root(cls, value: str) -> str:
        path = Path(value)
        if path.is_absolute() or ".." in path.parts or not path.parts:
            raise ValueError("artifact_root must be a safe workspace-relative path")
        return path.as_posix()

    def environment(self) -> dict[str, str]:
        return {
            "REDTRACE_CONTEXT_HARNESS_ENABLED": "1" if self.enabled else "0",
            "REDTRACE_CONTEXT_ARTIFACT_ROOT": self.artifact_root,
            "REDTRACE_CONTEXT_INLINE_BYTES": str(self.inline_bytes),
            "REDTRACE_CONTEXT_VISIBLE_BYTES": str(self.visible_bytes),
            "REDTRACE_CONTEXT_QUERY_BYTES": str(self.query_bytes),
            "REDTRACE_CONTEXT_PARSE_BYTES": str(self.parse_bytes),
            # Keep Python, PowerShell and common CLI subprocesses on a single
            # UTF-8 contract even when the dispatcher itself runs on Windows.
            "PYTHONUTF8": "1",
            "PYTHONIOENCODING": "utf-8",
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
        }


class RuntimeConfig(BaseModel):
    max_workers: int = Field(gt=0)
    max_running_projects: int = Field(gt=0)
    max_project_workers: int = Field(gt=0)
    interval: int = Field(gt=0)
    healthcheck_timeout: int = Field(gt=0)
    worker_healthcheck: WorkerHealthcheckMode = "startup_only"
    execution: ExecutionMode = "container"
    prompt_group: str = Field(min_length=1)
    prompt_mode: Literal["cairn", "legacy"] = "cairn"


class WorkerConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str
    type: WorkerType
    enabled: bool = True
    endpoint_mode: EndpointMode = "auto"
    task_types: list[TaskType] = Field(
        default_factory=lambda: ["reason", "explore", "bootstrap"]
    )
    max_running: int = Field(gt=0)
    priority: int = Field(ge=0)
    context_length: int | None = Field(default=None, gt=0)
    env: dict[str, str] = Field(default_factory=dict)

    @field_validator("task_types")
    @classmethod
    def validate_task_types(cls, value: list[TaskType]) -> list[TaskType]:
        if not value:
            raise ValueError("task_types must not be empty")
        if len(set(value)) != len(value):
            raise ValueError("task_types must be unique")
        return value

    @model_validator(mode="after")
    def validate_env(self) -> "WorkerConfig":
        # Required LLM env keys (base_url / key / model) are enforced per execution mode by
        # DispatchConfig: container mode needs them, local mode reuses the host CLI config.
        # The checks below are mode-independent and always apply.
        if self.type == "pi":
            _validate_optional_positive_int_env(self.name, self.env, "PI_MODEL_CONTEXT_WINDOW")
            legacy_context = self.env.get("PI_MODEL_CONTEXT_WINDOW", "").strip()
            if self.context_length is None and legacy_context:
                self.context_length = int(legacy_context)
        if self.type == "mock":
            resolve_mock_behavior(self.name, self.env)
        return self

    def api_configured(self) -> bool:
        """Whether RedTrace has a complete per-process API override for this Worker."""

        required = WORKER_ENV_KEYS[self.type]
        return bool(required) and all(self.env.get(key, "").strip() for key in required)

    def has_api_config(self) -> bool:
        """Whether any part of a RedTrace API override is present."""

        return any(
            self.env.get(key, "").strip()
            for key in WORKER_ENV_KEYS[self.type]
        )


class DispatchConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    server: str
    paths: PathsConfig = Field(default_factory=PathsConfig)
    runtime: RuntimeConfig
    tasks: TasksConfig
    context_harness: ContextHarnessConfig = Field(
        default_factory=ContextHarnessConfig
    )
    container: ContainerConfig | None = None
    local: LocalConfig | None = None
    common_env: dict[str, str] = Field(default_factory=dict)
    workers: list[WorkerConfig]

    @model_validator(mode="before")
    @classmethod
    def merge_common_env(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        common_env = data.get("common_env")
        if common_env is None:
            common_env = {}
        workers = data.get("workers")
        if not isinstance(common_env, dict) or not isinstance(workers, list):
            return data

        merged = dict(data)
        merged_workers: list[Any] = []
        for worker in workers:
            if not isinstance(worker, dict):
                merged_workers.append(worker)
                continue
            worker_env = worker.get("env")
            if worker_env is None:
                worker_env = {}
            if not isinstance(worker_env, dict):
                merged_workers.append(worker)
                continue
            worker_copy = dict(worker)
            worker_copy["env"] = {**common_env, **worker_env}
            merged_workers.append(worker_copy)
        merged["workers"] = merged_workers
        return merged

    @model_validator(mode="after")
    def validate_workers(self) -> "DispatchConfig":
        names = [worker.name for worker in self.workers]
        if len(set(names)) != len(names):
            raise ValueError("worker names must be unique")
        if self.runtime.max_project_workers > self.runtime.max_workers:
            raise ValueError("max_project_workers cannot exceed max_workers")
        return self

    @model_validator(mode="after")
    def validate_execution_mode(self) -> "DispatchConfig":
        if self.runtime.execution == "container":
            if self.container is None:
                raise ValueError("container config is required when runtime.execution is container")
        else:
            if self.local is None:
                self.local = LocalConfig()
        for worker in self.workers:
            if not worker.enabled:
                continue
            required = WORKER_ENV_KEYS[worker.type]
            missing = [key for key in required if not worker.env.get(key, "").strip()]
            if self.runtime.execution == "container" and missing:
                raise ValueError(
                    f"worker {worker.name} missing env keys: {', '.join(missing)}"
                )
            if (
                self.runtime.execution == "local"
                and worker.has_api_config()
                and missing
            ):
                raise ValueError(
                    f"worker {worker.name} must configure all API override env keys "
                    f"together; missing: {', '.join(missing)}"
                )
        return self

    @classmethod
    def load(cls, path: Path) -> "DispatchConfig":
        config_path = path.expanduser().resolve()
        data = yaml.safe_load(config_path.read_text(encoding="utf-8")) or {}
        data = _resolve_config_paths(config_path, data)
        data = resolve_config_secrets(config_path, data)
        config = cls.model_validate(data)
        validate_prompt_resources(config.runtime.prompt_group)
        return config


def _resolve_config_paths(config_path: Path, data: Any) -> Any:
    if not isinstance(data, dict):
        return data
    raw_paths = data.get("paths")
    raw_paths = dict(raw_paths) if isinstance(raw_paths, dict) else {}
    config_dir = config_path.parent
    root = resolve_portable_path(
        os.environ.get("REDTRACE_ROOT", raw_paths.get("root", ".")),
        base=config_dir,
    )
    resolved: dict[str, str] = {"root": str(root)}
    overrides = {
        "skills": "REDTRACE_SKILLS_DIR",
        "mcp": "REDTRACE_MCP_DIR",
        "plugins": "REDTRACE_PLUGINS_DIR",
        "managed": "REDTRACE_MANAGED_DIR",
        "workspaces": "REDTRACE_WORKSPACE_ROOT",
        "audit": "REDTRACE_AUDIT_ROOT",
    }
    defaults = {
        "skills": "skills",
        "mcp": "mcp",
        "plugins": "plugins",
        "managed": ".redtrace",
        "workspaces": "workspaces",
        "audit": ".redtrace/audit",
    }
    for name, env_name in overrides.items():
        value = os.environ.get(env_name, raw_paths.get(name, defaults[name]))
        resolved[name] = str(resolve_portable_path(value, base=root))
    updated = dict(data)
    updated["paths"] = resolved
    local = updated.get("local")
    if isinstance(local, dict) or (
        isinstance(updated.get("runtime"), dict)
        and updated["runtime"].get("execution") == "local"
    ):
        local_copy = dict(local) if isinstance(local, dict) else {}
        workspace_root = local_copy.get("workspace_root")
        if workspace_root:
            local_copy["workspace_root"] = str(
                resolve_portable_path(workspace_root, base=root)
            )
        else:
            local_copy["workspace_root"] = resolved["workspaces"]
        updated["local"] = local_copy
    return updated


def _validate_optional_positive_int_env(worker_name: str, env: dict[str, str], key: str) -> None:
    value = env.get(key)
    if value is None or not value.strip():
        return
    try:
        parsed = int(value)
    except ValueError as exc:
        raise ValueError(f"worker {worker_name} env {key} must be an integer") from exc
    if parsed <= 0:
        raise ValueError(f"worker {worker_name} env {key} must be greater than 0")


def validate_prompt_resources(prompt_group: str) -> None:
    prompts_dir = resources.files("redtrace.dispatcher.prompts")
    group_dir = prompts_dir.joinpath(prompt_group)
    if not group_dir.is_dir():
        raise ValueError(f"missing prompt group: {prompt_group}")
    required_tokens = PROMPT_REQUIRED_TOKENS_BY_GROUP.get(prompt_group, DEFAULT_PROMPT_REQUIRED_TOKENS)
    for name, tokens in required_tokens.items():
        try:
            content = group_dir.joinpath(name).read_text(encoding="utf-8")
        except FileNotFoundError as exc:
            raise ValueError(f"prompt group {prompt_group} missing resource: {name}") from exc
        missing = [token for token in tokens if token not in content]
        if missing:
            raise ValueError(f"prompt group {prompt_group} resource {name} missing placeholders: {', '.join(missing)}")

    # Validate cairn prompt group
    cairn_dir = prompts_dir.joinpath("cairn")
    if cairn_dir.is_dir():
        for name, tokens in DEFAULT_PROMPT_REQUIRED_TOKENS.items():
            try:
                content = cairn_dir.joinpath(name).read_text(encoding="utf-8")
            except FileNotFoundError:
                raise ValueError(f"prompt group cairn missing resource: {name}")
            missing_tokens = [token for token in tokens if token not in content]
            if missing_tokens:
                raise ValueError(f"prompt group cairn resource {name} missing placeholders: {', '.join(missing_tokens)}")


def resolve_mock_behavior(worker_name: str, env: dict[str, str]) -> dict[str, dict[str, Any]]:
    unknown = sorted(key for key in env if key.startswith("MOCK_") and key not in MOCK_ALLOWED_ENV_KEYS)
    if unknown:
        raise ValueError(f"worker {worker_name} has unsupported mock env keys: {', '.join(unknown)}")

    behavior: dict[str, dict[str, Any]] = {}
    for phase, allowed_outcomes in MOCK_ALLOWED_OUTCOMES.items():
        prefix = _mock_env_prefix(phase)
        payload = _parse_mock_phase_payload(worker_name, env, prefix, MOCK_DEFAULT_BEHAVIOR[phase])
        min_delay, max_delay = _parse_mock_delay_range(worker_name, prefix, payload.get("delay"))
        if max_delay < min_delay:
            raise ValueError(f"worker {worker_name} {prefix}.delay[1] must be greater than or equal to delay[0]")
        raw_outcomes = payload.get("outcomes")
        if not isinstance(raw_outcomes, dict):
            raise ValueError(f"worker {worker_name} {prefix}.outcomes must be an object")
        unknown_outcomes = sorted(set(raw_outcomes) - allowed_outcomes)
        if unknown_outcomes:
            raise ValueError(f"worker {worker_name} {prefix}.outcomes has unsupported keys: {', '.join(unknown_outcomes)}")
        outcomes: dict[str, float] = {}
        total = Decimal("0")
        for outcome in sorted(allowed_outcomes):
            weight = _parse_mock_probability(
                worker_name,
                prefix,
                raw_outcomes,
                outcome,
            )
            outcomes[outcome] = float(weight)
            total += weight
        if total != Decimal("1"):
            raise ValueError(f"worker {worker_name} {prefix}.outcomes probabilities must sum to 1.0, got {total}")
        behavior[phase] = {
            "delay": {"min": min_delay, "max": max_delay},
            "outcomes": outcomes,
        }
        rules = payload.get("rules")
        if rules is not None:
            if not isinstance(rules, list):
                raise ValueError(f"worker {worker_name} {prefix}.rules must be an array")
            normalized_rules: list[dict[str, Any]] = []
            for index, rule in enumerate(rules):
                if not isinstance(rule, dict):
                    raise ValueError(f"worker {worker_name} {prefix}.rules[{index}] must be an object")
                force = rule.get("force")
                if not isinstance(force, str) or force not in allowed_outcomes:
                    raise ValueError(
                        f"worker {worker_name} {prefix}.rules[{index}].force must be one of: {', '.join(sorted(allowed_outcomes))}"
                    )
                entry: dict[str, Any] = {"force": force}
                if "fact_ids_gte" in rule:
                    value = rule["fact_ids_gte"]
                    if not isinstance(value, int) or value < 0:
                        raise ValueError(f"worker {worker_name} {prefix}.rules[{index}].fact_ids_gte must be a non-negative integer")
                    entry["fact_ids_gte"] = value
                if "fact_ids_lte" in rule:
                    value = rule["fact_ids_lte"]
                    if not isinstance(value, int) or value < 0:
                        raise ValueError(f"worker {worker_name} {prefix}.rules[{index}].fact_ids_lte must be a non-negative integer")
                    entry["fact_ids_lte"] = value
                if "open_intents_empty" in rule:
                    value = rule["open_intents_empty"]
                    if not isinstance(value, bool):
                        raise ValueError(f"worker {worker_name} {prefix}.rules[{index}].open_intents_empty must be boolean")
                    entry["open_intents_empty"] = value
                normalized_rules.append(entry)
            behavior[phase]["rules"] = normalized_rules
    return behavior


def _mock_env_prefix(phase: str) -> str:
    return f"MOCK_{phase.upper()}"


def _parse_mock_phase_payload(worker_name: str, env: dict[str, str], key: str, default: dict[str, Any]) -> dict[str, Any]:
    raw = env.get(key)
    if raw is None:
        return json.loads(json.dumps(default))
    try:
        value = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"worker {worker_name} {key} must be a JSON object") from exc
    if not isinstance(value, dict):
        raise ValueError(f"worker {worker_name} {key} must be a JSON object")
    return value


def _parse_mock_delay_range(worker_name: str, key: str, value: Any) -> tuple[float, float]:
    if not isinstance(value, list) or len(value) != 2:
        raise ValueError(f"worker {worker_name} {key}.delay must be a two-element number array")
    min_delay = _coerce_mock_seconds(worker_name, f"{key}.delay[0]", value[0])
    max_delay = _coerce_mock_seconds(worker_name, f"{key}.delay[1]", value[1])
    return min_delay, max_delay


def _coerce_mock_seconds(worker_name: str, key: str, value: Any) -> float:
    if isinstance(value, bool):
        raise ValueError(f"worker {worker_name} {key} must be a number")
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"worker {worker_name} {key} must be a number") from exc
    if parsed < 0:
        raise ValueError(f"worker {worker_name} {key} must be non-negative")
    return parsed


def _parse_mock_probability(worker_name: str, phase_key: str, outcomes: dict[str, Any], outcome: str) -> Decimal:
    raw = outcomes.get(outcome, MOCK_DEFAULT_BEHAVIOR[phase_key.removeprefix("MOCK_").lower()]["outcomes"][outcome])
    try:
        value = Decimal(str(raw))
    except InvalidOperation as exc:
        raise ValueError(f"worker {worker_name} {phase_key}.outcomes.{outcome} must be a decimal probability") from exc
    if value < 0 or value > 1:
        raise ValueError(f"worker {worker_name} {phase_key}.outcomes.{outcome} must be between 0 and 1")
    return value
