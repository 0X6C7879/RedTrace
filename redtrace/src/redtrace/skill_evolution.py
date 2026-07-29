from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import shutil
import subprocess
import threading
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
DEFAULT_AUTHOR_TIMEOUT = 120
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

    def __init__(self, root: Path):
        self.root = root
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
        tool = self._select_tool()
        if tool is None:
            raise EvolutionDeferred(
                "no Claude Code, Codex, or Pi CLI is available for background authoring"
            )
        prompt = self._prompt(proposal, target, related)
        worker = self._configured_worker(tool)
        command = self._command(tool, prompt, worker)
        if os.name == "posix" and shutil.which("nice"):
            command = ["nice", "-n", "10", *command]
        environment = dict(os.environ)
        if worker is not None:
            environment.update(worker.env)
        kwargs: dict[str, Any] = {
            "cwd": self.root,
            "capture_output": True,
            "text": True,
            "encoding": "utf-8",
            "errors": "replace",
            "timeout": self.timeout,
            "check": False,
            "env": environment,
        }
        try:
            result = subprocess.run(command, **kwargs)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise EvolutionDeferred(f"{tool} background author failed: {exc}") from exc
        if result.returncode != 0:
            detail = (result.stderr or result.stdout).strip()[-500:]
            raise EvolutionDeferred(
                f"{tool} background author exited {result.returncode}: {detail}"
            )
        content = _extract_authored_skill(tool, result.stdout)
        if not content:
            raise EvolutionDeferred(f"{tool} did not return a complete SKILL.md")
        return content

    def _select_tool(self) -> str | None:
        configured = os.environ.get("REDTRACE_SKILL_AUTHOR", "auto").strip().lower()
        if configured in {"off", "disabled", "none"}:
            return None
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
            if binary in {"claude", "codex", "pi"} and shutil.which(binary):
                available.append(binary)
        for binary in available:
            worker = self._configured_worker(binary)
            if worker is not None and worker.api_configured():
                return binary
        return available[0] if available else None

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
        return (
            "You are the low-priority RedTrace Skill author. Follow the included "
            "skill-creator contract. Use only the verified candidate evidence below. "
            "Generalize away targets, credentials, task IDs, temporary paths, and "
            "project-specific details. Prefer a compact replacement of the matching "
            "Skill; create a new Skill only if no existing entry can cover it. "
            "Return only one complete SKILL.md beginning with YAML frontmatter. "
            "Do not call tools or modify files.\n\n"
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
            paths = list(self.inbox.glob("*.json"))
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
                    _atomic_write(
                        path,
                        json.dumps(
                            merged,
                            ensure_ascii=False,
                            separators=(",", ":"),
                        )
                        + "\n",
                    )
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

    def process_pending(self, limit: int = 8) -> int:
        processed = 0
        for path in sorted(self.inbox.glob("*.json"))[: max(1, limit)]:
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
                    "Skill evolution deferred id=%s reason=%s",
                    proposal_id,
                    exc,
                )
            except SkillConflictError as exc:
                proposal_id = str(proposal.get("proposal_id") or path.stem)
                decision = EvolutionDecision(
                    proposal_id,
                    "rejected",
                    str(exc),
                    evolution_type=str(
                        proposal.get("evolution_type") or "CAPTURE"
                    ),
                )
                LOG.info(
                    "Stale Skill evolution rejected id=%s reason=%s",
                    proposal_id,
                    exc,
                )
            except Exception as exc:
                proposal_id = str(proposal.get("proposal_id") or path.stem)
                decision = EvolutionDecision(
                    proposal_id,
                    "rejected",
                    str(exc),
                    evolution_type=str(
                        proposal.get("evolution_type") or "CAPTURE"
                    ),
                )
                LOG.warning(
                    "Skill evolution proposal rejected id=%s reason=%s",
                    proposal_id,
                    exc,
                )
                self._degrade_failed_skill(proposal)
            self.store.record_skill_audit(
                {
                    "action": f"evolution-{decision.status}",
                    "evolutionType": decision.evolution_type,
                    "actor": str(proposal.get("worker") or "worker"),
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

    def evolve(self, proposal: dict[str, Any]) -> EvolutionDecision:
        proposal = _normalize_proposal(proposal)
        proposal_id = str(
            proposal.get("proposal_id") or uuid.uuid4().hex
        )
        evolution_type = proposal["evolution_type"]
        self._validate_evidence(proposal)
        self._validate_feedback_safety(proposal)
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
        trust = (
            "provisional"
            if target is None or major_change
            else target.trust
        )
        record = self.store.write_skill(
            candidate_name,
            content,
            enabled=True,
            expected_revision=expected_revision,
            actor=str(proposal.get("worker") or "worker"),
            reason=str(proposal.get("summary") or ""),
            action=action,
            trust=trust,
            successful_reuses=(
                target.successful_reuses if target is not None else 0
            ),
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

    def _validate_evidence(self, proposal: dict[str, Any]) -> None:
        summary = proposal.get("summary")
        validation = proposal.get("validation")
        impact = proposal.get("impact")
        if not isinstance(summary, str) or not summary.strip() or len(summary) > 500:
            raise ValueError("summary must contain 1-500 characters")
        if (
            not isinstance(validation, list)
            or not validation
            or len(validation) > 8
            or any(
                not isinstance(item, str)
                or not item.strip()
                or len(item) > 300
                for item in validation
            )
        ):
            raise ValueError(
                "1-8 concrete validation results up to 300 characters are required"
            )
        if not isinstance(impact, dict):
            raise ValueError("impact must be an object")
        verified = (
            impact.get("task_succeeded") is True
            or impact.get("step_verified") is True
        )
        if not verified:
            raise ValueError(
                "a successful task or independently verified step is required"
            )
        metrics = (
            impact.get("tool_calls_saved", 0),
            impact.get("invalid_steps_avoided", 0),
            impact.get("duration_saved_ms", 0),
        )
        if any(
            not isinstance(value, int)
            or isinstance(value, bool)
            or value < 0
            for value in metrics
        ):
            raise ValueError("impact metrics must be non-negative integers")
        content = proposal.get("content")
        if isinstance(content, str) and content.strip():
            if impact.get("task_succeeded") is True and not any(metrics):
                raise ValueError(
                    "full replacement proposals must measure an improvement"
                )
            return
        procedure = proposal.get("procedure")
        evidence_refs = proposal.get("evidence_refs")
        if (
            not isinstance(procedure, list)
            or not procedure
            or len(procedure) > 8
            or any(
                not isinstance(item, str)
                or not item.strip()
                or len(item) > 300
                for item in procedure
            )
        ):
            raise ValueError(
                "compact feedback requires 1-8 reusable procedure steps"
            )
        if (
            not isinstance(evidence_refs, list)
            or not evidence_refs
            or len(evidence_refs) > 8
            or any(
                not isinstance(item, str)
                or not item.strip()
                or len(item) > 200
                for item in evidence_refs
            )
        ):
            raise ValueError(
                "compact feedback requires 1-8 bounded evidence references"
            )

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
            raise ValueError(f"target Skill does not exist: {requested}")
        proposed_name = str(
            proposal.get("proposed_name") or ""
        ).strip().lower()
        for record in records:
            if record.enabled and record.name == proposed_name:
                return record
        best = self._related_records(proposal, records)
        if not best:
            return None
        score = _proposal_similarity(proposal, proposed_name, best[0])
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
        if (
            target.provisional_task
            and source_task
            and source_task == target.provisional_task
        ):
            raise ValueError(
                "provisional Skill must be reused in an independent task"
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
        if self.engine.pending_count():
            self._event.set()

    def notify(self) -> None:
        self._event.set()

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
    merged["occurrences"] = int(existing.get("occurrences") or 1) + 1
    for key in ("validation", "evidence_refs"):
        values: list[str] = []
        for item in [
            *(existing.get(key) or []),
            *(incoming.get(key) or []),
        ]:
            if isinstance(item, str) and item not in values:
                values.append(item)
        merged[key] = values[:8]
    source_tasks: list[str] = []
    for item in [
        *(existing.get("source_tasks") or []),
        *(incoming.get("source_tasks") or []),
    ]:
        if isinstance(item, str) and item not in source_tasks:
            source_tasks.append(item)
    merged["source_tasks"] = source_tasks[:8]
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


def _extract_authored_skill(tool: str, stdout: str) -> str | None:
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
    match = FENCED_SKILL_PATTERN.search(text)
    if match:
        return match.group(1).strip() + "\n"
    start = text.find("---")
    if start >= 0:
        candidate = text[start:].strip()
        if len(candidate.split("---", 2)) == 3:
            return candidate + "\n"
    return None


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
