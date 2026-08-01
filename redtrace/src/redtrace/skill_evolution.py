from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol

from redtrace.capabilities import (
    CapabilityStore,
    PI_MCP_EXTENSION,
    PI_PROVIDER_EXTENSION,
    SkillConflictError,
    SkillRecord,
    _atomic_write,
    _frontmatter,
    validate_capability_name,
)

LOG = logging.getLogger(__name__)
TOKEN_PATTERN = re.compile(r"[a-z0-9]+|[\u4e00-\u9fff]{2,}", re.IGNORECASE)
NAME_LINE_PATTERN = re.compile(r"^(name:\s*).+$", re.MULTILINE)
FENCED_SKILL_PATTERN = re.compile(
    r"```(?:markdown|md)?\s*(---\s*\n.*?\n---.*?)(?:```|$)",
    re.IGNORECASE | re.DOTALL,
)
EVOLUTION_TYPES = frozenset({"FIX", "IMPROVE", "CAPTURE", "MERGE", "RETIRE"})
DEFAULT_QUEUE_LIMIT = 128
DEFAULT_MATCH_THRESHOLD = 0.34
DEFAULT_DUPLICATE_RATIO = 0.08
DEFAULT_AUTHOR_TIMEOUT = 600
DEFAULT_VERIFICATION_ATTEMPTS = 3
DEFAULT_VERIFICATION_RETRY_SECONDS = 60
AUTHOR_PROTOCOL_VERSION = 3
REQUIRED_SECTION_GROUPS = (
    ("trigger", "触发"),
    ("scope", "applicability", "适用"),
    ("workflow", "process", "执行流程", "流程"),
    ("validation", "success", "验证", "成功标准"),
    ("failure", "fallback", "失败"),
    ("safety", "boundary", "安全", "边界"),
)
FEEDBACK_SECRET_PATTERN = re.compile(
    r"(?i)(?:api[_-]?key|token|password|authorization|cookie)\s*[:=]\s*\S+"
)
CONTENT_SECRET_PATTERN = re.compile(
    r"(?i)(?:sk-[a-z0-9_-]{12,}|bearer\s+[a-z0-9._~-]{12,}|"
    r"(?:api[_-]?key|password)\s*[:=]\s*[^\s<{][^\s]{7,})"
)
TARGET_SPECIFIC_PATTERNS = (
    re.compile(r"https?://\S+", re.IGNORECASE),
    re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
    re.compile(r"(?:/Users/|/home/|/tmp/|[A-Za-z]:\\)[^\s`]+"),
    re.compile(r"\b[0-9a-f]{8}-[0-9a-f-]{27,}\b", re.IGNORECASE),
)
PROPOSAL_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class EvolutionDeferred(RuntimeError):
    """A valid candidate that cannot be authored in the current environment."""


class SkillAuthor(Protocol):
    def author(
        self,
        proposal: dict[str, Any],
        target: SkillRecord | None,
        related: list[SkillRecord],
    ) -> str: ...


@dataclass(frozen=True, slots=True)
class EvolutionDecision:
    proposal_id: str
    status: str
    reason: str
    skill: str | None = None
    version: int | None = None
    revision: str | None = None
    merged: tuple[str, ...] = ()
    evolution_type: str | None = None
    trust: str | None = None

    def as_dict(self) -> dict[str, Any]:
        return {
            "proposalId": self.proposal_id,
            "status": self.status,
            "reason": self.reason,
            "skill": self.skill,
            "version": self.version,
            "revision": self.revision,
            "merged": list(self.merged),
            "evolutionType": self.evolution_type,
            "trust": self.trust,
        }


class NativeSkillAuthor:
    """Use one installed native Worker CLI as a bounded background author."""

    def __init__(self, root: Path, preferred_worker: Any = None):
        self.root = root
        self.preferred_worker = preferred_worker
        self._workers: dict[str, Any] = {}
        self.timeout = _positive_env(
            "REDTRACE_SKILL_AUTHOR_TIMEOUT",
            DEFAULT_AUTHOR_TIMEOUT,
        )

    def author(
        self,
        proposal: dict[str, Any],
        target: SkillRecord | None,
        related: list[SkillRecord],
    ) -> str:
        tools = self._select_tools(proposal)
        if not tools:
            raise EvolutionDeferred(
                "no Claude Code, Codex, or Pi CLI is available for background authoring"
            )
        prompt = self._prompt(proposal, target, related)
        failures: list[str] = []
        deadline = time.monotonic() + self.timeout
        for tool in tools:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                failures.append(
                    f"Skill authoring exceeded the {self.timeout}s total budget"
                )
                break
            worker = self._configured_worker(tool)
            try:
                stdout = self._run_tool(tool, prompt, worker, remaining)
            except EvolutionDeferred as exc:
                failures.append(str(exc))
                continue
            content = _extract_authored_skill(tool, stdout)
            if content:
                for _repair_attempt in range(2):
                    defects = _authoring_defects(content, target)
                    if not defects:
                        break
                    remaining = deadline - time.monotonic()
                    if remaining <= 0:
                        break
                    repair_prompt = (
                        f"{prompt}\n\n"
                        "Your previous complete-Skill draft failed deterministic "
                        "validation. Repair it without adding unverified claims. "
                        f"DEFECTS: {', '.join(defects)}\n\n"
                        f"PREVIOUS DRAFT:\n{content}\n\n"
                        "Return only the corrected complete SKILL.md."
                    )
                    try:
                        repaired_stdout = self._run_tool(
                            tool,
                            repair_prompt,
                            worker,
                            remaining,
                        )
                        repaired = _extract_authored_skill(tool, repaired_stdout)
                        if repaired:
                            content = repaired
                    except EvolutionDeferred as exc:
                        failures.append(str(exc))
                        break
                return content
            failures.append(f"{tool} did not return a complete SKILL.md")
        raise EvolutionDeferred("; ".join(failures))

    def verify(
        self,
        proposal: dict[str, Any],
        evidence: dict[str, Any],
    ) -> dict[str, Any]:
        """Ask the reserved Worker for one bounded independent verification."""
        tools = self._select_tools(proposal)
        if not tools:
            raise EvolutionDeferred("reserved Worker CLI is unavailable")
        tool = tools[0]
        worker = self._configured_worker(tool)
        stdout = self._run_tool(
            tool,
            self._verification_prompt(proposal, evidence),
            worker,
            self.timeout,
        )
        result = _extract_verification(tool, stdout)
        if result is None:
            raise EvolutionDeferred("verification Worker did not return valid JSON")
        if result.get("verified") is not True:
            reason = str(result.get("validation") or "candidate was not verified")
            raise EvolutionDeferred(reason[:300])
        validation = str(result.get("validation") or "").strip()
        metric = str(result.get("metric") or "")
        metric_value = result.get("metric_value")
        if not validation:
            raise EvolutionDeferred("verification result omitted its conclusion")
        if metric not in {
            "tool_calls_saved",
            "invalid_steps_avoided",
            "duration_saved_ms",
        }:
            raise EvolutionDeferred("verification result used an unsupported metric")
        if (
            not isinstance(metric_value, int)
            or isinstance(metric_value, bool)
            or metric_value <= 0
        ):
            raise EvolutionDeferred("verification result omitted a positive measured impact")
        return {
            "validation": validation[:300],
            "metric": metric,
            "metric_value": metric_value,
        }

    def _select_tools(self, proposal: dict[str, Any]) -> list[str]:
        if self.preferred_worker is not None:
            tool = {
                "claudecode": "claude",
                "codex": "codex",
                "pi": "pi",
            }.get(str(self.preferred_worker.type))
            return [tool] if tool and shutil.which(tool) else []
        configured = os.environ.get("REDTRACE_SKILL_AUTHOR", "auto").strip().lower()
        if configured in {"off", "disabled", "none"}:
            return []
        order = (
            [configured]
            if configured != "auto"
            else [
                item.strip().lower()
                for item in os.environ.get(
                    "REDTRACE_SKILL_AUTHOR_ORDER",
                    "claude,codex,pi",
                ).split(",")
                if item.strip()
            ]
        )
        aliases = {"claudecode": "claude"}
        available: list[str] = []
        for item in order:
            binary = aliases.get(item, item)
            if (
                binary in {"claude", "codex", "pi"}
                and binary not in available
                and shutil.which(binary)
            ):
                available.append(binary)
        if configured != "auto":
            return available
        source_worker = str(proposal.get("worker") or "").strip().casefold()
        workers = {
            binary: self._configured_worker(binary)
            for binary in available
        }
        return sorted(
            available,
            key=lambda binary: (
                0
                if (
                    (worker := workers[binary]) is not None
                    and worker.api_configured()
                    and worker.name.casefold() == source_worker
                )
                else 1,
                0 if worker is not None and worker.api_configured() else 1,
                available.index(binary),
            ),
        )

    def _command(
        self,
        tool: str,
        prompt: str,
        worker: Any = None,
    ) -> list[str]:
        if tool == "claude":
            model_args = (
                ["--model", worker.env["ANTHROPIC_MODEL"]]
                if worker is not None and worker.api_configured()
                else []
            )
            return [
                "claude",
                "--permission-mode",
                "dontAsk",
                "--disable-slash-commands",
                "--effort",
                "low",
                *model_args,
                "-p",
                "--output-format",
                "text",
                "--",
                prompt,
            ]
        if tool == "codex":
            provider_args: list[str] = []
            if worker is not None and worker.api_configured():
                provider_args = [
                    "--model",
                    worker.env["CODEX_MODEL"],
                    "-c",
                    'model_provider="redtrace"',
                    "-c",
                    'model_providers.redtrace.name="redtrace"',
                    "-c",
                    'model_providers.redtrace.wire_api="responses"',
                    "-c",
                    'model_reasoning_effort="low"',
                    "-c",
                    (
                        "model_providers.redtrace.base_url="
                        + json.dumps(worker.env["CODEX_BASE_URL"])
                    ),
                    "-c",
                    'model_providers.redtrace.env_key="OPENAI_API_KEY"',
                ]
            return [
                "codex",
                "exec",
                "--json",
                "--sandbox",
                "read-only",
                *provider_args,
                "--",
                prompt,
            ]
        provider_args = []
        if worker is not None and worker.api_configured():
            extension = (
                self.root
                / "skills"
                / ".redtrace"
                / "pi-author-provider.js"
            )
            _atomic_write(extension, PI_PROVIDER_EXTENSION)
            provider_args = [
                "--extension",
                str(extension),
                "--provider",
                "redtrace",
                "--model",
                worker.env["PI_MODEL"],
            ]
        else:
            provider_args = ["--extension", PI_MCP_EXTENSION]
        return [
            "pi",
            *provider_args,
            "--mode",
            "json",
            "--no-tools",
            "--no-session",
            "--no-skills",
            "--no-context-files",
            "--thinking",
            "low",
            "-p",
            prompt,
        ]

    def _configured_worker(self, tool: str) -> Any:
        if self.preferred_worker is not None:
            worker_tool = {
                "claudecode": "claude",
                "codex": "codex",
                "pi": "pi",
            }.get(str(self.preferred_worker.type))
            return self.preferred_worker if worker_tool == tool else None
        if tool in self._workers:
            return self._workers[tool]
        try:
            from redtrace.dispatcher.config import DispatchConfig

            configured = os.environ.get("REDTRACE_DISPATCH_CONFIG")
            candidates = [
                Path(configured).expanduser() if configured else None,
                self.root / "dispatch.yaml",
                self.root / "dispatch.local.yaml",
            ]
            path = next(
                (
                    candidate.resolve()
                    for candidate in candidates
                    if candidate is not None and candidate.is_file()
                ),
                None,
            )
            if path is None:
                return None
            config = DispatchConfig.load(path)
            worker_type = {
                "claude": "claudecode",
                "codex": "codex",
                "pi": "pi",
            }[tool]
            worker = next(
                (
                    worker
                    for worker in config.workers
                    if worker.enabled and worker.type == worker_type
                ),
                None,
            )
            if worker is not None:
                self._workers[tool] = worker
            return worker
        except Exception:
            LOG.debug(
                "background author could not load Worker configuration",
                exc_info=True,
            )
            return None

    def _run_tool(
        self,
        tool: str,
        prompt: str,
        worker: Any,
        timeout: float,
    ) -> str:
        command = self._command(tool, prompt, worker)
        if os.name == "posix" and shutil.which("nice"):
            command = ["nice", "-n", "10", *command]
        environment = dict(os.environ)
        if worker is not None:
            environment.update(worker.env)
            if tool == "claude" and worker.api_configured():
                for key in (
                    "ANTHROPIC_API_KEY",
                    "ANTHROPIC_OAUTH_TOKEN",
                    "CLAUDE_CODE_USE_BEDROCK",
                    "CLAUDE_CODE_USE_VERTEX",
                    "CLAUDE_CODE_USE_FOUNDRY",
                ):
                    if key not in worker.env:
                        environment.pop(key, None)
        try:
            result = subprocess.run(
                command,
                cwd=self.root,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=max(1, timeout),
                check=False,
                env=environment,
            )
        except subprocess.TimeoutExpired as exc:
            raise EvolutionDeferred(f"{tool} Worker exceeded its time budget") from exc
        except OSError as exc:
            raise EvolutionDeferred(f"{tool} Worker failed: {exc}") from exc
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()[-300:]
            raise EvolutionDeferred(
                f"{tool} Worker exited {result.returncode}: {detail}"
            )
        return result.stdout

    def _verification_prompt(
        self,
        proposal: dict[str, Any],
        evidence: dict[str, Any],
    ) -> str:
        candidate = {
            key: proposal.get(key)
            for key in (
                "target_skill",
                "summary",
                "applicability",
                "procedure",
                "validation",
                "evidence_refs",
            )
        }
        return (
            "You are the independent RedTrace Skill verification Worker. "
            "Evaluate the candidate only against the supplied task evidence. "
            "Do not modify files, submit proposals, or claim a benefit that the "
            "evidence does not support. Mark verified=true only when a reusable "
            "claim is independently supported and at least one quantitative "
            "benefit is defensible. Use invalid_steps_avoided for distinct failed "
            "branches that this guidance would prevent, tool_calls_saved only for "
            "documented redundant calls, and duration_saved_ms only for recorded "
            "timings. Return exactly one JSON object with keys verified (boolean), "
            "validation (string), metric (tool_calls_saved, invalid_steps_avoided, "
            "or duration_saved_ms), and metric_value (positive integer).\n\n"
            f"CANDIDATE:\n{json.dumps(candidate, ensure_ascii=False, indent=2)}\n\n"
            f"TASK EVIDENCE:\n{json.dumps(evidence, ensure_ascii=False, indent=2)}"
        )

    def _prompt(
        self,
        proposal: dict[str, Any],
        target: SkillRecord | None,
        related: list[SkillRecord],
    ) -> str:
        creator_path = self.root / "skills" / "skill-creator" / "SKILL.md"
        try:
            creator = creator_path.read_text(encoding="utf-8")[:16_000]
        except OSError:
            creator = ""
        evidence = {
            key: proposal.get(key)
            for key in (
                "evolution_type",
                "proposed_name",
                "target_skill",
                "summary",
                "applicability",
                "procedure",
                "validation",
                "evidence_refs",
                "merge_skills",
            )
            if proposal.get(key)
        }
        existing = []
        if target is not None:
            existing.append(
                {
                    "name": target.name,
                    "trust": target.trust,
                    "content": target.content[:24_000],
                }
            )
        for record in related[:3]:
            if target is not None and record.name == target.name:
                continue
            existing.append(
                {
                    "name": record.name,
                    "description": record.description,
                    "headings": _headings(record.content),
                }
            )
        growth_budget = (
            min(8192, max(1024, int(len(target.content) * 0.25)))
            if target is not None
            else None
        )
        constraints = {
            "required_sections": [group[0] for group in REQUIRED_SECTION_GROUPS],
            "max_characters": (
                len(target.content) + growth_budget
                if target is not None and growth_budget is not None
                else _positive_env("REDTRACE_MAX_SKILL_CHARS", 65_536)
            ),
            "replacement_must_not_be_append_only": target is not None,
        }
        return (
            "You are the low-priority RedTrace Skill author. Follow the included "
            "skill-creator contract. Use only the verified candidate evidence below. "
            "Generalize away targets, credentials, task IDs, temporary paths, and "
            "project-specific details. Prefer a compact replacement of the matching "
            "Skill; create a new Skill only if no existing entry can cover it. "
            "Return only one complete SKILL.md beginning with YAML frontmatter. "
            "Do not call tools or modify files.\n\n"
            f"ENGINE CONSTRAINTS:\n{json.dumps(constraints, ensure_ascii=False, indent=2)}\n\n"
            f"SKILL CREATOR CONTRACT:\n{creator}\n\n"
            f"CANDIDATE:\n{json.dumps(evidence, ensure_ascii=False, indent=2)}\n\n"
            f"RELEVANT SKILL ENTRIES:\n{json.dumps(existing, ensure_ascii=False, indent=2)}"
        )


class SkillEvolutionEngine:
    """Bounded candidate admission and low-priority Skill evolution."""

    def __init__(
        self,
        store: CapabilityStore | None = None,
        author: SkillAuthor | None = None,
    ):
        self.store = store or CapabilityStore()
        self.author = author or NativeSkillAuthor(self.store.root)
        self.inbox = self.store.skill_meta_dir / "inbox"
        self.deferred = self.store.skill_meta_dir / "deferred"
        self.queue_limit = _positive_env(
            "REDTRACE_SKILL_QUEUE_LIMIT",
            DEFAULT_QUEUE_LIMIT,
        )
        self.match_threshold = _float_env(
            "REDTRACE_SKILL_MATCH_THRESHOLD",
            DEFAULT_MATCH_THRESHOLD,
        )
        self.max_duplicate_ratio = _float_env(
            "REDTRACE_SKILL_MAX_DUPLICATE_RATIO",
            DEFAULT_DUPLICATE_RATIO,
        )
        self.failure_limit = _positive_env(
            "REDTRACE_SKILL_FAILURE_LIMIT",
            3,
        )
        self._process_lock = threading.Lock()

    def submit(self, proposal: dict[str, Any]) -> str:
        payload = _normalize_proposal(proposal)
        self._validate_feedback_safety(payload)
        content = payload.get("content")
        if isinstance(content, str) and len(content) > self.store.max_skill_chars:
            raise ValueError(
                f"proposal exceeds {self.store.max_skill_chars} characters"
            )
        self.store.ensure()
        self.inbox.mkdir(parents=True, exist_ok=True)
        fingerprint = _proposal_fingerprint(payload)
        payload["fingerprint"] = fingerprint
        payload["occurrences"] = max(1, int(payload.get("occurrences") or 1))
        source_task = _source_task(payload)
        payload["source_tasks"] = [source_task] if source_task else []
        with self.store._skill_lock():
            deferred_paths = list(self.deferred.glob("*.json")) if self.deferred.is_dir() else []
            inbox_paths = list(self.inbox.glob("*.json"))
            paths = [*inbox_paths, *deferred_paths]
            for path in paths:
                try:
                    existing = json.loads(path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
                if (
                    isinstance(existing, dict)
                    and existing.get("fingerprint") == fingerprint
                ):
                    merged = _merge_duplicate_proposals(existing, payload)
                    destination = path
                    if path.parent == self.deferred and self._ready(merged):
                        destination = self.inbox / path.name
                    _atomic_write(
                        destination,
                        json.dumps(
                            merged,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        + "\n",
                    )
                    if destination != path:
                        path.unlink(missing_ok=True)
                    return str(existing.get("proposal_id") or path.stem)
            if len(paths) >= self.queue_limit:
                raise ValueError(
                    f"Skill evolution queue is full ({self.queue_limit})"
                )
            proposal_id = uuid.uuid4().hex
            payload["proposal_id"] = proposal_id
            _atomic_write(
                self.inbox / f"{proposal_id}.json",
                json.dumps(
                    payload,
                    ensure_ascii=False,
                    separators=(",", ":"),
                )
                + "\n",
            )
        return proposal_id

    def restore_ready_deferred(self) -> int:
        """Requeue deferred candidates that now satisfy the current evidence rules."""
        if not self.deferred.is_dir():
            return 0
        restored = 0
        self.inbox.mkdir(parents=True, exist_ok=True)
        with self.store._skill_lock():
            for path in self.deferred.glob("*.json"):
                try:
                    proposal = json.loads(path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
                if not isinstance(proposal, dict) or not self._ready(proposal):
                    continue
                destination = self.inbox / path.name
                os.replace(path, destination)
                restored += 1
        return restored

    def requeue_ready_deferred(self, proposal_id: str) -> bool:
        """Move one fully evidenced candidate back to the authoring inbox."""
        if not PROPOSAL_ID_PATTERN.fullmatch(proposal_id):
            raise ValueError("invalid proposal id")
        path = self.deferred / f"{proposal_id}.json"
        destination = self.inbox / path.name
        self.inbox.mkdir(parents=True, exist_ok=True)
        with self.store._skill_lock():
            if not path.is_file():
                return destination.is_file()
            proposal = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(proposal, dict) or not self._ready(proposal):
                return False
            os.replace(path, destination)
        return True

    def _ready(self, proposal: dict[str, Any]) -> bool:
        try:
            evidence_tier = self._validate_evidence(proposal)
            return evidence_tier == "full" or (
                evidence_tier == "minimal"
                and int(proposal.get("occurrences") or 1) >= 3
            )
        except (TypeError, ValueError):
            return False

    def pending_count(self) -> int:
        return (
            len(list(self.inbox.glob("*.json")))
            if self.inbox.is_dir()
            else 0
        )

    def deferred_count(self) -> int:
        return (
            len(list(self.deferred.glob("*.json")))
            if self.deferred.is_dir()
            else 0
        )

    def deferred_items(self, limit: int = 20) -> list[dict[str, Any]]:
        """Return bounded, safe summaries for human review."""
        if not self.deferred.is_dir():
            return []
        items: list[dict[str, Any]] = []
        paths = sorted(
            self.deferred.glob("*.json"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )[: max(1, min(limit, 100))]
        for path in paths:
            try:
                proposal = json.loads(path.read_text(encoding="utf-8"))
            except (json.JSONDecodeError, OSError):
                continue
            if not isinstance(proposal, dict):
                continue
            try:
                tier = self._validate_evidence(proposal)
            except (TypeError, ValueError):
                tier = "invalid"
            impact = proposal.get("impact")
            impact = impact if isinstance(impact, dict) else {}
            checks = [
                {
                    "label": "任务或步骤已验证",
                    "complete": impact.get("task_succeeded") is True
                    or impact.get("step_verified") is True,
                },
                {
                    "label": "至少一项量化收益",
                    "complete": any(
                        isinstance(impact.get(key), int)
                        and not isinstance(impact.get(key), bool)
                        and impact.get(key, 0) > 0
                        for key in (
                            "tool_calls_saved",
                            "invalid_steps_avoided",
                            "duration_saved_ms",
                        )
                    ),
                },
                {
                    "label": "验证结论",
                    "complete": bool(proposal.get("validation")),
                },
                {
                    "label": "可复用步骤",
                    "complete": bool(proposal.get("procedure")),
                },
                {
                    "label": "来源任务",
                    "complete": bool(
                        proposal.get("source_tasks")
                        or proposal.get("evidence_refs")
                    ),
                },
            ]
            verification = proposal.get("verification")
            verification = verification if isinstance(verification, dict) else {}
            verification_status = str(verification.get("status") or "queued")
            attempts = int(verification.get("attempts") or 0)
            if verification_status == "running":
                verification_label = "空闲 Worker 正在独立核验"
            elif verification_status == "author_failed":
                verification_label = "作者输出未通过，等待其他 Worker 重试"
            elif verification_status == "failed":
                verification_label = (
                    "自动核验失败，已停止重试"
                    if attempts >= DEFAULT_VERIFICATION_ATTEMPTS
                    else "自动核验失败，系统稍后重试"
                )
            elif verification_status == "verified":
                verification_label = "AI 核验通过，等待进化处理"
            else:
                verification_label = "等待空闲 Worker 自动核验"
            reason = {
                "unmeasured": "缺少量化收益；等待 AI 自动核验",
                "minimal": "证据不完整；等待 AI 重复验证",
                "full": "证据已满足；等待恢复处理",
                "invalid": "候选格式无效；建议人工放弃",
            }.get(tier, "等待 AI 复核")
            items.append(
                {
                    "proposalId": str(
                        proposal.get("proposal_id") or path.stem
                    ),
                    "targetSkill": proposal.get("target_skill"),
                    "summary": str(proposal.get("summary") or "")[:500],
                    "projectId": proposal.get("project_id"),
                    "intentId": proposal.get("intent_id"),
                    "occurrences": int(proposal.get("occurrences") or 1),
                    "evidenceTier": tier,
                    "evidenceChecks": checks,
                    "requirementsMet": sum(
                        1 for check in checks if check["complete"]
                    ),
                    "requirementsTotal": len(checks),
                    "sourceTasks": list(proposal.get("source_tasks") or [])[:8],
                    "verificationStatus": verification_status,
                    "verificationWorker": verification.get("worker"),
                    "verificationAttempts": attempts,
                    "verificationLabel": verification_label,
                    "reason": reason,
                }
            )
        return items

    def claim_deferred_verification(
        self,
        worker_name: str,
    ) -> dict[str, Any] | None:
        """Atomically claim one deferred candidate for an idle Worker."""
        if not self.deferred.is_dir():
            return None
        now = time.time()
        claimed: dict[str, Any] | None = None
        with self.store._skill_lock():
            for path in sorted(self.deferred.glob("*.json")):
                try:
                    proposal = json.loads(path.read_text(encoding="utf-8"))
                except (json.JSONDecodeError, OSError):
                    continue
                if not isinstance(proposal, dict):
                    continue
                ready = self._ready(proposal)
                verification = proposal.get("verification")
                verification = verification if isinstance(verification, dict) else {}
                failed_workers = [
                    str(item)
                    for item in (verification.get("failed_workers") or [])
                ]
                if verification.get("author_protocol") != AUTHOR_PROTOCOL_VERSION:
                    failed_workers = []
                if worker_name in failed_workers:
                    continue
                attempts = int(verification.get("attempts") or 0)
                status = str(verification.get("status") or "queued")
                started_at = float(verification.get("started_at") or 0)
                next_attempt_at = float(verification.get("next_attempt_at") or 0)
                if status == "running" and now - started_at < DEFAULT_AUTHOR_TIMEOUT:
                    continue
                if attempts >= DEFAULT_VERIFICATION_ATTEMPTS and not ready:
                    continue
                if next_attempt_at > now:
                    continue
                proposal["verification"] = {
                    "status": "running",
                    "worker": worker_name,
                    "attempts": attempts + 1,
                    "started_at": now,
                    "failed_workers": failed_workers,
                    "author_protocol": AUTHOR_PROTOCOL_VERSION,
                }
                _atomic_write(
                    path,
                    json.dumps(proposal, ensure_ascii=False, separators=(",", ":"))
                    + "\n",
                )
                claimed = proposal
                break
        if claimed is not None:
            self.store.record_skill_audit(
                {
                    "action": "evolution-verification-started",
                    "actor": worker_name,
                    "proposalId": claimed.get("proposal_id"),
                    "attempt": claimed["verification"]["attempts"],
                }
            )
        return claimed

    def fail_deferred_verification(
        self,
        proposal_id: str,
        worker_name: str,
        reason: str,
    ) -> None:
        """Record a bounded autonomous verification failure for later retry."""
        path = self.deferred / f"{proposal_id}.json"
        attempts = 0
        with self.store._skill_lock():
            if not path.is_file():
                return
            proposal = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(proposal, dict):
                return
            verification = proposal.get("verification")
            verification = verification if isinstance(verification, dict) else {}
            attempts = int(verification.get("attempts") or 1)
            failed_workers = [
                str(item)
                for item in (verification.get("failed_workers") or [])
            ]
            proposal["verification"] = {
                "status": "failed",
                "worker": worker_name,
                "attempts": attempts,
                "error": reason[:300],
                "next_attempt_at": time.time()
                + DEFAULT_VERIFICATION_RETRY_SECONDS,
                "failed_workers": failed_workers,
                "author_protocol": AUTHOR_PROTOCOL_VERSION,
            }
            _atomic_write(
                path,
                json.dumps(proposal, ensure_ascii=False, separators=(",", ":"))
                + "\n",
            )
        self.store.record_skill_audit(
            {
                "action": "evolution-verification-failed",
                "actor": worker_name,
                "proposalId": proposal_id,
                "attempt": attempts,
                "reason": reason[:300],
            }
        )

    def apply_autonomous_verification(
        self,
        proposal_id: str,
        worker_name: str,
        evidence: dict[str, Any],
    ) -> bool:
        """Attach one Worker-produced verification and requeue when ready."""
        if not PROPOSAL_ID_PATTERN.fullmatch(proposal_id):
            raise ValueError("invalid proposal id")
        validation = str(evidence.get("validation") or "").strip()
        metric = str(evidence.get("metric") or "")
        metric_value = evidence.get("metric_value")
        if not validation:
            raise ValueError("validation is required")
        if metric not in {
            "tool_calls_saved",
            "invalid_steps_avoided",
            "duration_saved_ms",
        }:
            raise ValueError("unsupported evidence metric")
        if (
            not isinstance(metric_value, int)
            or isinstance(metric_value, bool)
            or metric_value <= 0
        ):
            raise ValueError("metric_value must be a positive integer")

        path = self.deferred / f"{proposal_id}.json"
        self.inbox.mkdir(parents=True, exist_ok=True)
        with self.store._skill_lock():
            if not path.is_file():
                raise FileNotFoundError(proposal_id)
            proposal = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(proposal, dict):
                raise ValueError("proposal root must be an object")
            verification = proposal.get("verification")
            verification = verification if isinstance(verification, dict) else {}
            attempt = int(verification.get("attempts") or 1)
            failed_workers = [
                str(item)
                for item in (verification.get("failed_workers") or [])
            ]
            source_task = f"ai-verification:{proposal_id}:{attempt}"
            if source_task in (proposal.get("source_tasks") or []):
                raise ValueError("evidence must come from another task")
            incoming = {
                "validation": [validation],
                "evidence_refs": [source_task],
                "source_tasks": [source_task],
                "impact": {
                    "task_succeeded": False,
                    "step_verified": True,
                    "tool_calls_saved": 0,
                    "invalid_steps_avoided": 0,
                    "duration_saved_ms": 0,
                    metric: metric_value,
                },
            }
            merged = _merge_duplicate_proposals(proposal, incoming)
            merged["verification"] = {
                "status": "verified",
                "worker": worker_name,
                "attempts": attempt,
                "completed_at": time.time(),
                "failed_workers": failed_workers,
                "author_protocol": AUTHOR_PROTOCOL_VERSION,
            }
            ready = self._ready(merged)
            destination = self.inbox / path.name if ready else path
            _atomic_write(
                destination,
                json.dumps(merged, ensure_ascii=False, separators=(",", ":"))
                + "\n",
            )
            if destination != path:
                path.unlink(missing_ok=True)
        self.store.record_skill_audit(
            {
                "action": "evolution-evidence-added",
                "actor": worker_name,
                "proposalId": proposal_id,
                "sourceTask": source_task,
                "metric": metric,
                "metricValue": metric_value,
                "ready": ready,
            }
        )
        return ready

    def discard_deferred(self, proposal_id: str) -> bool:
        """Discard one reviewed deferred candidate without touching Skills."""
        if not PROPOSAL_ID_PATTERN.fullmatch(proposal_id):
            raise ValueError("invalid proposal id")
        path = self.deferred / f"{proposal_id}.json"
        with self.store._skill_lock():
            if not path.is_file():
                return False
            path.unlink()
        self.store.record_skill_audit(
            {
                "action": "evolution-discarded",
                "actor": "api",
                "proposalId": proposal_id,
                "reason": "deferred candidate discarded after human review",
            }
        )
        return True

    def process_pending(
        self,
        limit: int = 8,
        *,
        proposal_id: str | None = None,
    ) -> int:
        """Finalize queued candidates serially.

        ``proposal_id`` is the task-end fast path: it finalizes the candidate
        produced by the current task before that task is concluded. The
        background worker continues to use the bounded batch path.
        """
        with self._process_lock:
            return self._process_pending_locked(
                limit=limit,
                proposal_id=proposal_id,
            )

    def _process_pending_locked(
        self,
        *,
        limit: int,
        proposal_id: str | None,
    ) -> int:
        processed = 0
        if proposal_id is not None:
            candidate = self.inbox / f"{proposal_id}.json"
            paths = [candidate] if candidate.is_file() else []
        else:
            paths = sorted(self.inbox.glob("*.json"))[: max(1, limit)]
        for path in paths:
            decision: EvolutionDecision
            proposal: dict[str, Any] = {}
            move_to_deferred = False
            try:
                loaded = json.loads(path.read_text(encoding="utf-8"))
                if not isinstance(loaded, dict):
                    raise ValueError("proposal root must be an object")
                proposal = loaded
                decision = self.evolve(proposal)
            except EvolutionDeferred as exc:
                proposal_id = str(proposal.get("proposal_id") or path.stem)
                decision = EvolutionDecision(
                    proposal_id,
                    "deferred",
                    str(exc),
                    evolution_type=str(
                        proposal.get("evolution_type") or "CAPTURE"
                    ),
                )
                move_to_deferred = True
                self._degrade_failed_skill(proposal)
                LOG.info(
                    "skill.evolution.deferred id=%s target=%s reason=%s",
                    proposal_id,
                    proposal.get("target_skill"),
                    str(exc)[:200],
                )
            except SkillConflictError as exc:
                proposal_id = str(proposal.get("proposal_id") or path.stem)
                verification = proposal.get("verification")
                verification = verification if isinstance(verification, dict) else {}
                autonomous = any(
                    isinstance(item, str) and item.startswith("ai-verification:")
                    for item in (proposal.get("source_tasks") or [])
                )
                if autonomous:
                    worker_name = str(verification.get("worker") or "unknown")
                    failed_workers = [
                        str(item)
                        for item in (verification.get("failed_workers") or [])
                    ]
                    if worker_name not in failed_workers:
                        failed_workers.append(worker_name)
                    proposal["verification"] = {
                        **verification,
                        "status": "author_failed",
                        "error": str(exc)[:300],
                        "failed_workers": failed_workers,
                        "author_protocol": AUTHOR_PROTOCOL_VERSION,
                    }
                    _atomic_write(
                        path,
                        json.dumps(
                            proposal,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        + "\n",
                    )
                decision = EvolutionDecision(
                    proposal_id,
                    "deferred" if autonomous else "rejected",
                    str(exc),
                    evolution_type=str(
                        proposal.get("evolution_type") or "CAPTURE"
                    ),
                )
                move_to_deferred = autonomous
                LOG.info(
                    "skill.evolution.%s id=%s target=%s reason=%s",
                    decision.status,
                    proposal_id,
                    proposal.get("target_skill"),
                    str(exc)[:200],
                )
            except Exception as exc:
                proposal_id = str(proposal.get("proposal_id") or path.stem)
                verification = proposal.get("verification")
                verification = verification if isinstance(verification, dict) else {}
                autonomous = any(
                    isinstance(item, str) and item.startswith("ai-verification:")
                    for item in (proposal.get("source_tasks") or [])
                )
                if autonomous:
                    worker_name = str(verification.get("worker") or "unknown")
                    failed_workers = [
                        str(item)
                        for item in (verification.get("failed_workers") or [])
                    ]
                    if worker_name not in failed_workers:
                        failed_workers.append(worker_name)
                    proposal["verification"] = {
                        **verification,
                        "status": "author_failed",
                        "error": str(exc)[:300],
                        "failed_workers": failed_workers,
                        "author_protocol": AUTHOR_PROTOCOL_VERSION,
                    }
                    _atomic_write(
                        path,
                        json.dumps(
                            proposal,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        + "\n",
                    )
                decision = EvolutionDecision(
                    proposal_id,
                    "deferred" if autonomous else "rejected",
                    str(exc),
                    evolution_type=str(
                        proposal.get("evolution_type") or "CAPTURE"
                    ),
                )
                move_to_deferred = autonomous
                LOG.warning(
                    "skill.evolution.%s id=%s target=%s reason=%s",
                    decision.status,
                    proposal_id,
                    proposal.get("target_skill"),
                    str(exc)[:200],
                )
                if not autonomous:
                    self._degrade_failed_skill(proposal)
            else:
                if decision.status == "accepted":
                    LOG.info(
                        "skill.evolution.updated id=%s skill=%s version=%s "
                        "type=%s merged=%s",
                        decision.proposal_id,
                        decision.skill,
                        decision.version,
                        decision.evolution_type,
                        list(decision.merged) or None,
                    )
            verification_actor = proposal.get("verification")
            verification_actor = (
                verification_actor
                if isinstance(verification_actor, dict)
                else {}
            )
            self.store.record_skill_audit(
                {
                    "action": f"evolution-{decision.status}",
                    "evolutionType": decision.evolution_type,
                    "actor": str(
                        verification_actor.get("worker")
                        or proposal.get("worker")
                        or "worker"
                    ),
                    "proposalId": decision.proposal_id,
                    "skill": decision.skill,
                    "version": decision.version,
                    "revision": decision.revision,
                    "trust": decision.trust,
                    "reason": decision.reason[:500],
                    "projectId": proposal.get("project_id"),
                    "intentId": proposal.get("intent_id"),
                    "taskType": proposal.get("task_type"),
                    "impact": proposal.get("impact"),
                    "validation": proposal.get("validation"),
                    "evidenceRefs": proposal.get("evidence_refs"),
                    "sourceTasks": proposal.get("source_tasks"),
                    "occurrences": proposal.get("occurrences", 1),
                    "merged": list(decision.merged),
                }
            )
            if move_to_deferred:
                self.deferred.mkdir(parents=True, exist_ok=True)
                os.replace(path, self.deferred / path.name)
            else:
                path.unlink(missing_ok=True)
            processed += 1
        return processed

    def decision_for(self, proposal_id: str) -> dict[str, Any]:
        """Return the durable state of one submitted candidate."""
        for event in self.store.read_skill_audit(limit=500):
            if event.get("proposalId") != proposal_id:
                continue
            action = str(event.get("action") or "")
            if not action.startswith("evolution-"):
                continue
            return {
                "proposalId": proposal_id,
                "status": action.removeprefix("evolution-"),
                "reason": event.get("reason"),
                "skill": event.get("skill"),
                "version": event.get("version"),
                "revision": event.get("revision"),
                "trust": event.get("trust"),
                "evolutionType": event.get("evolutionType"),
                "merged": event.get("merged") or [],
            }
        if (self.deferred / f"{proposal_id}.json").is_file():
            return {
                "proposalId": proposal_id,
                "status": "deferred",
                "reason": "candidate is waiting for independent measured evidence",
            }
        if (self.inbox / f"{proposal_id}.json").is_file():
            return {
                "proposalId": proposal_id,
                "status": "queued",
                "reason": "candidate has not been finalized",
            }
        return {
            "proposalId": proposal_id,
            "status": "unknown",
            "reason": "candidate state is unavailable",
        }

    def evolve(self, proposal: dict[str, Any]) -> EvolutionDecision:
        proposal = _normalize_proposal(proposal)
        proposal_id = str(
            proposal.get("proposal_id") or uuid.uuid4().hex
        )
        evolution_type = proposal["evolution_type"]
        evidence_tier = self._validate_evidence(proposal)
        self._validate_feedback_safety(proposal)

        if evidence_tier == "unmeasured":
            raise EvolutionDeferred(
                "no measured successful impact; deferred until a task records "
                "at least one saved tool call, avoided invalid step, or saved millisecond"
            )

        # Minimal-evidence proposals are deferred to the pending-verification
        # queue. They accumulate occurrences until a future task provides
        # sufficient validation for full authoring.
        if evidence_tier == "minimal" and proposal.get("occurrences", 1) < 3:
            raise EvolutionDeferred(
                "insufficient evidence for immediate evolution; deferred to "
                "pending-verification queue (occurrences="
                f"{proposal.get('occurrences', 1)})"
            )

        records = self.store.list_skills()
        target = self._select_target(proposal, records)

        if proposal.get("reuse_validated") is True:
            return self._promote_reuse(
                proposal_id,
                proposal,
                target,
                evolution_type,
            )
        if evolution_type == "RETIRE":
            return self._retire(
                proposal_id,
                proposal,
                target,
                evolution_type,
            )

        content = proposal.get("content")
        if not isinstance(content, str) or not content.strip():
            related = self._related_records(proposal, records)
            content = self.author.author(proposal, target, related)
        content = content.rstrip() + "\n"

        proposed_name = str(
            proposal.get("proposed_name") or ""
        ).strip().lower()
        metadata = _frontmatter(content)
        if target is None:
            candidate_name = proposed_name or metadata.get("name", "").lower()
            candidate_name = validate_capability_name(candidate_name)
            if metadata.get("name", "").strip().lower() != candidate_name:
                raise ValueError(
                    "new Skill frontmatter name must match the selected name"
                )
            self._make_room(records)
            expected_revision = None
            major_change = True
            action = "evolve-create"
        else:
            candidate_name = target.name
            content = _replace_frontmatter_name(content, candidate_name)
            self._validate_replacement(target, content)
            expected = proposal.get("expected_revision")
            if expected is not None and str(expected) != target.revision:
                raise SkillConflictError(
                    f"proposal is based on stale {candidate_name} revision "
                    f"{expected}; current is {target.revision}"
                )
            expected_revision = target.revision
            major_change = _is_major_change(target.content, content)
            action = f"evolve-{evolution_type.lower()}"

        self._validate_content(
            content,
            require_complete=target is None or major_change,
        )
        source_task = _source_task(proposal)
        # Trust belongs to a revision, not to the Skill name. Every content
        # mutation must prove itself in a later independent project.
        trust = "provisional"
        record = self.store.write_skill(
            candidate_name,
            content,
            enabled=True,
            expected_revision=expected_revision,
            actor=str(proposal.get("worker") or "worker"),
            reason=str(proposal.get("summary") or ""),
            action=action,
            trust=trust,
            successful_reuses=0,
            failure_count=0 if evolution_type == "FIX" else (
                target.failure_count if target is not None else 0
            ),
            provisional_task=source_task if trust == "provisional" else None,
        )
        merged = self._merge_redundant_skills(
            record,
            proposal.get("merge_skills") if evolution_type == "MERGE" else None,
        )
        return EvolutionDecision(
            proposal_id,
            "accepted",
            "validated evolution committed",
            skill=record.name,
            version=record.version,
            revision=record.revision,
            merged=tuple(merged),
            evolution_type=evolution_type,
            trust=record.trust,
        )

    def _validate_evidence(self, proposal: dict[str, Any]) -> str:
        """Validate feedback evidence and return confidence tier.

        Returns "full" when all strict requirements are met (ready for
        immediate authoring) or "minimal" when only summary is present
        (should be deferred to the pending-verification queue).

        Raises ValueError only for fundamentally invalid data.
        """
        summary = proposal.get("summary")
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 500:
            raise ValueError("summary must contain 1-500 characters")

        # Check strict requirements for full-confidence evolution.
        validation = proposal.get("validation")
        impact = proposal.get("impact")
        procedure = proposal.get("procedure")
        evidence_refs = proposal.get("evidence_refs")
        content = proposal.get("content")

        # Impact verification check.
        impact_verified = False
        if isinstance(impact, dict):
            outcome_verified = (
                impact.get("task_succeeded") is True
                or impact.get("step_verified") is True
            )
            metrics = (
                impact.get("tool_calls_saved", 0),
                impact.get("invalid_steps_avoided", 0),
                impact.get("duration_saved_ms", 0),
            )
            metrics_valid = not any(
                not isinstance(value, int)
                or isinstance(value, bool)
                or value < 0
                for value in metrics
            )
            impact_verified = outcome_verified and metrics_valid and any(metrics)

        if not impact_verified:
            return "unmeasured"

        # Validation list check.
        validation_ok = (
            isinstance(validation, list)
            and len(validation) > 0
            and len(validation) <= 8
            and all(
                isinstance(item, str) and item.strip() and len(item) <= 300
                for item in validation
            )
        )

        # Procedure check.
        procedure_ok = (
            isinstance(procedure, list)
            and len(procedure) > 0
            and len(procedure) <= 8
            and all(
                isinstance(item, str) and item.strip() and len(item) <= 300
                for item in procedure
            )
        )

        # Evidence refs check.
        evidence_ok = bool(_source_task(proposal)) or (
            isinstance(evidence_refs, list)
            and len(evidence_refs) > 0
            and len(evidence_refs) <= 8
            and all(
                isinstance(item, str) and item.strip() and len(item) <= 200
                for item in evidence_refs
            )
        )

        # Full-content proposals have their own path.
        if isinstance(content, str) and content.strip():
            if impact_verified and validation_ok:
                return "full"
            return "minimal"

        # Compact feedback: full tier requires all strict fields.
        if impact_verified and validation_ok and procedure_ok and evidence_ok:
            return "full"
        return "minimal"

    def _degrade_failed_skill(self, proposal: dict[str, Any]) -> None:
        """Record a verified FIX signal even when authoring cannot complete."""
        if str(proposal.get("evolution_type") or "").upper() != "FIX":
            return
        impact = proposal.get("impact")
        if not isinstance(impact, dict) or not (
            impact.get("task_succeeded") is True
            or impact.get("step_verified") is True
        ):
            return
        name = str(proposal.get("target_skill") or "").strip().lower()
        if not name:
            return
        try:
            record = self.store.get_skill(name)
            failures = record.failure_count + 1
            retired = failures >= self.failure_limit
            self.store.write_skill(
                record.name,
                record.content,
                enabled=record.enabled and not retired,
                expected_revision=record.revision,
                actor="evolver",
                reason="verified Skill failure; authoring did not commit a fix",
                action="quality-degrade",
                trust="retired" if retired else "provisional",
                successful_reuses=record.successful_reuses,
                failure_count=failures,
                provisional_task=record.provisional_task,
            )
        except Exception:
            LOG.debug("failed to record Skill quality degradation", exc_info=True)

    def _validate_feedback_safety(self, proposal: dict[str, Any]) -> None:
        text_values: list[str] = []
        for key in ("summary", "applicability"):
            value = proposal.get(key)
            if isinstance(value, str):
                text_values.append(value)
        for key in ("procedure", "validation", "evidence_refs"):
            value = proposal.get(key)
            if isinstance(value, list):
                text_values.extend(
                    item for item in value if isinstance(item, str)
                )
        joined = "\n".join(text_values)
        if FEEDBACK_SECRET_PATTERN.search(joined):
            raise ValueError(
                "candidate feedback contains a credential or secret value"
            )
        if any(pattern.search(joined) for pattern in TARGET_SPECIFIC_PATTERNS):
            raise ValueError(
                "candidate feedback contains target- or task-specific data"
            )

    def _validate_content(
        self,
        content: str,
        *,
        require_complete: bool,
    ) -> None:
        if len(content) > self.store.max_skill_chars:
            raise ValueError(
                f"SKILL.md exceeds {self.store.max_skill_chars} characters"
            )
        metadata = _frontmatter(content)
        if not metadata.get("name") or not metadata.get("description"):
            raise ValueError(
                "Skill frontmatter must include name and description"
            )
        if CONTENT_SECRET_PATTERN.search(content):
            raise ValueError("Skill contains a credential-like literal")
        if _contains_target_specific_content(content):
            raise ValueError("Skill contains target- or task-specific content")
        duplicate_ratio = _duplicate_paragraph_ratio(content)
        if duplicate_ratio > self.max_duplicate_ratio:
            raise ValueError(
                f"duplicate paragraph ratio {duplicate_ratio:.3f} "
                f"exceeds {self.max_duplicate_ratio:.3f}"
            )
        if require_complete:
            headings = _headings(content).lower()
            missing = [
                group[0]
                for group in REQUIRED_SECTION_GROUPS
                if not any(token in headings for token in group)
            ]
            if missing:
                raise ValueError(
                    "new or major Skill is incomplete; missing sections: "
                    + ", ".join(missing)
                )

    def _validate_replacement(
        self,
        current: SkillRecord,
        candidate: str,
    ) -> None:
        if current.content == candidate:
            raise ValueError("proposal does not change the Skill")
        current_body = _normalized_body(current.content)
        candidate_body = _normalized_body(candidate)
        if current_body and candidate_body.startswith(current_body):
            raise ValueError(
                "simple append-only evolution is forbidden; merge, replace, "
                "or compress the Skill"
            )
        growth_budget = min(
            8192,
            max(1024, int(len(current.content) * 0.25)),
        )
        if len(candidate) > len(current.content) + growth_budget:
            raise ValueError(
                "replacement exceeds the bounded evolution growth budget"
            )
        current_duplicates = _duplicate_paragraph_ratio(current.content)
        candidate_duplicates = _duplicate_paragraph_ratio(candidate)
        if candidate_duplicates > max(
            self.max_duplicate_ratio,
            current_duplicates,
        ):
            raise ValueError("replacement increases duplicate content")

    def _select_target(
        self,
        proposal: dict[str, Any],
        records: list[SkillRecord],
    ) -> SkillRecord | None:
        requested = str(
            proposal.get("target_skill") or ""
        ).strip().lower()
        if requested:
            for record in records:
                if record.name == requested:
                    return record
            # Target not found by exact name — fall through to similarity
            # matching instead of rejecting the proposal outright.
        proposed_name = str(
            proposal.get("proposed_name") or ""
        ).strip().lower()
        for record in records:
            if record.enabled and record.name == proposed_name:
                return record
        best = self._related_records(proposal, records)
        if not best:
            return None
        score = _proposal_similarity(proposal, proposed_name or requested, best[0])
        return best[0] if score >= self.match_threshold else None

    def _related_records(
        self,
        proposal: dict[str, Any],
        records: list[SkillRecord],
    ) -> list[SkillRecord]:
        proposed_name = str(
            proposal.get("proposed_name") or ""
        ).strip().lower()
        return sorted(
            (record for record in records if record.enabled),
            key=lambda record: _proposal_similarity(
                proposal,
                proposed_name,
                record,
            ),
            reverse=True,
        )[:4]

    def _promote_reuse(
        self,
        proposal_id: str,
        proposal: dict[str, Any],
        target: SkillRecord | None,
        evolution_type: str,
    ) -> EvolutionDecision:
        if target is None:
            raise ValueError("validated reuse requires an existing target Skill")
        source_task = _source_task(proposal)
        if not source_task:
            raise ValueError(
                "validated reuse requires a project and intent evidence source"
            )
        provisional_project = (
            target.provisional_task.rsplit(":", 1)[0]
            if target.provisional_task
            else None
        )
        source_project = source_task.rsplit(":", 1)[0]
        if provisional_project and source_project == provisional_project:
            raise ValueError(
                "provisional Skill must be reused in an independent project"
            )
        trust = (
            "trusted"
            if target.trust == "provisional"
            else target.trust
        )
        record = self.store.write_skill(
            target.name,
            target.content,
            enabled=target.enabled,
            expected_revision=target.revision,
            actor=str(proposal.get("worker") or "worker"),
            reason=str(proposal.get("summary") or ""),
            action="reuse-validated",
            trust=trust,
            successful_reuses=target.successful_reuses + 1,
            failure_count=target.failure_count,
            provisional_task=(
                "" if trust == "trusted" else target.provisional_task
            ),
        )
        return EvolutionDecision(
            proposal_id,
            "accepted",
            "independent reuse validated",
            skill=record.name,
            version=record.version,
            revision=record.revision,
            evolution_type=evolution_type,
            trust=record.trust,
        )

    def _retire(
        self,
        proposal_id: str,
        proposal: dict[str, Any],
        target: SkillRecord | None,
        evolution_type: str,
    ) -> EvolutionDecision:
        if target is None:
            raise ValueError("RETIRE requires an existing target Skill")
        record = self.store.write_skill(
            target.name,
            target.content,
            enabled=False,
            expected_revision=target.revision,
            actor=str(proposal.get("worker") or "worker"),
            reason=str(proposal.get("summary") or ""),
            action="retire",
            trust="retired",
            successful_reuses=target.successful_reuses,
            failure_count=target.failure_count + 1,
            provisional_task=target.provisional_task,
        )
        return EvolutionDecision(
            proposal_id,
            "accepted",
            "Skill retired with rollback history preserved",
            skill=record.name,
            version=record.version,
            revision=record.revision,
            evolution_type=evolution_type,
            trust=record.trust,
        )

    def _make_room(self, records: list[SkillRecord]) -> None:
        if len(records) < self.store.max_skills:
            return
        disabled = sorted(
            (
                record
                for record in records
                if not record.enabled and record.name != "skill-creator"
            ),
            key=lambda record: (record.updated_at or "", record.name),
        )
        if not disabled:
            raise ValueError(
                f"skill count limit reached ({self.store.max_skills})"
            )
        victim = disabled[0]
        self.store.delete_skill(
            victim.name,
            actor="evolver",
            reason="pruned oldest retired Skill at count limit",
            action="retire-prune",
        )

    def _merge_redundant_skills(
        self,
        target: SkillRecord,
        requested: Any = None,
    ) -> list[str]:
        requested_names = {
            str(item).strip().lower()
            for item in requested
            if isinstance(item, str)
        } if isinstance(requested, list) else set()
        merged: list[str] = []
        target_lines = _content_lines(target.content)
        for other in self.store.list_skills():
            if other.name == target.name or not other.enabled:
                continue
            name_similarity = _containment(
                _tokens(target.name),
                _tokens(other.name),
            )
            description_similarity = _containment(
                _tokens(target.description),
                _tokens(other.description),
            )
            other_lines = _content_lines(other.content)
            covered = len(other_lines & target_lines) / max(
                1,
                len(other_lines),
            )
            redundant = (
                max(name_similarity, description_similarity) >= 0.75
                and covered >= 0.95
            )
            if other.name not in requested_names and not redundant:
                continue
            self.store.write_skill(
                other.name,
                other.content,
                enabled=False,
                expected_revision=other.revision,
                actor="evolver",
                reason=f"merged into {target.name}",
                action="merge-retire",
                trust="retired",
                successful_reuses=other.successful_reuses,
                failure_count=other.failure_count,
                provisional_task=other.provisional_task,
            )
            merged.append(other.name)
        return merged


class SkillEvolutionWorker:
    """One low-priority daemon drains durable proposals outside task execution."""

    def __init__(self, engine: SkillEvolutionEngine | None = None):
        self.engine = engine or SkillEvolutionEngine()
        self._event = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self) -> None:
        if self._thread is not None and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = threading.Thread(
            target=self._run,
            name="redtrace-skill-evolution",
            daemon=True,
        )
        self._thread.start()
        self.engine.restore_ready_deferred()
        if self.engine.pending_count():
            self._event.set()

    def notify(self) -> None:
        self._event.set()

    def finalize(self, proposal_id: str) -> dict[str, Any]:
        """Finalize the current task's candidate before task conclusion."""
        self.engine.process_pending(proposal_id=proposal_id)
        return self.engine.decision_for(proposal_id)

    def stop(self) -> None:
        self._stop.set()
        self._event.set()
        if self._thread is not None:
            self._thread.join(timeout=2)
        self._thread = None

    def _run(self) -> None:
        while not self._stop.is_set():
            self._event.wait()
            self._event.clear()
            if self._stop.is_set():
                break
            while (
                self.engine.pending_count()
                and not self._stop.is_set()
            ):
                self.engine.process_pending()


def _normalize_proposal(proposal: dict[str, Any]) -> dict[str, Any]:
    payload = dict(proposal)
    evolution_type = str(
        payload.get("evolution_type")
        or payload.get("type")
        or "CAPTURE"
    ).strip().upper()
    if evolution_type not in EVOLUTION_TYPES:
        raise ValueError(
            "evolution_type must be FIX, IMPROVE, CAPTURE, MERGE, or RETIRE"
        )
    payload["evolution_type"] = evolution_type
    impact = payload.get("impact")
    payload["impact"] = dict(impact) if isinstance(impact, dict) else {}
    for key in (
        "procedure",
        "validation",
        "evidence_refs",
        "merge_skills",
    ):
        value = payload.get(key)
        payload[key] = list(value) if isinstance(value, list) else []
    return payload


def _proposal_fingerprint(proposal: dict[str, Any]) -> str:
    stable = {
        key: proposal.get(key)
        for key in (
            "evolution_type",
            "proposed_name",
            "target_skill",
            "summary",
            "applicability",
            "procedure",
            "reuse_validated",
            "merge_skills",
        )
    }
    encoded = json.dumps(
        stable,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(encoded.encode()).hexdigest()[:24]


def _merge_duplicate_proposals(
    existing: dict[str, Any],
    incoming: dict[str, Any],
) -> dict[str, Any]:
    merged = dict(existing)
    existing_sources = [
        item for item in (existing.get("source_tasks") or []) if isinstance(item, str)
    ]
    incoming_sources = [
        item for item in (incoming.get("source_tasks") or []) if isinstance(item, str)
    ]
    new_sources = [item for item in incoming_sources if item not in existing_sources]
    merged["occurrences"] = int(existing.get("occurrences") or 1) + len(new_sources)
    for key in ("validation", "evidence_refs"):
        values: list[str] = []
        for item in [
            *(existing.get(key) or []),
            *(incoming.get(key) or []),
        ]:
            if isinstance(item, str) and item not in values:
                values.append(item)
        merged[key] = values[:8]
    merged["source_tasks"] = [*existing_sources, *new_sources][:8]
    existing_impact = existing.get("impact")
    incoming_impact = incoming.get("impact")
    existing_impact = existing_impact if isinstance(existing_impact, dict) else {}
    incoming_impact = incoming_impact if isinstance(incoming_impact, dict) else {}
    merged["impact"] = {
        "task_succeeded": existing_impact.get("task_succeeded") is True
        or incoming_impact.get("task_succeeded") is True,
        "step_verified": existing_impact.get("step_verified") is True
        or incoming_impact.get("step_verified") is True,
        **{
            key: max(
                [
                    0,
                    *[
                        value
                        for value in (
                            existing_impact.get(key, 0),
                            incoming_impact.get(key, 0),
                        )
                        if isinstance(value, int)
                        and not isinstance(value, bool)
                    ],
                ]
            )
            for key in (
                "tool_calls_saved",
                "invalid_steps_avoided",
                "duration_saved_ms",
            )
        },
    }
    return merged


def _source_task(proposal: dict[str, Any]) -> str | None:
    project = str(proposal.get("project_id") or "").strip()
    intent = str(proposal.get("intent_id") or "").strip()
    if project and intent:
        return f"{project}:{intent}"
    return intent or project or None


def _proposal_text(proposal: dict[str, Any]) -> str:
    return " ".join(
        [
            str(proposal.get("proposed_name") or ""),
            str(proposal.get("summary") or ""),
            str(proposal.get("applicability") or ""),
            " ".join(proposal.get("procedure") or []),
        ]
    )


def _proposal_similarity(
    proposal: dict[str, Any],
    proposed_name: str,
    record: SkillRecord,
) -> float:
    name_score = _containment(
        _tokens(proposed_name),
        _tokens(record.name),
    )
    context_score = _containment(
        _tokens(_proposal_text(proposal)),
        _tokens(
            " ".join(
                (
                    record.name,
                    record.description,
                    _headings(record.content),
                )
            )
        ),
    )
    return (name_score * 0.65) + (context_score * 0.35)


def _authoring_defects(
    content: str,
    target: SkillRecord | None = None,
) -> list[str]:
    defects: list[str] = []
    try:
        metadata = _frontmatter(content)
    except ValueError:
        metadata = {}
    if not metadata.get("name"):
        defects.append("missing frontmatter name")
    if not metadata.get("description"):
        defects.append("missing frontmatter description")
    if target is not None and metadata.get("name") != target.name:
        defects.append(f"frontmatter name must remain {target.name}")
    headings = _headings(content).lower()
    missing = [
        group[0]
        for group in REQUIRED_SECTION_GROUPS
        if not any(token in headings for token in group)
    ]
    if missing:
        defects.append("missing sections: " + ", ".join(missing))
    if CONTENT_SECRET_PATTERN.search(content):
        defects.append("contains a credential-like literal")
    if _contains_target_specific_content(content):
        defects.append("contains target- or task-specific content")
    duplicate_ratio = _duplicate_paragraph_ratio(content)
    if duplicate_ratio > DEFAULT_DUPLICATE_RATIO:
        defects.append("contains duplicate paragraphs")
    if target is not None:
        growth_budget = min(8192, max(1024, int(len(target.content) * 0.25)))
        if len(content) > len(target.content) + growth_budget:
            defects.append("exceeds the bounded replacement growth budget")
        current_body = _normalized_body(target.content)
        candidate_body = _normalized_body(content)
        if current_body and candidate_body.startswith(current_body):
            defects.append("is append-only instead of a compact replacement")
    return defects


def _extract_authored_skill(tool: str, stdout: str) -> str | None:
    text = _extract_agent_text(tool, stdout)

    match = FENCED_SKILL_PATTERN.search(text)
    if match:
        return match.group(1).strip() + "\n"
    start = text.find("---")
    if start >= 0:
        candidate = text[start:].strip()
        if len(candidate.split("---", 2)) == 3:
            return candidate + "\n"
    return None


def _extract_verification(tool: str, stdout: str) -> dict[str, Any] | None:
    text = _extract_agent_text(tool, stdout).strip()
    if text.startswith("```json") and text.endswith("```"):
        text = text[7:-3].strip()
    elif text.startswith("```") and text.endswith("```"):
        text = text[3:-3].strip()
    try:
        payload = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            return None
        try:
            payload = json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            return None
    return payload if isinstance(payload, dict) else None


def _extract_agent_text(tool: str, stdout: str) -> str:
    text = stdout
    if tool == "codex":
        for line in reversed(stdout.splitlines()):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            item = event.get("item") if isinstance(event, dict) else None
            if (
                isinstance(item, dict)
                and item.get("type") == "agent_message"
                and isinstance(item.get("text"), str)
            ):
                text = item["text"]
                break
    elif tool == "pi":
        for line in reversed(stdout.splitlines()):
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            message = event.get("message") if isinstance(event, dict) else None
            content = message.get("content") if isinstance(message, dict) else None
            if not isinstance(content, list):
                continue
            parts = [
                str(item.get("text"))
                for item in content
                if isinstance(item, dict)
                and item.get("type") == "text"
                and item.get("text")
            ]
            if parts:
                text = "\n".join(parts)
                break
    return text


def _positive_env(name: str, default: int) -> int:
    try:
        value = int(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if value > 0 else default


def _float_env(name: str, default: float) -> float:
    try:
        value = float(os.environ.get(name, default))
    except (TypeError, ValueError):
        return default
    return value if 0 <= value <= 1 else default


def _tokens(text: str) -> set[str]:
    return {
        token.lower()
        for token in TOKEN_PATTERN.findall(text)
        if len(token) > 1
    }


def _containment(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / min(len(left), len(right))


def _headings(content: str) -> str:
    return " ".join(
        line.lstrip("#").strip()
        for line in content.splitlines()
        if line.startswith("#")
    )


def _normalized_body(content: str) -> str:
    parts = content.split("---", 2)
    body = parts[2] if len(parts) == 3 else content
    return "\n".join(
        line.rstrip()
        for line in body.strip().splitlines()
    )


def _content_lines(content: str) -> set[str]:
    return {
        re.sub(r"\s+", " ", line).strip().lower()
        for line in _normalized_body(content).splitlines()
        if len(re.sub(r"\s+", " ", line).strip()) >= 24
    }


def _duplicate_paragraph_ratio(content: str) -> float:
    paragraphs = [
        re.sub(r"\s+", " ", paragraph).strip().lower()
        for paragraph in re.split(
            r"\n\s*\n",
            _normalized_body(content),
        )
    ]
    paragraphs = [
        paragraph
        for paragraph in paragraphs
        if len(paragraph) >= 40
    ]
    if not paragraphs:
        return 0.0
    return (
        len(paragraphs) - len(set(paragraphs))
    ) / len(paragraphs)


def _replace_frontmatter_name(content: str, name: str) -> str:
    parts = content.split("---", 2)
    if len(parts) != 3:
        return content
    frontmatter = NAME_LINE_PATTERN.sub(
        rf"\g<1>{name}",
        parts[1],
        count=1,
    )
    return f"---{frontmatter}---{parts[2]}"


def _is_major_change(current: str, candidate: str) -> bool:
    current_headings = _tokens(_headings(current))
    candidate_headings = _tokens(_headings(candidate))
    if not current_headings or not candidate_headings:
        return True
    structure_overlap = _containment(current_headings, candidate_headings)
    size_delta = abs(len(candidate) - len(current)) / max(1, len(current))
    return structure_overlap < 0.50 or size_delta > 0.30


def _contains_target_specific_content(content: str) -> bool:
    if re.search(
        r"(?:/Users/|/home/[^<\s`]+|/tmp/[^<\s`]+|[A-Za-z]:\\Users\\)",
        content,
        re.IGNORECASE,
    ):
        return True
    if re.search(
        r"\b(?:proj(?:ect)?|task|intent)[_-][a-z0-9]{6,}\b",
        content,
        re.IGNORECASE,
    ):
        return True
    for url in re.findall(r"https?://[^\s)`]+", content, re.IGNORECASE):
        lowered = url.lower()
        if "<target>" in lowered or "{{target}}" in lowered:
            continue
        if any(
            allowed in lowered
            for allowed in (
                "example.com",
                "example.org",
                "example.net",
                "localhost",
            )
        ):
            continue
        return True
    for address in re.findall(r"\b(?:\d{1,3}\.){3}\d{1,3}\b", content):
        if (
            address.startswith("127.")
            or address.startswith("192.0.2.")
            or address.startswith("198.51.100.")
            or address.startswith("203.0.113.")
        ):
            continue
        return True
    return False
