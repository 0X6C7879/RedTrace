from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal, InvalidOperation
import json
import os
import re
from importlib import resources
from pathlib import Path
from typing import Any, Literal

import yaml
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from redtrace.config_secrets import resolve_config_secrets
from redtrace.paths import RedTracePaths, resolve_portable_path


TaskType = Literal["reason", "explore", "bootstrap"]
CompletedAction = Literal["remove", "stop"]
WorkerHealthcheckMode = Literal["startup_and_task", "startup_only", "disabled"]
ExecutionMode = Literal["container", "local"]
ReasoningEffort = Literal[
    "off", "minimal", "low", "medium", "high", "xhigh", "max"
]
ReasoningPolicy = Literal[
    "auto_max", "off", "minimal", "low", "medium", "high", "xhigh", "max"
]


DEFAULT_PROMPT_REQUIRED_TOKENS: dict[str, tuple[str, ...]] = {
    "reason.md": (
        "{graph_yaml}",
        "{fact_ids}",
        "{open_intents}",
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
    conclude_timeout: int = Field(gt=0)
    max_intents: int = Field(
        gt=0,
        default=4,
        description="Maximum open or working Intents allowed per project",
    )


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


class PathsConfig(BaseModel):
    """Portable RedTrace directory layout, normalized by ``DispatchConfig.load``."""

    model_config = ConfigDict(extra="forbid")

    root: str = "."
    skills: str = "skills"
    mcp: str = "mcp"
    managed: str = ".redtrace"
    workspaces: str = "workspaces"
    audit: str = ".redtrace/audit"

    def layout(self) -> RedTracePaths:
        return RedTracePaths(
            root=Path(self.root),
            skills=Path(self.skills),
            mcp=Path(self.mcp),
            managed=Path(self.managed),
            workspaces=Path(self.workspaces),
            audit=Path(self.audit),
        )


class RuntimeConfig(BaseModel):
    max_workers: int = Field(gt=0)
    max_running_projects: int = Field(gt=0)
    max_project_workers: int = Field(gt=0)
    interval: int = Field(gt=0)
    healthcheck_timeout: int = Field(gt=0)
    worker_healthcheck: WorkerHealthcheckMode = "startup_only"
    execution: ExecutionMode = "container"
    prompt_group: str = Field(min_length=1)


class WorkerConfig(BaseModel):
    """A DSH-native Worker: scheduling identity plus its model route.

    The Worker decides who executes (provider, model, task eligibility,
    concurrency, priority); the provider's model entry owns the context
    window, output cap, and reasoning configuration. ``mock`` is the deterministic
    test engine.
    """

    model_config = ConfigDict(extra="forbid")

    name: str
    enabled: bool = True
    provider: str = Field(min_length=1)
    model: str = Field(default="mock")
    bootstrap: bool = True
    reason: bool = True
    explore: bool = True
    max_running: int = Field(default=1, gt=0)
    priority: int = Field(default=0, ge=0)
    env: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def validate_worker(self) -> "WorkerConfig":
        if self.provider == "mock":
            resolve_mock_behavior(self.name, self.env)
            return self
        if self.env:
            raise ValueError(
                f"worker {self.name}: env is only supported for provider 'mock'"
            )
        if not self.model.strip():
            raise ValueError(f"worker {self.name}: model is required")
        if not (self.bootstrap or self.reason or self.explore):
            raise ValueError(
                f"worker {self.name}: at least one of bootstrap/reason/explore is required"
            )
        return self

    @property
    def type(self) -> str:
        """Legacy dispatcher view: only the mock engine runs there."""
        return "mock" if self.provider == "mock" else "dsh"

    @property
    def task_types(self) -> list[TaskType]:
        return [
            task
            for task, eligible in (
                ("bootstrap", self.bootstrap),
                ("reason", self.reason),
                ("explore", self.explore),
            )
            if eligible
        ]


class ProviderModelConfig(BaseModel):
    """One model served by a provider: identity plus its own capacities.

    The model entry owns capacities, reasoning policy/capabilities, and any
    protocol compatibility override;
    Workers reference a model by id and carry no per-model duplicates.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    id: str = Field(min_length=1, max_length=256)
    context_window: int = Field(default=1_000_000, gt=0)
    max_tokens: int = Field(default=128_000, gt=0)
    reasoning: ReasoningPolicy = "auto_max"
    reasoning_efforts: dict[ReasoningEffort, str | None] | Literal[False] | None = None
    # Legacy ``none`` remains readable and has the same meaning as ``auto``.
    # This is a wire-format override for OpenAI Chat Completions, not a
    # reasoning-strength control.
    thinking_format: Literal["auto", "deepseek", "openai", "none"] = "auto"

    @model_validator(mode="before")
    @classmethod
    def normalize_yaml_reasoning_keys(cls, data: Any) -> Any:
        # YAML 1.1 loaders parse an unquoted ``off:`` key as boolean False.
        # Accept the human-friendly spelling used by DSH examples without
        # letting that loader quirk escape into the validated capability map.
        if not isinstance(data, dict) or not isinstance(data.get("reasoning_efforts"), dict):
            return data
        efforts = data["reasoning_efforts"]
        if False not in efforts or "off" in efforts:
            return data
        normalized = dict(data)
        normalized_efforts = dict(efforts)
        normalized_efforts["off"] = normalized_efforts.pop(False)
        normalized["reasoning_efforts"] = normalized_efforts
        return normalized

    @model_validator(mode="after")
    def validate_reasoning(self) -> "ProviderModelConfig":
        efforts = self.reasoning_efforts
        if efforts is False:
            if self.reasoning != "auto_max":
                raise ValueError(
                    "a non-reasoning model must use reasoning='auto_max'"
                )
            return self
        if efforts is None:
            return self
        if not efforts:
            raise ValueError(
                "reasoning_efforts must declare supported levels, be false, or be omitted"
            )
        if not any(level != "off" for level in efforts):
            raise ValueError(
                "reasoning_efforts must include at least one thinking level"
            )
        for level, wire_value in efforts.items():
            if level == "off":
                if wire_value == "":
                    raise ValueError("reasoning_efforts.off must be null or non-empty")
            elif not isinstance(wire_value, str) or not wire_value:
                raise ValueError(
                    f"reasoning_efforts.{level} needs a non-empty wire value"
                )
        if self.reasoning != "auto_max" and self.reasoning not in efforts:
            raise ValueError(
                f"reasoning '{self.reasoning}' is not declared in reasoning_efforts"
            )
        return self


class ProviderConfig(BaseModel):
    """A model API provider: protocol, endpoint, credential, and model list.

    Referenced by Workers through ``provider``; a provider may be shared by
    any number of Workers. The credential is either an inline ``api_key``
    (may be a ``${REDTRACE_SECRET:...}`` reference) or an ``api_key_env``
    name resolved from the launching environment. Each model's context
    capacities and reasoning configuration live on its ``models`` entry.
    """

    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)

    api: Literal[
        "openai-completions", "openai-responses", "anthropic-messages"
    ] = "openai-completions"
    base_url: str = Field(min_length=1)
    api_key: str | None = Field(default=None, min_length=1)
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]*$")
    models: list[ProviderModelConfig] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_credential(self) -> "ProviderConfig":
        if self.api_key is None and self.api_key_env is None:
            raise ValueError("provider needs api_key or api_key_env")
        ids = [model.id for model in self.models]
        if len(set(ids)) != len(ids):
            raise ValueError("provider model ids must be unique")
        return self


class DispatchConfig(BaseModel):
    model_config = ConfigDict(extra="forbid")

    server: str
    paths: PathsConfig = Field(default_factory=PathsConfig)
    runtime: RuntimeConfig
    tasks: TasksConfig
    container: ContainerConfig | None = None
    local: LocalConfig | None = None
    common_env: dict[str, str] = Field(default_factory=dict)
    providers: dict[str, ProviderConfig] = Field(default_factory=dict)
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

        # common_env targets worker processes: the mock test engine inherits it
        # through its env; the DSH runtime receives it through its launch
        # environment (see startup). Non-mock Workers carry no env.
        merged = dict(data)
        merged_workers: list[Any] = []
        for worker in workers:
            if not isinstance(worker, dict):
                merged_workers.append(worker)
                continue
            if str(worker.get("provider") or worker.get("type") or "") != "mock":
                merged_workers.append(worker)
                continue
            worker_env = worker.get("env")
            if not isinstance(worker_env, dict):
                worker_env = {}
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
        return self

    @model_validator(mode="after")
    def validate_execution_mode(self) -> "DispatchConfig":
        if any(
            worker.provider != "mock" for worker in self.workers
        ) and self.runtime.execution != "local":
            raise ValueError(
                "provider Workers run on the DSH runtime, which requires native "
                "local execution"
            )
        if self.runtime.execution == "container":
            if self.container is None:
                raise ValueError("container config is required when runtime.execution is container")
        else:
            if self.local is None:
                self.local = LocalConfig()
        for worker in self.workers:
            if worker.provider == "mock":
                continue
            if worker.provider not in self.providers:
                raise ValueError(
                    f"worker {worker.name} references undeclared provider "
                    f"'{worker.provider}'"
                )
            provider = self.providers[worker.provider]
            if not any(model.id == worker.model for model in provider.models):
                raise ValueError(
                    f"worker {worker.name} references model '{worker.model}' "
                    f"not declared by provider '{worker.provider}'"
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
        "managed": "REDTRACE_MANAGED_DIR",
        "workspaces": "REDTRACE_WORKSPACE_ROOT",
        "audit": "REDTRACE_AUDIT_ROOT",
    }
    defaults = {
        "skills": "skills",
        "mcp": "mcp",
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
